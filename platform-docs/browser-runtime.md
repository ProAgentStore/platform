# ProAgentStore Browser Runtime

Runtime-backed agents use `pags up`, which runs local browser and CLI capabilities from `packages/browser-runner`.

The current PAGS runtime pattern is:

```text
Workflow brain -> callRunner() -> RelayDO -> WebSocket -> local runner -> browser/tmux
```

The cloud-hosted workflow is the brain. The local runner is the hands. This keeps account state, audit, and orchestration in ProAgentStore while browser sessions, local files, and CLI sessions stay on the user's machine.

## Connectivity Modes

`pags up` connects outbound to the ProAgentStore WebSocket relay. The local machine does not need to expose an inbound port.

```text
ProAgentStore Workflow
  -> RelayDO
  -> outbound WebSocket
  -> local browser runner
  -> Playwright browser or tmux CLI
```

Cloudflare Tunnel remains a fallback/debug path for older runtime registrations, but the default model is outbound WebSocket relay.

## Brain vs Hands

The workflow brain runs in ProAgentStore. The hands run locally.

| Piece | Where It Runs | Responsibility |
| --- | --- | --- |
| Brain | Cloudflare Workflow | Plans steps, manages durable task state, checks policy, requests approval |
| Relay | RelayDO WebSocket relay | Carries scoped calls between the cloud workflow and local runner |
| Hands | Local `pags up` runner | Drives Playwright browser actions or tmux CLI sessions |
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

Coder agents use the same runtime idea, but the local capability is a tmux-backed CLI session rather than a browser.

```text
Workflow brain -> RelayDO -> local runner -> tmux CLI session
```

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
