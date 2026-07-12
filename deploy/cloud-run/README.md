# Deploying the relay to Cloud Run (or any container host)

The relay only dials out and needs no inbound traffic, so any container host
works (Cloud Run, Fly, ECS, Container Apps). On Cloud Run, run it as a worker
rather than a request-serving service, since it flushes its queue on a timer.

## Secrets

Keep the signing seed and provider key in your secret manager, mounted as
environment variables. Do not bake them into an image or a config file.

```sh
# Generate a keypair locally and register the public half.
npx @postcept/relay keygen
# Store the seed (Google Secret Manager shown here).
gcloud secrets create postcept-relay-seed --data-file=- <<< "$POSTCEPT_RELAY_SEED"
```

## Deploy

```sh
gcloud run deploy postcept-relay \
  --image ghcr.io/postcept/relay:0.1.0 \
  --no-cpu-throttling \
  --no-allow-unauthenticated \
  --args=run \
  --set-env-vars=POSTCEPT_API_URL=https://api.postcept.com,CONNECTOR=stripe,EVIDENCE_MODE=minimal \
  --set-secrets=POSTCEPT_API_KEY=postcept-relay-api-key:latest,\
POSTCEPT_ORG_ID=postcept-relay-org:latest,\
POSTCEPT_RELAY_ID=postcept-relay-id:latest,\
POSTCEPT_RELAY_SEED=postcept-relay-seed:latest,\
STRIPE_API_KEY=stripe-readonly-key:latest
```

Notes:
- `--no-cpu-throttling` keeps the flush loop running between requests.
- The queue lives on the container filesystem. On Cloud Run that filesystem is ephemeral, so a
  cold start can lose not-yet-flushed observations. For durability across
  restarts, mount a volume (Cloud Run + a filestore/GCS-FUSE mount) or run on a
  host with a persistent disk (the Helm chart uses a PVC).
- `/healthz` on `RELAY_HEALTH_PORT` (default 8477) reports queue depth and
  dead-lettered count for your platform's health check or a scrape.
