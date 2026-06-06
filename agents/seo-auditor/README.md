# seo-auditor

A ProAgentStore agent that audits website SEO daily and tracks score trends over time.

## What it does

- Fetches each configured URL at 05:00 UTC daily
- Extracts: title, meta description, H1-H6 structure, image alt tags, internal/external links, word count, JSON-LD schema markup
- Calls Workers AI (`llama-3.3-70b`) to score each page 0-100 and generate actionable recommendations
- Falls back to deterministic rule-based scoring if AI response is malformed
- Persists each audit to D1 and a rolling 90-entry score history to a Durable Object per site
- Detects regressions (score dropped vs previous audit) and logs a warning

## API

| Method | Path | Description |
|--------|------|-------------|
| POST | `/sites` | Register a URL for daily auditing |
| GET | `/sites` | List all registered sites |
| GET | `/audits` | Paginated audit list (latest first) |
| GET | `/audits/latest` | Latest audit per site |
| GET | `/audits/:id` | Single audit by id |
| POST | `/cron/trigger` | Manually run a full audit cycle |
| GET | `/health` | Liveness probe |

### POST /sites

```json
{
  "url": "https://example.com",
  "label": "Example homepage"
}
```

### GET /audits

Query params: `limit` (max 100, default 20), `offset` (default 0), `site_id` (filter to one site).

### Audit object

```json
{
  "id": "abc123def456",
  "site_id": "xyz789",
  "audited_at": "2026-06-06T05:00:00.000Z",
  "score": 74,
  "title": "Example Domain",
  "meta_desc": "This domain is for use in illustrative examples.",
  "word_count": 312,
  "h1_count": 1,
  "images_total": 4,
  "images_no_alt": 1,
  "links_internal": 8,
  "links_external": 2,
  "has_schema": true,
  "recommendations": [
    "Expand meta description to 120-160 characters (currently 48).",
    "Add alt text to 1 image that is currently missing it.",
    "Expand content beyond 600 words for stronger SEO signals."
  ],
  "regression": false
}
```

## Scoring

The AI scores pages on these criteria (rule-based fallback uses the same weights):

| Signal | Points |
|--------|--------|
| Title present | 10 |
| Title 50-60 chars | 10 |
| Meta description present | 10 |
| Meta description 120-160 chars | 10 |
| Exactly one H1 | 15 |
| 300+ words | 10 |
| 600+ words | 5 bonus |
| All images have alt text | 10 (−2 per missing, max −10) |
| JSON-LD schema present | 10 |
| Internal + external links | 10 |

## Development

```bash
pnpm install
pnpm dev
```

Create the D1 database locally:

```bash
wrangler d1 create seo-auditor-db
# copy database_id into wrangler.toml
wrangler d1 migrations apply seo-auditor-db --local
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
| `ADMIN_TOKEN` | Bearer token for write API endpoints (optional; if unset all routes are open) |
