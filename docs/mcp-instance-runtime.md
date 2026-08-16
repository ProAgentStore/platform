# MCP Instance Runtime

ProAgentStore MCP has two separate chat paths:

- Public trial chat previews a published template agent.
- Instance chat runs a user's subscribed private copy of that agent.

The real product loop is the instance path. Public trial chat is useful for demos and marketplace discovery, but it should not be treated as the user's durable runtime.

## Connection

Connect an MCP client with browser sign-in:

```bash
npx mcp-remote https://mcp.proagentstore.online/mcp
```

The MCP worker is deployed at:

```text
https://mcp.proagentstore.online/mcp
```

Health check:

```bash
curl https://mcp.proagentstore.online/health
```

Expected response:

```json
{"ok":true,"service":"proagentstore-mcp","tools":136}
```

## Skills and Plugins

The reusable operating workflow is published as an Agent Skill and wrapped for both Codex and Claude Code.

Canonical skill:

```text
skills/proagentstore-mcp-operator/
```

Codex plugin wrapper:

```text
plugins/codex/proagentstore/
.agents/plugins/marketplace.json
```

Claude plugin wrapper:

```text
plugins/claude/proagentstore/
.claude-plugin/marketplace.json
```

See [Skill Publishing](../platform-docs/skill-publishing.md) for the install commands and release checklist.

## Correct User Runtime Flow

Use this flow when a user wants to run an agent with their own state, knowledge, memory, and billing credentials:

1. `list_agents` or `agent_info` finds a published template agent.
2. `subscribe_agent` creates a private `agent_instances` row and initializes a Durable Object for that user.
3. `my_instances` returns the user's runnable instance IDs.
4. `add_instance_knowledge` stores user-specific documents on the private instance.
5. `list_instance_knowledge` verifies the instance-specific knowledge was saved.
6. `chat_with_instance` sends messages to `/v1/instances/:instanceId/chat`.
7. `instance_messages` reads recent messages from that private instance.

Short form:

```text
list_agents -> subscribe_agent -> my_instances -> add_instance_knowledge -> chat_with_instance -> instance_messages
```

## Public Trial Flow

`chat_with_agent` intentionally calls:

```text
POST /v1/public/agents/:id/try
```

Use it for:

- Marketplace previews
- Smoke tests
- Anonymous first-run demos

Do not use it as the main runtime because it does not operate the user's subscribed instance.

## Billing Model

Agents must use caller-owned AI credentials. A subscribed instance can hold user-specific state and knowledge, but inference must not silently bill the platform account.

When caller credentials are missing, the expected response is:

```text
Add your Cloudflare Workers AI account ID and API token before running this agent.
```

That response means the instance runtime path is working and correctly refusing to spend platform-owned AI.

## MCP Tool Groups

The server currently has 137 tool registrations across `workers/mcp/src`.
Some are capability-gated and appear only for users with matching agent surfaces, so
`tools/list` on your own connection is the authoritative surface — 19 of those
registrations are gated. The `/health` marker reports the same total from
`workers/mcp/src/tool-count.ts`; it said a hardcoded `41` when this page was written,
which is the drift `scripts/docs-drift.mjs` now holds every statement of the number to.
The families below are a representative slice, not the complete list.

Creator tools:

- `create_agent`, `scaffold_agent`, `update_agent`, `my_agents`
- `list_agent_files`, `read_agent_file`, `write_agent_file`, `batch_write_agent_files`
- `trigger_agent_deploy`, `agent_deploy_status`
- `add_knowledge`, `list_knowledge`, `search_agent_knowledge`, `agent_analytics`

User runtime tools:

- `subscribe_agent`, `my_instances`, `chat_with_instance`, `instance_messages`
- `add_instance_knowledge`, `list_instance_knowledge`, `delete_instance_knowledge`, `search_instance_knowledge`
- `rename_instance`, `cancel_instance`, `register_instance_runtime`, `instance_runtime_status`

Storage / knowledge / RAG:

- `create_collection`, `list_instance_collections`, `insert_record`/`insert_instance_record`, `query_records`/`query_instance_records`, `update_record`
- `list_instance_files`, `upload_agent_file`, `delete_instance_file`
- `vector_stats`, `search_instance_knowledge`
- memory: `get_instance_memory`, `write_instance_memory`, `delete_instance_memory`

Coding (the Coder agent):

- `coding_repos_list`, `coding_repo_add`, `coding_sessions_list`
- `coding_session_capture`/`message`/`end`/`restart`/`fresh`
- `coding_loop_start`/`stop`/`status`, `coding_overseer`, `coding_diagnostics`

Repo Chat, triggers, board, settings, trace:

- `ingest_repo`, `ingest_repo_status`, `remove_repo`
- `list_instance_triggers`, `create_instance_trigger`, `run_instance_trigger`, `delete_instance_trigger`, `list_instance_trigger_events`
- `instance_board`, `set_board_item_status`, `get_instance_board_config`, `set_instance_board_config`
- `get_instance_settings`/`set_instance_settings`, `get_instance_instructions`/`set_instance_instructions`, `get_translation_config`/`set_translation_config`
- `agent_trace` (unified run timeline — primary debug tool), `instance_activity`, `mcp_audit_log`

Apply, account, usage:

- `apply_to_job`, `upload_resume`, `get_apply_tips`, `get_profile`/`update_profile`
- `billing_status`, `keys_status`, `email_status`, `usage_summary`

Discovery/reference tools:

- `list_agents`, `agent_info`, `chat_with_agent`, `platform_guide`, `sdk_reference`

## Live Test Record

The live authenticated MCP instance test passed on 2026-06-11.

Test agent:

```text
Name: Codex MCP Browser Test
Slug: codex-mcp-browser-test-20260611
Agent ID: ad376c07-5085-48da-b774-eeebff815bb0
```

Private instance created through `subscribe_agent`:

```text
Instance ID: 7867ed7e-e282-45de-b761-b71f77ddb462
Status: active
```

Verified live:

- MCP exposed its tool set (26 at the time of this 2026-06-11 record; 137 tool registrations in source today — see MCP Tool Groups above).
- Required instance tools were present.
- `subscribe_agent` returned the existing active instance.
- `add_instance_knowledge` saved a document to that private instance.
- `list_instance_knowledge` returned the saved document.
- `chat_with_instance` hit the private instance path.
- `instance_messages` contained the smoke-test prompt.
- The chat response correctly requested caller-owned Workers AI credentials.

## Troubleshooting OAuth

If `mcp-remote` waits at authorization or times out with:

```text
MCP error -32001: Request timed out
```

check the browser approval page first. The flow waits until the user approves the "Connect ProAgentStore MCP" page.

If approval was completed but the callback still does not return, clear stale `mcp-remote` auth state for this MCP server. The local auth cache is under:

```text
~/.mcp-auth/mcp-remote-0.1.37/
```

For this MCP server, stale files use the server hash:

```text
e9453613c36d30febd996eb96862ce53
```

Back up before removing anything:

```bash
ts=$(date +%Y%m%d%H%M%S)
mkdir -p ~/.mcp-auth/backup-$ts
mv ~/.mcp-auth/mcp-remote-0.1.37/e9453613c36d30febd996eb96862ce53_* ~/.mcp-auth/backup-$ts/
```

Then reconnect:

```bash
npx mcp-remote https://mcp.proagentstore.online/mcp
```

## Deployment

MCP deploys through:

```text
.github/workflows/deploy-mcp.yml
```

The workflow typechecks `workers/mcp`, deploys with Wrangler, and smoke-tests `/health`.
