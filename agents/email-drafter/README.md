# email-drafter

A ProAgentStore agent that generates emails matching your brand voice. Upload brand guidelines, example emails, and tone docs; then describe what you need and the agent drafts it using Workers AI.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Health check |
| POST | `/draft` | Generate a new email draft |
| GET | `/drafts` | List all drafts (optional `?tag=` filter) |
| GET | `/drafts/:id` | Get a single draft |
| POST | `/knowledge` | Add a brand document to the knowledge base |
| GET | `/knowledge` | List all knowledge base documents |
| DELETE | `/knowledge/:id` | Remove a knowledge base document |
| GET | `/config` | Get brand config |
| PUT | `/config` | Update brand config |
| POST | `/config/templates` | Add or overwrite a saved template |
| DELETE | `/config/templates/:name` | Remove a saved template |

## Draft request

`POST /draft`

```json
{
  "prompt": "Write a welcome email for a new customer who just signed up for our pro plan",
  "tone": "friendly",
  "recipientName": "Jane",
  "subjectHint": "Welcome to the team",
  "tags": ["welcome", "onboarding"],
  "template": "welcome-email"
}
```

`prompt` is required. All other fields are optional.

Response:

```json
{
  "id": "uuid",
  "prompt": "...",
  "subject": "Welcome to the team, Jane!",
  "body": "Hi Jane,\n\nWe're so excited to have you...\n\nBest,\nThe Team",
  "tags": ["welcome", "onboarding"],
  "template": "welcome-email",
  "tone": "friendly",
  "createdAt": "2026-06-06T12:00:00.000Z"
}
```

## Brand config

`PUT /config`

```json
{
  "tone": "friendly",
  "senderName": "The Acme Team",
  "signature": "Best,\nThe Acme Team\nacme.com",
  "styleNotes": "We never use the word 'leverage'. We prefer 'use'. Always write in second person."
}
```

Valid tones: `formal`, `casual`, `friendly`, `persuasive`, `empathetic`.

## Knowledge base

Upload brand documents so the AI uses the right voice and terminology.

`POST /knowledge`

```json
{
  "title": "Brand Voice Guidelines",
  "type": "brand-guidelines",
  "content": "Our brand voice is warm and direct. We avoid corporate jargon. We write as humans to humans..."
}
```

`type` is freeform — use values like `brand-guidelines`, `example-email`, `tone-guide` for organisation. Documents are injected into the AI prompt (up to ~4 000 characters total) to ground each draft.

## Templates

Save reusable email structures and reference them by name in `/draft` requests.

`POST /config/templates`

```json
{
  "name": "welcome-email",
  "content": "Subject: Welcome to {{product}}!\n\nHi {{name}},\n\nThank you for joining...\n\n[Main body here]\n\nWarmly,\n{{sender}}"
}
```

Then pass `"template": "welcome-email"` in your `/draft` request and the AI uses it as a structural starting point.

## Durable Objects

| DO class | Singleton key | Purpose |
|---|---|---|
| `BrandConfigDO` | `config` | Tone, signature, sender name, style notes, templates |
| `DraftStoreDO` | `store` | All generated drafts |
| `KnowledgeBaseDO` | `kb` | Brand documents |

## Secrets

Set via `wrangler secret put` and mirror in Doppler (`pags` project):

| Secret | Required | Description |
|--------|----------|-------------|
| `API_SECRET` | No | If set, all requests must include `Authorization: Bearer <value>` |

## Development

```bash
pnpm install
pnpm dev
```

Generate a draft locally:

```bash
curl -X POST http://localhost:8787/draft \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Write a short follow-up email after a sales demo", "tone": "friendly"}'
```

## Deploy

```bash
pnpm deploy
# or push to main — GitHub Actions auto-deploys
```

After first deploy, set optional secrets:

```bash
wrangler secret put API_SECRET
```

## Model

Uses `@cf/meta/llama-3.3-70b-instruct-fp8-fast` via Workers AI. The agent prompts the model to return JSON with `subject` and `body` fields. If generation fails the endpoint returns a 201 with a fallback body so callers can detect and retry.
