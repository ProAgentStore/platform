# AGENTNAME

A ProAgentStore agent with persistent conversation, memory, and Workers AI.

## Development

```bash
pnpm install
pnpm dev
```

## Deploy

```bash
pags publish
# Or: push to main → auto-deploys via GitHub Actions
```

## Customize

Edit `src/index.ts`:
- Change `SYSTEM_PROMPT` to define personality and behavior
- Add knowledge by storing docs in the DO
- Change the model in the `AI.run()` call
