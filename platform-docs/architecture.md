# Architecture

ProAgentStore is a Cloudflare-native marketplace and runtime platform for server-powered AI agents.

## Repository Map

```text
platform/
  workers/
    api/                 Hono API Worker, AgentDO, RelayDO, Workflows
    mcp/                 MCP server and OAuth provider
    host/                Static host for store, console, widget, docs
  store/
    console/             React/Vite console app
    docs/                Zensical-generated public docs
  platform-docs/         Zensical Markdown source for public docs
  packages/
    sdk/                 Browser/client SDK and shared helpers
    cli/                 pags CLI: init, publish, login, mcp, runner
    browser-runner/      Local Playwright/tmux runtime served by `pags up`
    compliance/          Policy/check tooling
  agents/                First-party catalog agents
  templates/             Agent scaffolds
  docs/                  Internal architecture and planning docs
```

## System Context

```text
Browser console / widget
        |
        v
workers/host -------------- static assets, generated docs, widget
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

## Control Plane

The control plane is the Cloudflare-hosted platform:

- `workers/api`: product API, orchestration, auth, connector OAuth, runtime registration, instance lifecycle, billing, analytics, storage routing.
- `workers/mcp`: MCP tool interface with OAuth scopes, confirmation gates, dry-run support, and audit logging.
- `workers/host`: static web host for the store, console, docs, widget, and public assets.

The control plane owns authorization, persistence, durable workflow state, and user-visible operational records.

## State Plane

State is split intentionally:

- D1 stores account, marketplace, instance, runtime, billing, OAuth-token ciphertext metadata, board, events, errors, and workflow/task mirrors.
- Durable Object storage stores per-agent runtime state: messages, memory, knowledge docs, tasks, collections, activity, file metadata, summaries.
- R2 stores binary files and large artifacts.
- Vectorize stores semantic vectors for knowledge and repo/file retrieval.

## Runtime Plane

Runtime-backed agents use `pags up`, which runs a local browser/CLI runtime from `packages/browser-runner`. The runner connects outbound to a per-instance `RelayDO`, so the cloud can call local capabilities without opening inbound ports.

Current runtime-backed surfaces:

- Job Application Assistant: Cloudflare Workflow brain drives Playwright browser actions.
- Coder: Cloudflare Workflow brain drives local CLI sessions in tmux. Coder sessions can route to node-scoped runners when multiple machines are connected to the same instance.

## Docs Plane

Zensical is the standard generator for public platform docs.

```text
platform-docs/*.md -> python3 -m zensical build --strict -> store/docs/**
```

The Host Worker build inlines the generated `store/docs` tree so `/docs/`, `/docs/search.json`, `/docs/assets/...`, and generated article pages are served from the same Worker as the main site.
