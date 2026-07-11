# ProAgentStore Architecture

This document is the current architecture map and assessment for the ProAgentStore
platform repo. It is intended to be the first place to look before changing core
runtime, storage, MCP, console, connector, or agent infrastructure.

Status: current as of 2026-07-11.

## Executive Summary

ProAgentStore is a Cloudflare-native marketplace and runtime platform for
server-powered AI agents. The main product loop is:

1. Creators publish agent templates.
2. Users subscribe to private agent instances.
3. Instances keep user-specific state, knowledge, memory, credentials, and
   runtime tasks.
4. The API, MCP server, console, and local runner all operate on the same
   instance model.

The architecture is strong in three areas:

- Clear separation between template agents and private user instances.
- Cloudflare primitives are used well for the product shape: Workers for HTTP,
  Durable Objects for per-agent state, Workflows for long-running brains, D1 for
  account metadata, R2 for blobs, Vectorize for RAG, and WebSockets for local
  runner relay.
- The MCP surface is not a sidecar. It is a first-class control surface that uses
  the same API and safety model as the console.

The biggest architectural risk is accretion. The platform has grown from store,
chat, MCP, browser automation, coding, voice, connectors, billing, and
observability into one large API worker and one large console tab structure.
The next phase should focus on extracting shared platform services without
abstracting away agent-specific domain logic.

## Repository Map

```text
platform/
+-- workers/
|   +-- api/                 Hono API Worker, AgentDO, RelayDO, Workflows
|   +-- mcp/                 MCP server and OAuth provider
|   +-- host/                Static host for store, console, widget, docs
+-- store/
|   +-- console/             React/Vite console app
+-- packages/
|   +-- sdk/                 Browser/client SDK and shared UI/voice helpers
|   +-- cli/                 pags CLI: init, publish, login, mcp, runner
|   +-- browser-runner/      Local Playwright/tmux runtime served by `pags up`
|   +-- compliance/          Policy/check tooling
+-- agents/                  First-party catalog agents
+-- templates/               Agent scaffolds for worker, cron, api templates
+-- docs/                    Architecture, runtime, MCP, and strategy docs
+-- assets/                  Store-facing assets
```

## System Context

```text
Browser console / widget
        |
        v
workers/host -------------- static assets, docs, widget
        |
        v
workers/api --------------- auth, agents, instances, runtime, connectors
  |      |      |      |
  |      |      |      +-- D1: users, agents, instances, runtime rows, billing
  |      |      +--------- R2: files, media, screenshots, agent assets
  |      +---------------- Vectorize: knowledge embeddings
  +----------------------- Durable Objects: AgentDO, RelayDO
           |
           +-- Workflows: JobApplyWorkflow, CodingSessionWorkflow

MCP clients
        |
        v
workers/mcp --------------- OAuth + tool surface, calls workers/api

Local machine
        |
        v
packages/browser-runner ---- Playwright browser, tmux CLIs, local files
        ^
        |
RelayDO WebSocket relay ---- outbound runner connection, no inbound tunnel
```

## Runtime Planes

### Control Plane

The control plane is the Cloudflare-hosted platform:

- `workers/api`: product API, orchestration, auth, connector OAuth, runtime
  registration, instance lifecycle, billing, analytics, storage routing.
- `workers/mcp`: MCP tool interface with OAuth scopes, confirmation gates,
  dry-run support, and audit logging.
- `workers/host`: static web host for the store, console, docs, widget, and
  public assets.

The control plane is responsible for authorization, persistence, durable
workflow state, and user-visible operational records.

### State Plane

State is split intentionally:

- D1 stores account, marketplace, instance, runtime, billing, OAuth-token
  ciphertext metadata, board, events, errors, and workflow/task mirrors.
- Durable Object storage stores per-agent runtime state: messages, memory,
  knowledge docs, tasks, collections, activity, file metadata, summaries.
- R2 stores binary files and large artifacts.
- Vectorize stores semantic vectors for knowledge and repo/file retrieval.

This split is sensible. D1 is used for relational product state and cross-object
queries. Durable Objects own instance-local mutable state. R2 and Vectorize are
used only where their storage shape fits.

### Runtime Plane

Runtime-backed agents use `pags up`, which runs a local browser/CLI runtime from
`packages/browser-runner`. The runner connects outbound to a per-instance
`RelayDO`, so the cloud can call local capabilities without opening inbound
ports.

Current runtime-backed surfaces:

- Job Application Assistant: Cloudflare Workflow brain drives Playwright browser
  actions.
- Coder: Cloudflare Workflow brain drives local CLI sessions in tmux.

The key architectural pattern is "brain in cloud, hands local":

```text
Workflow brain -> callRunner() -> RelayDO -> WebSocket -> local runner -> browser/tmux
```

## API Worker

Primary files:

- `workers/api/src/index.ts`
- `workers/api/src/types.ts`
- `workers/api/src/agent-do.ts`
- `workers/api/src/relay-do.ts`
- `workers/api/src/workflows/job-apply.ts`
- `workers/api/src/workflows/coding-session.ts`
- `workers/api/migrations/*.sql`

The API worker is a Hono app. It mounts route modules for:

- Auth and profiles: `/v1/auth`, `/v1/profile`
- Agents: `/v1/agents`, versions, analytics, exports, public trials
- Instances: `/v1/instances`
- Instance storage: documents, files, collections, search, activity, summaries
- Runtime: `/v1/relay`, runtime registration/status/task mirrors
- Coding: `/v1/instances/:id/coding/...`
- Connectors: Gmail, Google Drive, Zoho WorkDrive
- Keys: BYOK key vault and key proxy
- Billing, notifications, push, dashboard, errors

The worker also exports:

- `AgentDO`: per-agent/per-instance state and chat runtime.
- `RelayDO`: WebSocket relay between cloud and local runtime.
- `JobApplyWorkflow`: durable job application browser brain.
- `CodingSessionWorkflow`: durable coding-session brain.

### Assessment

What is good:

- Route modules are mostly well-scoped.
- Runtime state is not forced into D1 when DO storage is the right owner.
- Workflows are used for long-running apply/coding flows instead of trying to
  stretch request lifetimes.
- Rate limits are explicit in the API entrypoint.
- Connector tokens are encrypted through the key vault instead of stored raw.

What needs attention:

- `workers/api/src/index.ts` is now a central registry for too many unrelated
  product areas. This is still workable, but every cross-cutting middleware or
  route addition raises blast radius.
- OAuth connector routes duplicate state-signing, refresh-token storage,
  status, disconnect, and import-to-knowledge flow.
- Runtime-backed agent logic is split across routes, workflow files, runner
  client helpers, board/task mirrors, and console surfaces. The boundaries are
  correct, but there is no single typed "runtime task service" yet.
- `AgentDO` has grown into a large multi-capability object. It owns chat,
  memory, tasks, knowledge, files, repo ingest, collections, summaries, vector
  search, and activity. That is the correct owner for instance-local state, but
  the implementation should be decomposed internally.

## AgentDO

`AgentDO` is the stateful per-agent runtime. It handles:

- HTTP chat and WebSocket chat.
- Messages and summaries.
- Memory.
- Tasks.
- Markdown knowledge documents.
- URL and repo ingestion.
- Collections and records.
- Files and file registration.
- Vector search.
- Activity logs.
- State/config updates.

Storage is mediated by `AgentStorageEngine`, with:

- DO storage as the primary source of truth.
- R2 for large blobs.
- Vectorize for semantic retrieval.
- Optional platform-paid Workers AI for embeddings/summaries when
  `PLATFORM_AI_ENABLED=true`.

### Assessment

The DO boundary is strategically correct: instance-local mutable state belongs
close to the agent. The issue is implementation size, not ownership. A good next
step is to split handlers into internal modules grouped by state area while
leaving `AgentDO` as the HTTP router and authority.

Recommended internal split:

- `agent-do-chat.ts`
- `agent-do-knowledge.ts`
- `agent-do-files.ts`
- `agent-do-collections.ts`
- `agent-do-repo.ts`
- `agent-do-activity.ts`

Do not move state ownership to D1 just to make the file smaller.

## MCP Worker

Primary files:

- `workers/mcp/src/index.ts`
- `workers/mcp/src/oauth-provider.ts`
- `workers/mcp/src/safety.ts`
- `workers/mcp/src/instance-tools.ts`
- `workers/mcp/src/storage-tools.ts`
- `workers/mcp/src/repo-tools.ts`

The MCP worker exposes a browser-authenticated MCP server. It calls the API
worker for actual product operations. Tool safety is enforced through:

- OAuth scopes: read, write, runtime, destructive.
- Read-only environment mode.
- Confirmation requirements for destructive operations.
- Dry-run support where useful.
- MCP audit logging.

### Assessment

This is a strong boundary. MCP should remain a facade over platform APIs, not a
second implementation of business logic. The current direction is good.

Areas to watch:

- Tool registration is already large and will keep growing.
- Agent-specific tools are gated by instance capabilities. This is the right
  model, but the capability data must stay accurate in D1 and seed migrations.
- Keep all write/destructive checks in `safety.ts` or a successor policy module,
  not scattered inside individual tools.

## Console

Primary files:

- `store/console/src/*`
- `store/console/src/tabs/*`
- `store/console/src/components/*`
- `packages/sdk/src/*`

The console is a React/Vite app. It uses the SDK client to call `workers/api`.
Shared UI/voice helpers live in `packages/sdk`.

Major surfaces:

- Agent/instance list and store flows.
- Chat and voice.
- Knowledge: docs, memory, files, vectors, credentials, rules.
- Settings: runtime, voice, translation, connectors, billing-ish operations.
- Board and runtime task UX.
- Coder surface.
- Apply surface.

### Assessment

The console has become the fastest-growing part of the system. The UX is
feature-rich, but tab files now contain provider-specific state, connector
panels, runtime controls, and domain logic in the same component tree.

Highest-value refactors:

- Extract connector panels from `KnowledgeTab` and `SettingsTab`.
- Extract a `ConnectorStatusRow` component for Gmail, Google Drive, and
  WorkDrive.
- Extract provider import panels:
  - `DriveImportPanel`
  - `WorkDriveImportPanel`
  - future connectors should plug into the same interface.
- Keep domain-specific surfaces separate from shared tabs. Apply, Coder, and
  future runtime-backed agents should own their specialized panels.

## CLI and Browser Runner

Primary files:

- `packages/cli`
- `packages/browser-runner`

The CLI is both creator tooling and runtime tooling:

- `pags login`
- `pags up`
- agent scaffolding and publishing
- MCP proxy helpers

The browser runner provides:

- Playwright browser control.
- Runtime task endpoints.
- CAPTCHA/handoff support.
- File upload support.
- tmux-backed coding sessions.
- Terminal capture and action execution.

### Assessment

The outbound relay design is the right choice. It avoids tunnel setup for the
normal path and supports one runner serving multiple instances.

Operational risk:

- Browser-runner tests are currently flaky/slow in the local full suite. The
  root `pnpm test` run on 2026-07-11 failed in unrelated browser-runner timeout
  tests while API/console checks passed. This should be treated as test
  reliability debt, not as connector risk.
- The runner is a critical dependency for flagship agents. Add a lightweight
  deterministic smoke test that does not depend on full browser interaction.

## Data Model

The D1 schema is migration-based. Important table groups:

- Identity and marketplace:
  - `users`
  - `agents`
  - `agent_versions`
  - `agent_instances`
  - `subscriptions`
- Runtime:
  - `instance_runtimes`
  - `instance_runtime_tasks`
  - `instance_runtime_task_events`
  - `board_items`
  - `agent_events`
- Credentials and connectors:
  - `user_api_keys`
  - `agent_credentials`
  - key-proxy usage tables
- Coding:
  - `coding_repos`
  - `coding_sessions`
  - `coding_timeline`
  - `github_installations`
- Apply:
  - `ats_apply_cache`
  - `user_profile`
- Operations:
  - `usage`
  - `notifications`
  - `push_subscriptions`
  - `error_log`
  - `message_gloss`

### Assessment

The schema reflects the product. The main concern is that runtime task state is
mirrored in multiple places: runner, D1 mirrors, board rows, agent events, and
workflow state. That is acceptable for UX and durability, but it needs a clear
source-of-truth rule.

Recommended source-of-truth rule:

- Durable Workflow owns long-running brain progress.
- Local runner owns immediate browser/tmux execution state.
- D1 `instance_runtime_tasks` is the user-visible mirror and query index.
- `agent_events` is the timeline/audit stream.
- Board rows are presentation and operational workflow state.

Documenting and enforcing this rule will prevent future "which table should I
update?" ambiguity.

## Connectors

Current connectors:

- Gmail: OAuth, email permission toggle, apply-flow email reads.
- Google Drive: OAuth, file search, text/document import into knowledge.
- Zoho WorkDrive: OAuth, folder browsing, paginated import of supported
  text-like files into knowledge.

Connector tokens are stored in `user_api_keys` with encrypted refresh tokens.
OAuth connections are account-level, but Drive/WorkDrive access is narrowed per
agent instance through `instance_connector_grants`. A user connects Google or
Zoho once, then grants individual agent instances access to specific folders.
Folder grants authorize that folder and descendants. Knowledge imports for those
providers must pass through an instance grant before files are copied into that
instance's documents.

### Assessment

The connector model is useful and consistent with the Knowledge product. The
implementation now has an explicit authorization split:

- `user_api_keys`: who connected the external account.
- `instance_connector_grants`: which agent instance may browse/import from which
  external roots.
- Agent knowledge docs: copied content the agent can use after import.

There is still enough OAuth and token-vault duplication to justify a small
shared connector service.

Recommended extraction:

- OAuth state signing and verification.
- Encrypted refresh-token get/upsert/delete/status helpers.
- Connector config status.
- Import-to-knowledge helper.
- Shared "supported text-like import" rules.

Avoid a heavy provider abstraction. Provider APIs differ too much. Share only
the platform mechanics.

## AI and BYOK

The intended billing/security model is:

- User-facing LLM chat and workflow brains use caller-owned credentials.
- Platform-paid Workers AI is gated by `PLATFORM_AI_ENABLED` for internal
  embeddings/summaries.
- Missing caller-owned AI credentials should fail clearly instead of silently
  billing the platform account.

This is architecturally sound and should remain a hard rule.

Risk:

- `PLATFORM_AI_ENABLED=true` in production config is explicitly documented as
  acceptable only while Serge is the sole user. This must be flipped off before
  real multi-user onboarding unless billing and policy intentionally change.

## Security Model

Current protections:

- Session tokens signed with `SESSION_SIGNING_KEY`.
- OAuth tokens encrypted with `KEY_ENCRYPTION_KEY`.
- CORS allowlist.
- Security headers.
- Rate limits, with stricter limits on expensive or sensitive routes.
- SSRF-safe fetch helpers for URL ingestion.
- MCP OAuth scopes and safety gates.
- Key reveal route is rate-limited.
- Runtime endpoint URL validation requires HTTPS except localhost development.

Areas to improve:

- Centralize OAuth connector state helpers and malformed-token handling.
- Add route-level tests for connector auth/ownership paths.
- Make destructive/secret-bearing route policies easier to audit from one file.
- Ensure all imported external text has size, type, and source metadata limits.

## Observability

Observability surfaces:

- `error_log` and `/v1/errors`
- `agent_events`
- runtime task events
- MCP `mcp_audit_log`
- apply/coding timelines
- console-visible activity and board state

What works:

- Errors from workflows and key operations are persisted instead of only logged.
- Unified trace concepts exist through `agent_events`.
- MCP exposes operational readbacks.

What needs improvement:

- Add a standard event taxonomy. Today event names are descriptive but not fully
  governed.
- Add correlation IDs consistently across API request, workflow run, runner
  task, and MCP operation.
- Add a "runbook per failure mode" document for apply, coding, connector OAuth,
  and runner relay.

## Testing and CI

Current checks used during recent WorkDrive work:

- `pnpm --filter proagentstore-api typecheck`
- `pnpm exec vitest run workers/api/src/lib/workdrive.test.ts workers/api/src/lib/drive.test.ts --reporter=verbose`
- `pnpm --filter @proagentstore/console build`
- GitHub CI on PRs

Known issues from local root commands:

- `pnpm test` can fail in unrelated browser-runner timeout tests.
- `pnpm lint` currently fails on existing repo-wide Biome diagnostics outside
  the WorkDrive change.

Assessment:

The API lib tests are useful and fast. Browser-runner integration tests need
isolation or tiering so ordinary platform changes can run a dependable local
suite.

Recommended test tiers:

- Tier 1: typecheck + fast unit tests + console build.
- Tier 2: API route tests and focused workflow pure logic tests.
- Tier 3: browser-runner integration tests.
- Tier 4: end-to-end deployed smoke tests.

## Main Architectural Risks

1. Large API worker surface area

The API worker is still coherent, but it is now the center of auth, marketplace,
runtime, storage, coding, connectors, billing, notifications, and observability.
Mitigation: extract shared service modules inside the worker before adding more
route families.

2. AgentDO implementation size

The DO boundary is correct, but the file should be split internally by state
area. Mitigation: keep the router thin and move handler groups to modules.

3. Console component growth

Settings and Knowledge tabs are accumulating connector and runtime-specific UI.
Mitigation: extract panels and shared connector rows.

4. Runtime task source-of-truth ambiguity

Task data exists in workflow state, runner state, D1 mirrors, board rows, and
events. Mitigation: document and enforce source-of-truth rules.

5. Connector duplication

Gmail, Drive, and WorkDrive have repeated OAuth and token-vault code.
Mitigation: extract small connector mechanics, not provider behavior.

6. Test reliability

Root tests are not currently a crisp go/no-go because browser-runner integration
timeouts can mask unrelated work. Mitigation: split test tiers and stabilize the
browser-runner teardown path.

7. Platform AI switch

`PLATFORM_AI_ENABLED=true` is acceptable for single-user development but risky
for broader onboarding. Mitigation: default off before multi-user launch and add
an operational checklist.

## Recommended Refactor Roadmap

### Immediate

- Extract connector OAuth/token-vault helpers.
- Extract WorkDrive and Drive import panels from `KnowledgeTab`.
- Add route tests for Google Drive and WorkDrive auth/ownership/error paths.
- Add a short runbook for connector setup and OAuth troubleshooting.
- Split CI/test scripts into fast and integration tiers.

### Next

- Split `AgentDO` handler groups into internal modules.
- Introduce a runtime task service with explicit source-of-truth semantics.
- Normalize event names and correlation IDs.
- Extract Settings connector rows into a data-driven component.
- Add a durable workflow/run observability page or MCP summary tool.

### Later

- Move agent-specific surfaces into capability-owned modules.
- Formalize an extension interface for future connectors.
- Add generated schema docs from D1 migrations.
- Add API route inventory generation from Hono route registration.

## Architecture Principles

Use these rules when adding new platform features:

- Keep template agents separate from private instances.
- Keep domain logic inside the agent or workflow that owns the domain.
- Share platform mechanics only after the duplication is proven.
- Durable Object storage owns instance-local mutable state.
- D1 owns relational product state and cross-instance queries.
- R2 owns blobs.
- Vectorize owns semantic retrieval indexes.
- Workflows own long-running brain progress.
- The local runner owns local browser/tmux execution.
- MCP should call platform APIs, not reimplement platform behavior.
- User-facing LLM spend must be BYOK unless the billing model explicitly
  changes.

## Related Docs

- [MCP Instance Runtime](mcp-instance-runtime.md)
- [MCP](mcp.md)
- [Browser-Capable Agent Runtime](browser-capable-agent-runtime.md)
- [Cloudflare Agent Stack 2026](cloudflare-agent-stack-2026.md)
- [Agent Platform Strategy](agent-platform-strategy.md)
- [Coder Cloud vs Local Placement](coder-cloud-vs-local-placement.md)
