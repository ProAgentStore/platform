# Coder Multi-Machine Runtime

Status: implemented for local Coder runners, July 2026.

## Problem

Coder sessions run on a user's local `pags up` process. Before this change, each
agent instance had one registered runtime row and one relay Durable Object keyed
by `instance_id`. A second machine could take over with `--force`, and sessions
were stamped with `runner_node` so they could be suspended/resumed, but the cloud
could not route session A to one machine and session B to another at the same
time.

That model is good for handoff. It is not true multi-machine support.

## Target Model

Keep the existing instance runtime row as the default browser/apply runtime, and
add node-level runtime records for Coder:

```text
instance_runtimes
  instance_id          default/legacy runtime for browser/apply

instance_runtime_nodes
  instance_id
  runner_node          local machine identity, usually hostname
  endpoint/token/...   same runner connection material as instance_runtimes
```

Relay Durable Object names become node-aware for Coder:

```text
legacy/default relay:  <instance_id>
node relay:            <instance_id>:node:<runner_node>
```

Every new coding session stores the runner node that was current when it was
created. Later commands resolve the session, read `session.runner_node`, and send
the command to that machine's relay. A legacy session with no `runner_node` falls
back to the default instance runtime.

## Product Semantics

- Multiple machines may be connected to the same Coder instance at once.
- A repo still has at most one active session, because a session owns one working
  tree and git index.
- Different repos can run on different machines concurrently.
- Existing browser/apply agents keep using the default instance runtime until
  they get their own placement model.
- `pags up --force` remains useful for replacing the same node's relay socket or
  taking over the default runtime, but it is no longer required just because
  another Coder machine is online.

## Routing Rules

1. Registering a runner with `runnerNode` upserts both:
   - the legacy/default `instance_runtimes` row for compatibility
   - the node row in `instance_runtime_nodes`
2. Relay connect includes `?node=<runner_node>` and uses the node relay name.
3. Creating a coding session stamps `runner_node` from the registering machine.
4. Capture, act, restart, end, co-pilot inspection, and workflow calls route to
   the session's node.
5. If the node is offline, the API returns a runner-disconnected result instead
   of silently sending to another machine.

## Implemented Pieces

1. `instance_runtime_nodes` migration stores per-machine runtime records.
2. Runtime helpers can upsert, read, list, heartbeat, and route to node rows.
3. Relay connect/status accepts `node=<runner_node>` and uses a node-scoped
   Durable Object name.
4. The CLI registers and heartbeats with `runnerNode=hostname()` and includes
   `node=hostname()` in the WebSocket relay URL.
5. Coder routes and workflows call `getRunnerConn(..., runnerNode)` for
   session-scoped operations.

## Remaining UI Work

- Show connected runner nodes in the Coder console.
- Let users choose the runner node when starting a new repo session.
- Show per-session runner ownership in diagnostics and status pages.
