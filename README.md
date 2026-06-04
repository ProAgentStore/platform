# ProAgentStore Platform

Server-powered AI agents for when browser isn't enough. Workers AI, D1, R2, cron, API gateway, Stripe Connect.

**Store:** https://proagentstore.online
**GitHub:** https://github.com/ProAgentStore
**Free pair:** https://freeagentstore.online

## Status: Phase 3 (SDK types only)

The PAGS platform is scaffolded with type definitions. Implementation begins after FAGS is fully shipped.

## What's in here

```
platform/
├── packages/
│   └── sdk/        @proagentstore/sdk — type definitions for Workers AI, D1, R2, Stripe
├── pnpm-workspace.yaml
├── tsconfig.json
└── vitest.config.ts
```

## SDK (types only — implementation Phase 3)

```typescript
import { initPro } from '@proagentstore/sdk';

const agent = initPro({ agentId: 'my-agent' });

agent.ai          // Workers AI (server-side inference, any model)
agent.db          // Per-agent D1 database
agent.storage     // Per-agent R2 file storage
agent.subscription // Stripe checkout/portal/status
agent.usage       // Usage tracking for creator payouts
```

## What Pro adds over Free

| Free (FAGS) | Pro (PAGS) |
|---|---|
| User's GPU/CPU (WebGPU/WASM) | Workers AI (70B+ models) |
| IndexedDB / Cache Storage | D1 database + R2 storage |
| Offline-capable | Cron scheduling |
| No API access | API gateway (agent-as-a-service) |
| MIT license required | Proprietary OK |
| $0 forever | $9/mo, creator payouts |

## Part of the FreeStore family

| Store | URL |
|---|---|
| FreeAppStore | https://freeappstore.online |
| FreeGameStore | https://freegamestore.online |
| FreeWebStore | https://freewebstore.online |
| FreeAgentStore | https://freeagentstore.online |
| **ProAgentStore** | **https://proagentstore.online** |

## License

MIT
