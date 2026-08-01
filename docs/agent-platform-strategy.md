# Agent platform strategy — how to scale to user-built agents without spaghetti

> **Status:** strategy / future direction, captured 2026-06-26. **Not now.**
> Current sequencing (owner): (1) make the existing agents work, (2) add another
> agent, (3) *then* open the platform for user agent development. This doc is the
> target for phase 3. See `cloudflare-agent-stack-2026.md` for the CF primitives.

## The problem

PAGS today has three coexisting agent patterns:

1. **Standalone-worker agents** (`site-monitor`, `lead-qualifier`, …) — each a deployed
   CF Worker, self-contained with its own `deploy.yml`. These live in their **own
   `ProAgentStore/<slug>` repos**, NOT the monorepo (the duplicate `agents/*` copies
   were removed 2026-08-01 — see the "agents live outside the monorepo" epic). Clone
   locally to `~/dev/stores/pags/agents/<slug>/`.
2. **Runtime-backed agents** (Coder, Job Application Assistant) — logic woven into
   the platform core (`workers/api`, `packages/browser-runner`, `store/console`),
   scattered by layer. Fine for a *handful of first-party* agents; **does NOT
   scale** to a marketplace — every new one is a PR to the monorepo, the deploy
   pipeline, the review + security surface. This is the spaghetti risk.
3. **Config/data agents** — identity + prompt + guardrails + KB + platform tools,
   stored in D1/DO (the `agents` table, `AgentDO`). No code. (`create_agent` via
   console/MCP.)

The goal: let **creators build agents**, **users subscribe + pay by usage**, at
scale, without creator code ever entering the platform monorepo.

## The one principle

**The monorepo holds the *platform only*** (runtime, tools, brain, marketplace,
billing). **Creator agents are either data or isolated code — never woven into the
core.** The capability registry (`lib/agent-capabilities.ts`) is the seed of this
boundary. First-party runtime agents (Coder/apply) are the rare core-resident
exception.

## The tiered model

### Tier 1 — Config/data agents (the default, ~90%)
Pure config + KB + a **declared set of platform tools** (collections, files, vector
search, fetch_url, email, webhooks, cron, the browser runner, the coding runner).
**All data in D1/DO — no code, no commit, no deploy.** Scales infinitely (rows, not
files), isolates per-instance DO, meters per execution/token.
**Build:** formalize a declarative agent schema (extend `agents.config.capabilities`
into identity/prompt/guardrails/tools[]/model/surfaces/runtime) + a shared
multi-tenant runtime (the `AgentDO` chat loop is ~80% there). Possibly **Code Mode**
for tool execution.

> **Progress (2026-08): mostly landed.** `agents.config.capabilities` now carries a
> declared `tools[]` allowlist against a data-driven `TOOL_CATALOG` (PR #59); the formal
> a formal `AgentDefinition`/`sanitizeAgentDefinition` was prototyped (PR #62) but **removed
> as premature dead code** — nothing wired it; rebuild it alongside the create/update route
> when that's actually done. And
> `repo-chat` is the first agent that declares its tools as data (PR #61). Remaining:
> wire create/update to a full definition + converge onto the shared runtime.

### Tier 2 — Code agents via Dynamic Workers (the "write on the fly" path)
When an agent needs custom logic, the creator (or **Coder itself**) writes code that
runs **isolated** — via **Dynamic Workers (Worker Loader API)**, NOT the monorepo:
- Store the source in D1/R2; hand the string to the loader at runtime → isolated V8
  sandbox in ms, with **scoped per-tenant bindings** and **server-side secret
  injection** (creator code never sees platform/other-tenant secrets).
- No deploy step → the "write an agent just like that, no commit" UX, safely.
- CF meters per unique Worker → clean usage data for payouts.
- Use **Workers for Platforms** instead only when a creator wants a *managed,
  deployed, custom-domain* Worker.

> **Security:** "code in the DB" must mean *stored source → loaded into an isolated
> Dynamic Worker*, NEVER `eval()` inside the platform worker (that would run creator
> code with platform bindings/secrets).

### Tier 0 — First-party runtime agents (Coder, apply)
Small, platform-team-owned, deep runtime integration; live in the core, gated by the
capability registry. Over time, converge toward the shared agent runtime so
"first-party" stops meaning "special-cased."

## Create → use → pay

The PAS economic model exists (single $5/mo platform sub; creators paid by **usage
share**, Spotify-style — `pas/platform/STRATEGY.md`). PAGS billing is deferred for
now; when enabled later, the missing plumbing is **per-agent metering**
(executions/tokens — `usage`/`agent_executions` tables exist; Dynamic Workers/WfP
add per-Worker analytics) → monthly Stripe Connect payout split. Works identically
for Tier 1 and Tier 2.

## The flywheel

Tier 1 makes creation trivial + safe by default; Tier 2 makes it unlimited + still
safe; **Coder closes the loop** — a creator describes an agent in plain language →
Coder writes the code → the platform loads it as a Dynamic Worker → it's in the
marketplace. Agents building agents.

## Phase-3 build order (when we get there)

1. Declarative agent-definition schema + shared multi-tenant runtime → Tier 1 default.
2. Creator authoring UI (console) for config agents — no code.
3. **Dynamic Workers** integration: load creator/AI code from D1/R2 with scoped
   bindings + per-agent metering → Tier 2; payout via Stripe Connect.
4. Cleanup: make apply manifest-only like Coder; migrate both first-party agents
   onto the shared runtime so the core stops growing per agent.
