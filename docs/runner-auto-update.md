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

Very old runners that cannot report a stable machine ID still need one manual upgrade/restart. They
remain visible but their settings link is deliberately unavailable rather than attaching a policy to
a mutable hostname.
