import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Outbox } from "../dist/queue.js";

const envelope = (id) => ({
  schema_version: "1",
  observation_id: id,
  operation_id: "op_1",
  org_id: "org_1",
  relay_id: "rly_1",
  connector: "mock",
  connector_version: "0.1.0",
  observed_at: "2026-07-12T00:00:00Z",
  nonce: `nonce-${id}-0123456789abcdef`,
  facts: { exists: false, duplicate_refund_ids: [], duplicates_available: true },
  relay_key_id: "ed25519:test",
  signature: "sig",
});

test("the queue survives a restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-"));
  new Outbox(dir).enqueue(envelope("obs_a"));
  // A brand-new instance (a new process, in real life) still sees the envelope.
  const reborn = new Outbox(dir);
  assert.equal(reborn.pending().length, 1);
  assert.equal(reborn.pending()[0].observation_id, "obs_a");
});

test("transient failures keep envelopes queued, permanent rejections dead-letter", async () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-"));
  const outbox = new Outbox(dir);
  outbox.enqueue(envelope("obs_ok"));
  outbox.enqueue(envelope("obs_dead"));
  outbox.enqueue(envelope("obs_retry"));

  const outcomes = { obs_ok: "accepted", obs_dead: "rejected", obs_retry: "retry" };
  const result = await outbox.flush(async (e) => outcomes[e.observation_id]);

  assert.deepEqual(result, { submitted: 1, rejected: 1, kept: 1 });
  assert.equal(outbox.pending()[0].observation_id, "obs_retry");
  assert.equal(outbox.deadLettered()[0].observation_id, "obs_dead");

  // Next flush succeeds for the kept one. The dead letter is never retried.
  const second = await outbox.flush(async () => "accepted");
  assert.deepEqual(second, { submitted: 1, rejected: 0, kept: 0 });
  assert.equal(outbox.deadLettered().length, 1);
});

test("a thrown submit counts as transient, not lost", async () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-"));
  const outbox = new Outbox(dir);
  outbox.enqueue(envelope("obs_x"));
  const result = await outbox.flush(async () => {
    throw new Error("network down");
  });
  assert.deepEqual(result, { submitted: 0, rejected: 0, kept: 1 });
  assert.equal(outbox.pending().length, 1);
});
