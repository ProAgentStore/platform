---
name: proagentstore-mcp-operator
description: Operate ProAgentStore account state only through the deployed MCP server. Use when creating, updating, subscribing to, running, or inspecting ProAgentStore agents and private instances on a user's behalf.
license: MIT
metadata:
  author: ProAgentStore
  version: "0.1.0"
---

# ProAgentStore MCP Operator

Use this skill when the user asks you to operate ProAgentStore through their account.

Requires an MCP client that supports OAuth or browser sign-in and access to `https://mcp.proagentstore.online/mcp`.

## Core Rule

All live ProAgentStore account operations must go through the deployed MCP server:

```text
https://mcp.proagentstore.online/mcp
```

Do not bypass MCP with direct database writes, private API calls, local secrets, or browser-only shortcuts unless the user explicitly overrides this rule.

Allowed without MCP:

- Reading and editing local repository files.
- Updating docs, tests, templates, and plugin packaging.
- Explaining how ProAgentStore MCP works.

Requires MCP:

- Creating or updating an agent in the user's ProAgentStore account.
- Subscribing to an agent.
- Running a private agent instance.
- Adding or inspecting instance knowledge.
- Reading account-specific agents, deployments, analytics, files, or messages.

## Connection

Use the platform MCP endpoint:

```bash
npx mcp-remote https://mcp.proagentstore.online/mcp
```

If the MCP client opens a browser authorization flow, wait for the user to approve it. Do not try to extract, print, or reuse OAuth tokens manually.

## Runtime Flow

Use public trial chat only for discovery:

```text
list_agents -> chat_with_agent
```

Use private instance chat for the real user runtime:

```text
list_agents -> subscribe_agent -> my_instances -> add_instance_knowledge -> chat_with_instance -> instance_messages
```

The private instance flow is the product path because it keeps user state, knowledge, memory, and billing credentials separate from the creator's template agent.

Use browser-capable private instances through ProAgentStore runtime tools:

```text
subscribe_agent -> register_instance_runtime -> instance_runtime_status -> run_instance_task -> approve_instance_task -> instance_task_events
```

PAGS is the MCP/account control plane. The local ProAgentStore runner executes Playwright, local file uploads, screenshots, terminal actions, and approval-gated browser actions through the outbound relay opened by `pags up`.

## Expected Missing-Credentials Response

If `chat_with_instance` returns:

```text
Add your Cloudflare Workers AI account ID and API token before running this agent.
```

the private runtime is working. The instance is correctly refusing to spend platform-owned AI credentials.

## Tool Surface

The server registers 145 tools; call `tools/list` for the current set. The tool table in
`workers/mcp/README.md` (or the published `platform-docs/mcp.md`) lists every tool with its
scope, dry-run support, and confirmation value. The always-on `platform_guide` tool returns a
plain-text map of the most commonly used ones — call it at the start of a session to orient
yourself without a round-trip through the full list.

Tools span four groups: catalog/reference (no auth required), creator agent tools (write
scope), user runtime and instance tools (runtime and destructive scopes), and observability
and coding tools (gated to the console surfaces the subscribed agent exposes).

## Operating Style

When operating through MCP:

1. State which MCP action you are taking.
2. Prefer private instance tools over public trial tools for durable work.
3. For mutating tools, pass `dry_run: true` first to preview what the call would do before committing it. The result says `dryRun: true` and describes the change without applying it.
4. Thirteen tools require an exact `confirm` value (compared with `===`, never fuzzy-matched). Twelve use the tool's own name: `write_agent_file`, `batch_write_agent_files`, `unregister_instance_runtime`, `cancel_instance_task`, `cancel_instance`, `delete_instance_knowledge`, `delete_instance_memory`, `delete_instance_file`, `delete_instance_trigger`, `delete_instance_connector_grant`, `delete_supervision`, `clear_instance_messages`. The exception is `remove_repo`, which requires `confirm: "remove_all_repos"` and only when removing every repo. A refusal from a confirm-gated tool is mechanical — the gate cannot be argued past; supply the exact value.
5. The `destructive` scope is never granted by default. A client connected with standard browser sign-in cannot run delete- or overwrite-style tools unless the authorization flow explicitly requests the `destructive` scope.
6. Report the MCP result in plain language with IDs, slugs, URLs, and next steps.
7. If OAuth or credentials block progress, explain the exact approval or credential step needed.
