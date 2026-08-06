# ProAgentStore Browser Runtime

Runtime-backed agents use `pags up`, which runs local browser and CLI capabilities from `packages/browser-runner`.

The current PAGS runtime pattern is:

```text
Workflow brain -> callRunner() -> RelayDO -> WebSocket -> local runner -> browser/terminal
```

The cloud-hosted workflow is the brain. The local runner is the hands. This keeps account state, audit, and orchestration in ProAgentStore while browser sessions, local files, and CLI sessions stay on the user's machine.

## Connectivity Modes

`pags up` connects outbound to the ProAgentStore WebSocket relay. The local machine does not need to expose an inbound port.

```text
ProAgentStore Workflow
  -> RelayDO
  -> outbound WebSocket
  -> local browser runner
  -> Playwright browser or terminal CLI
```

The outbound WebSocket relay is the only transport. The earlier Cloudflare Tunnel / cloudflared modes were removed — there is no tunnel fallback, no `--tunnel` flag, and no public inbound server. The runner mints a short-lived, instance-scoped relay token and opens `wss://…/v1/relay/:instanceId/connect`; that endpoint accepts **only** the relay token, never the 30-day account JWT, so a leaked relay URL cannot become account takeover. The relay DO is keyed per (instance, node) and hibernates when idle.

## What `pags up` Serves

One process, every eligible agent. An instance is eligible when its resolved `capabilities.runtime` is non-null (`browser` or `coding`); cloud-only chat, RAG, and connector agents are skipped and never need a runner at all.

Membership is re-evaluated while the runner is up, not fixed at startup. `pags up` passes `--watch-instances` (CLI ≥ 0.4.30), which polls `/v1/instances/my/instances` every 20 seconds and attaches newly eligible instances — registering the runtime and opening a relay socket for each — and detaches ones that stopped being eligible. Subscribing to a coding agent no longer requires restarting the runner. It polls rather than receiving a push because a brand-new instance has no socket for the server to push over.

| Flag | Effect |
| --- | --- |
| `--headless` | Run Playwright headless. |
| `--instance <id>` | Serve exactly one agent, by id or slug. Debug scope: this run does **not** watch for new instances. |
| `--force` | Take over when this same machine (same hostname/node) already has a runner connected. Also suspends coding sessions still owned by other nodes; the machine's own suspended sessions reactivate on reconnect. |

The only 409 is same-hostname: a second runner on the same node is rejected unless `--force`. Several *different* machines can each run `pags up` for the same instance concurrently, and routing follows whichever relay socket is actually live.

## Brain vs Hands

The workflow brain runs in ProAgentStore. The hands run locally.

| Piece | Where It Runs | Responsibility |
| --- | --- | --- |
| Brain | Cloudflare Workflow | Plans steps, manages durable task state, checks policy, requests approval |
| Relay | RelayDO WebSocket relay | Carries scoped calls between the cloud workflow and local runner |
| Hands | Local `pags up` runner | Drives Playwright browser actions or terminal CLI sessions |
| Browser/session | User machine | Keeps cookies, local files, active logins, and interactive handoff state |

## Browser-Capable Agents

Browser-capable agents are useful when a task needs:

- saved browser logins
- real page interaction
- file uploads and downloads
- manual handoff
- long-running task state
- screenshots or browser event traces

The Job Application Assistant is the reference browser-capable agent. Its Cloudflare Workflow brain drives a local Playwright browser through snapshot/action steps and can pause for user approval.

## Coder Agents

Coder agents use the same runtime idea, but the local capability is a coding CLI rather than a browser.

The runner starts that CLI as a **child process** and speaks to it directly — Claude Code over its structured `stream-json` interface (real turn events, so "is it still thinking?" is a fact rather than a regex guess), and any other engine as a raw spawn with stdout capture. It is **not** a tmux pane, and the terminal view is not a scraped TUI. Re-attaching after a runner restart works because Claude Code persists its session to `~/.claude`, so the runner re-spawns with `--resume <session id>`; tmux is not involved.

```text
Workflow brain -> RelayDO -> local runner -> coding CLI child process (stream-json)
```

tmux *is* still used on this platform, but by a different family: the **terminal connector**, which drives tmux, kitty or iTerm2 targets on the user's machine for terminal-operator agents. Those create real tmux sessions; Coder agents do not.

This allows long-running coding sessions while preserving the account-level control plane and audit model.

Coder also supports multiple connected machines for the same private instance. Each session is pinned to the runner node that owns it, so different repos can run on different machines concurrently. See [Coder Multi-Machine Runtime](coder-multi-machine.md).

## Safety Rules

- The runner must authenticate to ProAgentStore.
- Runtime tasks are scoped to a private instance.
- Destructive actions require explicit confirmation where supported.
- Browser tasks can require approval before final submission.
- Local files and browser profiles stay local unless the user intentionally uploads or imports content.

## When Not To Use A Browser Runtime

Most server-only agents should use hosted Worker execution or standard instance chat. Do not require `pags up` for agents that only need text processing, API calls, knowledge search, or document drafting.
