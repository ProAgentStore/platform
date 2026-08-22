# Coder Multi-Machine Runtime

You can connect more than one local machine to the same private agent instance. Each machine runs `pags up` and registers as a **runner node**, usually under its hostname.

Machine placement is a **platform** primitive, not a Coder feature: any agent that declares a local runtime — Coder, the Job Application Assistant, a terminal-operator agent — is bound to a machine the same way, and every runner call (chat tools, apply steps, coding sessions) routes there. Coder is simply the agent where it matters most, because a repo checkout only exists on one laptop.

## What This Enables

- Keep a desktop and a laptop connected to the same instance.
- Run different repo sessions on different machines at the same time.
- Preserve account-level authorization, audit, and workflow state in ProAgentStore.
- Keep local files, browser profiles, CLI logins, and coding sessions on the machine where they run.

One repo still has at most one active session, so two coding engines cannot fight over the same working tree and git index.

## Choosing The Machine — The "Runs On" Picker

The console **Settings** tab shows a **Runs on** picker: one tile per machine you run `pags up` on, and clicking a tile binds this agent to that machine. This is shipped UI, not planned work.

Each tile carries the machine's live state:

| Tile state | Meaning |
| --- | --- |
| **Attached · online** | The machine is up *and* this agent holds a live relay socket on it. |
| **Online · agent not attached** | The machine is running a runner for other agents, but not for this one. |
| **Offline** | No runner is running on that machine. |

The picker is backed by `GET /v1/instances/:id/runner-node`, which returns the current pin plus a per-node detail list:

```json
{
  "runnerNode": "my-laptop",
  "nodes": ["my-laptop", "desktop"],
  "nodesDetail": [
    { "node": "my-laptop", "connected": true,  "nodeOnline": true },
    { "node": "desktop",   "connected": false, "nodeOnline": true }
  ]
}
```

`connected` is *this agent's own* relay socket. `nodeOnline` is machine-level: whether that hostname holds a live socket for **any** of your instances. Reporting both is what lets the console distinguish "the machine is off" from "the machine is on but this agent never attached to it" — two problems with different fixes.

`PUT /v1/instances/:id/runner-node` with `{"runnerNode": "my-laptop"}` pins; `{"runnerNode": null}` clears the pin. The pin is stored as `config.runnerNode` on the instance and written as a single-key patch, so saving it cannot clobber a settings or behaviour change made from another tab.

## A Machine Is Not Its Hostname

`runner_node` is the machine's hostname, and a hostname is not stable — on macOS it follows the network-supplied name and flips between the `.local` mDNS form and whatever DHCP hands out. One laptop therefore used to appear as several machines in the picker, and an agent pinned to a name it had stopped using reported offline while `pags up` was running on it.

The hostname keeps its job — it is the routing key and it names the relay Durable Object — and a **stable machine id** now rides alongside it. The CLI mints one on first use and keeps it in `~/.config/proagentstore/machine.json` next to your session, together with the hostnames this machine has answered to.

- **The picker shows machines, not names.** Hostnames proven to belong to one machine collapse into a single tile under the freshest name.
- **A pin made under an old name keeps working.** When the pinned hostname is dead, routing looks for a node carrying the same machine id and uses that. This is not a fallback to another machine: sameness is a recorded fact, not a guess. `GET /v1/instances/:id/runner-node` reports it as `resolvedNode`, and the console says so and offers a one-click repin rather than repointing your agent silently.
- **Unknown identity fails closed.** Registrations from before this landed — and from any CLI that does not send an id — carry none, so nothing is merged and nothing heals. Those pins behave exactly as they always have, and the console names the dead pin and the machine that *is* up instead of prescribing `pags up` to someone already running it.

Rows written under an old hostname are adopted the next time that machine registers while remembering that name, which is how a pin stranded by a rename reconnects without you renaming anything.

## Routing Follows The Live Socket

Placement resolution is deliberately conservative in one direction and forgiving in the other.

**Pinned is authoritative.** If the instance is pinned to a machine, that machine is the only candidate. When its relay socket is not live, the agent reports **offline** — it does not quietly run somewhere you did not choose, and it does not report a different machine as online on its behalf. Start the runner on that machine, or pick another tile.

**Unpinned follows whatever is live.** With no pin, routing resolves to a machine whose relay socket is connected *right now*. It never trusts the stored runtime `status` column, which is not cleared on an unclean disconnect — a laptop lid closed mid-session still reads "registered" in the database. The relay Durable Object holds the socket and is the only source of truth.

**A session reclaims itself on a machine switch.** A coding session is pinned to the node that started it. If that machine has gone away and you drive the session from another connected machine, the session is relocated to the live one and continues there rather than dead-ending. A session pinned to a machine that is still live stays put.

**What moves with it, and what does not.** The session, its history and its work move. The *engine's own* conversation does not: a CLI like Claude Code keeps its transcript in its own store on the machine that ran it, and no database row can carry that across. So the engine on the new machine starts a new conversation — and it does not start empty. ProAgentStore seeds it with a **context brief** reconstructed from its own record of that repository: the instructions that were sent, what the engine did and how the turns ended.

That is continuity of understanding, not the original context. The brief does not carry file contents, the engine's tool state, or anything it worked out without saying — and the console says so on the open rather than implying the conversation survived. The same brief is used anywhere an engine would otherwise start cold: a different engine, a conversation too old to continue, or a machine whose CLI store has been cleared. Starting genuinely clean happens only when you ask for it with **Fresh**.

## Why This Agent Is Not Attached

When an agent has no live socket, the runtime status reports a diagnosis and the single command that fixes it:

| State | What happened | Fix |
| --- | --- | --- |
| `never-registered` | No runner has ever registered for this agent. | `pags up` |
| `runner-offline` | It registered, but the machine stopped heartbeating (older than ~90s — three missed beats). | `pags up` |
| `machine-online-agent-detached` | The machine is demonstrably alive and heartbeating, but this agent holds no socket — usually another runner on the same hostname already claimed it and this one was rejected. | `pags up --force` |
| `pinned-machine-offline` | This agent is pinned to a machine that is not connected, while a *different* machine of yours is. | No command — change **Runs on**, or start the runner on the pinned machine. |

`pags up` is the wrong advice in the third case, which is exactly the case that used to show an unexplained amber dot. It is wrong in the fourth too, and so is `--force`: the runner is already running, on the other machine.

The liveness this diagnosis is built on is **pin-aware**. A machine the pin excludes never contributes to `relay.connected`, so the status endpoint cannot report a live socket that belongs to a machine this agent would not route to. All three are derived server-side from "is there a runtime row", "is its heartbeat fresh", and "is a relay socket live", so no CLI upgrade is needed to see them.

## How It Works

```text
runner call (chat tool / apply step / coding session)
  -> resolved runner node (pin, else whichever socket is live)
  -> node-scoped RelayDO
  -> outbound WebSocket
  -> local pags up runner
  -> coding engine child process, browser, or terminal
```

Relay names are node-aware:

```text
default relay: <instance_id>
node relay:    <instance_id>:node:<runner_node>
```

Two tables back this. `instance_runtimes` holds the legacy default runtime for the instance, which older clients and non-node-aware paths still use. `instance_runtime_nodes` holds one row per connected machine — with the machine id alongside the hostname — and is what the picker and the Terminals page enumerate.

## User Flow

1. Install and sign in to the CLI on each machine (`npm i -g @proagentstore/cli`, `pags login`).
2. Run `pags up` on each machine you want available.
3. Open the instance in the console, go to **Settings**, and pick a machine under **Runs on**.
4. Add or open a repo and start a coding session.
5. The session stays pinned to that machine unless it goes away, in which case driving it from another connected machine relocates it.

Subscribing to a new agent does **not** require restarting the runner: `pags up` re-reads your eligible instances every 20 seconds and attaches new ones (CLI ≥ 0.4.30). See [Browser Runtime](browser-runtime.md).

## Operational Notes

- Several *different* machines can run `pags up` for the same instance concurrently. That is not a conflict and needs no flag.
- The only rejection is same-hostname: a second runner on a node that already holds the socket is closed with code `4409` unless you pass `--force`.
- `--force` also suspends coding sessions still owned by other nodes; the machine's own suspended sessions reactivate when it reconnects. History is preserved either way.
- Coding history is stored per repo, not per session, so ending a session does not lose it: `GET /v1/instances/:id/coding/repos/:repoId/timeline` returns the repo's whole history with session boundaries marked.
- Coding sessions are child processes, not tmux panes. A session's `engineLabel` is `<engine>:<session id>`; the `coding_sessions.tmux_session` column keeps its old name for compatibility but stores that label, and there is no tmux session to attach to. See [Browser Runtime](browser-runtime.md#coder-agents).
