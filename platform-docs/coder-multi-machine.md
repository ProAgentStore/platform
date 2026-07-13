# Coder Multi-Machine Runtime

Coder can connect more than one local machine to the same private Coder instance.

Each machine runs `pags up`. ProAgentStore records the machine as a runner node, usually using the local hostname. New coding sessions are pinned to the runner node that owns them. Later terminal capture, manual messages, autonomous Loop runs, restarts, and end-session calls route back to that same node.

## What This Enables

- Keep a desktop and laptop connected to the same Coder instance.
- Run different repo sessions on different machines at the same time.
- Preserve account-level authorization, audit, and workflow state in ProAgentStore.
- Keep local files, browser profiles, CLI auth, and tmux sessions on the machine where they run.

One repo still has at most one active session. That prevents two coding CLIs from fighting over the same working tree and git index.

## How It Works

```text
Coder session
  -> stored runner node
  -> node-scoped RelayDO
  -> outbound WebSocket
  -> local pags up runner
  -> tmux CLI session
```

The legacy instance runtime row remains the default runtime for browser/apply behavior and older clients. Coder adds node-level runtime rows for machine-specific routing.

```text
instance_runtimes
  default/legacy runtime for the instance

instance_runtime_nodes
  one row per connected Coder machine
```

Relay names are node-aware:

```text
default relay: <instance_id>
node relay:    <instance_id>:node:<runner_node>
```

## User Flow

1. Install and sign in to the CLI on each machine.
2. Run `pags up` on each machine you want available to Coder.
3. Open the Coder instance in the console.
4. Add or open a repo and start a coding session.
5. The session stays pinned to the runner node where it started.

Current UI behavior starts new sessions on the default/latest connected runner. The API already accepts a specific `runnerNode`; the remaining UI work is to show connected nodes and let users choose the node when starting a new session.

## Operational Notes

- `pags up --force` is no longer required just because another Coder machine is online.
- Use `--force` only when replacing a stale relay socket during debugging.
- If the owning node is offline, session commands report the runner as disconnected instead of silently sending work to another machine.
- Browser/apply agents still use the default instance runtime until they get their own placement picker.
