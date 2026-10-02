# Runner recovery investigation (#901)

Reviewed on 2026-10-03 against main at `e58ae471` and the issue's report.

## What the measurements establish

`runnerLiveStatus` in `workers/api/src/lib/runner-health.ts` derives
`unresponsive` from a connected relay and an unsuccessful health check. Neither
measurement establishes which process or socket is at fault. The earlier claim
that reconnecting cannot help was stronger than the evidence.

`attachAgentOnNode` in `workers/api/src/lib/runner-repin.ts` probes the target
agent's sockets through `evictStaleRunnerSocket`, clears nonresponding sockets,
then tries this owner's carrier sockets on the target machine. The CLI's
`answerControl` in `packages/cli/src/commands/runner/relay.ts` handles a named
membership sync by dropping the existing attachment and opening it afresh.
Consequently, recovery with `evicted: 0` is consistent with the implementation:
a socket that answers pings can still need its attachment reopened.

Force attachment confirms relay attachment, not `/health` or session recovery.
Diagnostics must be repeated afterwards. If every carrier is unavailable, the
remote command cannot recover a frozen process; starting or restarting `pags up`
on the machine remains the fallback.

## Recovery decision

Recommend explicit `force_runner_attach` followed by `coding_diagnostics` before
requiring a physical restart for a connected but unresponsive runner. Keep
diagnostics read-only: automatic force attachment can close a responding socket
and interrupt in-flight commands, so it does not belong in a health inspection.
A disconnected target socket can also be recovered through another responding
carrier on the same machine; it does not invariably require hands-on access.

## Opaque MCP failures

The issue provides no transport logs for the historical bare MCP failure, so its
exact source cannot be established from the repository. Main already includes
the #887 `authedAsyncCall` confirmation window and lost-reply handling for both
machine tools. This change adds `confirmation.reason` and any received HTTP
status to distinguish transport loss, a confirmation deadline, and a gateway
failure, while naming the polling tool in the message. Transport errors, slow confirmation, and gateway failures must
remain uncertain outcomes with polling instructions: the write may have landed.
Explicit application refusals remain errors. A complete MCP connection loss or
client-side failure can still prevent any server response reaching the caller.
