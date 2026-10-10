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

Very old runners that cannot report a stable machine ID still need one manual upgrade/restart. They
remain visible but their settings link is deliberately unavailable rather than attaching a policy to
a mutable hostname.
