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
├── packages/sdk/     Internal TypeScript SDK for agents
├── packages/cli/     @proagentstore/cli — init, check, publish, MCP proxy, local runtime
├── packages/browser-runner/ ProAgentStore Playwright + tmux runtime bundled into the CLI
├── workers/api/      Hono API worker (auth, agents, instances, coding, apply, keys, analytics)
├── workers/host/     Marketing site + console + widget
├── workers/mcp/      MCP server for Codex, Claude Code, Cursor, and VS Code
├── store/            Source HTML for all pages
├── skills/           Open Agent Skills source files
├── plugins/          Codex and Claude plugin wrappers
├── agents/           13 catalog agents (10 flagship + job-application-assistant, coder, repo-chat)
└── templates/        Agent scaffolding (worker, cron, api)
```

## Agent types

| Type | Template | What it does |
|---|---|---|
| **Agent** | `worker` | Full AI: conversation, memory, knowledge base, core tools, Workers AI |
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
codex mcp add proagentstore --url https://mcp.proagentstore.online/mcp
codex mcp list
# If the server shows "Not logged in":
codex mcp login proagentstore

claude mcp add --transport http proagentstore https://mcp.proagentstore.online/mcp
claude mcp list

npx mcp-remote https://mcp.proagentstore.online/mcp
npx @proagentstore/cli mcp
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

The full MCP-first developer surface is documented at:

- https://proagentstore.online/docs/mcp/
- [docs/mcp.md](docs/mcp.md)
- [server.json](server.json)
- [.mcp.json](.mcp.json)
- [AGENTS.md](AGENTS.md)

MCP safety is enforced server-side. OAuth supports `read`, `write`, `runtime`, and `destructive` scopes; `MCP_READ_ONLY=1` forces read-only mode; mutating tools support `dry_run` where useful; overwrite/destructive tools require exact `confirm` values; and `mcp_audit_log` exposes recent MCP write, runtime, dry-run, denied, and destructive events.

## Architecture

The current system map, runtime boundaries, data ownership rules, risk assessment, and refactor roadmap live in [Architecture](docs/architecture.md).

### Browser runtime (`pags up`)

Browser- and coding-capable agents use PAGS as the control-plane brain and a local **ProAgentStore browser runtime** (`runtimePlane: "pags"`, Playwright + tmux, bundled into the CLI) as the hands. One public package, one command — no monorepo, no tunnel binary in the default path.

```text
PAGS control plane / MCP / Workflows
  -> task, auth, approval, audit, the LLM brain
ProAgentStore browser runtime (pags up)
  -> Playwright, local files, real browser profile, tmux CLIs
Real browser / real repo
  -> job boards, uploads, receipts, coding sessions
```

```bash
npm i -g @proagentstore/cli
pags login
pags up            # one multiplexed runner for ALL your instances on this machine
```

`pags up` is the canonical runner: **one process serves every active instance on that machine**. It defaults to a **WebSocket relay** (the runner connects outbound to a per-instance or node-scoped `RelayDO` — no cloudflared, no public server, no inbound tunnel). Cloud → `callRunner()` → `RelayDO` → WebSocket → runner. Cloudflared tunnels remain only as a legacy `--tunnel quick|named` option.

- Coder can run multiple machines against the same instance at once. Each coding session is pinned to the runner node that owns it; different repos can run on different machines concurrently.
- `pags up --force` — replace the current relay socket when debugging stale local connections
- `pags up --instance <id>` — pin to one agent (debug)
- `pags up --headless` — headless mode

The job-application agent runs on this runtime via the LLM-driven apply pipeline below (not a fixed `job.apply_basic` task): `POST /v1/instances/:id/apply { url, resumePath }` starts `JobApplyWorkflow`, which drives the runtime's `/browser/snapshot` + `/browser/act` endpoints. The **Coder** agent runs its chosen CLI (Claude Code / Codex / Grok) in a tmux pane on the session's assigned runner node.

### Job application agent (LLM-driven apply)

The flagship apply flow: a **Brain** (Cloudflare Workflow `JobApplyWorkflow`, using the user's BYOK Claude) drives the **Hands** (the local browser runtime) to fill and submit a real application — snapshot the ARIA tree → pick one action → act → repeat. Durable + resumable (escapes the 30s Worker limit). Retry + attempt tracking per job. Three human-in-the-loop handoffs share one pause/resume machine: **captcha** (solve in a live takeover, auto-resumes), **stuck** (do one step + Resume), **needs_input** (supply a value → saved to Profile → resumes). Per-ATS tips are cached and fed back next run; "Open in Gmail" surfaces confirmation links. `dryRun:true` fills everything but a workflow-level guard blocks the final Submit click.

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

## Catalog agents

13 first-party agents ship in the catalog: 10 flagship + three headliners (job-application-assistant, Coder, Repo Chat).

| Agent | Type | Description |
|---|---|---|
| site-monitor | Worker | Hourly URL change detection + webhook alerts |
| lead-qualifier | Agent | AI lead scoring from webhook submissions |
| content-pipeline | Worker | Daily AI content generation to R2 |
| competitor-intel | Worker | Daily competitor tracking + AI briefings |
| support-escalator | Agent | Ticket triage + auto-response + daily summary |
| data-analyst | Agent | CSV upload → natural-language SQL queries |
| meeting-notes | Agent | Transcript → summary + action items + daily digest |
| seo-auditor | Worker | Daily page crawl → AI scores 0-100 + regressions |
| invoice-parser | Tool | POST text → structured JSON extraction |
| email-drafter | Agent | Brand-voice KB → AI email drafts |
| **job-application-assistant** | Agent | LLM-driven apply: Brain (`JobApplyWorkflow`) drives the local browser runtime to fill + submit real applications |
| **Coder** (`coder`) | Agent | Multi-CLI coding agent — runs Claude Code / Codex / Grok in tmux via `pags up`; supports multiple connected machines per instance; Engine · Pilot · Co-pilot · Loop · Overseer · Chat |
| **Repo Chat** (`repo-chat`) | Agent | Read-only chat with any GitHub repo(s) — server-side ingest + RAG, no local runner |

### Other capabilities

- **Two-way voice** in the **Assistant** chat and the **Coder Co-pilot** (shared `useVoice` hook) — pick **Dictation** (browser, real-time live words) or **Whisper** (OpenAI via the key proxy, most accurate) STT; browser or OpenAI TTS with a voice/speed picker; labeled **Talk / Speak / Hands-free / Mute** controls (icon-only on mobile); a spoken **"repeat"** command; and **double-tap any voice message to replay its saved recording** (R2, per-turn). Adaptive VAD + pause/sensitivity/language settings; iOS gesture handling.
- **First-class Markdown documents** in Knowledge — create/read/edit; the agent reads and updates them via the Assistant.
- **Observability** — browser + server errors flow to a durable log (`client:voice*`, `keys-proxy`, `job-apply`, …) surfaced via MCP `list_errors`; a unified per-run timeline via `agent_events` + MCP `agent_trace`.
- **Agent-configurable work board** — one board per instance; columns are declared per agent (`capabilities.boardColumns`), one card per job, with move / retry / attempts. Driven from MCP via `instance_board`. (Replaces the old two-board / "runtime board" design.)

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
