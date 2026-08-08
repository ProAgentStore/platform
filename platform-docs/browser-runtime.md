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

### The generic browser task

Job-apply's engine is not job-specific. `BrowserTaskWorkflow` drives the same snapshot/act loop toward an arbitrary `{url, objective}` (`POST /v1/instances/{id}/browse`), and an agent opts into it by declaring `runtime: "browser"` and `workflow: "BROWSER_TASK"` — no monorepo code per agent.

The objective is composed, not typed: the agent's `identity.goal` supplies the standing instruction, and the subscriber's typed settings are rendered underneath it. `config.browserTask.startUrlSetting` names which setting holds the start URL, so the page to visit is configured once in the console rather than retyped on every manual run and duplicated into every cron trigger's config.

All three handoffs come from the shared loop and behave identically to apply:

| Reason | Trigger | What the subscriber sees |
| --- | --- | --- |
| `challenge` | The page snapshot reports a captcha, 2FA or security check | Live takeover — solve it in the real browser; the run resumes itself |
| `stuck` | Repeated failures on one control | Take over that single step, then Resume |
| `needs_input` | The brain calls `request_user_info` | An input box; the value is saved and the run continues |

The brain is told never to sign in and never to invent a value — a missing answer is a handoff, not a guess.

### Read-only browser agents

`config.browserTask.readOnly` makes "this agent only ever observes" a runtime property rather than a prompt instruction. Declared on the **agent row**, it is read from there and nowhere else — not the request body, not the trigger config, not the instance config — so a subscriber, a cron config, or the model itself cannot clear it. The workflow's act layer refuses every committing click (`blockedActionReason`) before it reaches the page.

This is what makes it reasonable to point an agent at a real logged-in account: the blast radius of a wrong decision is a wasted step rather than a payment.

Two limits worth stating, because an unverifiable safety claim is worth nothing:

- The guard covers committing **clicks**. Typing and Enter are not blocked, because a watcher needs a search box — so the guarantee is "it cannot click Pay", not a formal sandbox.
- It is fail-safe by design, so a filter button literally labelled "Apply" is refused too. Refusing a harmless click is the cheap error.

`readOnly` and the per-run `dryRun` share one commit-verb guard on purpose: two guards would eventually disagree about what "committing" means, and the weaker one would be the hole. `readOnly` wins when both are set, so a permanent property is never described to the model as a rehearsal it could retry.

**Portal Watch** (`portal-watch`, migration 0087) is the first-party agent built on this. It reads the accounts that only tell you things after you log in — energy, rates, an insurance renewal, a case status, a supplier portal — in the subscriber's own signed-in browser, and reports the actual figures and dates. It exists entirely as seed data: declared capabilities, two typed settings, and a goal. There is no portal-watch code in the monorepo, so a sibling (a shipment tracker, a case-status watcher) is another row, not another PR.

Paired with a `run_browse` cron trigger it does the round unattended. A run that finds nothing new still costs a run — change detection and notify-on-change are deliberately **not** built here; the right shape for them is a `browse` pipeline step feeding `dedupe_upsert` with `emitOn: "update"` into the delivery pump, which belongs with opening the step vocabulary rather than in a bespoke branch of the workflow.

## Coder Agents

Coder agents use the same runtime idea, but the local capability is a coding CLI rather than a browser.

The runner starts that CLI as a **child process** and speaks to it directly — Claude Code over its structured `stream-json` interface (real turn events, so "is it still thinking?" is a fact rather than a regex guess), and any other engine as a raw spawn with stdout capture. It is **not** a tmux pane, and the terminal view is not a scraped TUI. Re-attaching after a runner restart works because Claude Code persists its session to `~/.claude`, so the runner re-spawns with `--resume <session id>`; tmux is not involved.

```text
Workflow brain -> RelayDO -> local runner -> coding CLI child process (stream-json)
```

### What a session remembers

A session is closed automatically after **six hours** with nothing touching it — a `claude` child process resident on your laptop indefinitely, one per repo, is the cost that buys. Whatever needs the session next simply opens a new one, so you never have to think about that.

What the new session **starts with** is a decision the platform makes and states:

- The previous conversation on that repo was used **within the last four days** → it continues where it left off.
- Older than that, or a different engine, or a session whose engine never launched → it starts clean.

The two windows measure different things on purpose. Six hours asks "is anyone looking right now?", and is deliberately shorter than a night so a session abandoned at the end of the day does not hold a process until morning. Four days asks "is this still the same piece of work?", and is long enough to cover a long weekend — the cost of continuing a stale conversation is tokens, paid on every turn.

Either way the agent tells you which one happened on the turn it happens, and it only claims to have continued a conversation when the machine confirms it did. Two caveats worth knowing rather than discovering: a conversation only exists on the machine that held it, so opening the repo on a different laptop starts clean; and continuing requires `pags up` from **0.4.44** or later.

tmux *is* still used on this platform, but by a different family: the **terminal connector**, which drives tmux, kitty or iTerm2 targets on the user's machine for terminal-operator agents. Those create real tmux sessions; Coder agents do not.

This allows long-running coding sessions while preserving the account-level control plane and audit model.

Coder also supports multiple connected machines for the same private instance. Each session is pinned to the runner node that owns it, so different repos can run on different machines concurrently. See [Coder Multi-Machine Runtime](coder-multi-machine.md).

## Safety Rules

- The runner must authenticate to ProAgentStore.
- Runtime tasks are scoped to a private instance.
- Destructive actions require explicit confirmation where supported.
- Browser tasks can require approval before final submission.
- An agent declared `readOnly` cannot perform a committing click at all; the refusal is enforced in the workflow, not requested in the prompt.
- Local files and browser profiles stay local unless the user intentionally uploads or imports content.

## When Not To Use A Browser Runtime

Most server-only agents should use hosted Worker execution or standard instance chat. Do not require `pags up` for agents that only need text processing, API calls, knowledge search, or document drafting.
