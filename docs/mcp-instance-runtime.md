# MCP Instance Runtime

ProAgentStore MCP should treat public agents as templates and subscribed instances as the real runtime.

## Correct Flow

1. `list_agents` or `agent_info` finds a published template agent.
2. `subscribe_agent` creates a private `agent_instances` row and initializes a Durable Object for that user.
3. `my_instances` returns the user's runnable instance IDs.
4. `add_instance_knowledge` stores user-specific documents on the private instance.
5. `chat_with_instance` sends messages to `/v1/instances/:instanceId/chat`.
6. `instance_messages` and `list_instance_knowledge` inspect that private instance.

## Public Trial Flow

`chat_with_agent` intentionally calls `/v1/public/agents/:id/try`. It is useful for demos and marketplace previews, but it is not the primary product loop because it does not operate the user's subscribed instance.

## Billing Model

Agents must use caller-owned AI credentials. A subscribed instance can hold user-specific state and knowledge, but inference should not silently bill the platform account.

## MCP Tool Groups

Creator tools:

- `create_agent`
- `scaffold_agent`
- `update_agent`
- `my_agents`
- repo tools such as `list_agent_files`, `read_agent_file`, `write_agent_file`, `trigger_agent_deploy`

User runtime tools:

- `subscribe_agent`
- `my_instances`
- `chat_with_instance`
- `instance_messages`
- `add_instance_knowledge`
- `list_instance_knowledge`
- `delete_instance_knowledge`
- `cancel_instance`
