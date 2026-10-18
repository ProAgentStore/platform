# Runner auto-update

Auto-update is an opt-in policy owned by the account and addressed by the runner's stable physical
machine ID, not its hostname or an individual agent. Existing machines have no policy row and are
therefore disabled by default.

Enable it from **Terminals → a machine** or through the MCP `set_machine_policy` tool. The choice is
durable while a machine is offline and is returned whenever that machine registers or heartbeats.
The runner persists its last observed policy locally, then re-syncs on reconnect.

## Compatibility and first rollout

The switch is a stored account policy, not an upgrade command. A runner can have a stable machine
ID (and therefore a working detail link and toggle) before it has the auto-update controller. In
particular, a connected **0.4.90** runner records the policy but cannot act on it; enabling the
toggle does not bootstrap that process. The controller first ships in **0.4.92**, so upgrade an
already-running older runner through a separately authorised, safe `runner_update` while it is
idle, wait for it to reconnect and report `0.4.92` or later, and only then choose whether to
enable the policy. `runner_update` itself is supported by 0.4.90, but it is still a deliberate
remote update/restart and is not performed merely by visiting this page or changing the toggle.

Safe rollout procedure:

1. Verify the target machine is connected and has no coding turn or local application run.
2. Authorise one manual `runner_update` for that named, idle machine; do not enable the policy as
   a substitute for this bootstrap step.
3. Wait for the same stable machine ID to reconnect and confirm its reported CLI version is at
   least `0.4.92`.
4. If desired, enable the policy and monitor its reported lifecycle. Leaving it off is safe and is
   the default.

An unavailable version is also not evidence of support: wait for a reported `0.4.92` or later
before relying on automatic updates.

When enabled, the runner checks the published `@proagentstore/cli` release with bounded, jittered
backoff. It uses the same safe update path as manual `runner_update`: semantic versions only,
source checkouts/no-restarter installations are reported as unsupported, active coding and local
application work defer the install, and the policy is rechecked before installation. Turning the
toggle off cancels an update that has not begun installing. A receipt is not success; the Terminals
page records checking, waiting, installing/restarting, verified reconnect, unsupported, offline, or
failure with its last attempt.

## Diagnostics: what the controller last did (#1020)

`get_machine_policy` (and the Terminals machine detail) carries `auto_update_diagnostics` beside the
existing fields. Receipt and action are separate facts:

- `last_heartbeat_at` — when the runner's last status report arrived. A heartbeat re-sends the cached
  status, so this is telemetry freshness only, never evidence the updater ran.
- `last_check_at` / `last_decision_at` — the runner's own time for its last work/registry check and its
  last controller decision. `last_attempt_at` follows the decision time; for a runner older than
  0.4.101, which reports no decision time, it advances only when the reported status changes.
- `next_retry_due_at` — when the controller's next timer is due. Heartbeats arriving well after it,
  with `last_decision_at` unchanged, mean the timer is not running.
- `blocker_class` — why it is waiting: `active_sessions` (a coding session not proven idle, an
  unmatched turn, or a local run), `observation_failure` (the paired `/coding/sessions` + `/health`
  look failed or was malformed — fail closed), `idle_wait` (observed idle, but the final race-safe
  admission refused; retried), or `unknown`.
- `observations` — the last five paired looks: `{success, sampled_at, source}`. No session text,
  process arguments, paths, prompts or tokens are reported. A readable `sessions` look also carries
  `session_states` (CLI 0.4.117): how many retained engines were `active_turns`, `unknown`,
  `idle_retained` and `stopped`, by the guard's own rule (`sessionStateOf` in
  `runner-work-observation.ts`), so the counts and the blocker cannot disagree. `active_turns` and
  `unknown` block an update; idle retained and stopped engines do not. Counts only.

Retained engines that report `alive:true, runState:"idle"` and engines that have exited do not block;
any other or missing lifecycle state does.

**Seen live (2026-10-13 UTC, read-only).** CLI 0.4.122 was published at 2026-10-12T22:13Z. pink-laptop
(macOS, Auto-update ON) restarted its runner at 23:14:49Z and reported `verified_success` on 0.4.122. No
`runner_update` had been issued to it since 2026-10-12T09:45Z. `verified_success` is set only when the recorded install target is
the running version, the runtime is healthy and every original agent has reattached. Its diagnostics show the
fields above doing their job: heartbeats at 09:21Z, while `last_check_at`/`last_decision_at` stayed at
05:28:56Z with `blocker_class: null`, a due `next_retry_due_at`, and paired observations reading
`active_turns: 0`. That is an unattended, guarded cycle on macOS. The Windows path is not confirmed by it
(see [Windows](#windows)).

A release check that could not run (npm unreachable, or not startable) is `failed` with its reason
and retried with backoff (CLI 0.4.117). It used to be `unsupported`, which means "this install can
never update" and is skipped by the stuck check, so a machine that could not ask npm went quiet.
`unsupported` is now kept for what is permanent: a source checkout, or nothing to restart the runner.

An `offline` status means the owner policy could not be re-read. The runner drops its authority to
install the moment a refresh fails, but it keeps a backed-off retry timer (about 1 minute, doubling
to a cap of about an hour), so `next_retry_due_at` stays set; recovery does not wait for a heartbeat.
Only a fresh ON from the service lets a retry observe work or install. An explicit OFF stops the
retries.

`verified_success` is a claim about an UPDATE CYCLE, not about a version (CLI 0.4.109). The runner reports it only
when its own persisted record shows an attempted install (`installing`/`restarting` with that target, written before
the restart and read back by the new process), the running and published versions both read as `x.y.z`, the running
one is at or past the target, and both halves of the local work look (`/coding/sessions`, `/health`) answered. A
runner that merely finds itself current reports `enabled`; an unreadable version, a restart onto an older version
than attempted, or a missing/partial health look reports `failed` with the reason, and is retried with backoff.
Each policy refresh and each work/registry look is bounded at 30 seconds: past it the request is aborted, the check
counts as failed (`last_check_at` moves, `last_decision_at` does not), a retry is scheduled, and a late answer is
dropped — it cannot restore authority, override a newer answer, or start an install.

The status itself is the runner's record, not the service's. Every registration and heartbeat answer
echoes back the status that request reported, which can be older than a decision the controller made
while it was in flight. From CLI 0.4.108 a runner takes only the owner's switch from such an answer and
keeps its own status, so a late `restarting` echo can no longer overwrite the `verified_success` a
restarted runner has verified (which then lingered until the next six-hourly check). An owner OFF, or
ON after OFF, still adopts the service's record.

## Stuck: ON, connected, and not catching up (#1034)

A runner's `auto_update_status` is its own record, so a controller that has stopped making progress
keeps reporting, for example, `waiting_for_idle` with a fresh heartbeat. On 2026-10-12 a machine
showed "auto-update: on" and `waiting_for_idle` while running 0.4.94 with 0.4.111 published. Its
own check had last seen 0.4.98.

**Controllers before CLI 0.4.101 can wedge this way.** When the final race-safe admission refused
an install from a deferred (busy-to-idle) callback, that path re-armed no timer (#1020). The runner
then held `waiting_for_idle` with no retry until the policy was toggled or the process restarted.
0.4.101 retries that refusal, and 0.4.111 bounds every check, but a runner stuck on an older
controller cannot fetch that fix itself. It needs **one manual `runner_update`**; after that the
policy carries it forward.

The platform detects this from outside instead of trusting the status. It reads the published
`@proagentstore/cli` release times from the npm registry (cached about 10 minutes) and sets
`auto_update_stuck` on the machine when all of these hold:

- the policy is ON and the machine is connected now;
- the machine does not already report `unsupported` for a permanent reason (a source checkout, nothing to
  restart the runner) — an `unsupported` whose stored reason is "npm could not be asked" is not hidden (#1054);
- the machine's CLI is older than the published `latest`; and
- either the first release it is missing was published more than **24 hours** ago
  (`behind_published`), or its own check last saw a version that has newer releases published
  more than 24 hours ago (`stale_latest`, since the runner checks about every six hours).

`auto_update_stuck` carries `reason`, `behind_since`, `published_version`, `releases_behind`,
`remedy: "runner_update"` and a plain-language `detail`. It appears on `list_runner_nodes` (each
machine row of `GET /v1/terminals/nodes`), on `get_machine_policy` / the machine detail, and on
the Terminals page and the machine page, with **Update CLI** offered on a connected machine. The
stored status is left as the runner reported it; the stuck flag is what says it is not progressing.
An unreadable registry or runner version is never reported as stuck. Offline machines and machines
with the policy off are not flagged.

**`cannot_fetch_update` (#1054).** A connected, ON, win32 machine on CLI 0.4.116 or older whose updater's
stored reason is "npm could not be asked" is flagged at once, not after 24 hours: its npm calls cannot start
on Windows, so it can never fetch 0.4.117 itself, and `runner_update` runs the same npm call. Its remedy is
`manual_npm_install` — `npm i -g @proagentstore/cli` at the machine, then restart the "pags up" scheduled
task — and the Console does not offer **Update CLI** for it. Each `list_runner_nodes` row also carries the
runner's own `last_error`, so the reason is on the row, not only in `get_machine_policy`. From 0.4.119 that
reason names npm's actual failure (npm's error lines, a spawn error such as ENOENT, or a timeout) instead of
only "npm could not be asked", and it stays a retryable `failed`.

The platform does **not** start that update by itself. #1034 lists a server-initiated one-time
`runner_update` only as optional, and nothing in its discussion asks for it. The investigation in
#1020 took the cautious line on owner machines: it forced no update, kept the update guard
fail-closed, and noted that filing an issue does not authorise a forced update. A stuck machine is
therefore surfaced with its remedy, and the owner, or an agent they authorise, runs
`runner_update`. That uses the usual wait-for-turn semantics.

**A timed-out `runner_update` is re-checked before it is called failed (#1034).** The relay gives
the update command about two minutes. A machine that is slow to install, or that restarts before its
reply gets through, used to leave the operation `failed` ("relay connected but the update command
timed out") even when the update had landed. On pink-laptop, the run reported as failed had in fact
installed 0.4.111 and restarted. Now, after a timeout, the platform re-reads the version the machine
registers for up to 150 seconds. If it has moved past the version from before the command, the
operation continues as a restart: held agents are waited for and re-attached, and the result is
`restarted`, with the lost reply named in its detail. If the version does not move, the operation is
`failed` and says which version the machine still reports. Dry runs install nothing and are not
re-read.

## Never left without a running `pags up` (#1141)

On 2026-10-17 two machines went offline in the middle of an automatic update to 0.4.149. Their status
stayed at `installing` and they sent no heartbeat after that. `runner_restart` cannot reach a runner that
is not running, and the owner was away from both machines. Four changes make that state recover by
itself, or at least say what happened.

**The new version is on trial, and the old one stays installed.** Under the bootstrap stub (#862) a
release is installed next to the running one in the payload cache (`~/.config/proagentstore/cli/<version>`).
The cache always keeps the newest version that has not been given up on, so a rollback always has
somewhere to land. The new version goes on trial (`packages/cli/src/bootstrap/trial.ts`). It passes
the trial the first time its relay registers or heartbeats. The stub gives it up, and runs the previous
version, when any of these happens:

- it throws while it is being loaded. The previous version then starts at once, in the same process.
- it has not registered **5 minutes** after its first start. If something restarts this process (a
  `pags up` supervising its runner, the Windows launcher, or a service), the stub exits with the restart
  code (75) and the next start runs the previous version. If nothing restarts it, the stub records the
  verdict and the next `pags up` runs the previous version.
- it has been started 6 times without registering (a crash loop). The `pags up` process and its
  runner each count as a start.

A version that was given up on is not picked again. The stub's own check on `pags up` does not fetch it,
and the updater refuses it as `failed` with the reason ("… was installed here and rolled back: …") until
a newer release is published. The version that runs next reports the rollback in its first registration
("Rolled back from 0.4.149 to 0.4.148: it crashed on start: …"). That message goes to `last_error` and
to the error log.

**An OS supervisor: `pags up --install-service`.** This installs a LaunchAgent on macOS, a systemd
user unit on Linux, or a Scheduled Task at startup on Windows, and starts it. All three run the same small
Node supervisor (`~/.config/proagentstore/pags-up-supervisor.mjs`). It starts `pags up --headless` with
`PAGS_SERVICE=1` and appends its output to `pags-up.log`. When `pags up` exits with the restart code
(an update or `runner_restart`), the supervisor starts it again after 1 second. After any other exit it
waits, doubling the wait from 10 seconds up to 5 minutes, and resets the wait once a run has lasted 10
minutes. `pags up --uninstall-service` removes it. The macOS LaunchAgent runs only while the user is
logged in, so a Mac that has to come back after a reboot unattended needs automatic login. The Linux
installer runs `loginctl enable-linger` so the unit runs with nobody logged in. On Windows the task is
registered from an elevated PowerShell. If registering is refused, the installer leaves the script it
wrote and says to run it from an elevated shell.

**A silent install is reported, not left at `installing`.** A cron sweep turns any machine whose
policy reads `installing` or `restarting`, and that has not reported for **5 minutes**, into
`failed`. Its `last_error` begins "No heartbeat within 5 minutes of installing an update", and the
sweep writes one `runner-auto-update` error-log row. `list_runner_nodes` and the machine detail
flag it as `auto_update_stuck` with `reason: no_heartbeat_after_install` and
`remedy: restart_at_machine`. This flag does not need a live connection or the registry, because the
machine in this state is usually disconnected. The machine's own next report replaces the verdict. Any
`failed` status that a runner reports is also an error-log row, written once for each distinct reason
rather than once per heartbeat.

**One machine at a time.** Every registration and heartbeat answer carries `autoUpdatePolicy.fleetUpdating`.
This is the number of the owner's other machines that are `installing` or `restarting` and have reported
in the last 10 minutes. A machine that is itself mid-update counts only the machines that began before it
(by attempt time, then machine id), so when two machines start together exactly one goes ahead. While the
count is above zero an automatic update waits with `blocker_class: fleet_stagger` and checks again every
15 seconds. The install bridge reads the count once more from the refresh it makes just before npm runs.
A machine that has been silent for longer than that 10-minute window stops holding up the rest of the fleet.

## Windows

How `pags up` is installed and kept running on Windows is in
[platform-docs/windows.md](../platform-docs/windows.md). What matters for updates:

**The restart itself needs no setup.** `pags up` starts its runner child with
`PAGS_UP_SUPERVISED=2` (`packages/cli/src/commands/up.ts`), so the child's restarter is `pags-up`
(`restarterFrom` in `commands/runner/self-update.ts`). After an install the child exits with code 75
and `pags up` restarts itself on the new release. That holds under the Task Scheduler wrapper too,
so `PAGS_SERVICE` and `PAGS_RESTART_COMMAND` are not needed there.

**A restart leaves no blocked parent (#1036, CLI 0.4.113).** Up to 0.4.112, `pags up` restarted
itself with `execFileSync`: the new `pags up` ran as a child and the old one waited on it forever, so
every update or `r` added one idle process (six deep on one machine after two days). Now
(`packages/cli/src/commands/up-restart.ts`):

- under a service (`PAGS_SERVICE=1`) `pags up` exits with code 75 and the service starts the new
  release; with `PAGS_RESTART_COMMAND` it starts that command detached and exits;
- in a terminal or tmux pane on macOS and Linux it replaces itself in place (`process.execve`, Node
  22.15 or later): same pid, same terminal, nothing left behind;
- where that is not available, Windows included, the first restart turns the process into one thin
  launcher that runs `pags up` again whenever it asks for a restart. That is two processes for good,
  however many updates follow. Restarting the Task Scheduler task clears the launcher too.

A machine still running an older `pags up` keeps its existing chain until that process is restarted
once at the machine.

**npm on Windows (CLI 0.4.117).** On Windows `npm` is `npm.cmd`, which `execFile` cannot start
without a shell. Up to 0.4.116 every npm call in the update path failed there — the release check, the
global install and the stub's cache install — so an ON machine reported `unsupported` with "npm could
not be asked for the latest @proagentstore/cli" (dell-laptop, 2026-10-12). Every one now goes through
`npmInvocation` (`packages/cli/src/bootstrap/payload.ts`): npm's own `npm-cli.js`, found beside the
`npm.cmd` on PATH or beside `node.exe`, run by the runner's Node with no shell; else `npm.cmd` through
`cmd.exe /d /s /c` with every argument quoted. A Windows machine still on 0.4.116 or older cannot fetch
this fix itself, and `runner_update` uses the same npm path: update it once at the machine with
`npm i -g @proagentstore/cli`, then restart the task. After that the policy carries it forward.

Very old runners that cannot report a stable machine ID still need one manual upgrade/restart. They
remain visible but their settings link is deliberately unavailable rather than attaching a policy to
a mutable hostname.
