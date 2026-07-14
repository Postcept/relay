import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { signEnvelope, keyIdFor, publicKeyFromSeed, normalizeFacts } from "../dist/envelope.js";

// Signed by the Postcept API's Python implementation. Ed25519 is deterministic,
// so this relay must reproduce the signature byte-for-byte: any drift in the
// canonicalization (either language) fails this test loudly.
const vector = JSON.parse(
  readFileSync(new URL("./vectors/envelope.json", import.meta.url), "utf8")
);
const missing = JSON.parse(
  readFileSync(new URL("./vectors/envelope_missing.json", import.meta.url), "utf8")
);
const controlChars = JSON.parse(
  readFileSync(new URL("./vectors/envelope_control_chars.json", import.meta.url), "utf8")
);

test("reproduces the Python-signed vector byte-for-byte", async () => {
  const signed = await signEnvelope(vector.envelope_unsigned, vector.seed_b64);
  assert.equal(signed.signature, vector.signature);
});

test("derives the same key id as the control plane", async () => {
  const publicKey = await publicKeyFromSeed(vector.seed_b64);
  assert.equal(keyIdFor(publicKey), vector.relay_key_id);
  assert.equal(Buffer.from(publicKey).toString("base64"), vector.public_key);
});

test("a tampered fact changes the signature", async () => {
  const inflated = structuredClone(vector.envelope_unsigned);
  inflated.facts.amount_cents = 999999;
  const signed = await signEnvelope(inflated, vector.seed_b64);
  assert.notEqual(signed.signature, vector.signature);
});

test("reproduces the Python-signed missing-refund vector byte-for-byte", async () => {
  const signed = await signEnvelope(missing.envelope_unsigned, missing.seed_b64);
  assert.equal(signed.signature, missing.signature);
});

test("an observer that omits absent keys still signs the full-schema facts", async () => {
  // A relay connector that saw no refund returns only the three keys it can speak
  // to (exists:false, no duplicates), leaving every identity field undefined. That
  // envelope must still verify against the control plane, which fills those keys
  // with null. signEnvelope normalizes first, so the signature matches the vector
  // where the nulls are spelled out. This is the missing-refund path that used to
  // fail signature verification.
  const partial = structuredClone(missing.envelope_unsigned);
  partial.facts = { exists: false, duplicate_refund_ids: [], duplicates_available: true };
  const signed = await signEnvelope(partial, missing.seed_b64);
  assert.equal(signed.signature, missing.signature);
});

test("reproduces the Python-signed control-character vector byte-for-byte", async () => {
  // Strings with tab, newline, carriage return, non-ASCII and DEL must escape the
  // same way Python's json.dumps does, or the signature diverges.
  const signed = await signEnvelope(controlChars.envelope_unsigned, controlChars.seed_b64);
  assert.equal(signed.signature, controlChars.signature);
});

test("normalizeFacts fills every absent field with null", () => {
  const full = normalizeFacts({
    exists: false,
    duplicate_refund_ids: [],
    duplicates_available: true,
  });
  assert.deepEqual(full, {
    exists: false,
    refund_id: null,
    charge_id: null,
    amount_cents: null,
    currency: null,
    customer: null,
    status: null,
    operation_ref: null,
    duplicate_refund_ids: [],
    duplicates_available: true,
  });
});
