# AGENTS.md

## ProAgentStore Access Rules

Use ProAgentStore account state only through the configured MCP server.

- Do not use the ProAgentStore web UI for account actions unless the user explicitly asks.
- Do not call private REST, GraphQL, database, or worker APIs directly unless the user explicitly overrides this rule.
- First inspect available MCP tools/resources before choosing an action.
- Prefer read-only tools unless the task explicitly requires changes.
- Confirm before destructive actions such as cancelling instances, deleting knowledge, or overwriting files.
- Never use a generic shell/API proxy as a substitute for a specific MCP tool.

## Expected MCP Server

```toml
[mcp_servers.proagentstore]
url = "https://mcp.proagentstore.online/mcp"
```

Use the public trial flow only for previews:

```text
list_agents -> chat_with_agent
```

Use private instance flow for durable user work:

```text
list_agents -> subscribe_agent -> my_instances -> add_instance_knowledge -> chat_with_instance -> instance_messages
```

Use browser-capable instance flow when local Playwright is needed:

```text
subscribe_agent -> register_instance_runtime -> instance_runtime_status -> run_instance_task -> approve_instance_task -> instance_task_events
```
