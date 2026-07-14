#!/usr/bin/env node
// Observe your system of record locally, sign what you saw, and submit it. The
// provider key and the signing seed stay in this process. The relay only dials
// out.
//
//   postcept-relay keygen
//   postcept-relay observe refund --operation op_1 --refund-id re_x
//   postcept-relay flush
//   postcept-relay run            # periodic flush + health endpoint
//   postcept-relay audit          # score recent refunds, key never leaves this box
//
// Environment:
//   POSTCEPT_API_URL        default https://api.postcept.com
//   POSTCEPT_API_KEY        org API key (authenticates the submission)
//   POSTCEPT_ORG_ID         your org id (bound into every envelope)
//   POSTCEPT_RELAY_ID       from POST /v1/relay-keys
//   POSTCEPT_RELAY_SEED     base64 Ed25519 seed from `keygen` (keep secret)
//   POSTCEPT_RELAY_DATA     queue directory, default ./postcept-relay-data
//   CONNECTOR               mock | stripe (default mock)
//   STRIPE_API_KEY          restricted read-only key, stripe connector only
//   EVIDENCE_MODE           full | minimal (default full)
//   RELAY_HEALTH_PORT       health endpoint port for `run`, default 8477

import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { buildEnvelope, keyIdFor, publicKeyFromSeed, type ObservationEnvelope } from "./envelope.js";
import { Outbox } from "./queue.js";
import { observeMockRefund } from "./connectors/mock.js";
import { observeStripeRefund, sampleStripeRefunds } from "./connectors/stripe.js";

const API_URL = (process.env.POSTCEPT_API_URL || "https://api.postcept.com").replace(/\/$/, "");
const DATA_DIR = process.env.POSTCEPT_RELAY_DATA || "./postcept-relay-data";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable ${name}.`);
    process.exit(1);
  }
  return value;
}

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function submit(envelope: ObservationEnvelope): Promise<"accepted" | "rejected" | "retry"> {
  try {
    const res = await fetch(`${API_URL}/v1/relay/observations`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${required("POSTCEPT_API_KEY")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(envelope),
    });
    if (res.ok) return "accepted";
    if (res.status === 422) {
      const detail = ((await res.json().catch(() => null)) as { detail?: string } | null)?.detail;
      console.error(`Envelope ${envelope.observation_id} rejected: ${detail ?? "HTTP 422"}`);
      return "rejected";
    }
    return "retry"; // 401/5xx/429, keep it queued
  } catch {
    return "retry"; // network failure, the queue keeps it
  }
}

async function cmdKeygen(): Promise<void> {
  const seed = randomBytes(32);
  const seedB64 = seed.toString("base64");
  const publicKey = await publicKeyFromSeed(seedB64);
  const publicB64 = Buffer.from(publicKey).toString("base64");
  console.log("Generated a relay keypair. The seed stays with you. Register only the public half.\n");
  console.log(`POSTCEPT_RELAY_SEED=${seedB64}   # secret, store in your secret manager`);
  console.log(`public_key=${publicB64}`);
  console.log(`key_id=${keyIdFor(publicKey)}\n`);
  console.log("Register it:");
  console.log(`  curl -X POST ${API_URL}/v1/relay-keys \\`);
  console.log('    -H "Authorization: Bearer <your session or setup token>" \\');
  console.log(`    -d '{"name": "my-relay", "public_key": "${publicB64}"}'`);
  console.log("\nThe returned id is your POSTCEPT_RELAY_ID.");
}

async function cmdObserve(): Promise<void> {
  const kind = process.argv[3];
  if (kind !== "refund") {
    console.error('Only "observe refund" is supported in this version.');
    process.exit(1);
  }
  const operationId = flag("--operation");
  const refundId = flag("--refund-id");
  if (!operationId || !refundId) {
    console.error("Usage: postcept-relay observe refund --operation <op_id> --refund-id <re_...>");
    process.exit(1);
  }
  const connector = process.env.CONNECTOR || "mock";
  const evidenceMode = (process.env.EVIDENCE_MODE || "full") as "full" | "minimal";
  const facts =
    connector === "stripe"
      ? await observeStripeRefund(required("STRIPE_API_KEY"), refundId, evidenceMode)
      : await observeMockRefund(refundId);

  const envelope = await buildEnvelope(
    {
      operationId,
      orgId: required("POSTCEPT_ORG_ID"),
      relayId: required("POSTCEPT_RELAY_ID"),
      connector,
      facts,
    },
    required("POSTCEPT_RELAY_SEED")
  );
  const outbox = new Outbox(DATA_DIR);
  outbox.enqueue(envelope);
  console.log(
    `Observed ${refundId} via ${connector} (exists=${facts.exists}, status=${facts.status ?? "n/a"}), ` +
      `signed ${envelope.observation_id}, queued.`
  );
  const result = await outbox.flush(submit);
  console.log(`Flushed: ${result.submitted} submitted, ${result.rejected} rejected, ${result.kept} queued.`);
}

async function cmdFlush(): Promise<void> {
  const result = await new Outbox(DATA_DIR).flush(submit);
  console.log(`Flushed: ${result.submitted} submitted, ${result.rejected} rejected, ${result.kept} queued.`);
}

async function cmdRun(): Promise<void> {
  const outbox = new Outbox(DATA_DIR);
  const port = Number(process.env.RELAY_HEALTH_PORT || 8477);
  createServer((req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          queue_depth: outbox.pending().length,
          dead_lettered: outbox.deadLettered().length,
        })
      );
    } else {
      res.writeHead(404).end();
    }
  }).listen(port, () => console.log(`Health endpoint on :${port}/healthz`));

  console.log("Relay running. Flushing the queue every 15s.");
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const result = await new Promise<{ submitted: number; rejected: number; kept: number }>(
      (resolve) => setTimeout(() => outbox.flush(submit).then(resolve), 15_000)
    );
    if (result.submitted || result.rejected) {
      console.log(
        `Flushed: ${result.submitted} submitted, ${result.rejected} rejected, ${result.kept} queued.`
      );
    }
  }
}

/**
 * Score the account's recent refunds without handing anyone the key.
 *
 * The refunds are read here, in this process, with the key that is already on this
 * machine. Only the facts go to Postcept, which scores them and signs the badge.
 * No account, no API key, nothing stored.
 */
async function cmdAudit(): Promise<void> {
  const limit = Number(flag("--limit") ?? "25");
  const label = flag("--label") ?? undefined;
  const apiKey = required("STRIPE_API_KEY");

  const refunds = await sampleStripeRefunds(apiKey, limit);
  if (refunds.length === 0) {
    console.log("No refunds found on this account, so there is nothing to audit yet.");
    return;
  }

  // A stable, non-secret fingerprint of the account. The key itself never leaves.
  const accountRef = createHash("sha256").update(apiKey).digest("hex").slice(0, 12);

  const res = await fetch(`${API_URL}/v1/vcr-audit/observed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      connector: "stripe",
      account_ref: accountRef,
      refunds,
      agent_label: label,
    }),
  });
  if (!res.ok) {
    throw new Error(`Audit failed: HTTP ${res.status} ${await res.text()}`);
  }

  const report = (await res.json()) as {
    sampled: number;
    vcr: { verified: number; incomplete: number; duplicated: number; verified_completion_rate: number };
    findings: { refund_id: string; result: string; detail: string }[];
    badge: unknown;
  };
  const rate = (report.vcr.verified_completion_rate * 100).toFixed(1);
  console.log(`Sampled ${report.sampled} recent refunds on ${accountRef}.`);
  console.log(`Refund integrity: ${rate}% of sampled refunds verified settled`);
  console.log(
    `  verified ${report.vcr.verified}, incomplete ${report.vcr.incomplete}, duplicated ${report.vcr.duplicated}`
  );
  for (const f of report.findings.filter((x) => x.result !== "verified")) {
    console.log(`  ${f.result.padEnd(11)} ${f.refund_id}  ${f.detail}`);
  }
  console.log("\nSigned badge (verify it with @postcept/receipt):");
  console.log(JSON.stringify(report.badge, null, 2));
}

const command = process.argv[2];
const commands: Record<string, () => Promise<void>> = {
  keygen: cmdKeygen,
  observe: cmdObserve,
  flush: cmdFlush,
  run: cmdRun,
  audit: cmdAudit,
};

const handler = commands[command ?? ""];
if (!handler) {
  console.error("Usage: postcept-relay <keygen | observe | flush | run | audit>");
  process.exit(1);
}
handler().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
