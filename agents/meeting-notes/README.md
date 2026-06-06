# meeting-notes

A ProAgentStore agent that processes meeting transcripts from Zoom, Teams, Otter, or any text source. Workers AI extracts structured notes — summary, action items, decisions, follow-ups, and attendees — and stores them in a Durable Object. A daily cron at 18:00 UTC sends a digest of all open action items from the past 7 days.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/webhook/transcript` | Ingest a transcript — returns extracted notes |
| GET | `/meetings` | List meetings (newest first) — supports `?search=`, `?limit=`, `?cursor=` |
| GET | `/meetings/:id` | Get a single meeting with full transcript and notes |
| GET | `/action-items` | List all action items — supports `?status=open\|done` |
| PUT | `/action-items/:id` | Update an action item (mark done, reassign, set due date) |
| GET | `/digest` | On-demand digest — add `?format=json` for structured output |
| POST | `/cron/trigger` | Manually run the daily digest cycle (dev/debug) |
| GET | `/health` | Liveness probe |

## Webhook payload

```json
{
  "transcript": "Alice: Let's kick off. We need to ship the new dashboard by Friday...",
  "source": "zoom",
  "date": "2026-06-06"
}
```

`transcript` is required. `source` defaults to `"unknown"`. `date` defaults to today (ISO format).

### Response

```json
{
  "id": "abc123xyz",
  "title": "Product Dashboard Launch Planning",
  "attendees": ["Alice", "Bob", "Carol"],
  "summary": "Team aligned on shipping the new dashboard by Friday. Carol will lead QA. Budget approved for contractor.",
  "decisions": ["Ship dashboard by EOD Friday", "Hire contractor for data migration"],
  "followUps": ["Revisit analytics strategy next sprint"],
  "actionItems": [
    {
      "id": "def456",
      "text": "Complete QA pass on dashboard",
      "assignee": "Carol",
      "dueDate": "2026-06-07",
      "status": "open"
    }
  ]
}
```

## Updating action items

```bash
curl -X PUT https://meeting-notes.proagentstore.online/action-items/<id> \
  -H "Content-Type: application/json" \
  -d '{"status": "done"}'
```

Patchable fields: `status` (`open` or `done`), `assignee`, `dueDate`.

## Secrets

Set these via `wrangler secret put` and mirror in Doppler (`pags` project):

| Secret | Required | Description |
|--------|----------|-------------|
| `WEBHOOK_SECRET` | No | If set, callers must send `X-Webhook-Secret: <value>` |
| `DIGEST_WEBHOOK` | No | URL to POST daily digest to (Slack, n8n, email relay) |

## Digest webhook payload

When the cron fires (or `/cron/trigger` is called), `DIGEST_WEBHOOK` receives:

```json
{
  "event": "daily_digest",
  "generatedAt": "2026-06-06T18:00:00.000Z",
  "openActionItems": 5,
  "recentMeetings": 3,
  "text": "Meeting Notes Daily Digest — 2026-06-06\n\n..."
}
```

## Development

```bash
pnpm install
pnpm dev
```

Test the webhook locally:

```bash
curl -X POST http://localhost:8787/webhook/transcript \
  -H "Content-Type: application/json" \
  -d '{
    "transcript": "Alice: We need to launch the new feature by Friday. Bob agreed to handle QA. Carol will update the docs by Thursday.",
    "source": "zoom",
    "date": "2026-06-06"
  }'
```

## Deploy

```bash
pnpm deploy
# or push to main — GitHub Actions auto-deploys
```

After first deploy, set secrets:

```bash
wrangler secret put WEBHOOK_SECRET
wrangler secret put DIGEST_WEBHOOK
```

## AI model

Uses `@cf/meta/llama-3.3-70b-instruct-fp8-fast` via Workers AI. Transcripts are truncated to 12,000 characters before extraction. If the AI returns malformed output, the raw response is stored as the summary so the transcript is never lost.
