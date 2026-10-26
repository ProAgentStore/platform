# Actions recovery architecture review

**2026-10-26 — rollout hold.** This review covers the PAGS-owned macOS Actions
service introduced for [epic #1365](https://github.com/ProAgentStore/platform/issues/1365).
Do not adopt the tiny or pink runners until the job-safety and update-lifecycle
gates below pass. The temporary AC watchers remain in place.

**Implementation update:** the #1373 and #1374 code fixes, #1209 launch preflight,
and #1375 bootstrap policy fix were pushed at `dbf65e32`. The supervisor now
stops `runsvc.sh` gracefully, proves process exit before replacement, replays
unfinished recovery, and hands off only to a relay-proven CLI version when idle.
The updater retains live payloads and activates staged updates only after final
policy admission. Focused tests, 610 related pre-push tests, and packed release
smoke passed. CI, publishing, and the physical macOS/AC tests remain rollout gates.

## Boundaries

| Process | Owner | Starts at boot | Update path | Health evidence |
|---|---|---|---|---|
| `pags up` | PAGS service | Yes | PAGS auto-update and restart | Relay heartbeat and runtime health |
| `pags actions supervise` | One PAGS LaunchDaemon per runner | Yes | Idle handoff after a verified PAGS update | Local status, CLI version, and current-child ready event |
| `runsvc.sh` / GitHub runner | PAGS supervisor | Via supervisor | GitHub runner's own updater | New `Listening for Jobs` and GitHub online/busy view |

The separation is sound: Actions can recover while the PAGS relay is offline,
and each service owns one configured runner. The LaunchDaemon runs as the owner,
with a root-owned plist, and invokes GitHub's required `runsvc.sh` entry point.
`KeepAlive`, `UserName`, and explicit `ProgramArguments` follow Apple's launchd
model. [GitHub's service guidance](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/configure-the-application?platform=mac)
and [Apple's launchd guide](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html)
support these choices.

## Findings that blocked rollout

1. [#1373](https://github.com/ProAgentStore/platform/issues/1373): the prior supervisor
   signaled the whole process group after a worker check. A job could start in
   between and receive the signal. The fix signals `runsvc.sh`, proves the old
   listener exited before replacement, and resumes unfinished durable recovery.
   GitHub's [service template](https://github.com/actions/runner/blob/main/src/Misc/layoutbin/actions.runner.service.template)
   signals the service process and allows a long graceful stop.
2. [#1374](https://github.com/ProAgentStore/platform/issues/1374): `pags up`
   previously updated independently of the long-lived Actions supervisors.
   The fix reports version skew, defers a handoff until idle, pins the live
   payload, and keeps unverified candidates away from Actions.
3. [#1209](https://github.com/ProAgentStore/platform/issues/1209): service
   installation now preflights the captured PATH, Node, and durable bootstrap
   before it stops a legacy service.

The general PAGS updater had a separate policy defect:
[#1375](https://github.com/ProAgentStore/platform/issues/1375) tracks the
bootstrap's unconditional fetch before Auto-update OFF was checked. It now
uses the connected updater and activates a staged payload only after final
policy admission.

## Safety fixes from this review

- The API now treats incomplete/malformed machine status as **unknown**, not
  “current, zero runners”; a null runner entry no longer causes a 500.
- `pags actions service remove` refuses a legacy service it did not generate.
  Remote deregistration requires a removal receipt **and** a live check that
  the exact service and runner processes are gone. The temporary watcher is
  not considered proof of PAGS ownership.

## Refactor order

1. **Implemented, awaiting physical verification:** stop the owned service
   process, defer for an active worker, verify the old listener is gone before
   replacement, and replay the persisted recovery ID.
2. **Implemented, awaiting release verification:** promote only admitted CLI
   payloads, hand off idle Actions supervisors, report version skew, retain a
   live old payload, and load the packed supervisor in release smoke.
3. Use a shared, runtime-validated status contract across browser runner, API,
   MCP, and console. The current optional fields are copied across three
   packages; `serviceState` is declared but not produced.
4. Inventory macOS services once per status request (or cache briefly).
   Current status runs synchronous `plutil` scans for every runner and can
   stall the relay event loop on a host with many plists.
5. Extract the local/remote manual-recovery request writer into one protocol
   primitive; the two implementations have different validation rules.

Only after #1373 and #1374 pass release and physical service tests should
[#1368](https://github.com/ProAgentStore/platform/issues/1368) adopt the three
active laptop runners. Then verify a pre-login reboot, short AC interruption,
and several-hour sleep/AC return before removing either temporary AC watcher.
