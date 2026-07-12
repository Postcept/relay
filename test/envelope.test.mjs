import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { signEnvelope, keyIdFor, publicKeyFromSeed } from "../dist/envelope.js";

// Signed by the Postcept API's Python implementation. Ed25519 is deterministic,
// so this relay must reproduce the signature byte-for-byte: any drift in the
// canonicalization (either language) fails this test loudly.
const vector = JSON.parse(
  readFileSync(new URL("./vectors/envelope.json", import.meta.url), "utf8")
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
