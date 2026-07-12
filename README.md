# @postcept/relay

Read your system of record where it already lives and send Postcept a signed
observation instead of your credentials.

The relay runs in your environment. It reads the system of record (Stripe today,
or a mock ledger for trying it out) with a key you control, normalises what it
saw, signs it, and sends that signed observation to Postcept. Postcept checks the
signature against a public key you registered, rejects replays and stale or
tampered submissions, and verifies the agent's claim against what your relay
reported. The receipt names the relay as the source.

Your provider key and the relay's signing seed never leave your environment.

## Quick start (mock ledger, no provider account)

```
npx @postcept/relay keygen
```

Register the printed public key with `POST /v1/relay-keys` to get a relay id, then:

```
export POSTCEPT_API_KEY=pcpt_sk_...
export POSTCEPT_ORG_ID=org_...
export POSTCEPT_RELAY_ID=rly_...
export POSTCEPT_RELAY_SEED=...        # from keygen, keep it secret

npx @postcept/relay observe refund --operation op_1 --refund-id re_4md82k
```

Then verify against the observation:

```
curl -X POST https://api.postcept.com/v1/verifications \
  -H "Authorization: Bearer $POSTCEPT_API_KEY" -H "Content-Type: application/json" \
  -d '{"operation_id":"op_1","agent_id":"my-agent","connector":"relay",
       "claim":{"refund_id":"re_4md82k","amount_cents":12000,"currency":"usd",
                "customer":"mara.ellis@example.com"}}'
```

The receipt's `connectors_checked` reads `relay:rly_...`, so the evidence shows the
source was your observation and not a Postcept-held credential.

## Stripe (read-only)

Create a restricted Stripe key with read access to Refunds and Charges. That is
everything this connector calls. Then:

```
export CONNECTOR=stripe
export STRIPE_API_KEY=rk_live_...     # restricted, read-only
export EVIDENCE_MODE=minimal          # optional, omit the customer identity
```

With `EVIDENCE_MODE=minimal` the customer field is left out and Postcept skips the
customer check rather than passing it, so sending less evidence never raises
confidence.

## Durability

Signed observations are written to a local queue (`POSTCEPT_RELAY_DATA`, JSONL)
before any network call, so a crash or an unreachable control plane loses nothing.
`flush` (or the `run` loop, every 15 seconds) retries transient failures and moves
permanently rejected observations to `dead.jsonl` for inspection. `run` serves
`GET :8477/healthz` with the queue depth.

## Docker

```
npm run build
docker build -t postcept-relay packages/relay
docker run -e POSTCEPT_API_KEY=... -e POSTCEPT_ORG_ID=... \
  -e POSTCEPT_RELAY_ID=... -e POSTCEPT_RELAY_SEED=... \
  -v relay-data:/relay/data postcept-relay
```

## Deploying

`deploy/helm` is a Helm chart. It creates no Service or Ingress, uses a PVC for the
queue, and reads secrets from a Secret you manage. `deploy/cloud-run` covers a
serverless worker, with a note on queue durability on ephemeral filesystems.

## What a signed observation proves

An accepted observation shows it came from your registered relay, unchanged,
recently, and once. It does not show that the provider's answer was itself
correct, which is why the receipt names the relay and why revoking a relay key
(`DELETE /v1/relay-keys/{id}`) takes effect right away.
