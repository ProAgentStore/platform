# AGENTNAME

A ProAgentStore agent with persistent conversation and caller-owned Workers AI billing.

## AI Billing

This template does not use the ProAgentStore Cloudflare Workers AI binding. AI calls require caller-provided Cloudflare Workers AI credentials:

- `X-CF-Account-ID`
- `X-CF-AI-Token`

Inference spend bills to the caller's Cloudflare account, not the ProAgentStore platform account.

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
