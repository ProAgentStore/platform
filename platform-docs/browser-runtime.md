---
description: "Run pags up for local browser and CLI capabilities, outbound relay connections, background operation, and runtime diagnostics."
---

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
| `--headless` | Fallback browser mode when neither the instance nor its agent specifies one. |
| `--instance <id>` | Serve exactly one agent, by id or slug. Debug scope: this run does **not** watch for new instances. |
| `--force` | Take over when this same machine (same hostname/node) already has a runner connected. Also suspends coding sessions still owned by other nodes; the machine's own suspended sessions reactivate on reconnect. |

The only 409 is same-hostname: a second runner on the same node is rejected unless `--force`. Several *different* machines can each run `pags up` for the same instance concurrently, and routing follows whichever relay socket is actually live.

## Visible and headless browsers per agent

With CLI 0.4.197 or later, the browser mode belongs to the agent configuration (#1429).
In the agent builder, set **Browser mode** to **Visible browser**, **Headless browser**,
or inherit the runner default. An instance owner can override this in the instance's
**Settings → Browser settings**, or inherit the agent default.

The order is instance override → agent default → runner fallback. `--headless` and
`PAGS_RUNNER_HEADLESS=1` supply only that last fallback; an explicit visible setting
wins even when the runner was installed as a background service. Browser visibility
and whether the runner has a terminal window are separate settings.

Through MCP, use `get_instance_browser_mode` and `set_instance_browser_mode` with
`mode: "headed"`, `mode: "headless"`, or `mode: null` to clear an instance override.
Creators set `capabilities.browserMode` through `create_agent` / `update_agent`.
The read response names the effective configured mode and its source; when both
settings inherit, the runner fallback remains unknown until the machine applies it.

Changes apply at the next safe browser launch; they do not interrupt an active run.
Different instances keep separate browser sessions, so one can be visible while
another is headless. A visible browser requires an interactive desktop on the machine
that runs the agent. A remote machine's browser window appears on that machine.
The task's **Screenshot replay** provides a timeline slider in the console in either mode,
when screenshot capture is enabled.

## Browser and profile selection

CLI 0.4.198 adds independent browser and profile settings (#1431). Agent creators
choose defaults; instance owners can override each field or inherit it in **Settings →
Browser settings**. Mode, browser choice, and profile persistence are separate choices.

| Browser choice | What actually runs |
| --- | --- |
| Installed Google Chrome | The machine's Chrome stable channel. No silent fallback if it cannot launch. |
| Installed Microsoft Edge | The machine's Edge stable channel. No silent fallback if it cannot launch. |
| Playwright Chromium | Playwright's matching Chromium build, using its full browser in headed or headless mode. |
| Playwright Firefox | Playwright's matching patched Firefox build; not an arbitrary installed Firefox. |
| Playwright WebKit | Playwright's matching WebKit build; not the Safari application. |

A **persistent** profile remembers this instance's sign-ins and browser state, separately
for each browser choice. A **fresh session** (`ephemeral`) starts with empty browser
state and discards it when the run ends. Explicit browser/profile configuration uses
PAGS-owned profiles and does not implicitly copy the owner's everyday Chrome profile.
Switching browsers preserves old persistent profiles so switching back can reuse them.

When a field inherits all the way down, existing workflow behavior stays intact:
research's isolated browser is fresh per run, the application's isolated browser keeps
its own sign-ins, and the general workflow browser keeps its automation profile. The
legacy Chrome preference and runner environment fallback remain only when no browser
choice is configured. Choose a browser explicitly when its identity matters.

Through MCP use `get_instance_browser_settings`, `set_instance_browser_settings`, and
`get_instance_browser_session`. Each setting accepts `null` to clear that override;
omitted fields stay unchanged. The session read is evidence of the browser actually
launched, distinct from settings saved for a future session. It reports the engine,
channel/version, actual visibility and profile policy. An unavailable browser returns
an actionable launch failure, never a successful receipt for another browser.

The runner supplies its own native Playwright browser context to the standard MCP
server. Screenshot replay and human takeover use the same page across the supported
engines. These choices follow [Playwright's browser support](https://playwright.dev/docs/browsers),
[persistent-context guidance](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context),
and [MCP context integration](https://github.com/microsoft/playwright-mcp/blob/main/index.d.ts).
Installed Chrome does not guarantee that websites will allow automation; challenges
remain visible for a human takeover.

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

## Reviewing an Application Runner application

With CLI 0.4.231, a Full-mode application configured for manual review retains its browser and AI
run while awaiting your approval. Approve the exact application from its review view or MCP
`approve_application`; this grants one submission for those documents, not global auto-submit.
The agent checks the current page again and continues in the same session. Ordinary Resume does
not authorize submission. The history slider’s Live position lets you take control of the same
review page. Return control before approval can continue; returning alone grants no submission
permission. Use Stop to end the run.

The review wait is bounded to 90% of the configured engine tool budget (`maxMinutes`), and the
checkpoint records its expiry. If the page is lost, the wait expires or the run already ended,
approval cannot revive it. Full-mode uncertain attempts need supported reconciliation before any
retry; a status of “awaiting review” on an old ended run is not proof that retry is safe.

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

**The saved brief (#1065).** An agent's local browser settings can hold the owner's saved search brief:
roles, places and sites, edited in Settings → Local browser research and shown beside the scan schedule.
- **What each run is given:** its objective plus that brief, scheduled or started by hand. A scheduled
  objective can therefore say "matching the saved brief" and mean it.
- **Fenced as data:** the brief sits in the CLI's prompt fenced as data (ADR 0006), beside the objective
  and never inside the rules, so nothing in it can change what the run may do.
- **Owner-authored only:** it comes from the settings field, or is copied once from a memory entry the
  owner set (`source: "user"`); an agent-written entry is refused.
- **Every run's trace records** `brief_included`, `brief_not_supported` (the runner's CLI is older than
  0.4.132, ignores the field, and runs on the objective alone), `brief_unconfirmed`, or `brief_missing`
  (the objective mentions a saved brief but none is saved).

**Where findings go (#1096).** It depends on the run's results collection.
- **`job_leads` (a Job Search Scout):** each finding is written when the run completes, just as the Gmail and pasted-URL intakes write theirs.
  - **Deduplication:** by the collection's key field (`url`), then by job (the work key).
  - **Prior applications:** a job that already has an application is never written again.
  - **Verification off:** the lead is stored `new` and is ready for triage. Its `verification.state` is `research_observed`: seen by the run's browser, but not proven to have a live apply path.
  - **Verification on:** the lead is stored `awaiting_browser_verification` and is also queued in `job_lead_browser_verifications`.
  - **Lifecycle fields:** a page's own claims about lifecycle fields (status, apply or application ids) are dropped.
- **Any other collection:** findings wait for the owner to save or skip each one (#946).
- **Unsaved findings:** a finding with no decision yet (`pending` in the scan's telemetry) is kept on the run and can be saved with `review_local_browser_finding`. It is not on any queue, and the scan's outcome says so.

A run whose CLI exits without ever calling the bridge ends `failed`, saying no page was opened. A Codex run needs a runner on CLI 0.4.74 or newer, because older runners cannot approve the bridge's tools for `codex exec`. Preflight flags an older runner, and a start on one ends at once as `runner_unsupported`, naming the update or the switch to Claude Code.

## Coder Agents

Coder agents use the same runtime idea, but the local capability is a coding CLI rather than a browser.

The runner starts that CLI as a **child process** and speaks to it directly — Claude Code over its structured `stream-json` interface (real turn events, so "is it still thinking?" is a fact rather than a regex guess), and any other engine as a raw spawn with stdout capture. It is **not** a tmux pane, and the terminal view is not a scraped TUI. Re-attaching after a runner restart works because Claude Code persists its session to `~/.claude`, so the runner re-spawns with `--resume <session id>`; tmux is not involved.

```text
Workflow brain -> RelayDO -> local runner -> coding CLI child process (stream-json)
```

### Provision a repository on the remote machine

The platform can create a coder's checkout through the connected runner; a normal fresh clone needs no terminal step
on that machine. Pin the instance with `set_instance_runner_node`, then call:

```json
{
  "instance_id": "<your-coder-instance-id>",
  "path": "~/dev/chinese",
  "github_repo": "<owner>/<repository>",
  "clone": true
}
```

These are the arguments to `coding_repo_add`. The runner expands `~` against its own home on Windows, macOS or Linux.
The destination may be missing or empty, below that home, within an owner-registered project root, or a child of the
runner's managed repository directory. Existing files are never overwritten to make room for a clone. Protected paths,
symlink redirects and nested checkouts are refused. The folder is bound only after the runner verifies its checkout and
matching GitHub origin.

Fresh-checkout provisioning and file inspection have different permissions (#1446). An empty folder does not need to be
registered as a read root before cloning into it. Provisioning does not make unrelated plain folders readable or change
the owner's roots file. If an older runner refuses a fresh clone with “not a git repository or a folder you have allowed,”
update the selected machine to CLI 0.4.201 or newer using `runner_update` and retry the same request once the updated runner is confirmed.
The fix belongs in the remote runner, so a cloud-only deployment is insufficient.

When the response says cloning is still in progress, repeat the exact arguments to join that job; do not create a second
instance or destination. After success, check `coding_repos_list` for the expected repository, ready checkout and selected
machine, then start work with `coding_loop_start`. A failed clone's runner status remains available even if partial files
remain; a fresh attempt cannot overwrite a nonempty destination. A repeated request cannot join another repository's
clone job. A disappeared or malformed job receipt is unconfirmed, and a failed partial checkout is not accepted as ready
just because its Git origin is readable (#1454). Missing or empty destinations remain safely retryable.

The destination guard also protects bare repositories and separate Git administration directories that have no literal
`.git` path component. Session-created checkouts apply the same guard before creating missing nested paths (#1455).
Credential-directory names are reserved case-insensitively even before they exist; ordinary directory names
retain the filesystem's case behavior. A validated empty clone directory is reserved before the background
job starts, so aliases resolve to the same filesystem-native canonical job key (#1457).

Active clone jobs count as local work for safe update/restart admission until success or failure (#1458).
A crash or forced restart can still lose in-memory clone receipts (#1459); an unknown outcome requires inspection,
not an assumption of completion.

The machine still needs Git and authorized repository credentials. The clone uses its existing HTTPS credential helper
or SSH identity; PAGS GitHub connector write consent does not sign Git in on that machine. A credential refusal is reported
separately from destination validation. Likewise, a connected runner and a ready checkout do not establish that the chosen
coding engine is signed in or that the machine has capacity: `runner_setup`, `coding_diagnostics` and the run's start receipt
report those remaining checks.

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
to the caller. MCP `browser_run_screenshots` lists the same stored frames and
`browser_run_screenshot` returns one frame as image content with its metadata. Neither read takes a
new screenshot. Image access applies the same instance, run and owner checks as the console.

- **The runner takes them, never the model.** Frames are captured at fixed points — after a
  navigation, an accepted click, a page read or wait, a pause or blocker, and at completion; on an
  application run also after a fill, an upload, a checkpoint, review and a submit. `browser_take_screenshot`
  stays refused to the CLI.
- **Form controls are blurred by default.** In **Settings → Browser screenshots**, the owner can turn
  **Blur form fields** off to record visible form values (#1433, CLI 0.4.199). This choice is separate
  from enabling screenshots and is fixed when a run starts. With blurring on, Playwright masks inputs,
  textareas, selects and editable regions for the capture, including frames and shadow roots. A failed
  capture produces no frame. With blurring off, the screenshot shows the page as rendered, including
  ordinary typed values; the website's own password bullets remain. Existing frames cannot be unblurred.
- **The trace stays redacted.** It records only that a frame exists (`screenshot.captured`, with its
  sequence number and capture point) — never the image, page text, form values or typed values. Stored
  metadata is the capture point, the page URL without its query or fragment, its domain and an action
  class.
- **Bounded.** From CLI 0.4.211, the runner retains the latest 60 research frames or 40 application
  frames in memory, while continuing to capture later actions and review/completion frames. Older
  runners stop capturing when that lifetime cap is reached. Frames are viewport only and individually
  size-capped. The cloud retains frames already collected even after the runner evicts them. A slow
  collector can miss the rolling window: native pulls report the exact gap relative to the requested
  cursor, and stored replay coverage reports missing sequence ranges without claiming the latest frame
  is the current screen. Research frames are kept as long
  as the run's trace (default 30 days); workflow tasks and application runs, 30 days. Screenshots taken
  before this contract (`runshot/`) are still served as they were.

### Inspect browser evidence through MCP

Use the instance id and the exact run address: `subject_kind` is `runtime_task`, `local_apply_run`,
or `local_browser_run`, and `subject_id` is that run's id. An application id is not a fill-run id.

| Tool | Evidence returned |
| --- | --- |
| `browser_run_calls` | Ordered native calls with tool name, bounded target/argument summaries, start time, duration, outcome, internal-call flag and redacted error heads (at most 200 characters). |
| `browser_run_state` | The retained or freshly observed native/MCP selected tabs, bounded tab inventory, pending native file chooser and last observed dialog type. |
| `browser_run_screenshots` | Stored frame metadata, capture timestamps when available, URL/action/target captions, capture-off status and pagination. |
| `browser_run_screenshot` | One listed artifact's metadata and actual image, preserving the run's frozen blurring setting. |

For call and screenshot lists, follow `nextCursor` while `hasMore` is true. The default MCP page has
25 entries; `limit` can reduce it. A page may be smaller to fit the MCP text budget; use its returned
cursor, not the requested limit, to continue without skipping records. Cursors belong to their respective listing and run. Calls use
durable insertion order; native `seq` can reset when the recorder's `epoch` changes.

Call and state reads default to `refresh: true`: they collect diagnostics still retained by the
connected runner and save them in the cloud. `refresh: false` reads only saved cloud evidence.
Collection also occurs during normal run sync, including final sync; evidence already collected
survives the runner's restart. No diagnostic read launches a browser, selects a tab, navigates,
approves a website, resumes a run or repeats a browser action.

Read `coverage` before drawing conclusions from calls. It reports unsupported or unavailable
sources, dropped calls, detected restarts, invalid records and a bounded collection limit. Older
runners may expose calls without an epoch, or refuse diagnostics entirely; missing evidence is not
proof that no action occurred. Calls and state are retained for 30 days after collection. Evidence
that was never collected before a restart cannot be recovered by these tools.

For state, check `availability`, `freshness`, `capturedAt` and `snapshot.current` together. A retained
snapshot is not necessarily the current browser. Tab lists are capped at 20 and report truncation.
Dialog state describes a past observation, not proof that a dialog is still open. These diagnostics
do not include page HTML, form contents, dialog messages or cookies. Typed values and file contents
are omitted; URLs omit queries and fragments. A call's `urlAfter` is its known navigation argument,
not proof of the final loaded URL. Use stored screenshots for visual evidence when available.

### Turning screenshots off

Screenshots are **on** by default. An owner can turn them off for one agent (#1064): **Settings → Browser
screenshots** in the console, `PUT /v1/instances/:id/browser-screenshots {"enabled": false}`, or the MCP
tool `set_browser_screenshots`. One switch covers every browser run the agent makes — workflow tasks,
research runs and Application Runner fills.

To keep screenshots but show form values, send
`PUT /v1/instances/:id/browser-screenshots {"blurFormFields": false}` or set
`blur_form_fields: false` with `set_browser_screenshots`. Omitted fields are preserved. Turning blurring
off stores those visible values in the owner's replay screenshots; access controls and retention stay
the same. Credential-vault substitution and text-log redaction are independent of this visual setting.

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

### Application Runner fills (`runtime: "local_apply"`)

#### Signing in, recovering access and creating an account

**Required behavior, owner directive of 6 November 2026.** Authentication is part of completing an
authorized application. The Runner should work through these steps before handing an ordinary login
page back to the owner:

1. Reuse the run's existing signed-in browser session when it belongs to the intended account.
2. Try the existing credential for the observed site's authorized origin through the credential
   broker. A missing vault entry does not establish that the owner has no account.
3. If an existing account needs recovery, use the site's recovery/reset flow and the connected,
   pinned Gmail account to receive the relevant recovery message. Do not keep retrying a rejected
   password or create a duplicate account to avoid recovery.
4. Create an account only when the site establishes that none exists for the intended identity and
   account creation is authorized. Complete its email verification through that same pinned Gmail
   account, then verify the signed-in identity before continuing the application.

The model interprets the live site's controls and feedback; this sequence is not a set of
employer-specific scripts. Credentials, verification codes and reset links must use the protected,
origin-bound broker rather than appear in model output, chat, logs or application documents. Mail
must be matched to the intended account, site and current request; an unrelated or stale message is
not recovery evidence. Site permission, mailbox permission and account identity remain separate checks.
CAPTCHA, a required owner consent or legal acceptance, unsupported security steps and missing personal
facts still need the owner. Authentication does not grant application-submission permission.

**What is implemented as of CLI 0.4.229:** persistent application profiles can reuse sessions, and
agent-driven sign-in can provision an existing matching vault username/password. Without a vault
login, username-only provisioning is currently limited to the supported SEEK hosts with
`signInEmail` and permitted email access. The Gmail path reads a requested numeric sign-in code; it
is not a general password-reset-link or account-verification service.

Since #1619, when the owner's `accountCreation` authorization is on (frozen per run), a sign-in wall with
no saved login is answered immediately with the Profile address, and the agent can register or reset
through `request_new_password`, `request_sign_in_link` and `request_sign_in_code`; a generated password is
kept as a provisional vault credential and confirmed (or moved onto the replaced credential) only when
the agent reports the account signed in. Account existence is the model's reading of the live page. A
saved website allow list is access configuration, not evidence that authentication works there.

Until the missing capability is implemented, report which step is unsupported and offer the same
run's bounded browser handoff when available. Do not claim that an account was absent, recovered,
created or verified from a settings change or a successful click alone. See the
[browser-agent design contract](https://github.com/ProAgentStore/platform/blob/main/docs/browser-agent-design.md)
for the required behavior and execution-evidence rules. These application permissions do not change
the read-only research agents' sign-in restrictions described above.

**Job preferences live on the instance (#1508, CLI 0.4.213).** Open the relevant Tailor or
Application Runner → **Knowledge → Memory** and edit **Job application preferences**. Employment
type, salary expectation, availability, planned holidays and recruitment adjustments belong to that
instance, rather than the general account Profile. The Memory view shows their values and confirmation
dates; holidays also have a validity date. Salary superannuation basis and disclosures remain unanswered
until the owner supplies the necessary facts.

The stored entry is `job_application_preferences`, type `preference`, explicitly user-set. The same
entry is accessible with `get_instance_memory` / `write_instance_memory`; its versioned document is
validated by `instance-preferences-contract.ts`. Each direct or queued dispatch reads its own instance
again and records a hash/count receipt without answer text. Agent-written summaries are not owner
answers. Unavailable, malformed or expired preferences prevent dispatch and report what needs fixing.
New preferences supersede recognized old values in the working sources; the original prepared document
bytes and hashes remain intact. An application-specific answer must match the actual screening question
to take precedence. Memory edits do not approve a submission or resume a running application.

**While an application runs, the owner hears it (#1107).** The Tailor and the Runner already record every
step on their run's trace; each sync now also turns that trace into owner notifications, through the
owner-attention policy (#991/#992) so each is controllable per instance, event and channel:

- **`run_progress`** — one update per *stage* reached, never per field: on the listing, waiting at a
  sign-in, signed in, filling the form, uploading documents, at a checkpoint, submitting (the Tailor:
  reading sources, writing the materials). Each says the stage, the last action and the elapsed time.
  It is listed in-app by default and only pushes if the owner turns push on for it.
- **Blockers nothing announced before**, pushed at once: the listing expired (`blocker_required`), a
  consent wall (`blocker_required`), an `auto_submit` run that was lost or timed out so nobody knows
  whether it submitted (`decision_required`), and a Tailor that needs the owner's answers
  (`input_required`). A sign-in or CAPTCHA pause, an unconfirmed submit and the final outcome keep their
  own notifications below and are not repeated.
- **`run_stalled`** — once per run, when no new event arrived within the stall threshold: the run's
  `stallMinutes` setting, or automatically half its `maxMinutes` (at most 10, at least 5). A run paused
  on a person is waiting, not stalled.

Each is claimed on the run row before it is raised, so the per-minute sweep and an owner's read never
announce it twice, and a run that ended more than 30 minutes ago never re-announces. Text carries stage
names, counts and reason codes only — never a URL or a field's value. `application_trace` returns the
ordered history, paged (`cursor`/`limit`).

An Application Runner does not use these takeovers. Its `get_instance_browser_verification` reports
`capability.declared: false`, and that is expected. A fill run escalates to the owner in two ways of its own:

- **The run needs help at a sign-in or CAPTCHA** (#1013). Supported agent-driven sign-in is attempted
  first as described above; unavailable recovery/registration remains a reported capability gap.
  The run's own browser is offered to the owner as a bounded handoff
  (`blocker_required`: "Sign in to continue an application"). The owner clears the step
  on their device and resumes the same run.
- **The site needs a sign-in before the one-click press** (#1094). The application browser keeps its
  sign-ins between runs (on-disk profile, per machine and profile). Before pressing a control that may
  send the application, the run checks that profile's session for the site. It pauses `login_required`
  **before pressing anything** when SEEK has never been signed in on that profile, when an earlier
  press bounced to the site's sign-in page, or when a recorded session cookie has expired. The owner
  signs in once through the handoff above, and later runs reuse the session. Only cookie names and
  expiry are recorded, never values. Where the profile lives, and its limits:
  `packages/browser-runner/APPLICATION_PROFILES.md`.
- **The submit was pressed and the site did not confirm it** (`submit_unconfirmed`, #1068). For example,
  a "Quick apply" control, which the Runner treats as a possible one-click send, lands on a sign-in page.
  - **It is never retried.** A redirect is not proof that nothing was sent (#994, #1013).
  - **The owner is told** with `decision_required`: "Check whether it was sent".
  - **The card offers a read-only check.** "Check the employer's site (read-only)" asks the run's own
    Runner to read the site's history. If the site needs a sign-in or CAPTCHA first, it opens a separate
    read-only handoff for that.
  - **The check can only report** confirmed, no submission, ambiguous or unavailable. It cannot fill,
    submit or clear the uncertainty. For SEEK it can currently only answer "ambiguous": the Runner has
    no verified way to read SEEK's application history.
  - **The owner can vouch for it** (#1073). After checking the employer's site themselves, the owner
    records "I checked the employer site and nothing was submitted", with what they checked, using
    **"I checked — nothing was sent"** on the card or the MCP tool `assert_application_not_submitted`.
    - It is stored as the **owner's assertion**, never as proof. The reconciliation record is left as
      it was.
    - It allows exactly **one** new fill. That fill spends it, and the run's trace names the assertion.
    - Without one, an attempted submit stays blocked.

### Verifying Gmail job leads

A Gmail Scout resolves a one-job provider alert to the posting's canonical URL, which carries only
the posting id. When the server cannot check that page (blocked, or no structured posting), the lead
is not thrown away. It is stored `awaiting_browser_verification` and checked in the Scout's own
browser, under the instance's browser verification settings. Only the canonical URL is sent, never
the personalised alert link.

A digest or recommendation email ("20 new jobs for …") is handled one posting at a time (#1248).
Each SEEK, LinkedIn or Indeed posting it links to is deduplicated by its job id, then checked on its
own canonical page. It is added, queued for this browser check, or rejected, and each outcome is logged
with its reason in the scan log (`gmail_scout_scan_log`). Its tracking redirects are never followed.

SEEK refuses the server, so a SEEK digest posting usually waits here for the browser check. It carries
the title and employer from the digest's own listing for that job (#1251). A lead stored untitled
before that is named the next time a scan or reprocess sees a listing for it. A digest that links to
no identifiable posting is rejected as `digest`.

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
