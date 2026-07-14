// The signed observation the relay sends. Canonicalization matches the Python
// implementation that verifies it, so the signatures agree.

import * as ed from "@noble/ed25519";
import { canonicalize } from "./canonical.js";

export const SCHEMA_VERSION = "1";
export const CONNECTOR_VERSION = "0.1.0";

export interface RefundFacts {
  exists: boolean;
  refund_id?: string | null;
  charge_id?: string | null;
  amount_cents?: number | null;
  currency?: string | null;
  customer?: string | null;
  status?: string | null;
  operation_ref?: string | null;
  duplicate_refund_ids: string[];
  duplicates_available: boolean;
}

export interface ObservationEnvelope {
  schema_version: string;
  observation_id: string;
  operation_id: string;
  org_id: string;
  relay_id: string;
  connector: string;
  connector_version: string;
  observed_at: string;
  nonce: string;
  facts: RefundFacts;
  relay_key_id: string;
  signature: string;
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const fromB64 = (value: string) => new Uint8Array(Buffer.from(value, "base64"));

export function keyIdFor(publicKey: Uint8Array): string {
  const urlsafe = Buffer.from(publicKey).toString("base64url").replace(/=+$/, "");
  return `ed25519:${urlsafe.slice(0, 16)}`;
}

export async function publicKeyFromSeed(seedB64: string): Promise<Uint8Array> {
  return ed.getPublicKeyAsync(fromB64(seedB64));
}

// The signed facts always carry the full schema: every key present, null for a
// value the relay could not observe. An observer that leaves a key undefined would
// otherwise drop it from the canonical body, while the control plane fills the same
// key with null, so the two would sign different bytes. This is what lets a
// missing-refund observation (exists:false, everything else null) verify.
export function normalizeFacts(facts: RefundFacts): RefundFacts {
  return {
    exists: facts.exists,
    refund_id: facts.refund_id ?? null,
    charge_id: facts.charge_id ?? null,
    amount_cents: facts.amount_cents ?? null,
    currency: facts.currency ?? null,
    customer: facts.customer ?? null,
    status: facts.status ?? null,
    operation_ref: facts.operation_ref ?? null,
    duplicate_refund_ids: facts.duplicate_refund_ids ?? [],
    duplicates_available: facts.duplicates_available ?? true,
  };
}

export async function signEnvelope(
  unsigned: Omit<ObservationEnvelope, "signature">,
  seedB64: string
): Promise<ObservationEnvelope> {
  const normalized = { ...unsigned, facts: normalizeFacts(unsigned.facts) };
  const body = new TextEncoder().encode(canonicalize(normalized));
  const signature = await ed.signAsync(body, fromB64(seedB64));
  return { ...normalized, signature: b64(signature) };
}

export interface ObserveInput {
  operationId: string;
  orgId: string;
  relayId: string;
  connector: string;
  facts: RefundFacts;
}

export async function buildEnvelope(
  input: ObserveInput,
  seedB64: string
): Promise<ObservationEnvelope> {
  const publicKey = await publicKeyFromSeed(seedB64);
  const unsigned: Omit<ObservationEnvelope, "signature"> = {
    schema_version: SCHEMA_VERSION,
    observation_id: `obs_${crypto.randomUUID().replace(/-/g, "")}`,
    operation_id: input.operationId,
    org_id: input.orgId,
    relay_id: input.relayId,
    connector: input.connector,
    connector_version: CONNECTOR_VERSION,
    observed_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    nonce: crypto.randomUUID().replace(/-/g, ""),
    facts: input.facts,
    relay_key_id: keyIdFor(publicKey),
  };
  return signEnvelope(unsigned, seedB64);
}
