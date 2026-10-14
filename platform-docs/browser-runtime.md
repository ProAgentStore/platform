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

## Foreground and background (`pags up --background`)

`pags up` is a **foreground** process by default, and stays that way. Its window is where you see what it is doing (`l` shows its log), and closing it, or pressing `q`, stops the runner. Leave it open the way you would a dev server.

`pags up --background` (CLI ≥ 0.4.125, #499) is the **opt-in** alternative. Use it when you want the runner to keep serving your agents with no terminal open. It never becomes the default.

- **What it serves is exactly what a foreground `pags up` here would serve.** The discovery, the "Runs on" pin rule, `--instance`, `--headless` and `--force` all behave the same. It also watches for newly eligible agents unless it was started with `--instance`. `pags status` lists the agents it attached at start.
- **There is one runner per account per machine, in either mode.** The background runner holds the same single-instance lock as a foreground one. Starting a second one, in either mode, is refused with who holds it. `pags up --replace` takes over from either mode gracefully.
- **It reports success only once the runner is actually up.** It waits until the detached runner holds the lock and answers its own health check. If the runner stops first, you get the tail of its log and exit code 1.

| Command | What it does |
| --- | --- |
| `pags up --background` | Start the runner detached. The terminal can then be closed. |
| `pags status` | Whether a runner is running here for your account, its pid, uptime, CLI version and launch kind (`background`, terminal, tmux, service). For a background runner it also shows what it serves and its log path. Exit code 0 when running, 1 when not. |
| `pags logs [-n N] [-f]` | The background runner's log, `~/.config/proagentstore/logs/runner-<hash>.log`. A log over 5 MB is moved to `.1` at the next start. |
| `pags down` | Stop it. It drains running work first; `--now` stops it immediately. |

**What it does NOT do.** It does not start at login or boot, and it does not restart after a crash. It runs until `pags down`, a crash, logout or a reboot. A runner that drives your real browser profile and spawns coding CLIs with your shell's credentials should come back by itself only if you set that up deliberately. A login item (a per-user LaunchAgent) is a separate step that has not been built yet. A remote update (`runner_update`) does restart it, on the new release, with the same flags.

The console's machine view receives the launch kind with each heartbeat, so a background runner reports itself as `background` rather than as a terminal. Showing that on the Terminals page is a follow-up.

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

The Job Application Assistant is the reference browser-capable agent. Its Cloudflare Workflow brain drives a local Playwright browser through snapshot/action steps and submits completed applications autonomously. It pauses only when a human must solve a captcha/security check, operate a stuck control, or supply a fact the saved Profile does not contain.

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

### Local CLI browser research (`runtime: "local_browser"`)

A separate runtime from the Workflow-driven browser task above. A locally signed-in Codex or Claude Code CLI drives the browser, using its subscription and no API key. It works through a bridge inside the runner that offers only read-only tools: open a page, go back, read the page, wait, and click links or pagination. It needs no repository. The runner enforces the rules itself, whatever the model asks for. A run stops for the owner on these pages:

| Pause | What triggers it | What the owner does |
| --- | --- | --- |
| `consent_required` | A site that is not on the allow list, or the signed-in browser profile | Allow it and resume, or stop the run |
| `captcha` / `login_required` | A captcha, or a page with a password field | Clear it in the browser on that machine, then resume. The run never signs in |
| `paywall` | A page asking to subscribe, or saying a free-article limit has been reached | If you subscribe, sign in yourself in that browser and resume. Otherwise stop, or let the pause end: the source is reported and the run never gets around it |
| `access_blocked` | A bot check or access-control page ("unusual traffic", "Access Denied", 403) | Pass a human check in that browser and resume, or leave it. The run reports a block that is still there; it never retries past it |
| `write_affordance` | A form that submits, pays or uploads: an application, card fields, a file input, or an account sign-up | Let it read the page and resume, or stop and it goes back. Nothing on the page can be filled or submitted in either case |

A run whose CLI exits without ever calling the bridge ends `failed`, saying no page was opened. A Codex run needs a runner on CLI 0.4.74 or newer, because older runners cannot approve the bridge's tools for `codex exec`. Preflight flags an older runner, and a start on one ends at once as `runner_unsupported`, naming the update or the switch to Claude Code.

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

**And yes, a terminal-operator agent can be pointed at a pane that is running a coding CLI.** That is the second, supported way to drive `claude` or `codex` from this platform, and it is a genuinely different trade rather than a lesser Coder: you get a real terminal you can `tmux attach` to and send keystrokes into, and you give up measurement — a pane holds rendered text, not the structured `result` event a child-process engine reports its own tokens and cost from, so those drives are recorded as **unmetered** and never appear as a figure on the Usage page. A `$0` there means *not measured*, not *free*. The turn boundary is inferred from rendered text rather than signalled by the engine, and the merge-policy enforcement Coder repos get does not apply. The full comparison, and why the split is settled rather than provisional, is in [`docs/coding-engines.md` → "Two ways to drive a CLI"](https://github.com/ProAgentStore/platform/blob/main/docs/coding-engines.md) and [ADR 0003](https://github.com/ProAgentStore/platform/blob/main/docs/adr/0003-a-coder-engine-reports-its-own-turns.md).

This allows long-running coding sessions while preserving the account-level control plane and audit model.

Coder also supports multiple connected machines for the same private instance. Each session is pinned to the runner node that owns it, so different repos can run on different machines concurrently. See [Coder Multi-Machine Runtime](coder-multi-machine.md).

## Safety Rules

- The runner must authenticate to ProAgentStore.
- Runtime tasks are scoped to a private instance.
- Destructive actions require explicit confirmation where supported.
- Browser tasks can require approval before final submission.
- An agent declared `readOnly` cannot perform a committing click at all; the refusal is enforced in the workflow, not requested in the prompt.
- Local files and browser profiles stay local unless the user intentionally uploads or imports content.

## Replay screenshots

Every browser run can be played back afterwards in the console (#1063): a JOB_APPLY or BROWSER_TASK
workflow task, a Scout's research run, and an Application Runner fill. They share one contract — a
screenshot is stored evidence addressed by its run (`runtime_task`, `local_browser_run`,
`local_apply_run`), its bytes are kept in owner-scoped storage, and they are only served through
`GET /v1/instances/:id/browser-artifacts`, which checks the instance, the frame and the run all belong
to the caller. They are not exposed over MCP.

- **The runner takes them, never the model.** Frames are captured at fixed points — after a
  navigation, an accepted click, a page read or wait, a pause or blocker, and at completion; on an
  application run also after a fill, an upload, a checkpoint, review and a submit. `browser_take_screenshot`
  stays refused to the CLI.
- **Form controls are blurred.** Before every frame the runner blurs every input, textarea, select and
  editable region, and removes the blur straight after. If the blur cannot be confirmed, no frame is
  taken. This applies to research runs as well as application runs.
- **The trace stays redacted.** It records only that a frame exists (`screenshot.captured`, with its
  sequence number and capture point) — never the image, page text, form values or typed values. Stored
  metadata is the capture point, the page URL without its query or fragment, its domain and an action
  class.
- **Bounded.** At most 60 frames per research run and 40 per application run, viewport only, each frame
  capped in size, held in the runner's memory until the cloud pulls it. Research frames are kept as long
  as the run's trace (default 30 days); workflow tasks and application runs, 30 days. Screenshots taken
  before this contract (`runshot/`) are still served as they were.

### Turning screenshots off

Screenshots are **on** by default. An owner can turn them off for one agent (#1064): **Settings → Browser
screenshots** in the console, `PUT /v1/instances/:id/browser-screenshots {"enabled": false}`, or the MCP
tool `set_browser_screenshots`. One switch covers every browser run the agent makes — workflow tasks,
research runs and Application Runner fills.

- **Fixed when a run starts.** The run records the value it started with, so switching mid-run never
  changes a run already going. Turning screenshots off deletes nothing already stored; earlier frames
  expire on their normal retention.
- **Off means no frame anywhere.** The runner is told not to capture (no recorder, `screenshot: false` on
  every browser action); the cloud does not pull frames for an off run, even from an older runner that
  ignored the flag; and the store refuses a frame for any run that recorded off. Each layer holds on its
  own.
- **What remains is metadata only.** The run's trace still records every navigation, action, pause and
  result, and says that screenshots were off and why (`screenshots: "off"`, reason `owner_setting`) —
  never a frame. The replay shows "Screenshots were off for this run" instead of an empty player.
- Changing the switch is audited (`browser_screenshots.changed`).

## When Not To Use A Browser Runtime

Most server-only agents should use hosted Worker execution or standard instance chat. Do not require `pags up` for agents that only need text processing, API calls, knowledge search, or document drafting.

## Browser verification and takeovers

An agent that declares a local browser (`capabilities.runtime: "local_browser"`) can verify pages the
server cannot fetch, in the owner's own browser. Each instance chooses, in **Settings → Browser
verification** or with `set_instance_browser_verification`:

- **enabled**: on only for an agent that declares the capability. The setting turns a declared
  capability on; it never adds one.
- **runtime**: `pinned` (only the machine the agent is pinned to) or `any_eligible` (any eligible
  machine, the pinned one first). `list_eligible_browser_runtimes` shows each machine's heartbeat,
  attachment (transport only), health and CLI version, apart from each other.
- **fallback** when no eligible machine is available: `wait` (up to `waitLimitMinutes`) or
  `mark_unverifiable`.
- **takeover**: `prompt` asks the owner to take over when a run needs a person; `never` ends that
  attempt instead. **allowMobile** says whether a takeover may be answered from a phone.

The machine pin, site consent and notifications are set where they always were. A paused run's
**takeover** is recorded before any remote control is shown, and moves `requested → active → resumed`,
or `ended` / `expired`. The Console and `browser_takeover_list` read the same records. The runner's
remote view is refused for a task with no live takeover. Takeover requests, approvals, failures and
completions are notification events (`takeover_required`, `approval_required`,
`browser_verification_failed`, `browser_verification_completed`), so the instance's notification
policy decides which of them push. Their links carry only ids, never a page URL, token or session.

For a Gmail job lead, the push is sent once its verification reaches a final verdict, not when a run
ends. A run can finish and still report that it could not read the posting, and that is not a
completed verification. An open, closed or different job is `browser_verification_completed`. A
lead closed as unverifiable is `browser_verification_failed`, whether every attempt failed or no
eligible browser was available under the `fallback`. An attempt that will be retried sends nothing.
The push names the job by title and links to Settings, never to the posting.

### Verifying Gmail job leads

A Gmail Scout resolves a one-job provider alert to the posting's canonical URL, which carries only
the posting id. When the server cannot check that page (blocked, or no structured posting), the lead
is not thrown away. It is stored `awaiting_browser_verification` and checked in the Scout's own
browser, under the instance's browser verification settings. Only the canonical URL is sent, never
the personalised alert link.

The Gmail Scout declares a local browser for this (#1048). It runs research only, on your own Codex or
Claude subscription. Browser verification is off until you turn it on for the Scout and pin a machine.

Which job sites it may open is each Scout's own **browser source policy** (#1049), set in Settings →
Local browser research or with MCP `set_instance_local_browser_settings` (`allow_domains`,
`deny_domains`):

- **Denied sites** are never opened; the lead is closed as unverifiable and the attempt records why.
- **An allowed-sites list** opens only those sites (each covers its subdomains, e.g. `indeed.com` covers
  `au.indeed.com`); a posting elsewhere is refused the same way.
- **No list** (the default) means any public job site — but a NEW site is opened only after you decide.
  The Scout asks once, durably (a takeover request, reason `consent_required`, pushed as
  `takeover_required`), and the lead waits without spending an attempt. Allow or decline the site in
  Local browser research or with `set_local_browser_consent`; the decision stands for later leads. A site
  you declined is refused. Unanswered past the browser verification wait limit, the lead is closed.

Saved settings that no longer fit the agent open nothing: the lead waits and says why. If the Scout's
agent ever stops declaring a local browser, waiting leads stay waiting rather than being closed.

The run reports one typed outcome:

- **active**: the lead becomes `new`, and only then can it be applied for and reach the Tailor.
- **expired** or **mismatch**: the lead is closed.
- **temporarily_unverifiable**: retried with backoff; after three attempts the lead is `unverifiable`.

A lead the owner has already moved on is never rewritten by a late outcome. Every attempt is
recorded; `job_lead_browser_verifications` shows them, and `verify_job_lead_now` checks a waiting
lead now.
