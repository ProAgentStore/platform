# AGENTNAME

A scheduled ProAgentStore worker.

## AI Billing

This template does not include a ProAgentStore Cloudflare Workers AI binding. If the cron job needs AI, wire it to a user-owned provider credential or another explicit billing source.

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

Edit `src/index.ts` to add scheduled work.
