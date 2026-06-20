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

## Agent Rules

```md
Use ProAgentStore only through the configured MCP server.

Do not use the web UI.
Do not call REST/GraphQL/private APIs directly.
First inspect available MCP tools/resources.
Prefer read-only tools unless the task explicitly requires changes.
Confirm before destructive actions.
```

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
- Tools are purpose-specific; there is no generic shell or arbitrary API proxy tool.
- Browser actions are task-based and can require explicit approval.
- Private instance runtime uses caller-owned AI credentials.
- Prefer read-only tools unless the user explicitly requests changes.
