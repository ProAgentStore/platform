# ProAgentStore Docs

ProAgentStore is an MCP-first marketplace and runtime platform for server-powered AI agents.

Creators publish agent templates. Users subscribe to private agent instances. Each instance keeps user-specific state, knowledge, memory, credentials, and runtime tasks. The console, API, MCP server, connectors, and local runner all operate on that same private instance model.

## Start Here

- [Connectors](connectors.md): connect Google Drive, Google Docs, and Zoho WorkDrive at the account level, then grant selected folders or shared drives to agents.
- [Triggers](triggers.md): configure webhooks and cron schedules for private agent instances.
- [MCP](mcp.md): connect Codex, Claude Code, Cursor, and other MCP clients to the official ProAgentStore MCP server.
- [Browser Runtime](browser-runtime.md): run local browser and CLI capabilities with `pags up`.
- [Coder Multi-Machine Runtime](coder-multi-machine.md): connect multiple local machines to the same Coder instance and route sessions by runner node.
- [Architecture](architecture.md): understand the control plane, state plane, runtime plane, and main Cloudflare services.
- [Skill Publishing](skill-publishing.md): publish ProAgentStore skills for Codex and Claude users.

## Core Model

ProAgentStore separates account connections from agent permissions.

1. The user connects a provider to their ProAgentStore account.
2. The user grants selected folders, shared drives, repositories, mailboxes, or runtime capabilities to one or more agents.
3. The user configures instance-level triggers such as webhooks or schedules when external systems should start work.
4. Agents use only the granted resources through scoped platform tools.
5. MCP and console actions share the same authorization and audit model.

This is the intended model for Google Docs and Zoho WorkDrive. Connect the account once, then allow specific agents to use specific folders or shared drives.

## Public Endpoints

```text
https://proagentstore.online/docs/
https://proagentstore.online/llms.txt
https://proagentstore.online/llms-full.txt
https://proagentstore.online/openapi.yaml
https://proagentstore.online/.well-known/mcp-server.json
https://mcp.proagentstore.online/mcp
```

## Operating Rule For Agents

Agents should use ProAgentStore through MCP or documented platform APIs. They should not scrape the console or call private endpoints directly.
