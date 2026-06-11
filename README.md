# ProAgentStore Platform

Marketplace for server-powered AI agents. Creators build agent templates, clients subscribe and run them on their own data.

**Store:** https://proagentstore.online
**API:** https://api.proagentstore.online
**MCP:** https://mcp.proagentstore.online/mcp
**Console:** https://proagentstore.online/console/
**GitHub:** https://github.com/ProAgentStore
**Free pair:** https://freeagentstore.online

## What's in here

```
platform/
├── packages/sdk/     @proagentstore/sdk — TypeScript SDK for agents
├── packages/cli/     @proagentstore/cli — init, check, publish
├── workers/api/      Hono API worker (auth, agents, instances, keys, analytics)
├── workers/host/     Marketing site + console + widget
├── workers/mcp/      MCP server for Claude/Cursor/VS Code
├── store/            Source HTML for all pages
├── skills/           Open Agent Skills source files
├── plugins/          Codex and Claude plugin wrappers
├── agents/           5 flagship agents (site-monitor, lead-qualifier, etc.)
└── templates/        Agent scaffolding (worker, cron, api)
```

## Agent types

| Type | Template | What it does |
|---|---|---|
| **Agent** | `worker` | Full AI: conversation, memory, knowledge base, 10 tools, Workers AI |
| **Worker** | `cron` | Scheduled tasks: daily digests, monitoring, batch processing |
| **Tool** | `api` | Stateless endpoint: transform, generate, analyze |

## Quick start

### Use an agent
```bash
# Try any published agent — no sign-up needed
curl -X POST https://api.proagentstore.online/v1/public/agents/chatbot/try \
  -H "Content-Type: application/json" \
  -d '{"message":"Hello!"}'
```

### Build an agent
```bash
npx @proagentstore/cli init my-agent --template worker
cd my-agent
pnpm install && pnpm dev
npx @proagentstore/cli publish
```

### SDK
```typescript
import { initPro } from '@proagentstore/sdk'

const agent = initPro({ agentId: 'your-id', token: 'your-token' })
const { response } = await agent.chat('Hello!')
```

### Embed widget
```html
<script src="https://proagentstore.online/widget.js"
  data-agent="chatbot" data-theme="dark"></script>
```

### MCP
```bash
npx mcp-remote https://mcp.proagentstore.online/mcp
```

MCP has two runtime modes:

- `chat_with_agent` calls the public trial endpoint. Use it for discovery and smoke tests.
- `subscribe_agent` creates your private instance, then `chat_with_instance` runs that instance with your own state, knowledge, and caller-provided AI credentials.

Typical user run:

```text
list_agents -> subscribe_agent -> my_instances -> add_instance_knowledge -> chat_with_instance
```

The expected response when user-owned AI credentials are missing is:

```text
Add your Cloudflare Workers AI account ID and API token before running this agent.
```

That means the instance runtime path is working and correctly refusing to bill the platform AI account. See [MCP Instance Runtime](docs/mcp-instance-runtime.md) for the full tool map, live test record, and OAuth troubleshooting.

### Skills and plugins

ProAgentStore publishes skills through platform-specific plugin marketplaces so users can find them from both Codex and Claude Code.

Codex:

```bash
codex plugin marketplace add ProAgentStore/platform
```

Claude Code:

```text
/plugin marketplace add ProAgentStore/platform
/plugin install proagentstore@proagentstore
/reload-plugins
```

See [Skill Publishing](docs/skill-publishing.md) for the publishing layout, marketplace files, and dual Codex/Claude release checklist.

Public discovery pages:

- https://proagentstore.online/skills/
- https://proagentstore.online/skills/proagentstore-mcp-operator/
- https://proagentstore.online/llms.txt
- https://proagentstore.online/llms-full.txt
- https://proagentstore.online/skills.json

## Flagship agents

| Agent | Type | Description |
|---|---|---|
| site-monitor | Worker | Hourly URL change detection + webhook alerts |
| lead-qualifier | Agent | AI lead scoring from webhook submissions |
| content-pipeline | Worker | Daily AI content generation to R2 |
| competitor-intel | Worker | Daily competitor tracking + AI briefings |
| support-escalator | Agent | Ticket triage + auto-response + daily summary |

## Part of the FreeStore ecosystem

| Store | URL | Product |
|---|---|---|
| FreeAppStore | freeappstore.online | PWA apps |
| FreeGameStore | freegamestore.online | Browser games |
| FreeWebStore | freewebstore.online | AI-built sites |
| FreeAgentStore | freeagentstore.online | Browser AI tools |
| ProAppStore | proappstore.online | Paid apps |
| **ProAgentStore** | **proagentstore.online** | **Server AI agents** |

## License

MIT
