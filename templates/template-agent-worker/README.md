# AGENTNAME

A ProAgentStore agent with persistent conversation and caller-owned Workers AI billing.

## AI Billing

This template does not use the ProAgentStore Cloudflare Workers AI binding. AI calls require caller-provided Cloudflare Workers AI credentials:

- `X-CF-Account-ID`
- `X-CF-AI-Token`

Inference spend bills to the caller's Cloudflare account, not the ProAgentStore platform account.

## Failures and telemetry

When Workers AI refuses the call or answers with nothing, `POST /chat` returns **502**
`{"error":"upstream_ai_failed","upstreamStatus":<status>}` — never a 200 with an empty
result — and writes one JSON log line (`event: "upstream_ai_failed"`), visible in
`wrangler tail` and Workers Logs. The upstream response body is not echoed back or logged.
Nothing is stored for a failed turn, so an empty reply never enters the conversation history.

This template has no platform error log of its own. To keep these failures, report from
`upstreamFailure()` in `src/index.ts` to your own sink (Sentry, a webhook, a D1 table).

## Development

```bash
pnpm install
pnpm dev
```

## Deploy

```bash
pags publish
# Or: push to main to auto-deploy via GitHub Actions
```

## Customize

Edit `src/index.ts`:

- Change `SYSTEM_PROMPT` to define personality and behavior
- Add knowledge by storing docs in the Durable Object
- Change the `MODEL` constant
