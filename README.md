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
├── packages/browser-runner/ ProAgentStore Playwright + terminal/coding runtime bundled into the CLI
├── workers/api/      Hono API worker (auth, agents, instances, coding, apply, keys, analytics)
├── workers/host/     Marketing site + console + widget
├── workers/mcp/      MCP server for Codex, Claude Code, Cursor, and VS Code
├── store/            Source HTML for all pages
├── skills/           Open Agent Skills source files
├── plugins/          Codex and Claude plugin wrappers
├── agents/           Tier-0 first-party agent sources kept in this repo
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
- [MCP](platform-docs/mcp.md)
- [server.json](server.json)
- [.mcp.json](.mcp.json)
- [AGENTS.md](AGENTS.md)

MCP safety is enforced server-side. OAuth supports `read`, `write`, `runtime`, and `destructive` scopes; `MCP_READ_ONLY=1` forces read-only mode; mutating tools support `dry_run` where useful; overwrite/destructive tools require exact `confirm` values; and `mcp_audit_log` exposes recent MCP write, runtime, dry-run, denied, and destructive events.

## Architecture

The current system map, runtime boundaries, data ownership rules, risk assessment, and refactor roadmap live in [Architecture](docs/architecture.md).

### Browser runtime (`pags up`)

Browser- and coding-capable agents use PAGS as the control-plane brain and a local **ProAgentStore browser runtime** (`runtimePlane: "pags"`, Playwright + terminal/coding capabilities, bundled into the CLI) as the hands. One public package, one command — no monorepo and no tunnel binary.

```text
PAGS control plane / MCP / Workflows
  -> task, auth, approval, audit, the LLM brain
ProAgentStore browser runtime (pags up)
  -> Playwright, local files, real browser profile, terminal/coding engines
Real browser / real repo
  -> job boards, uploads, receipts, coding sessions
```

```bash
npm i -g @proagentstore/cli
pags login
pags up            # one runner for every active runtime-capable instance
```

`pags up` is the canonical runner: **one process serves every active instance whose `capabilities.runtime` is non-null**. Cloud-only chat/RAG/connector agents (`runtime: null`) are skipped — they never need a local runner.

Membership is **live**, not a startup snapshot. `pags up` passes `--watch-instances` (CLI ≥ 0.4.30), so the runner re-reads `/v1/instances/my/instances` every 20s and attaches newly eligible agents — and detaches ones that stopped being eligible — without a restart. Subscribing to a coding agent while the runner is up just works. (Polling, not push: a brand-new instance has no socket to push over; #83 tracks the push path.) A scoped `pags up --instance <id>` deliberately does *not* watch — it means that one agent and nothing else.

Transport is a **WebSocket relay**: the runner connects outbound to a per-(instance, node) `RelayDO` — no cloudflared, no public server, no inbound port. Cloud -> `callRunner()` -> `RelayDO` -> WebSocket -> runner. There is no `--tunnel` flag or tunnel fallback in the current CLI. The runner mints a short-lived, instance-scoped relay token for the handshake; the 30-day account JWT is never put in the WebSocket URL.

- Coder can run multiple machines against the same instance at once. Each coding session is pinned to the runner node that owns it; different repos can run on different machines concurrently.
- `pags up --force` — replace the current relay socket when debugging stale local connections
- `pags up --instance <id>` — pin to one agent (debug)
- `pags up --headless` — headless mode

The job-application agent runs on this runtime via the LLM-driven apply pipeline below, not a legacy fixed runtime task: `POST /v1/instances/:id/apply { url, resumePath }` starts `JobApplyWorkflow`, which drives the runtime's `/browser/snapshot` + `/browser/act` endpoints. The **Coder** agent runs its chosen engine (Claude Code, Codex, Gemini CLI, Grok, or a local command) on the session's assigned runner node; Claude uses a persistent structured session, while other engines run one-shot turns.

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

See [Skill Publishing](platform-docs/skill-publishing.md) for the publishing layout, marketplace files, and dual Codex/Claude release checklist.

Public discovery pages:

- https://proagentstore.online/skills/
- https://proagentstore.online/skills/proagentstore-mcp-operator/
- https://proagentstore.online/llms.txt
- https://proagentstore.online/llms-full.txt
- https://proagentstore.online/skills.json

## Catalog agents

### Where the catalog actually lives

**The authoritative catalog is the `agents` table in D1**, read through `GET /v1/agents`. Nothing
in this repo is a mirror of it. A file in this repo is either a *source* for one catalog row or
it is not part of the catalog at all — those are different things, and conflating them is what
this section exists to prevent.

| Source | What it is | Authority |
|---|---|---|
| `agents` table in D1 | Every published agent, its capabilities, settings schema and pipelines. | **Authoritative.** Read `GET /v1/agents`, or the MCP `list_agents` tool. |
| `workers/api/migrations/*seed*.sql` | How a first-party agent gets *into* that table on a fresh database. Idempotent `INSERT OR IGNORE`. | Authoritative for the agents it seeds. Editing a seed does not change an already-seeded row — that needs a follow-up `UPDATE` migration. |
| `agents/<slug>/agent.json` | The manifest for a **Tier-0** agent whose code the platform itself builds or imports. | Source only. It does **not** create a catalog row. |
| `store/registry.json` | Dead. See below. | None. |

An agent can therefore be in the catalog with no file in this repo, and have a folder here with
no separate catalog row of its own. Both are normal.

### Tier-0 agents — the only ones with source in this repo

`agents/` holds exactly three, enforced in CI by `scripts/check-agents-allowlist.mjs`:

| Folder | Why it is Tier-0 |
|---|---|
| `agents/coder` | `agents/coder/web` is a pnpm workspace member imported by the console. |
| `agents/job-application-assistant` | Manifest for the apply agent. (Its `src/` Worker is legacy and undeployed — see that folder's README.) |
| `agents/repo-chat` | Reference source for the Repo Chat agent. |

Everything else is a standalone org repo under [ProAgentStore](https://github.com/ProAgentStore),
cloned locally to `~/dev/stores/pags/agents/<slug>/`. Adding a fourth folder here fails CI on
purpose (epic #50) — the monorepo previously accumulated ten stale vendored copies that were
never built or deployed.

### What ships today

13 agents are published. Grouped by where each one comes from:

**Seeded by a migration** — reproducible on a fresh database:

| Slug | Name | Seed | Source in repo |
|---|---|---|---|
| `coder` | Coder | `0021` | `agents/coder` |
| `repo-chat` | Repo Chat | `0032` | `agents/repo-chat` |
| `site-builder` | Small Business Website Builder | `0057` | none — fully declarative (`lib/pipelines/*.json`) |
| `coder-repo` | Repo Coder | `0063` | none — declarative capabilities |
| `coder-lead` | Coder Lead | `0063` | none — declarative capabilities |
| `local-repo-chat` | Local Repo Chat | `0066` | none — declarative capabilities |
| `tmux-operator` | tmux Operator | `0072` | none — declarative capabilities |

**Created through the API/console by the operator** — they exist only as D1 rows, so a fresh
database will not have them. Treat this as known drift, not a design:

| Slug | Name | Notes |
|---|---|---|
| `job-application-assistant` | Job Application Assistant | Manifest in `agents/`, but no seed migration. Migration `0022` only *updates* its capabilities if the row already exists. |
| `language-buddy` | Language Buddy | Migration `0041` sets its `settingsSchema` if present; it does not create it. |
| `doc-chat` | Doc Chat | |
| `small-business-website-lead-finder` | Small Business Website Lead Finder | Standalone org repo, cloned to `pags/agents/`. |
| `lead-outreach-tj6qrr` | Lead Outreach Assistant | The middle link of the lead chain. |
| `facebook-friend-confirmer` | Facebook Friends | Browser-runtime agent. |

The three-agent lead chain is `small-business-website-lead-finder` → `lead-outreach-tj6qrr` →
`site-builder`, wired with `agent_connections` rather than code.

Publishing is gated: `PUT /v1/agents/:id` and `POST /v1/batch/bulk-visibility` both refuse to
publish a smoke-test fixture (#65, #64), which is what stopped the catalog from re-accumulating
the 16 fixtures and scaffold seeds an audit removed.

### `store/registry.json` is intentionally empty

It is the input to `store/build-details.js`, a static agent-detail-page generator. Neither is
wired to anything: `build-details.js` has no `package.json` script and no CI workflow calls it.
Agent detail pages are served dynamically at `/agents/:slug/` from `GET /v1/public/agents/:id`.
The file is kept as an empty stub so the dead generator does not crash if someone runs it. It is
**not** a public discovery artifact — for that, use `GET /v1/agents`, `store/llms.txt`, or
`store/skills.json`.

### Agents removed from this list

Earlier revisions of this README listed ten agents — `site-monitor`, `lead-qualifier`,
`content-pipeline`, `competitor-intel`, `support-escalator`, `data-analyst`, `meeting-notes`,
`seo-auditor`, `invoice-parser`, `email-drafter`. They were vendored seed copies under `agents/`,
removed in platform `main` commit `f9980a8`. None of them has a seed migration or a published
catalog row today. Do not re-add them here.

One of them survives as a lookup key, not as an agent: the seed migrations resolve the operator
account with `SELECT owner_id FROM agents WHERE slug = 'data-analyst' AND owner_id LIKE 'google:%'`.
That is a way to find the operator's user id on the production database, and it falls back to
`'system'`. It does not mean `data-analyst` is a catalog agent.

### Other capabilities

- **Two-way voice** in the **Assistant** chat and the **Coder Co-pilot** (shared `useVoice` hook) — pick **Dictation** (browser, real-time live words) or **Whisper** (OpenAI via the key proxy, most accurate) STT; browser or OpenAI TTS with a voice/speed picker; a single segmented **Chat · Tap-to-talk · Hands-free** mode control (Mute is a Hands-free sub-control; icon-only on mobile); a spoken **"repeat"** command; and **double-tap any voice message to replay its saved recording** (R2, per-turn). Adaptive VAD + pause/sensitivity/language settings; iOS gesture handling.
- **First-class Markdown documents** in Knowledge — create/read/edit; the agent reads and updates them via the Assistant.
- **Observability** — browser + server errors flow to a durable log (`client:voice*`, `keys-proxy`, `job-apply`, …) surfaced via MCP `list_errors`; a unified per-run timeline via `agent_events` + MCP `agent_trace`.
- **Agent-configurable work board** — one board per instance; columns are declared per agent (`capabilities.boardColumns`), one card per job, with move / retry / attempts. Driven from MCP via `instance_board`. (Replaces the old two-board / "runtime board" design.)

## Developing

### Tests — two projects, not one pool

`pnpm test` runs everything. Underneath it is split (`vitest.config.ts`):

| Project | What | How it runs |
|---|---|---|
| `unit` | ~3100 tests, pure functions and mocked I/O | parallel fork pool |
| `integration` | `packages/browser-runner/**` — a real Chrome per test over CDP, bound sockets, spawned tmux panes, real `git clone` | one file at a time, after `unit`, alone |

Ten tests in `integration` take longer than the other ~3100 combined. They are also the
only ones people see flake locally — so it is worth being precise about why.

```bash
pnpm test               # both, integration last and alone
pnpm test:unit          # the fast ~3100 — what you want in a tight loop
pnpm test:integration   # the real-browser / real-socket set
```

**These tests are sensitive to CPU availability, not to anything in the code under test.**
There is no race, no port collision, no leaked browser between files. Every failure ever
observed was `Test timed out in Nms` on code that passes whenever the machine is quiet.
Measured: the same passing browser test took 11.4s alone, 20.6s inside the suite, and 39.3s
with a second full suite running beside it. And when the box was fully saturated, the run
that failed failed in `rate-limit.test.ts`, `publish.test.ts` and `storage-tools.test.ts` —
three *pure unit* files with no browser and no socket in them. Browser tests starve first
because they are the heaviest, not because they are browser tests.

So if this flakes for you, do not weaken an assertion — look at what else is running.
CI is not affected and never has been: it executes the suite alone on a dedicated runner,
which is exactly why it is green. The split exists for the shared dev machine, and mostly
to give real-I/O tests a timeout budget sized for real I/O instead of vitest's 5s default.

If you add a test that launches a browser or binds a listening socket, put it under
`packages/browser-runner/` so it inherits that budget; `scripts/check-test-isolation.mjs`
fails CI if it lands anywhere else.

> **Orphaned Chromes.** Playwright's cleanup does not run when a test runner is SIGKILLed,
> so aborted runs leave whole browsers behind — measured on this repo's dev machine: 174
> live browser profiles, the oldest 26 hours old, ~1000 processes, load average 190. They
> are invisible and they make every later run slower, which is most of why "flaky" feels
> random. If local tests feel inexplicably slow:
> `ps ax | grep -c playwright_chromiumdev_profile`.

### Docs artifacts — what is a source and what is generated

| Artifact | Status | How to update |
|---|---|---|
| `platform-docs/*.md` | **source** | edit directly; add the page to `nav` in `zensical.toml` |
| `store/docs/**` | **generated, not committed** | `pnpm docs:build`; never hand-edit, never `git add` |
| `store/openapi.yaml` | source | edit when you add or change a route |
| `store/llms.txt`, `store/llms-full.txt` | source | edit by hand; they are what an agent reads first |
| `workers/mcp/README.md` tool table | source | add a row whenever you register a tool |
| `workers/mcp/src/tool-count.ts` | source of truth for the count | bump when you add or remove a tool |

`store/docs` is build output in the same sense as `workers/host/src/pages.ts`: both
`ci.yml` and `deploy-host.yml` run `pnpm docs:build` before anything reads it, so a
committed copy could only ever be stale — and was. Run `pnpm docs:build` once on a fresh
checkout before `pnpm test:e2e` or `node workers/host/build.js`; both read `/docs/*`.

### Drift checks

Prose is the one part of this repo that nothing else validates, so it rots quietly and
then teaches an agent something false. Two commands catch the classes that have actually
bitten us (#209, #210):

```bash
pnpm docs:drift        # nav ↔ pages, MCP tool table + count, removed commands, docs links,
                       # and (delegated) the route/spec check below
pnpm openapi:coverage  # every Hono route is documented or explicitly excluded, and every
                       # documented path resolves to a real handler
```

Both run in CI. When one fails it names the file and the number it expected — fix the docs,
or fix the code they describe, but do not silence a check without moving the thing it was
watching. Deliberately-undocumented routes go in the `EXCLUSIONS` array in
`scripts/openapi-coverage.mjs`, each with a reason.

**When you add a route**, update `store/openapi.yaml` (or add an exclusion).
**When you add an MCP tool**, add its row to `workers/mcp/README.md` and bump
`workers/mcp/src/tool-count.ts` — `index.test.ts` asserts that constant against a real
registration run, and `/health` plus three docs quote it.
**When you add a docs page**, add it to `nav` in `zensical.toml`.

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
