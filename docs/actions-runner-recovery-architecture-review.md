# Actions recovery architecture review

**2026-10-26 — rollout hold.** This review covers the PAGS-owned macOS Actions
service introduced for [epic #1365](https://github.com/ProAgentStore/platform/issues/1365).
Do not adopt the tiny or pink runners until the job-safety and update-lifecycle
gates below pass. The temporary AC watchers remain in place.

## Boundaries

| Process | Owner | Starts at boot | Update path | Health evidence |
|---|---|---|---|---|
| `pags up` | PAGS service | Yes | PAGS auto-update and restart | Relay heartbeat and runtime health |
| `pags actions supervise` | One PAGS LaunchDaemon per runner | Yes | Currently only a service restart | Local status and current-child ready event |
| `runsvc.sh` / GitHub runner | PAGS supervisor | Via supervisor | GitHub runner's own updater | New `Listening for Jobs` and GitHub online/busy view |

The separation is sound: Actions can recover while the PAGS relay is offline,
and each service owns one configured runner. The LaunchDaemon runs as the owner,
with a root-owned plist, and invokes GitHub's required `runsvc.sh` entry point.
`KeepAlive`, `UserName`, and explicit `ProgramArguments` follow Apple's launchd
model. [GitHub's service guidance](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/configure-the-application?platform=mac)
and [Apple's launchd guide](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html)
support these choices.

## Rollout blockers

1. [#1373](https://github.com/ProAgentStore/platform/issues/1373): the supervisor
   signals the whole process group after a worker check. A job can start in
   between and receive the signal. It also needs to prove the old listener
   exited before starting a new one, and resume an unfinished durable recovery
   after a crash. GitHub's [service template](https://github.com/actions/runner/blob/main/src/Misc/layoutbin/actions.runner.service.template)
   signals the service process and allows a long graceful stop.
2. [#1374](https://github.com/ProAgentStore/platform/issues/1374): `pags up`
   auto-updates independently of the long-lived Actions supervisors. A healthy
   relay can run new code while Actions recovery still runs old code; status
   does not expose that version skew. A newly downloaded payload is visible to
   Actions before the PAGS startup probe approves it.
3. [#1209](https://github.com/ProAgentStore/platform/issues/1209): service
   installation needs a preflight proving the captured PATH resolves Node and
   the CLI bootstrap path is durable before it stops a legacy service.

The general PAGS updater has a separate policy defect:
[#1375](https://github.com/ProAgentStore/platform/issues/1375) tracks the
bootstrap's unconditional fetch before Auto-update OFF is checked. It is not
specific to Actions, but the service lifecycle must not rely on that fetch.

## Safety fixes from this review

- The API now treats incomplete/malformed machine status as **unknown**, not
  “current, zero runners”; a null runner entry no longer causes a 500.
- `pags actions service remove` refuses a legacy service it did not generate.
  Remote deregistration requires a removal receipt **and** a live check that
  the exact service and runner processes are gone. The temporary watcher is
  not considered proof of PAGS ownership.

## Refactor order

1. Make stop, wait-for-exit, and restart one explicit state machine with a
   persisted recovery ID. Signal only the owned service process; defer for an
   active worker; verify the old listener is gone before a replacement.
2. Make CLI payload promotion and Actions supervisor handoff part of one
   verified update protocol. Report the supervisor version, keep a live old
   payload available, and test the Actions service in release smoke.
3. Use a shared, runtime-validated status contract across browser runner, API,
   MCP, and console. The current optional fields are copied across three
   packages; `serviceState` is declared but not produced.
4. Inventory macOS services once per status request (or cache briefly).
   Current status runs synchronous `plutil` scans for every runner and can
   stall the relay event loop on a host with many plists.
5. Extract the local/remote manual-recovery request writer into one protocol
   primitive; the two implementations have different validation rules.

Only after #1373 and #1374 pass code and service tests should
[#1368](https://github.com/ProAgentStore/platform/issues/1368) adopt the three
active laptop runners. Then verify a pre-login reboot, short AC interruption,
and several-hour sleep/AC return before removing either temporary AC watcher.
