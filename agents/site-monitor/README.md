# site-monitor

A ProAgentStore agent that monitors websites for content changes on an hourly cron schedule.

## What it does

- Fetches each configured URL every hour
- Normalizes HTML (strips scripts/styles, collapses whitespace) and SHA-256 hashes it
- Compares to the previous hash stored in a Durable Object
- On change: writes a history row to D1 and fires a webhook with a diff summary
- Webhook payloads are HMAC-signed when `WEBHOOK_SECRET` is set

## API

| Method | Path | Description |
|--------|------|-------------|
| POST | `/sites` | Add a URL to monitor |
| DELETE | `/sites/:id` | Remove a URL |
| GET | `/sites` | List all sites with current state |
| GET | `/sites/:id/history` | Paginated change history |
| GET | `/config` | Get global webhook URL |
| PUT | `/config` | Set global webhook URL |
| POST | `/cron/trigger` | Manually trigger a check cycle |
| GET | `/health` | Liveness probe |

### POST /sites

```json
{
  "url": "https://example.com",
  "label": "Example homepage",
  "webhook_url": "https://hooks.example.com/notify"  // optional per-site override
}
```

### PUT /config

```json
{ "webhook_url": "https://hooks.example.com/global" }
```

### Webhook payload (event: site.changed)

```json
{
  "event": "site.changed",
  "site": { "id": "abc123", "url": "https://example.com", "label": "Example" },
  "change": {
    "id": "xyz789",
    "detected_at": "2026-06-06T12:00:00.000Z",
    "old_hash": "aabbcc...",
    "new_hash": "ddeeff...",
    "summary": "Added: \"New sale item\" | Removed: \"Out of stock\"",
    "content_len": 42301
  }
}
```

Webhook signature header: `X-Hub-Signature-256: sha256=<hmac>`

## Development

```bash
pnpm install
pnpm dev
```

Create the D1 database locally:

```bash
wrangler d1 create site-monitor-db
# copy database_id into wrangler.toml
wrangler d1 migrations apply site-monitor-db --local
```

## Deploy

Push to `main` — GitHub Actions runs migrations then deploys the worker.

Or manually:

```bash
pnpm run db:migrate
pnpm deploy
```

## Secrets

Set via `wrangler secret put` and mirror in Doppler project `pags`:

| Secret | Purpose |
|--------|---------|
| `WEBHOOK_SECRET` | HMAC key for outbound webhook signatures (optional) |
