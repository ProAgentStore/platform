# AGENTS.md

## ProAgentStore Access Rules

Use ProAgentStore account state only through the configured MCP server.

- Do not use the ProAgentStore web UI for account actions unless the user explicitly asks.
- Do not call private REST, GraphQL, database, or worker APIs directly unless the user explicitly overrides this rule.
- First inspect available MCP tools/resources before choosing an action. The surface is
  per-connection — some tools are gated to the console surfaces of the agents the connected
  user actually subscribes to, so call `tools/list` rather than assuming a name exists.
- Prefer read-only tools unless the task explicitly requires changes. You do not have to
  guess which those are: every tool carries `readOnlyHint` / `destructiveHint` annotations,
  and they are accurate — `readOnlyHint: true` means the tool only reads.
- Use `dry_run: true` before uncertain write/runtime/destructive actions.
- Confirm before destructive actions such as cancelling instances, deleting knowledge, unregistering runtimes, cancelling tasks, or overwriting files.
- Use the exact `confirm` value required by the MCP tool schema.
- Use `mcp_audit_log` when the user asks what MCP actions were attempted or completed.
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

Use the runtime flow when work has to happen on the user's own machine — a browser acting
on a real site, or a coding CLI in a real checkout. The runner reaches the platform over a
WebSocket relay, so "is a runtime registered" is a question you must ask, not assume:

```text
subscribe_agent -> register_instance_runtime -> instance_runtime_status -> run_instance_task -> approve_instance_task -> instance_task_events
```

## Reading results

The server sends `instructions` on `initialize`. Read them: they are the server's own
statement of how it expects to be driven, and they are maintained with the tool surface.

Two tools return a **structured object, not a bare array** — this is the shape to code
against:

```text
list_agents   -> {"agents": [...]}
my_instances  -> {"instances": [...]}
```

Both also declare an `outputSchema` and answer with `structuredContent`. Every other tool
returns a single text content block.

Failure is detected structurally, not by reading prose. This server does not set `isError`.
A failure is either text beginning `Error: `, or JSON carrying an `error` key. Check both;
treat anything else as success.

## Vocabulary that decides an action

Four distinctions the platform makes and a caller routinely collapses. Getting one wrong
produces a confident, wrong report about someone's agent.

- **`mutates` is the field that answers "does this change anything"** — not `scope`. `scope`
  is what triggers the write-consent gate; the two are separate questions and a read can
  carry a write scope. Read `mutates`.
- **`reach` answers "does this touch anything outside the platform"**: `platform` (never
  leaves), `machine` (the owner's computer), `internet` (a third party, or any host the
  caller names). Do not derive this from whether a tool names a connector — that proxy is
  wrong in both directions. It fails closed: an unclassified tool reports `internet`.
- **`tier` has four values**, not two: `base` (always granted), `standard`
  (creator-selectable), `runtime` (needs a local runner), `connector` (external system).
- **A run's `health` has four values**: `working`, `waiting`, `stalled`, and `ended`.
  `ended` means the run is CLOSED and makes no claim that anything is running — and since
  it is returned for any run that is not `running`, it is the answer you will see most
  often. Quote `health`; do not derive your own verdict from `status` or from timestamps.
  `lastAliveAt` (a heartbeat) and `lastProgressAt` (the last instruction advance) are
  different facts: a healthy long step looks stale on the second and fresh on the first.
  A parked run carries `waitingReason`, and `waitingUntil` only when a resume time is
  actually knowable — a run waiting on a *person* has no such time.
