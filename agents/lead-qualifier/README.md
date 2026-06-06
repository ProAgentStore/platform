# lead-qualifier

A ProAgentStore agent that receives inbound leads via webhook, scores them with Workers AI (hot / warm / cold), stores them in a Durable Object, and fires outbound notifications for hot leads.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/webhook/ingest` | Receive a new lead (form submission) |
| GET | `/leads` | List all leads — supports `?status=` and `?score=` filters |
| GET | `/leads/:id` | Get a single lead with AI notes |
| PUT | `/leads/:id/status` | Manually update lead status |
| GET | `/stats` | Aggregate counts and conversion rate |

## Webhook ingest payload

```json
{
  "name": "Jane Smith",
  "email": "jane@acme.com",
  "company": "Acme Corp",
  "message": "We are evaluating CRM tools for our enterprise team — budget approved.",
  "phone": "+1-555-0100",
  "role": "VP of Sales"
}
```

`name` and `email` are required. All other fields are optional and are stored as-is. Extra fields (phone, role, budget, etc.) are passed to the AI for scoring context.

The response includes the assigned score:

```json
{
  "id": "uuid",
  "score": "hot",
  "scoreValue": 88,
  "status": "new"
}
```

## Lead statuses

`new` → `contacted` → `qualified` → `converted`
or
`new` → `disqualified`

Update via `PUT /leads/:id/status` with body `{ "status": "contacted" }`.

## Secrets

Set these via `wrangler secret put` and mirror in Doppler (`pags` project):

| Secret | Required | Description |
|--------|----------|-------------|
| `WEBHOOK_SECRET` | No | If set, callers must send `X-Webhook-Secret: <value>` |
| `NOTIFY_WEBHOOK` | No | URL to POST hot lead events to (Slack, n8n, Zapier) |

## Development

```bash
pnpm install
pnpm dev
```

Test the webhook locally:

```bash
curl -X POST http://localhost:8787/webhook/ingest \
  -H "Content-Type: application/json" \
  -d '{"name":"Jane Smith","email":"jane@acme.com","company":"Acme Corp","message":"Ready to buy, budget approved, need enterprise plan."}'
```

## Deploy

```bash
pnpm deploy
# or push to main — GitHub Actions auto-deploys
```

After first deploy, set secrets:

```bash
wrangler secret put WEBHOOK_SECRET
wrangler secret put NOTIFY_WEBHOOK
```

## Hot lead notification payload

When a lead scores hot, the agent POSTs to `NOTIFY_WEBHOOK`:

```json
{
  "event": "hot_lead",
  "lead": {
    "id": "uuid",
    "name": "Jane Smith",
    "email": "jane@acme.com",
    "company": "Acme Corp",
    "message": "...",
    "scoreValue": 88,
    "notes": "Enterprise company with budget approved. Decision maker (VP) ready to buy immediately.",
    "createdAt": "2026-06-06T12:00:00.000Z"
  }
}
```

## Scoring model

Uses `@cf/meta/llama-3.3-70b-instruct-fp8-fast` via Workers AI. The agent asks the model to output a score (0–100) and classification (hot/warm/cold) as JSON, with 2–3 sentence reasoning. If AI is unavailable, falls back to keyword heuristics.

Thresholds: **70+** = hot, **40–69** = warm, **0–39** = cold.
