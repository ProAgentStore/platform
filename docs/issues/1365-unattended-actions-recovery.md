# #1365 — PAGS-owned unattended Actions recovery queue

Design: [actions-runner-unattended-recovery.md](../actions-runner-unattended-recovery.md).
Fleet evidence and temporary watcher: [machine-setup#15](https://github.com/serge-ivo/machine-setup/issues/15).

| Order | Issue | Deliverable | Depends on |
|---|---|---|---|
| 1 | [#1366](https://github.com/ProAgentStore/platform/issues/1366) | PAGS per-runner supervisor, AC wake state machine, active-job protection, verified readiness contract | — |
| 2 | [#1209](https://github.com/ProAgentStore/platform/issues/1209) | Generated macOS system service, existing `.runner` adoption, exact rollback/removal | #1366 contract |
| 2 | [#1367](https://github.com/ProAgentStore/platform/issues/1367) | Local health and recovery telemetry, GitHub status integration, safe explicit control through PAGS | #1366 contract |
| 3 | [#1368](https://github.com/ProAgentStore/platform/issues/1368) | Tiny/pink migration, physical overnight retest, retirement of machine-setup watchers | #1366, #1209, #1367 |

The [epic](https://github.com/ProAgentStore/platform/issues/1365) owns the
acceptance checklist and closing decision. #1209 is an existing open issue
from the self-hosted runner program; it was expanded rather than duplicated.
The owner must be at the laptops for #1368's charger tests. There is no
GitHub Project or milestone queue attached to these issues; the epic's order
and dependency text are the queue.

Do not remove the temporary watcher before the PAGS service has restored
every Actions scope after a real long sleep with no login, remote shell or
button press. An unsupported fully depleted Intel laptop remains outside
this Actions recovery guarantee.
