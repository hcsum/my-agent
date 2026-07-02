# Cloudflare Worker: Agent Status Mirror

This Worker is the public mirror for the agent's local `public-activity` feed.

## Why this exists

The bridge already writes two public-safe files locally:

- `current.json`
- `events.json`

This Worker keeps the same read model, but moves the public read endpoint to a stable Cloudflare URL. Your laptop only needs outbound HTTPS.

## Public endpoints

- `GET /current.json`
- `GET /events.json`
- `GET /health`

The Worker also exposes:

- `POST /ingest`

That endpoint is for the local bridge only. Protect it with `INGEST_TOKEN`.

## Presence model

The local bridge now pushes the latest snapshot on every write and sends the same snapshot again on a heartbeat cadence.

The Worker derives:

- `online`
- `stale`
- `offline`

When presence becomes `stale` or `offline`, `current.json` overrides the displayed `status` and `title`, but preserves the last known machine status in `lastKnownStatus`.

## Setup

1. Log into Cloudflare:

```bash
npx wrangler login
```

2. Create a KV namespace:

```bash
npx wrangler kv namespace create opencode-agent-status
```

3. Copy the returned namespace id into [cloudflare/agent-status-worker/wrangler.jsonc](/Users/sum/Codes/opencode-agent/cloudflare/agent-status-worker/wrangler.jsonc:1) as `kv_namespaces[0].id`.

4. Generate Worker types:

```bash
npm run cf:agent-status:types
```

5. Set the ingest secret:

```bash
npx wrangler secret put INGEST_TOKEN --config cloudflare/agent-status-worker/wrangler.jsonc
```

6. Deploy:

```bash
npm run cf:agent-status:deploy
```

7. Point the local bridge at the Worker:

```dotenv
PUBLIC_ACTIVITY_SYNC_URL=https://<your-worker>.<your-subdomain>.workers.dev/ingest
PUBLIC_ACTIVITY_SYNC_TOKEN=<same token you set in wrangler secret put>
PUBLIC_ACTIVITY_HEARTBEAT_MS=60000
PUBLIC_ACTIVITY_SYNC_TIMEOUT_MS=10000
```

## Local checks

Before deploy:

```bash
npm run cf:agent-status:types
npm run cf:agent-status:check
```

After deploy:

```bash
curl https://<your-worker>.<your-subdomain>.workers.dev/health
curl https://<your-worker>.<your-subdomain>.workers.dev/current.json
curl https://<your-worker>.<your-subdomain>.workers.dev/events.json
```
