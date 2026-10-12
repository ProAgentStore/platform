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
- `observations` — the last five paired looks: `{success, sampled_at, source}` only. No session text,
  process arguments, paths, prompts or tokens are reported.

Retained engines that report `alive:true, runState:"idle"` and engines that have exited do not block;
any other or missing lifecycle state does.

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
- the machine does not already report `unsupported`;
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

## Windows

How `pags up` is installed and kept running on Windows is in
[platform-docs/windows.md](../platform-docs/windows.md). What matters for updates:

**The restart itself needs no setup.** `pags up` starts its runner child with
`PAGS_UP_SUPERVISED=2` (`packages/cli/src/commands/up.ts`), so the child's restarter is `pags-up`
(`restarterFrom` in `commands/runner/self-update.ts`). After an install the child exits with code 75
and `pags up` restarts itself on the new release. That holds under the Task Scheduler wrapper too,
so `PAGS_SERVICE` and `PAGS_RESTART_COMMAND` are not needed there.

**Each restart nests a process (#1036, open).** `pags up` restarts itself with `execFileSync`, which
starts the new `pags up` as a child and blocks the old one until it exits. Every update adds one more
waiting parent, and under the Task Scheduler wrapper the process count grows by one each time. To
clear it, restart the task (`Stop-ScheduledTask` then `Start-ScheduledTask -TaskName "pags up"`) or
the machine after an update.

**Self-update cannot run npm on Windows yet.** *Read from the source, not yet reproduced on a
Windows machine.* Every npm call in the update path runs through `execFile("npm", …)` with no shell:
the release check (`latestPublishedVersion`, `packages/cli/src/bootstrap/payload.ts`), the global
install (`installVersion`, `commands/runner/self-update.ts`) and the stub's cache install
(`npmInstallInto`, `bootstrap/payload.ts`). On Windows `npm` is `npm.cmd`, and a `.cmd` file cannot be
started without a shell. So the release check comes back empty and the update is refused ("npm could
not be asked for the latest @proagentstore/cli"), whether it was started by the Auto-update policy or
by `runner_update`. Until that is fixed, update a Windows machine by hand: `npm i -g
@proagentstore/cli`, then restart the task.

Very old runners that cannot report a stable machine ID still need one manual upgrade/restart. They
remain visible but their settings link is deliberately unavailable rather than attaching a policy to
a mutable hostname.
