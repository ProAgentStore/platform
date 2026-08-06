# ProAgentStore MCP

ProAgentStore is MCP-first. Agents should operate account state through the official MCP server instead of scraping the UI or calling private APIs directly.

Remote MCP endpoint:

```text
https://mcp.proagentstore.online/mcp
```

Human and AI docs:

```text
https://proagentstore.online/docs/mcp/
https://proagentstore.online/llms.txt
https://proagentstore.online/.well-known/mcp-server.json
```

In-repo references, kept next to the code they describe:

- [`workers/mcp/README.md`](https://github.com/ProAgentStore/platform/blob/main/workers/mcp/README.md)
  — every tool, by category, with its scope, `dry_run` support, and `confirm` value.
- [`workers/mcp/AGENTS.md`](https://github.com/ProAgentStore/platform/blob/main/workers/mcp/AGENTS.md)
  — the behavioural contract for a calling agent: rules, workflow recipes, and what is
  deliberately not available.
- [`workers/mcp/CLAUDE.md`](https://github.com/ProAgentStore/platform/blob/main/workers/mcp/CLAUDE.md)
  — for work inside the worker itself: bindings, code layout, how to add a tool.

## Use It Now

Codex:

```bash
codex mcp add proagentstore --url https://mcp.proagentstore.online/mcp
codex mcp list
# If the server shows "Not logged in":
codex mcp login proagentstore
```

Claude Code:

```bash
claude mcp add --transport http proagentstore https://mcp.proagentstore.online/mcp
claude mcp list
```

Generic MCP client:

```bash
npx mcp-remote https://mcp.proagentstore.online/mcp
```

First-party local `npx` proxy:

```bash
npx @proagentstore/cli mcp
```

## Project Config

Use `.mcp.json` for MCP clients that support project-local config:

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

Use `.codex/config.toml` for Codex project-local config in trusted repos:

```toml
[mcp_servers.proagentstore]
url = "https://mcp.proagentstore.online/mcp"
tool_timeout_sec = 120
default_tools_approval_mode = "prompt"
```

For stdio-only MCP clients, use the published CLI as the local proxy:

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

## Agent Rules

```md
Use ProAgentStore only through the configured MCP server.

Do not use the web UI.
Do not call REST/GraphQL/private APIs directly.
First inspect available MCP tools/resources.
Prefer read-only tools unless the task explicitly requires changes.
Confirm before destructive actions.
```

## Auth

Two authentication paths resolve to the same ProAgentStore session:

- **OAuth 2.1 + PKCE** (default). The client discovers `/authorize` and `/token`, and may
  register dynamically at `/register`. PKCE `S256` is mandatory — a request without a
  `code_challenge` is rejected, and plain PKCE is disabled. The consent page delegates to
  ProAgentStore's own GitHub or Google sign-in, and the callback is bound to the browser
  that started the flow. Access tokens live 24 hours.
- **A per-call `token` argument**. Every authenticated tool accepts an optional PAGS
  session token. This bypasses the OAuth grant, so it carries no scope set (the default
  grant applies) and no audit subject (nothing is written to the audit log). Prefer OAuth
  unless you are scripting.

## Auth Scopes And Safety

OAuth connections can be scoped to:

- `read`
- `write`
- `runtime`
- `destructive`

If a client does not request a ProAgentStore-specific scope, or only requests standard OAuth/OIDC scopes such as `openid email profile`, ProAgentStore grants the default set `read write runtime`. **`destructive` is never granted by default**, so delete- and overwrite-style tools cannot run on a plain browser sign-in. Use `read` only for inspection agents. Set `MCP_READ_ONLY=1` on the MCP worker to force server-wide read-only mode — every non-`read` scope assertion is then denied regardless of the grant.

Mutating tools support `dry_run: true` where useful. It returns the call that would have been made (`{dryRun, tool, action, wouldDo}`), is audited, and changes nothing. The dry-run branch runs after the permission check, so a dry run of a tool you lack scope for still denies.

Destructive or overwrite-style tools require an exact `confirm` value. By convention the value is the tool's own name; `remove_repo` is the exception:

- `write_agent_file`: `confirm: "write_agent_file"`
- `batch_write_agent_files`: `confirm: "batch_write_agent_files"`
- `unregister_instance_runtime`: `confirm: "unregister_instance_runtime"`
- `cancel_instance_task`: `confirm: "cancel_instance_task"`
- `cancel_instance`: `confirm: "cancel_instance"`
- `delete_instance_knowledge`: `confirm: "delete_instance_knowledge"`
- `delete_instance_memory`: `confirm: "delete_instance_memory"`
- `delete_instance_file`: `confirm: "delete_instance_file"`
- `delete_instance_trigger`: `confirm: "delete_instance_trigger"`
- `clear_instance_messages`: `confirm: "clear_instance_messages"`
- `delete_instance_connector_grant`: `confirm: "delete_instance_connector_grant"`
- `remove_repo`: `confirm: "remove_all_repos"`, and only when removing **all** indexed repos

Use `mcp_audit_log` to inspect recent MCP write, runtime, dry-run, denied, and destructive tool events for the authenticated account. Audit events are redacted before storage — both by key name (`token`, `secret`, `password`, `credential`, `api_key`, …) and by value shape (`sk-…`, `ghp_…`, `xox…`, `AIza…`, JWTs, bearer headers) — and expire after 90 days.

## Error Shape

Tools return a single text content block. This server does **not** set `isError`. A
failure is one of:

- text beginning `Error: ` — authentication required, a denied scope, a missing
  confirmation, or an upstream error message;
- JSON text carrying an `error` key — any non-2xx from the platform API is converted to
  `{"error": "API <status>", …}` rather than being allowed to pass as a result.

Check for both. A permission denial is a configuration fact, not a transient failure:
retrying returns the identical message and writes another audit row.

## Correct Runtime Flows

Public trial preview:

```text
list_agents -> chat_with_agent
```

Private instance runtime:

```text
list_agents -> subscribe_agent -> my_instances -> add_instance_knowledge -> chat_with_instance -> instance_messages
```

Private instance triggers:

```text
my_instances -> list_instance_triggers -> create_instance_trigger -> run_instance_trigger -> list_instance_trigger_events
```

Use `create_instance_trigger` with action `sync_connector` and config
`provider` plus `grant_id` to schedule Google Drive or Zoho WorkDrive folder
syncs for an already-granted folder.

Browser-capable instance runtime:

```text
subscribe_agent -> register_instance_runtime -> instance_runtime_status -> run_instance_task -> approve_instance_task -> instance_task_events
```

Repo Chat — index a repository, then ask about the code:

```text
subscribe_agent -> ingest_repo -> ingest_repo_status (poll to done) -> chat_with_instance
```

Debug a wrong answer:

```text
agent_trace -> vector_stats -> search_instance_knowledge -> list_errors
```

`agent_trace` first: it interleaves chat turns, tool calls, apply steps, and failures in
time order, which separates "never retrieved the fact" from "retrieved it and reasoned
badly" from "the tool call failed".

Review what another agent did, and question it:

```text
instance_board -> ticket_thread (what was already asked) -> ask_ticket
```

`ask_ticket` is how one agent reviews another's work. The answer is built from THAT
ticket's record alone — its reasoning, its declared action, its logged activity — by a
model call with no tools, so the same question on two tickets gets two answers and an
unrecorded detail comes back as "that isn't recorded" rather than a plausible
reconstruction. Report that verbatim; a confabulated answer here is worse than no thread,
because it is read as the audit trail.

It explains, it never acts. Neither tool can start, change, approve or run anything, so
the approval gate keeps no free-text bypass — running a ticket's declared work is still
`approve_instance_task` / `run_instance_task`.

Safely attempt a destructive operation:

```text
<tool> with dry_run: true -> inspect wouldDo -> <tool> with the exact confirm value -> mcp_audit_log
```

More recipes, with real argument names, are in
[`workers/mcp/AGENTS.md`](https://github.com/ProAgentStore/platform/blob/main/workers/mcp/AGENTS.md).

## Tool Surface

The server registers **126 tools**. 108 are always present. The remaining 18 are gated to
the console surfaces of the connected user's own subscribed agents, so the surface is
per-connection:

| Surface | Gated tools |
|---|---|
| `apply` | `upload_resume`, `apply_to_job`, `get_profile`, `get_apply_tips` |
| `repo` | `ingest_repo`, `ingest_repo_status`, `remove_repo` |
| `coding` | `system_status`, `coding_diagnostics`, `coding_repos_list`, `coding_repo_add`, `coding_sessions_list`, `coding_session_capture`, `coding_session_message`, `coding_session_restart`, `coding_session_end`, `coding_session_fresh`, `coding_overseer` |

A Repo Chat user therefore never sees `apply_to_job`. Call `tools/list` and read what is
actually there rather than assuming a tool exists; the surface is versioned and will
change. The full table — every tool with its scope, `dry_run` support, and `confirm`
value — is in
[`workers/mcp/README.md`](https://github.com/ProAgentStore/platform/blob/main/workers/mcp/README.md).

## Capabilities

Read:

- agents
- private instances
- messages
- knowledge
- deployment status
- analytics
- runtime status
- task events
- MCP audit log

Write:

- create/update agents
- scaffold repositories
- write agent files
- subscribe to agents
- add instance knowledge
- register runtimes
- create, approve, and cancel runtime tasks

## Not Supported

Deliberate exclusions. There is no tool for any of these — an agent that knows this stops
looking and tells the user which console screen to use instead.

| Not available via MCP | Why |
|---|---|
| The credentials vault — site logins, passwords, PINs, recovery codes | Secrets. Console → Knowledge → Credentials. |
| API-key **values** | `keys_status` returns provider names only. There is no reveal tool and no route that returns a stored key. Gmail refresh tokens are never revealable at all. |
| Permission writes on instance state | `get_instance_state` is read-only; permission toggles stay in the console. The one carve-out is `set_instance_model`, which writes the `model` field and nothing else. |
| Stripe checkout and the customer portal | Browser redirects — a redirect URL is useless to a headless caller. `billing_status` reads; nothing writes. |
| Binary routes — voice-audio, R2 multipart upload parts, file byte download | MCP results are text. `list_instance_files` and `delete_instance_file` exist; reading the bytes does not. `upload_agent_file` takes text only; `upload_resume` is the single binary path, and is apply-scoped. |
| Arbitrary shell execution, or a generic API proxy | No shell tool, no open proxy. `call_instance_tool` reaches only the connector tools an instance declares and its owner has left enabled. |
| User deletion | Not modelled. |
| Another user's data | Every instance route is owner-scoped server-side. `list_errors` with `scope: "all"` is the only cross-user read and is admin-only. |

## Security

- OAuth/browser sign-in is the default auth path.
- OAuth scopes are enforced server-side for write, runtime, and destructive tools.
- Tools are purpose-specific; there is no generic shell or arbitrary API proxy tool.
- Mutating tools support dry-run previews where useful.
- Destructive and repository overwrite tools require explicit confirmation.
- MCP audit events are stored for authenticated OAuth sessions, redacted by key name and
  by value shape, and expire after 90 days.
- Browser actions are task-based and can require explicit approval.
- Private instance runtime uses caller-owned AI credentials.
- Connector tools are gated twice: the instance must declare the tool, and its owner must
  not have switched it off. `list_instance_tools` returns that verdict per tool, so it is
  also how you audit what an agent can reach.
- Prefer read-only tools unless the user explicitly requests changes.

The scope, read-only, confirmation, dry-run, audit, and redaction logic all live in one
module — `workers/mcp/src/safety.ts` — which is the reference implementation other OFO
stores vendor.
