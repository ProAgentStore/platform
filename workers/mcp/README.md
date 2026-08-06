# ProAgentStore MCP Server

`proagentstore-mcp` — the authenticated control plane for ProAgentStore. It is a
Cloudflare Worker that exposes the platform's agents, private instances, knowledge,
runtime, and observability as MCP tools.

ProAgentStore is MCP-first: a calling agent should operate account state through this
server rather than scraping the console or calling the REST API directly.

- Endpoint: `https://mcp.proagentstore.online/mcp` (Streamable HTTP)
- Health: `https://mcp.proagentstore.online/health`
- Registry entry: [`server.json`](../../server.json) at the repo root
- Published doc: [`platform-docs/mcp.md`](../../platform-docs/mcp.md)
- Agent-facing contract: [`AGENTS.md`](./AGENTS.md)
- Working in this directory: [`CLAUDE.md`](./CLAUDE.md)

## Connecting

### Claude Code

```bash
claude mcp add --transport http proagentstore https://mcp.proagentstore.online/mcp
claude mcp list
```

### Codex

```bash
codex mcp add proagentstore --url https://mcp.proagentstore.online/mcp
codex mcp list
# If the server shows "Not logged in":
codex mcp login proagentstore
```

### Any MCP client (remote proxy)

```bash
npx mcp-remote https://mcp.proagentstore.online/mcp
```

### stdio-only clients

```json
{
  "mcpServers": {
    "proagentstore": {
      "command": "npx",
      "args": ["-y", "@proagentstore/cli", "mcp"]
    }
  }
}
```

### Project-local config

`.mcp.json`:

```json
{
  "mcpServers": {
    "proagentstore": {
      "type": "streamable-http",
      "url": "https://mcp.proagentstore.online/mcp"
    }
  }
}
```

`.codex/config.toml`:

```toml
[mcp_servers.proagentstore]
url = "https://mcp.proagentstore.online/mcp"
tool_timeout_sec = 120
default_tools_approval_mode = "prompt"
```

### Registry discovery

`server.json` at the repo root is the published MCP registry entry:

```json
{
  "name": "io.github.ProAgentStore/platform",
  "title": "ProAgentStore",
  "remotes": [
    { "type": "streamable-http", "url": "https://mcp.proagentstore.online/mcp" }
  ]
}
```

The same metadata is served at
`https://proagentstore.online/.well-known/mcp-server.json`. Changing `server.json` on
`main` republishes it to the MCP registry via
`.github/workflows/publish-mcp-registry.yml`.

## Auth

Two paths, both resolving to a ProAgentStore session:

| Path | How | Notes |
|---|---|---|
| OAuth 2.1 + PKCE (default) | The client discovers `/authorize` + `/token`, registers dynamically at `/register`, and the browser consent page delegates to ProAgentStore's own GitHub or Google sign-in | PKCE `S256` is mandatory — `code_challenge` is required and plain PKCE is rejected. Access tokens live 24h. Requested scopes are stored on the grant. |
| Per-call `token` argument | Every authenticated tool accepts an optional `token` (a PAGS session token) | Bypasses the OAuth grant, so it carries no scope set and no audit subject: `requirePermission` falls back to the default scope grant and `audit()` writes nothing. Use OAuth unless you are scripting. |

The endpoint under `/mcp` is gated by the OAuth provider. Every other path is served by
the login handler: `/authorize`, `/authorize/continue`, `/oauth/callback`, `/health`,
and a plain-text root. Unknown paths return 404, and `/` answers a protocol client with
a JSON-RPC 405 pointing at `/mcp` — deliberately, because a 200 there makes a client
reconnect in a tight loop.

## Scopes

`read` · `write` · `runtime` · `destructive`.

The default grant — used when a client requests no scope, or only standard OIDC scopes
like `openid email profile` — is `read write runtime`. **`destructive` is never granted
by default**, so delete- and overwrite-style tools cannot run on a plain browser
sign-in.

Set `MCP_READ_ONLY=1` on the Worker to force server-wide read-only: every
non-`read` scope check is denied regardless of the grant.

See [`AGENTS.md`](./AGENTS.md) for the full safety contract, and `src/safety.ts` for the
implementation.

## Tools

**130 tool registrations.** 112 are always registered; 18 are gated to the console
surfaces of the connected user's subscribed agents (`apply`, `repo`, `coding`), so a
Repo Chat user never sees `apply_to_job`.

Legend: **Scope** is the scope asserted via `requirePermission`. `—` means the tool
performs no scope check and is gated only by having a valid session (all such tools are
reads, with the noted exceptions). **Dry** = accepts `dry_run: true`. **Confirm** = the
exact string the `confirm` argument must carry.

### Catalog and reference (no auth)

| Tool | Purpose | Scope | Dry | Confirm |
|---|---|---|---|---|
| `list_agents` | List all published agents | — | | |
| `agent_info` | Detail for one published agent | — | | |
| `chat_with_agent` | Trial chat against a published agent (preview only, 20-message cap) | — | | |
| `platform_guide` | Static platform guide text | — | | |
| `sdk_reference` | Static SDK usage examples | — | | |

### Creator: agents, repos, deploys

| Tool | Purpose | Scope | Dry | Confirm |
|---|---|---|---|---|
| `my_agents` | List agents you own | — | | |
| `create_agent` | Create an agent, including declarative `capabilities` + `settings_schema` | write | yes | |
| `update_agent` | Patch an agent's settings and capabilities | write | yes | |
| `scaffold_agent` | Create an agent *and* its GitHub repo from a starter template | write | yes | |
| `agent_analytics` | Usage stats for an owned agent | — | | |
| `get_agent_board_config` | Read the creator console board config | — | | |
| `update_agent_board_config` | Replace the creator console board columns | write | yes | |
| `get_agent_settings_schema` | Read an agent's declared subscriber settings schema | — | | |
| `set_agent_settings_schema` | Replace it (max 12 fields) | write | yes | |
| `get_agent_stats_schema` | Read an agent's declared stats cards (the default set subscribers inherit) | — | | |
| `set_agent_stats_schema` | Replace them (max 12 cards, closed source vocabulary) | write | yes | |
| `list_agent_repo_files` | List files in an owned agent's GitHub repo | — | | |
| `read_agent_file` | Read one file from that repo | — | | |
| `write_agent_file` | Create or overwrite one file | write | yes | `write_agent_file` |
| `batch_write_agent_files` | Create or overwrite many files | write | yes | `batch_write_agent_files` |
| `agent_deploy_status` | Latest GitHub Actions deploy runs | — | | |
| `trigger_agent_deploy` | Dispatch the deploy workflow | runtime | yes | |

### Creator: template knowledge, storage, files

Agent-scoped (the creator's template), not instance-scoped.

| Tool | Purpose | Scope | Dry | Confirm |
|---|---|---|---|---|
| `add_knowledge` | Add a document to an agent's KB | write | yes | |
| `list_knowledge` | List KB documents | — | | |
| `search_agent_knowledge` | Semantic search over KB, history, files | — | | |
| `list_agent_files` | List files stored by an agent | — | | |
| `upload_agent_file` | Upload a **text** file to agent storage | write | | |
| `agent_activity` | Recent activity log | — | | |
| `list_collections` | List an agent's collections with schema + counts | — | | |
| `create_collection` | Create a collection | write | | |
| `query_records` | Query a collection | — | | |
| `insert_record` | Insert a record | write | | |
| `update_record` | Update a record | write | | |

### Instances: lifecycle and chat

| Tool | Purpose | Scope | Dry | Confirm |
|---|---|---|---|---|
| `subscribe_agent` | Subscribe to a published agent, creating your private instance | write | yes | |
| `my_instances` | List your subscribed instances | — | | |
| `chat_with_instance` | The real runtime chat path (your state, your credentials) | runtime | yes | |
| `instance_messages` | Recent messages | — | | |
| `clear_instance_messages` | Delete all messages and voice recordings | destructive | yes | `clear_instance_messages` |
| `rename_instance` | Set or clear the display name | write | yes | |
| `set_instance_model` | Change the instance's chat model | write | yes | |
| `get_instance_state` | Read DO state (identity, guardrails, permissions) — read-only | — | | |
| `cancel_instance` | Cancel the subscription, deactivating the instance | destructive | yes | `cancel_instance` |

### Instance knowledge, vectors, files

| Tool | Purpose | Scope | Dry | Confirm |
|---|---|---|---|---|
| `add_instance_knowledge` | Add a document to your instance's KB | write | yes | |
| `list_instance_knowledge` | List KB documents | — | | |
| `delete_instance_knowledge` | Delete one document | destructive | yes | `delete_instance_knowledge` |
| `search_instance_knowledge` | Vector search — what is actually retrievable | — | | |
| `vector_stats` | Vector-store inventory grouped by source | — | | |
| `list_instance_files` | List uploaded files + extraction status | — | | |
| `delete_instance_file` | Delete a file, its metadata, and its vectors | destructive | yes | `delete_instance_file` |

### Instance memory, settings, instructions, translation

| Tool | Purpose | Scope | Dry | Confirm |
|---|---|---|---|---|
| `get_instance_memory` | Read memory entries | — | | |
| `write_instance_memory` | Create or update one memory entry | write | yes | |
| `delete_instance_memory` | Delete one memory entry by key | destructive | yes | `delete_instance_memory` |
| `get_instance_settings` | Read typed settings values + declared schema | — | | |
| `set_instance_settings` | Patch settings (only sent fields change) | write | yes | |
| `get_instance_stats` | Resolved stats cards + their current numbers (`null` in a series = nothing ran, not zero) | — | | |
| `set_instance_stats` | Patch your own stats cards (`card: null` removes/hides; never edits the template) | write | yes | |
| `get_instance_instructions` | Read Special Instructions | — | | |
| `set_instance_instructions` | Replace them (max 4000 chars) | write | yes | |
| `get_translation_config` | Read the translation display config | — | | |
| `set_translation_config` | Patch it | write | yes | |

### Instance collections and tickets

| Tool | Purpose | Scope | Dry | Confirm |
|---|---|---|---|---|
| `list_instance_collections` | List collections on a subscribed instance | read | | |
| `query_instance_records` | Query records | read | | |
| `insert_instance_record` | Insert a record (respects unique/dedup constraints) | write | | |
| `create_instance_ticket` | Put a ticket on the board without a runner | write | | |

### Board and runtime tasks

| Tool | Purpose | Scope | Dry | Confirm |
|---|---|---|---|---|
| `instance_board` | Read the live kanban board (one card per job) | — | | |
| `get_instance_board_config` | Read board columns + preferred view | — | | |
| `set_instance_board_config` | Override columns / view per instance | write | yes | |
| `set_board_item_status` | Move a card, or reset it to automation | write | yes | |
| `run_instance_task` | Create a task on the registered runtime | runtime | yes | |
| `approve_instance_task` | Approve a task waiting for human approval | runtime | yes | |
| `cancel_instance_task` | Cancel a runtime task | destructive | yes | `cancel_instance_task` |
| `hint_instance_task` | Attach guidance the agent reads on its next step | write | yes | |
| `clear_finished_tasks` | Clear done/failed/cancelled tasks from the board | write | yes | |
| `instance_task_events` | Recent runtime events | — | | |
| `ticket_thread` | Read one ticket's question-and-answer thread | — | | |
| `ask_ticket` | Ask one ticket about its own record — explains, never acts | write | yes | |

### Runtime registration

| Tool | Purpose | Scope | Dry | Confirm |
|---|---|---|---|---|
| `register_instance_runtime` | Register a local or managed browser runtime | runtime | yes | |
| `instance_runtime_status` | Is a runtime registered? | — | | |
| `unregister_instance_runtime` | Remove the registered runtime endpoint | destructive | yes | `unregister_instance_runtime` |

### Coding (gated to `surfaces: ["coding"]`)

| Tool | Purpose | Scope | Dry | Confirm |
|---|---|---|---|---|
| `system_status` | Runner connectivity, node, tmux sessions, repos, issues | — | | |
| `coding_diagnostics` | Same picture, for debugging offline/stuck sessions | — | | |
| `coding_repos_list` | Repos registered on the instance + their sessions | — | | |
| `coding_repo_add` | Add a repo by local path, `owner/repo`, or clone URL | write | | |
| `coding_sessions_list` | All sessions, active and ended | — | | |
| `coding_session_capture` | Live terminal output + run state | — | | |
| `coding_session_message` | Type into the CLI on the runner node | runtime | | |
| `coding_session_restart` | Restart the CLI, same session id | runtime | | |
| `coding_session_end` | End the session, stopping the CLI | runtime | | |
| `coding_session_fresh` | End and start clean (no `--resume`) | runtime | | |
| `coding_overseer` | Cross-repo coordinator; can drive a specific engine | runtime | | |

### Autonomous loops

All six are always registered — the `coding_loop_*` tools live in the coding module but
sit outside its surface gate.

| Tool | Purpose | Scope | Dry | Confirm |
|---|---|---|---|---|
| `start_instance_loop` | Give an agent an objective and let it run on the server, budget-bounded | write | yes | |
| `check_instance_loop` | Status, steps taken, stop reason (omit `run_id` to list runs) | read | | |
| `stop_instance_loop` | Cooperative stop — the in-flight step finishes | write | no ([why](#tools-with-no-dry-run)) | |
| `coding_loop_start` | Client-side loop: send objective, then iterate via loop-decide — runs every iteration before returning | runtime | yes | |
| `coding_loop_status` | Status of that loop | — | | |
| `coding_loop_stop` | Stop it (in-memory only; no scope check) | — | | |

### Triggers

| Tool | Purpose | Scope | Dry | Confirm |
|---|---|---|---|---|
| `list_instance_triggers` | List webhook/cron/connector-sync triggers | read | | |
| `create_instance_trigger` | Create one | write | yes | |
| `run_instance_trigger` | Fire one now | runtime | yes | |
| `list_instance_trigger_events` | Event history for a trigger | read | | |
| `delete_instance_trigger` | Delete it, plus its history and sync ledger | destructive | yes | `delete_instance_trigger` |

### Connector tools and grants

| Tool | Purpose | Scope | Dry | Confirm |
|---|---|---|---|---|
| `list_instance_tools` | Every registry tool with this instance's verdict (`allowed`, `scope`, `disabled`, `reason`) + input schemas | — | | |
| `set_instance_tool` | Switch one tool on or off for this instance | write | yes | |
| `call_instance_tool` | Invoke a connector tool directly (`tool` + `input`) | write | no ([why](#tools-with-no-dry-run)) | |
| `connector_status` | Is a file connector connected, and is this deployment configured for it? | — | | |
| `list_instance_connector_grants` | Folders granted to this instance — the grant *is* the permission | — | | |
| `grant_instance_connector_folder` | Grant a folder (folders only; files refused server-side) | write | yes | |
| `delete_instance_connector_grant` | Revoke a grant | destructive | yes | `delete_instance_connector_grant` |

### Agent-to-agent

| Tool | Purpose | Scope | Dry | Confirm |
|---|---|---|---|---|
| `list_supervision` | Agents a supervisor oversees | read | | |
| `create_supervision` | Put one agent in charge of another (loop/depth/fan-out checked) | write | yes | |
| `delete_supervision` | Remove a supervision link — silent afterwards: the supervisor stops reaching that subordinate rather than erroring | destructive | yes | `delete_supervision` |
| `list_connections` | Event connections leaving an instance | read | | |
| `create_connection` | Route an emitted fact to another agent (the pump) | write | yes | |

### Repo Chat (gated to `surfaces: ["repo"]`)

| Tool | Purpose | Scope | Dry | Confirm |
|---|---|---|---|---|
| `ingest_repo` | Index a GitHub repo into the instance's vector store (call again to add another, or same URL to re-index) | write | yes | |
| `ingest_repo_status` | Indexed repos + per-repo progress | — | | |
| `remove_repo` | Remove one repo, or all | write, or destructive when removing all | yes | `remove_all_repos` (only when removing all) |

### Apply (gated to `surfaces: ["apply"]`, except `update_profile`)

| Tool | Purpose | Scope | Dry | Confirm |
|---|---|---|---|---|
| `upload_resume` | Upload/replace the résumé, or re-parse the one on file | write | yes | |
| `apply_to_job` | Drive the browser to fill (and, with `submit: true`, submit) an application | runtime, or destructive when `submit: true` | yes | |
| `get_profile` | Read the structured candidate Profile + Job Preferences | — | | |
| `get_apply_tips` | Learned per-ATS tips | — | | |
| `update_profile` | Update Profile fields (string fields only) — always registered | write | yes | |

### Observability and account reads

| Tool | Purpose | Scope | Dry | Confirm |
|---|---|---|---|---|
| `agent_trace` | The primary debug tool — time-ordered timeline of chat turns, apply steps, tool calls, failures | — | | |
| `list_errors` | Persisted platform failures (`scope: "all"` is admin-only) | — | | |
| `instance_activity` | Append-only instance activity log | — | | |
| `list_pipeline_runs` | Declarative-pipeline runs with counts | — | | |
| `mcp_audit_log` | Recent MCP write/runtime/dry-run/denied events for this account | read | | |
| `billing_status` | Free vs Pro, paywall enforcement | — | | |
| `usage_summary` | Token usage + estimated cost by agent/model/activity | — | | |
| `keys_status` | Which providers have a BYOK key — **names only** | — | | |
| `email_status` | Gmail configured/connected | — | | |

### Tools with no dry run

`dry_run` is how a caller — usually a model — finds out what a call would do without
doing it. Every mutating tool offers one except these two, and the reason in both cases
is that a preview here would be *less* informative than something that already exists:

| Tool | Why not | Read this instead |
|---|---|---|
| `call_instance_tool` | A generic invoker. What the call does is decided by the connector registry in `workers/api`, which this Worker cannot see. Its preview could only echo your own `tool` and `input` back — a safety check that knows nothing about the side effect it is previewing. | `list_instance_tools` — the registry's own verdict (`allowed`, `scope`, `disabled`, `reason`) plus the input schema, as a read. |
| `stop_instance_loop` | Fully described by `run_id`; there is nothing else to get wrong. Stopping is also the safe direction — cooperative, the in-flight step settles its own spend. | `check_instance_loop` — the objective, steps taken and stop reason for the run you are about to stop. |

Both carry that reasoning in a comment above their registration, and
`instance-tools/contract.test.ts` lists them, so the set moves only deliberately.

## Not exposed via MCP

See [`AGENTS.md`](./AGENTS.md#not-supported-via-mcp) for the verified list and why.

## Local development

```bash
pnpm --filter proagentstore-mcp dev        # wrangler dev
pnpm --filter proagentstore-mcp typecheck
pnpm --filter proagentstore-mcp deploy
npx vitest run workers/mcp                 # from the repo root
```

Deploys run from CI on push to `main` (see `.github/workflows/`), not from a laptop.
