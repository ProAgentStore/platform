# Unattended Actions runner recovery on PAGS machines

**Status:** PAGS implementation shipped on `main` from `a6be5d7d` (CLI
0.4.186 with owner console and review fixes, MCP surface 0.1.189); fleet rollout and physical verification remain
queued behind the [architecture review](actions-runner-recovery-architecture-review.md).
This extends the self-hosted runner design in
[runner-self-hosted-design.md](runner-self-hosted-design.md). It does not
change GitHub Actions routing or promise startup after a laptop's battery is
fully depleted.

## Why this is needed

On 2026-10-25/26, `tiny-laptop` and `pink-laptop` slept on battery for about
17 hours 13 minutes. AC attachment woke both without a button or console login,
with about 97% and 93% charge remaining. PAGS reconnected. Their three GitHub
Actions `Runner.Listener` processes stayed alive but did not log a fresh
`Listening for Jobs` during the first nine minutes after AC returned. A remote
service restart brought all three back. The observed failure and temporary
fleet repair are tracked in
[machine-setup#15](https://github.com/serge-ivo/machine-setup/issues/15).

The temporary repair is a `machine-setup` LaunchDaemon and shell script on
each laptop that notices battery-to-AC transitions and restarts idle Actions
listeners. A simulated transition passed; a physical retest is outstanding.
The product goal is for PAGS to own installation, recovery, configuration,
monitoring, and removal of that behavior.

## Previous product boundary

`pags up` owns the PAGS relay/browser runner. It does not own GitHub's
`Runner.Listener` processes, and it can exit on a machine with no eligible
pinned runtime instances. The current CLI already offers
`pags up --install-service --daemon` for pre-login PAGS startup on macOS.
The two laptops still use earlier custom PAGS system LaunchDaemons.

Before this change, `actions_runner_setup` registered an Actions runner and called GitHub's
`svc.sh install/start`. On macOS that installs a user LaunchAgent. The laptops
instead use manually installed system LaunchDaemons so Actions starts before
login. Re-running setup when `.runner` existed returned early; it did not adopt
or repair the service. `actions_runner_status` already enriched each installed
runner with GitHub's online/busy/routable view when the App could read it. It
did not show the local service domain, a current supervisor health sample,
or the outcome of an AC wake recovery.

The original implementation points were
`packages/browser-runner/src/coding/actions-runner.ts`,
`packages/cli/src/service-install.ts`,
`workers/api/src/lib/actions-runner-provision.ts`, and
`workers/mcp/src/instance-tools/machine-control.ts`.

## Decision

PAGS will manage each Actions runner as its own OS service. On macOS the
pre-login mode is a root-owned **system LaunchDaemon** with `UserName` set to
the signed-in owner. Its program is a PAGS CLI command, for example
`pags actions supervise <scope>`; that command runs as the owner and starts
the configured GitHub runner as its child. PAGS generates and updates the
plist. There is no machine-maintained recovery script or separate AC watcher.
The system service does not require `pags up` to remain connected.

The supervisor owns exactly one installed runner folder and one listener
process tree. It holds an exclusive per-runner lock, uses the runner's existing
`.runner` and `.credentials` files, and never copies registration or account
tokens into the plist, logs, or process arguments. A crash of the supervisor
is restarted by launchd; a child exit is restarted with bounded backoff.

On macOS the supervisor watches the AC/battery state and persists the last
observed state in PAGS-owned local data. After battery use followed by AC, it
waits for network readiness, then renews the listener session by restarting
its own child. It **defers while that runner has an active `Runner.Worker`**
and retries when the worker ends. An outage of GitHub itself must not cause a
rapid restart loop. PAGS records the reason, times, and result of each
recovery. A fresh process alone is not success: the supervisor must observe
a current listener-ready event and the control plane must reconcile that with
GitHub's online view. Stale log lines cannot count as readiness.

`pags up` remains the separate PAGS runtime service. It may show Actions
health and accept an explicit owner-requested recovery through PAGS, but it
must not be the only actor capable of reviving Actions after an outage.

## Configuration and control

`actions_runner_setup` (and an equivalent local CLI path) gains an explicit
macOS system-service mode and an idempotent adoption path for an already
configured `.runner`. Administrator approval is required to install or remove
the root-owned plist. A remote PAGS call must return `needs_admin` with the
exact local step when elevation is unavailable; it must never try an
unattended password or silently fall back to a login-only LaunchAgent.

PAGS stores the desired service mode and AC-recovery policy as owner-visible
configuration, with a local copy sufficient to recover while its cloud relay
is disconnected. The default for a new macOS system service is to recover on
AC return; an owner can inspect or disable it through PAGS. The policy must
have one source of truth and survive CLI updates and reboots.

The implementation uses `actions_runner_setup` with
`service_mode: "macos_system"` to request pre-login mode. The machine returns
`needs_admin` with the local command. On that machine, the owner runs
`pags actions service install --dir <runner-directory>` and approves the
administrator prompt. `pags actions status --dir <runner-directory>` reads the
local supervisor sample, while `pags actions policy --dir <runner-directory>
--ac-recovery on|off` changes the persisted AC policy. PAGS also exposes
`actions_runner_status` and a scoped `actions_runner_recover` tool; the latter
returns a recovery ID whose outcome appears in status. Omitting `service_mode`
keeps the existing macOS user-service setup behavior.

The shipped local commands are `pags actions supervise --dir`,
`pags actions service install|remove --dir`, `pags actions status --dir`,
`pags actions recover --dir`, and `pags actions policy --dir --ac-recovery
on|off`. The service installation reads the existing runner configuration and
does not mint a second GitHub registration.

Extend `actions_runner_status` (MCP, API, and console/CLI view) with the local
service mode and health, last battery-to-AC observation, last restart reason,
last ready time, active-job deferral, and any recovery error. Keep the
existing GitHub `online`, `busy`, labels and routability fields. Show
`unknown` when the machine or GitHub cannot be read; do not turn an installed
folder or a live PID into a claim that jobs can run. An explicit recovery
command must target one managed runner, check for work, and report a durable
outcome rather than using a broad process kill.

## Adoption, upgrade, and removal

1. Inventory the exact runner folder, GitHub scope and name, current service
   label/domain, running worker, and existing PAGS service. Refuse ambiguous
   ownership or two live listeners for the same runner.
2. For an idle runner, stop the exact old service, install the generated
   system plist, start the PAGS supervisor, and verify a *new* ready event
   plus GitHub online status. Keep `.runner`, `.credentials`, labels, and job
   work directory; do not register a second GitHub runner.
3. On failure, stop the new service and restore the previous service. Report
   the partial state and required local step. A busy worker defers adoption.
4. Repeated setup reconciles service/config drift even when `.runner` exists.
   A CLI update must not leave a plist pinned to a removed Node path.
5. Removal stops the supervisor, removes its generated unit and local state,
   then performs the existing credential deregistration flow. It does not
   remove another scope's runner.

Once the PAGS service passes a physical AC-wake test on both laptops, remove
their `online.serge.actions-acwake-recover` temporary watchers and generated
machine-setup source. The PAGS runtime service can then be migrated separately
to the built-in `pags up --install-service --daemon` path, after checking that
no agent work is active.

## Boundaries and acceptance

This work first targets macOS system services. Existing Linux systemd and
Windows service paths retain their behavior; status must name their actual
service mode rather than implying macOS support. FileVault may prevent boot
until a person unlocks the disk. Neither an AC watcher nor Wi-Fi wake starts a
laptop whose battery is fully exhausted; that is a hardware test and not an
Actions service guarantee.

Acceptance requires:

- Unit and service tests for AC transition, network delay, child exit,
  bounded retry, active-worker deferral, stale readiness, duplicate-service
  refusal, existing `.runner` adoption, rollback, uninstall and update.
- A pre-login reboot test on each laptop, followed by a physical charger
  interruption while asleep. Verify no local login or power-button action,
  unchanged boot time, and a **new** `Listening for Jobs` plus GitHub online
  status for each runner. Repeat a several-hour sleep test to cover the
  observed stale-connection failure.
- PAGS status shows the configured mode, current GitHub and local health,
  recovery action and timestamps, including explicit unknown/error states.
- The temporary machine-setup watchers are removed only after both laptops
  pass. Record the exact observation and service state in their fleet notes.

## Delivery order

The [epic #1365](https://github.com/ProAgentStore/platform/issues/1365) and
[issue queue](issues/1365-unattended-actions-recovery.md) carry the ordered
checklist. First finalize the service/supervisor contract and
macOS implementation, then make setup/adoption/removal converge on it. Expose
status and explicit control against that contract. Last, migrate tiny and
pink, repeat the physical test, and remove the temporary watchers. The
existing #1209 service-install issue is reused; no duplicate ticket is needed.
