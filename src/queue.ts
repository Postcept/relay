// A JSONL outbox that survives restarts. Signed envelopes are appended before any
// network call and removed only once submitted. A permanent rejection (HTTP 422)
// moves to dead.jsonl. Transient failures stay queued for the next flush.

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ObservationEnvelope } from "./envelope.js";

export class Outbox {
  private readonly queueFile: string;
  private readonly deadFile: string;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.queueFile = join(dataDir, "queue.jsonl");
    this.deadFile = join(dataDir, "dead.jsonl");
  }

  enqueue(envelope: ObservationEnvelope): void {
    appendFileSync(this.queueFile, JSON.stringify(envelope) + "\n");
  }

  pending(): ObservationEnvelope[] {
    if (!existsSync(this.queueFile)) return [];
    return readFileSync(this.queueFile, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as ObservationEnvelope);
  }

  deadLettered(): ObservationEnvelope[] {
    if (!existsSync(this.deadFile)) return [];
    return readFileSync(this.deadFile, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as ObservationEnvelope);
  }

  /** Rewrite the queue atomically with only the still-pending envelopes. */
  private rewrite(remaining: ObservationEnvelope[]): void {
    const tmp = this.queueFile + ".tmp";
    writeFileSync(tmp, remaining.map((e) => JSON.stringify(e)).join("\n") + (remaining.length ? "\n" : ""));
    renameSync(tmp, this.queueFile);
  }

  // Submit every pending envelope. `submit` resolves to "accepted" (2xx),
  // "rejected" (permanent 4xx), or "retry" (transient). A thrown error counts as
  // a retry.
  async flush(
    submit: (envelope: ObservationEnvelope) => Promise<"accepted" | "rejected" | "retry">
  ): Promise<{ submitted: number; rejected: number; kept: number }> {
    const queue = this.pending();
    const remaining: ObservationEnvelope[] = [];
    let submitted = 0;
    let rejected = 0;
    for (const envelope of queue) {
      let outcome: "accepted" | "rejected" | "retry";
      try {
        outcome = await submit(envelope);
      } catch {
        outcome = "retry";
      }
      if (outcome === "accepted") {
        submitted += 1;
      } else if (outcome === "rejected") {
        appendFileSync(this.deadFile, JSON.stringify(envelope) + "\n");
        rejected += 1;
      } else {
        remaining.push(envelope);
      }
    }
    this.rewrite(remaining);
    return { submitted, rejected, kept: remaining.length };
  }
}
