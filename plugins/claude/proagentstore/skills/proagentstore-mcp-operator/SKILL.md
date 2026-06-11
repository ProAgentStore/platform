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

## Expected Missing-Credentials Response

If `chat_with_instance` returns:

```text
Add your Cloudflare Workers AI account ID and API token before running this agent.
```

the private runtime is working. The instance is correctly refusing to spend platform-owned AI credentials.

## Tool Groups

Creator tools:

- `create_agent`
- `scaffold_agent`
- `update_agent`
- `my_agents`
- `list_agent_files`
- `read_agent_file`
- `write_agent_file`
- `batch_write_agent_files`
- `trigger_agent_deploy`
- `agent_deploy_status`
- `add_knowledge`
- `list_knowledge`
- `agent_analytics`

User runtime tools:

- `subscribe_agent`
- `my_instances`
- `chat_with_instance`
- `instance_messages`
- `add_instance_knowledge`
- `list_instance_knowledge`
- `delete_instance_knowledge`
- `cancel_instance`

Discovery/reference tools:

- `list_agents`
- `agent_info`
- `chat_with_agent`
- `platform_guide`
- `sdk_reference`

## Operating Style

When operating through MCP:

1. State which MCP action you are taking.
2. Prefer private instance tools over public trial tools for durable work.
3. Ask the user before destructive actions like deleting knowledge or canceling an instance.
4. Report the MCP result in plain language with IDs, slugs, URLs, and next steps.
5. If OAuth or credentials block progress, explain the exact approval or credential step needed.
