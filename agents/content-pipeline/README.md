# content-pipeline

A ProAgentStore scheduled content generation agent. Runs daily at 6am UTC, picks a topic from your configured list, generates content via Workers AI, and stores it in R2.

## What it does

- **Cron** — fires daily at 6am UTC, picks the least-recently-used topic, generates content, stores JSON in R2
- **Topic management** — add/list topics via API; round-robin selection ensures even coverage
- **Configurable** — content type (blog/social/newsletter), tone, length, target audience, and AI model are all runtime-configurable without redeploying
- **R2 storage** — each generated piece is a JSON object in `pags-content-pipeline` bucket under `content/<timestamp>-<id>`
- **DurableObject** — stores topics list, config, and a content ID→R2 key index

## API

```
POST /topics          body: { "text": "..." }        → add a topic
GET  /topics                                          → list all topics
GET  /content         ?limit=20&cursor=...            → list generated content (newest first)
GET  /content/:id                                     → get a single piece by ID
GET  /config                                          → view current config
PUT  /config          body: { ...config fields }      → update config (partial patch)
```

### Config fields

| Field | Type | Default | Options |
|---|---|---|---|
| `contentType` | string | `blog` | `blog`, `social`, `newsletter` |
| `tone` | string | `professional` | `professional`, `casual`, `witty`, `inspirational`, `educational` |
| `length` | string | `medium` | `short` (~150w), `medium` (~400w), `long` (~800w) |
| `targetAudience` | string | `general audience` | any string |
| `model` | string | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | any Workers AI chat model |

## Development

```bash
pnpm install
pnpm dev
```

To trigger the cron locally:

```bash
curl "http://localhost:8787/__scheduled?cron=0+6+*+*+*"
```

## Deploy

Push to `main` — GitHub Actions deploys automatically via `wrangler deploy`.

First deploy: create the R2 bucket beforehand:

```bash
wrangler r2 bucket create pags-content-pipeline
```

## Quick start

```bash
# 1. Add some topics
curl -X POST https://content-pipeline.proagentstore.online/topics \
  -H 'Content-Type: application/json' \
  -d '{"text": "The future of remote work in 2026"}'

curl -X POST https://content-pipeline.proagentstore.online/topics \
  -H 'Content-Type: application/json' \
  -d '{"text": "Why async communication beats meetings"}'

# 2. Configure for your use case
curl -X PUT https://content-pipeline.proagentstore.online/config \
  -H 'Content-Type: application/json' \
  -d '{"contentType": "newsletter", "tone": "casual", "targetAudience": "startup founders"}'

# 3. List generated content after the cron fires
curl https://content-pipeline.proagentstore.online/content
```
