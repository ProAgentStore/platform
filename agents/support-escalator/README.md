# support-escalator

A ProAgentStore agent that triages incoming support tickets using Workers AI.

**Live at:** `https://support-escalator.proagentstore.online`

## What it does

1. **Receives tickets** via `POST /webhook/ticket` (subject, body, customerEmail, priority)
2. **Classifies** each ticket with Workers AI: auto-respond vs escalate
3. **Auto-responds** to common questions using the built-in knowledge base
4. **Escalates** hard tickets to the team via a webhook notification
5. **Daily cron** (9am UTC) sends an open-ticket summary to the escalation webhook

## API

| Method | Path | Description |
|--------|------|-------------|
| POST | `/webhook/ticket` | Receive a new support ticket |
| GET | `/tickets` | List all tickets (`?status=open\|escalated\|auto_responded\|resolved`) |
| GET | `/tickets/:id` | Get a single ticket |
| PUT | `/tickets/:id/resolve` | Mark a ticket resolved |
| GET | `/stats` | Open/closed/auto-responded counts |

## Webhook payload

```json
{
  "subject": "I can't log in",
  "body": "I forgot my password and the reset email isn't arriving.",
  "customerEmail": "alice@example.com",
  "priority": "normal"
}
```

Priority values: `low`, `normal`, `high`, `urgent` (defaults to `normal`).

### Signature verification

If `WEBHOOK_SECRET` is set, sign payloads with HMAC-SHA256:

```
X-Webhook-Signature: sha256=<hex_digest>
```

## Secrets

Set via `wrangler secret put` and update in Doppler project `pags`:

| Secret | Purpose |
|--------|---------|
| `ESCALATION_WEBHOOK_URL` | Slack / Discord / custom webhook URL for escalation and daily summary |
| `WEBHOOK_SECRET` | HMAC-SHA256 key to verify incoming ticket payloads (optional) |

## Setup

```bash
# 1. Create D1 database
wrangler d1 create support-escalator
# Copy the database_id into wrangler.toml

# 2. Install dependencies
pnpm install

# 3. Set secrets
wrangler secret put ESCALATION_WEBHOOK_URL
wrangler secret put WEBHOOK_SECRET

# 4. Deploy
wrangler deploy

# 5. Test locally
wrangler dev
```

## Knowledge base

The default KB covers billing, account, and technical questions. You can extend it by posting to the DO directly (internal route `/do/kb`). To add custom entries, modify `defaultKnowledgeBase()` in `src/index.ts` before deploying.

## Architecture

- **Hono** — lightweight routing
- **TicketStoreDO** — Durable Object holds all ticket state and the KB in DO storage (survives restarts, consistent within one DO instance)
- **Workers AI** — `@cf/meta/llama-3.3-70b-instruct-fp8-fast` for classification and response generation
- **Cron** — `0 9 * * *` (daily at 9am UTC) posts an open-ticket summary to the escalation webhook
- No external database required — all state lives in the Durable Object
