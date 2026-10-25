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

**Probed before it is swapped in (#1148).** The rollback above moves onto the new release first and falls back if it
fails. The install now also tries the new payload BESIDE the running `pags up` before anything is swapped: the running
process starts the candidate's own entry point as `pags runner probe --expect <version>`, a short-lived child that
checks that it loads as the release asked for, that the API accepts this machine's saved sign-in, and that it can open
a relay socket and get a round trip back. The probe takes nothing the running runner holds — not the per-account
runner lock, not any agent's relay slot (the socket is a `probe=1` connection the API answers itself, never the
agent's relay), not the local runtime port — and registers and changes nothing. The swap happens only if it passes. A
release that will not start, or is not the release asked for, is marked bad like a rollback (it shows on the machine
page, and **Retry** or `retry_rolled_back` tries it again) but leaves no rollback notice, since it never ran here. A
failure that may be the machine or the network (no sign-in, the API or relay unreachable, a timeout) is not remembered:
the update fails with the reason and is tried again. The trial window stays as the second line of defence. The probe
runs for the stub's payload cache only (a global `npm i -g` install has no payload to try), and
`PAGS_NO_UPDATE_PROBE=1` skips it.

**A runner not under the stub (#1147).** The trial and the fall-back above need the bootstrap stub, which runs payloads
from `~/.config/proagentstore/cli/<version>`. A runner started any other way — a global install run from a path other
than the stub — updates in place with `npm i -g`, and there is no older copy beside it. Two things change for it. It
SAYS so: every status report carries `rollbackAvailable` (`false` in place, `true` under the stub), the machine detail
and `list_runner_nodes` rows return it as `rollback_available`, and the machine page notes that the machine updates in
place. And the in-place install is no longer final: right after `npm i -g`, the installed package is started as `pags
runner probe` (see above), and if that fails the PREVIOUS release is installed again, the failing one is marked bad (if
it would not start), and the update fails naming both. What it cannot do is the stub's later fall-back, for a release
that starts and registers but crashes afterwards. Starting `pags up` from the installed `pags` command puts the machine
under the stub, and every update after that gets the trial.

**The trial is passed on health, not on a first answer (#1154).** A release on trial used to be kept as soon as the platform
answered its first registration. When the install was an automatic update cycle, it is now kept only once every agent
the machine held at install time that it should still hold has re-attached and registered (agents repinned, paused or
unsubscribed since are excused, as in the update verdict). Until then the runner says so in its output and the stub's
five-minute window runs; a release that answers but never brings its agents back is given up on and the previous release
runs. A start with no open update cycle (by hand, first run) is still proven by the first answer.

A version that was given up on is not picked again. The stub's own check on `pags up` does not fetch it,
and the updater refuses it as `failed` with the reason ("… was installed here and rolled back: …") until
a newer release is published. The version that runs next reports the rollback in its first registration
("Rolled back from 0.4.149 to 0.4.148: it crashed on start: …"). That message goes to `last_error` and
to the error log.

The rollback is also kept (#1150): each report lists the releases the machine rolled back from, as
`rollbacks` (`from`, `to`, `reason`, `at`), and the machine page shows them under "Rolled-back releases".
To try a rolled-back release again — after a fix at the machine, or when the failure was environmental —
press **Retry** on that page, or call `runner_update` with `retry_rolled_back` (`POST
/v1/terminals/nodes/{node}/update` with `{"retryRolledBack": true}`). The machine clears the bad mark for the
latest release and installs it on trial again, like any new release; if it fails again it is rolled back and
marked again. A plain update, and auto-update, still refuse a rolled-back release. Nothing needs deleting at
the machine (`~/.config/proagentstore/cli/.bad.json`).

**An OS supervisor: `pags up --install-service`.** This installs a LaunchAgent on macOS, a systemd
user unit on Linux, or a Scheduled Task at startup on Windows, and starts it. All three run the same small
Node supervisor (`~/.config/proagentstore/pags-up-supervisor.mjs`). It starts `pags up --headless` with
`PAGS_SERVICE=1` and appends its output to `pags-up.log`. When `pags up` exits with the restart code
(an update or `runner_restart`), the supervisor starts it again after 1 second. After any other exit it
waits, doubling the wait from 10 seconds up to 5 minutes, and resets the wait once a run has lasted 10
minutes. `pags up --uninstall-service` removes it. The macOS LaunchAgent runs only while the user is
logged in, so a Mac that has to come back after a reboot unattended needs either automatic login or
`pags up --install-service --daemon` (#1149): a LaunchDaemon in `/Library/LaunchDaemons` that runs as the
owner (`UserName`, with their `HOME`) from boot, with nobody logged in. Run it as that user, not root; it asks
for `sudo` in the terminal to copy the root-owned plist and load it, and replaces an existing LaunchAgent so
two supervisors do not fight for the runner's lock. The sign-in it uses is the plain file in
`~/.config/proagentstore`, not the keychain, so the same `pags login` works from the daemon. With FileVault on
the Mac still waits at the disk-unlock screen after a reboot. The watchdog service is a LaunchAgent and is not
installed under a daemon. `pags up --uninstall-service` removes whichever is installed. The Linux
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

## An update always comes back, and says what it did (#1151)

On 2026-10-17/18 the Mac mini, the pink laptop and dell-laptop each auto-updated 0.4.148 → 0.4.149, reported
`installing`, and were never heard from again. 0.4.149 was not broken — the Mac mini and the pink laptop run it,
started by hand — and byte-identical updater and restart code had moved the Mac mini 0.4.147 → 0.4.148 eleven
hours earlier. On the Mac mini the install completed (the 0.4.149 payload was renamed into its cache a second
before the last heartbeat) and no `runner connect` started after it, and no crash report was written — so what
died was the `pags up` the restart started, before it reached its runner. Nothing survived that: on macOS and
Linux the old process had replaced itself in place (`execve`), so the new one's exit was the end; on Windows
the launcher gave up after one failed start. Which step killed it could not be recovered — the CLI kept no
log, `console.clear()` had overwritten the terminal, and a `pags up`'s own exit is not a crash report.

**Nothing is left to a single start.** A restart no longer replaces the process in place: the process that
held the terminal stays as the launcher (above) and outlives every `pags up` it starts. When a start after a
remote update fails — any non-zero exit or signal — the launcher starts it again, waiting 10 seconds and
doubling up to 5 minutes, until one comes up (`relaunchDelayMs`, `up-restart.ts`). A `pags up` started
unattended (`PAGS_NO_PROMPT=1`, which every update restart sets) also no longer exits on what a retry
clears: it retries the instance list with backoff instead of exiting on a failed fetch, and waits up to a
minute for the old runner's lock before judging it. That half runs in the NEW release's code, so it already
protects the restart that an older `pags up` performs. Only a restart a person asked for (`r`) still reports
a failure and exits, because someone is there to see it.

**The update log.** Every step goes to `~/.config/proagentstore/update.log` (`PAGS_UPDATE_LOG` overrides),
one timestamped, pid-stamped line each, cut back to its newest half past 256KB
(`packages/cli/src/bootstrap/update-log.ts`): the install starting, finishing or failing with npm's
reason; the runner leaving for its restarter and with what exit code; each start and exit the launcher
sees and each retry; each `pags up` start, a failed instance fetch, a held lock; the stub's update,
rollback and choice of version; and the new version's first answer from the platform. The first
registration of every start uploads the newest 4000 characters, and the machine record keeps it as
`update_log` (`list_runner_nodes`, `machine_policies.update_log`, migration 0253) — so the next update
that does not come back can be read from the record of the start that follows it.

## One restart owner, and nothing that dies stays dead (#1154)

Every `pags up` now has exactly one thing that restarts it, and every way it can end is handed to that owner:

| Started as | Restart owner | What `list_runner_nodes` reports (`supervisor`) |
|---|---|---|
| `pags up --install-service` (launchd / systemd / Scheduled Task) | the service supervisor | `service` |
| `pags up` in a terminal or tmux pane | a launcher — the terminal `pags up` itself, from its **first** start | `launcher` |
| `pags up --background`, a bare `runner connect`, or a launcher that was killed | nothing | `none` |

`supervisor` is on each machine in `list_runner_nodes` (and on `resources.runner`, beside `launch`, which is
how it was started). Null means a CLI older than 0.4.151. Before this, `launch` and the runner's `rsid` were
never actually reported: `runner connect` put them only into its runtime child's environment.

How each ending is handed over (`runnerExitAction`, `up-restart.ts`):

- **75** — an update or `runner_restart`: the owner starts it again at once, on the new release.
- **0** — a deliberate stop (`pags down`, `--replace` from another terminal): `pags up` leaves cleanly, and the
  owner does not start it again.
- **anything else** — the runner crashed, was OOM-killed, or was killed by a signal: `pags up` exits **76**,
  and the owner starts it again with backoff (10s, doubling to 5 minutes, reset after a 10-minute run). Until
  0.4.150 a dead runner was only redrawn as "Runner exited (code N)" while `pags up` stayed up, so neither the
  service nor a launcher ever noticed it.

A launcher's child records the launcher's pid (`PAGS_UP_LAUNCHER_PID`). If the launcher is killed, the orphan
no longer exits to it: the next time its runner ends it becomes the launcher itself.

**Proven in real processes** (`packages/cli/src/commands/up-recovery.test.ts`): killing the runner brings up a
new `pags up` under the same launcher; killing the launcher and then the runner makes the orphan the new
launcher; a release that dies at every start is retried until the stub gives it up after six starts and runs
the previous version; one that crashes on import is rolled back in the same start; and a release given up on
is never started again. A reboot is the OS unit's job (`RunAtLoad`, `WantedBy=default.target`, `-AtStartup`).

**Still open.** macOS starts at login, not at boot (#1149). The trial/rollback lives in the *global* stub,
which an auto-update never replaces, so a machine whose global install predates 0.4.150 has no rollback until
`npm i -g @proagentstore/cli` is run there once, and a non-stub install has none (#1147). A release on trial
passes on the platform's first answer; "every agent re-attached" is checked, but does not roll back.

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
- everywhere else — a terminal or tmux pane on any OS — the first restart turns the process into one thin
  launcher that runs `pags up` again whenever it asks for a restart. That is two processes for good,
  however many updates follow. Restarting the Task Scheduler task clears the launcher too. (Up to 0.4.149,
  macOS and Linux replaced the process in place with `process.execve` instead; that left nothing to retry
  a respawn that failed — see the next section.)

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

## Safe by construction, and visible when it is not (#1320)

An update never leaves a machine broken, and the platform tells the owner when one needs a look — so nobody has to check
machines by hand.

**What already protects a machine** (#862, #1141): every release installs into a scratch folder and is renamed into place, beside
the previous one; a new version is on *trial* until its relay registers; a version that crashes on import, is started six times
unproven, or is still unproven five minutes after its first start is marked bad and the previous version runs again, never to be
fetched again; the last good version always stays in the cache.

**Pre-flight, before anything is fetched** (`bootstrap/preflight.ts`): the update folder must be writable, at least 400 MB must be
free where it installs, and Node must be 18 or later. A machine that cannot pass is left exactly as it was and says why
(`update pre-flight failed: only 90 MB free where the update installs…`); it shows up as a failed update in the fleet alerts below.
An already-installed version needs no pre-flight, so a full disk never stops a machine starting on what it has.

**Capability report on every start** (#1312): the runner detects its capabilities when it starts (including after every update
restart), re-checks every ten minutes, sends the full record whenever the platform does not hold its hash, and re-sends it at least
daily even when nothing changed.

**Fleet alerts** (`lib/fleet-health.ts`, every five minutes): each machine that is online is judged on whether it has reported its
capabilities (an alert after 30 minutes online with none), whether its report is stale (older than 36 hours), whether it is behind
the latest published release (a release gets 12 hours, measured from when the platform first saw it), whether its last update
failed, and whether its runner started five or more times in 24 hours. Each raises one alert per episode — a push notification
linking to the machine, an `agent_events` row (`fleet.<kind>`) — and clears when the machine recovers. An offline machine is not
judged here; machine silence has its own alarm.

## The watchdog: an always-on control channel (#1320)

A second OS service, separate from the runner's (`online.proagentstore.pags-watchdog` LaunchAgent, `pags-watchdog.service` user
unit, `pags watchdog` Scheduled Task), runs `pags watchdog run`. It has its own connection to the platform — a heartbeat every 30s
to `/v1/terminals/machines/{id}/watchdog/heartbeat` with the account session — so it works when the runner is dead or wedged.

- **Install.** A runner started by the service installs it once (`ensureWatchdogInstalled`; opt out with `PAGS_NO_WATCHDOG=1`).
  By hand: `pags watchdog install | uninstall | status`.
- **Reports.** Each heartbeat carries the watchdog's version, the payload versions on disk, trial and rollback state, bad versions,
  whether a runner holds a live lock, crashes in the last 24h and the last error (paths and token-shaped strings removed). It also
  carries the capability record (#1312) when the platform asks for it, so a machine with a dead runner still reports.
- **Commands** (queued by the owner at `POST .../watchdog/commands`, a closed set): `status`, `update [version]` (installs beside the
  current version; restarts the runner only if it is dead), `restart` (the runner's own service unit), `rollback` (needs a second
  good version; marks the newest bad and restarts), `diagnose` (allow-listed checks). Open commands of one kind are not doubled; unanswered
  ones expire (queued 24h, delivered 30m); at most three are delivered per heartbeat, each bounded to 10 minutes.
- **Outage.** Heartbeats back off 5s → 300s; results of finished commands are carried until the platform acknowledges them.

Rollback of a bad update itself is unchanged and needs no platform: trial period, bad-version memory, last-good kept (#1141).

## The release gate: a smoke test before every publish (#1152)

On 2026-10-17 a release that could not come back after an update went out because nothing started it before it was
published. The "Publish to npm" workflow now has a blocking smoke test, on GitHub-hosted **Linux and Windows** runners
(`smoke-linux`, `smoke-windows`; no macOS, for the minute cost). `publish` `needs` both, so a failure on either stops the
SDK and the CLI from being published. Run it yourself with `pnpm --filter @proagentstore/cli build` and then
`pnpm test:release-smoke`.

It never touches the real platform or the real npm account. The candidate is `npm pack`ed from `packages/cli` and
installed the way a user's machine gets it. One local server plays both the platform API (the sign-in, the agent list,
runtime registration and heartbeats, and the owner's auto-update switch) and an npm registry (the candidate as `latest`;
the previous release and every dependency passed through from the real registry). A preloaded hook
(`scripts/release-smoke/redirect.mjs`) points the compiled-in API address at that server, so the previous release runs
unmodified. Then:

1. **Start.** The candidate runs `pags up --headless` under the bootstrap stub; it must register a runtime and then
   heartbeat.
2. **Update.** The newest earlier release does the same with auto-update ON; its own updater must find the candidate,
   install it, leave, and the candidate must come back, registered and heartbeating. (With no earlier release this
   stage is skipped and says so.)

A failure prints which stage and what was missing, with the tail of the runner's `update.log` and output. Deliberately
out of scope: other operating systems and Node versions, an update mid-turn, a supervisor-managed start, a broken
candidate's automatic rollback, relay reconnects, packaging checks and a post-publish canary — this was the first
incident, and the issue asked for this one test.

## A restart started by a command is checked, and started again (#1151)

The `pags up` launcher and a service manager outlive the runner they restart, so they retry a start that dies. The other
restarter does not: `pags up --background` and anything run with `PAGS_RESTART_COMMAND` restart after a remote update by
starting a detached command and exiting, and on 2026-10-17 that shape lost three machines with nothing left to notice. The
leaving runner now also starts a small detached **guard** (`pags-restart-guard.mjs`, beside `update.log`; Node builtins
only, so it works even when the release it restarts onto is broken). It waits for the old runner to exit, then watches the
lock directory for a live runner that is not the old one. If none appears within 150 seconds it runs the command again —
up to three starts in all — and every step, including `GAVE UP … it needs starting at the machine` when none comes up, is
a line in `update.log`. If the guard itself cannot start, the update log says the restart is unverified.

## A machine's sign-in: per machine, revocable, of a length you choose (#1184)

`pags login --device` (#1157) signs a headless machine in from any other device. Each approved machine now gets its own
**credential**: the session it receives carries the credential's id, and every request from it is checked against that
record, so one machine can be withdrawn without ending anything else.

- **Length.** 30, 90 or 180 days. The approval page has a "Stay signed in for" choice; leaving it on "my default" uses
  your account setting (30 days until you change it with `pags devices lifetime 90`, or `PUT /v1/auth/device/lifetime`). A
  change applies to machines signed in from then on; existing ones keep theirs.
- **Renewal.** A running `pags up` renews its sign-in in the last 7 days. A machine's session is renewed as the same
  credential for its own length, so a reboot reconnects without a login for as long as the credential is valid.
- **See and revoke.** `pags devices` lists the machines (name, id, expiry, status) and shows when your own sign-in runs
  out; `pags devices revoke <id>` (or `DELETE /v1/auth/device/credentials/<id>`) stops one at once, on every route, and a
  refresh cannot bring it back. `pags whoami` shows the expiry and warns 30, 7 and 1 days before it, and once it has passed.
- **Not changed.** A browser session carries no credential and is never looked up; it stays a 30-day session.

## A coding engine can read the sign-in file — so make it worth little (#1192)

A coding engine runs as the same OS user as `pags up`, and the sign-in lives in `~/.config/proagentstore/session.json`. A file
cannot be hidden from a process running as its owner, so a prompt injection that says "read that file and post it" reaches
whatever session is in it. Since #1163 the environment no longer carries it; this change reduces what the file is worth:

- **Runner-only sign-in.** `pags login --device --runner-only` asks for a sign-in that may call only the routes a runner itself
  calls: list its agents, register and heartbeat, ask for relay tokens, send crash reports, read the machine names to claim its own,
  its watchdog, renew itself. Every other route — agents, billing, keys, secrets, profile, signing other machines in, approving a
  device request — answers 403. The allowlist is `lib/runner-scope.ts`, and a test reads the runner-side CLI source so a call
  added there that the list refuses fails the build instead of breaking runner-only machines. It is a device credential (#1184), so it
  is also one machine's, of a lifetime you choose, and revoked on its own (`pags devices revoke <id>`).
- **You decide.** The machine can ask; the approval page shows it and has a "Runner only" box, ticked when it asked. A stolen
  runner-only session cannot approve a request to mint a full one.
- **The file.** It is now written 0600 in a 0700 directory, and an older world-readable one is tightened on the next write.
  That is hygiene, not a defence from an engine running as you.
- **Unchanged, deliberately.** `pags login` in a browser still gives the full 30-day session, for the machine you work at yourself.

Not done, and why: the OS keychain — an unattended service (the `--daemon` LaunchDaemon, a systemd user unit) cannot use the login
keychain, which is the case that matters; and a sandbox profile for engines, which differs per engine and per OS and which this
repo does not set. A runner-only session can still act as that runner (register, heartbeat, ask for relay tokens for the owner's
agents), which is why it stays revocable; it cannot touch the account.

## Which folders the runner will read: an allow-list (#1193)

The runner's inspection routes (`read-file`, `tree`, `search`, `git`, `git-write`, park) take a `workDir` from the request, and the
platform supplies it from the owner's repo registry, which the machine has no copy of. #1165 refused the home folder, credential
directories and links into them — a deny-list, which left a registered or forged `~/Documents` readable and could not name every
app's token store. The runner now also requires the folder to be one of:

- **inside a git working tree** whose root is below the home folder (a `.git` directory, or the file a worktree or submodule has) —
  a repository, which is what these routes exist to read. A repository at the home folder itself (dotfiles) does not make everything
  in the home folder a repository; or
- **inside a root the owner registered on this machine**: `pags runner roots add <folder>` (and `remove`, or no argument to list).
  It writes `~/.config/proagentstore/runner-roots.json`. Nothing the cloud can ask for writes it, which is the point: a folder the
  platform supplies cannot widen what the machine allows.

The credential rules still come first, so a root cannot be the home folder, a folder above it, a credential directory or a link
into one. The runner's own managed clones are unchanged. A folder outside both is refused with the folder named and the command that
fixes it. Not covered: an engine running as you can edit the roots file as it can read anything you can (see the runner-only
sign-in above for what that costs).

Also worth knowing, from #1165: `tmux_secure_put` / `tmux_secure_get` no longer take an arbitrary path. A flow that delivered a `.env`
straight into a project folder now writes it to `~/.config/proagentstore/secure-files`, and the operator moves it.
