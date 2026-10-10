# Runner auto-update

Auto-update is an opt-in policy owned by the account and addressed by the runner's stable physical
machine ID, not its hostname or an individual agent. Existing machines have no policy row and are
therefore disabled by default.

Enable it from **Terminals → a machine** or through the MCP `set_machine_policy` tool. The choice is
durable while a machine is offline and is returned whenever that machine registers or heartbeats.
The runner persists its last observed policy locally, then re-syncs on reconnect.

When enabled, the runner checks the published `@proagentstore/cli` release with bounded, jittered
backoff. It uses the same safe update path as manual `runner_update`: semantic versions only,
source checkouts/no-restarter installations are reported as unsupported, active coding and local
application work defer the install, and the policy is rechecked before installation. Turning the
toggle off cancels an update that has not begun installing. A receipt is not success; the Terminals
page records checking, waiting, installing/restarting, verified reconnect, unsupported, offline, or
failure with its last attempt.

Very old runners that cannot report a stable machine ID or understand policy still need one manual
upgrade/restart. They remain visible but their settings link is deliberately unavailable rather than
attaching a policy to a mutable hostname.
