# competitor-intel

Daily competitor intelligence agent for ProAgentStore. Monitors a list of competitor URLs, detects content changes, and generates AI-written reports with trend analysis.

## How it works

1. Cron fires at 07:00 UTC every day
2. For each configured competitor URL, the agent fetches the page and strips HTML
3. Content is SHA-256 hashed and compared to the previous snapshot stored in the Durable Object
4. When a change is detected, Workers AI (`llama-3.3-70b`) writes a 2-4 sentence change summary
5. After all competitors are checked, AI writes an executive briefing covering all changes
6. The full report (summary + per-competitor items) is saved in the DO, keeping the last 90 days

## API

All write endpoints require `Authorization: Bearer <ADMIN_TOKEN>`. Reads are public.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/competitors` | yes | Add a competitor URL |
| `DELETE` | `/competitors/:id` | yes | Remove a competitor |
| `GET` | `/competitors` | no | List all competitors |
| `GET` | `/reports` | no | List report summaries (latest first, `?limit=N`) |
| `GET` | `/reports/latest` | no | Full latest report with per-competitor items |

### Add a competitor

```bash
curl -X POST https://competitor-intel.proagentstore.online/competitors \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com", "label": "Example Co"}'
```

### Get the latest report

```bash
curl https://competitor-intel.proagentstore.online/reports/latest
```

## Setup

### 1. Create the Worker

```bash
pnpm install
wrangler deploy
```

### 2. Set secrets

```bash
wrangler secret put ADMIN_TOKEN
# then add to Doppler project pags:
doppler secrets set ADMIN_TOKEN=<value> --project pags --config prd
```

### 3. Add competitors via the API

Use the `POST /competitors` endpoint above. The cron runs automatically at 07:00 UTC.

## Local dev

```bash
pnpm dev
# Trigger the cron manually:
curl "http://localhost:8787/__scheduled?cron=0+7+*+*+*"
```

## Bindings

| Binding | Type | Purpose |
|---------|------|---------|
| `AI` | Workers AI | Change summaries + executive briefings |
| `INTEL` | Durable Object | Competitor list, hash state, snapshots, reports |

## Data model (DO storage keys)

| Key | Value | Description |
|-----|-------|-------------|
| `competitors` | `Competitor[]` | All configured competitors |
| `state:<id>` | `CompetitorState` | Hash + fetch/change timestamps per competitor |
| `snap:<id>` | `string` (truncated at 50KB) | Previous text snapshot for AI diffing |
| `report:<iso-ts>` | `ReportEntry` | Full report; last 90 retained |
