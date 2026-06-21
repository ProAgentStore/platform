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

## Auth Scopes And Safety

OAuth connections can be scoped to:

- `read`
- `write`
- `runtime`
- `destructive`

If a client does not request a ProAgentStore-specific scope, or only requests standard OAuth/OIDC scopes such as `openid email profile`, ProAgentStore grants the existing default scope set for compatibility. Use `read` only for inspection agents. Set `MCP_READ_ONLY=1` on the MCP worker to force server-wide read-only mode.

Mutating tools support `dry_run: true` where useful. Destructive or overwrite-style tools require an exact `confirm` value:

- `write_agent_file`: `confirm: "write_agent_file"`
- `batch_write_agent_files`: `confirm: "batch_write_agent_files"`
- `unregister_instance_runtime`: `confirm: "unregister_instance_runtime"`
- `cancel_instance_task`: `confirm: "cancel_instance_task"`
- `delete_instance_knowledge`: `confirm: "delete_instance_knowledge"`
- `cancel_instance`: `confirm: "cancel_instance"`

Use `mcp_audit_log` to inspect recent MCP write, runtime, dry-run, denied, and destructive tool events for the authenticated account.

## Correct Runtime Flows

Public trial preview:

```text
list_agents -> chat_with_agent
```

Private instance runtime:

```text
list_agents -> subscribe_agent -> my_instances -> add_instance_knowledge -> chat_with_instance -> instance_messages
```

Browser-capable instance runtime:

```text
subscribe_agent -> register_instance_runtime -> instance_runtime_status -> run_instance_task -> approve_instance_task -> instance_task_events
```

Current CLI local browser mode uses `pags runner connect "$PAGS_INSTANCE_ID" --pags-token "$PAGS_TOKEN" --headless`, which starts the FAGS browser runtime, opens a Cloudflare quick tunnel, registers it with PAGS, and keeps it alive. The target cheapest best-practice local mode is outbound polling from FAGS to PAGS, with tunnel mode retained as fallback/debug.

```text
PAGS MCP/API control plane -> FAGS browser runtime -> Playwright browser
```

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

Not supported:

- user deletion
- permission changes
- broad billing changes
- arbitrary shell execution
- generic API proxying

## Security

- OAuth/browser sign-in is the default auth path.
- OAuth scopes are enforced server-side for write, runtime, and destructive tools.
- Tools are purpose-specific; there is no generic shell or arbitrary API proxy tool.
- Mutating tools support dry-run previews where useful.
- Destructive and repository overwrite tools require explicit confirmation.
- MCP audit events are stored for authenticated OAuth sessions.
- Browser actions are task-based and can require explicit approval.
- Private instance runtime uses caller-owned AI credentials.
- Prefer read-only tools unless the user explicitly requests changes.
