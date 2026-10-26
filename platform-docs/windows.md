---
description: "Install and run pags up on Windows, configure startup and power settings, and check runtime support and update procedures."
---

# Running `pags up` on Windows

`pags up` runs natively on Windows 10 and 11. No WSL is needed for the browser runtime. This page
covers installing it, keeping it running on a machine nobody is logged into, and what works there.

It was established on a Windows 11 Pro laptop (build 26200, Node 24.12, CLI 0.4.111 and 0.4.112) on
2026-10-12. Points that come from reading the source and have not been run on Windows yet are
marked as such.

## Requirements

- **Windows 10 or 11.**
- **Node.js LTS** from the official installer, which includes npm. The CLI declares no minimum Node
  version. The tested machine ran Node 24.12, installed in the default `C:\Program Files\nodejs`.
- **CLI 0.4.112 or later.** Earlier versions fail on that default Node path; see "Older CLI
  versions" at the end of this page.
- **Google Chrome**, recommended. The browser runtime prefers installed Chrome and falls back to
  Playwright's bundled Chromium when Chrome is missing.
- For coding agents: **Git for Windows**, and an engine CLI that is logged in (see the coding
  sessions note under "What works on Windows").

## Install and connect

In PowerShell or Command Prompt:

```powershell
npm i -g @proagentstore/cli
pags login            # opens your browser to sign in
pags up --headless    # starts the runner; leave it running
```

`pags login` stores your session in `%USERPROFILE%\.config\proagentstore\`. `pags up` registers
the machine under its hostname and connects every agent that needs a local runtime over an outbound
WebSocket relay, the same as on macOS and Linux. It is ready when it prints "ready for jobs", and the
machine then shows as connected on the console's **Terminals** page.

The tested setup uses `--headless`, which runs the browser without a window. A runner started at
boot by Task Scheduler (below) has no desktop to show a window on, so it must use `--headless`.

## Run at boot, without logging in

`pags up --install-service`, run once from an **elevated** PowerShell after `pags login`, sets this up for
you (#1141). It registers the Scheduled Task described below, running a small supervisor that starts
`pags up --headless` again whenever it exits. The wait between restarts doubles from 10 seconds up to 5
minutes, and the supervisor logs to the same `pags-up.log`. `pags up --uninstall-service` removes it. The
same flag installs a launchd LaunchAgent on macOS and a systemd user unit on Linux. The manual steps below
are still valid.

On macOS or Linux a launchd or systemd unit keeps `pags up` running. On Windows the equivalent is a
Task Scheduler task that:

- starts **at startup**;
- runs as your user with logon type **S4U** ("Run whether user is logged on or not", with no
  password stored), so it uses your `%USERPROFILE%` and therefore your `pags login` session;
- has **no execution time limit**, and **restarts on failure**;
- is **triggered again every 5 minutes** with **MultipleInstances = IgnoreNew** (#1154). Task Scheduler's
  restart-on-failure only covers a task that fails to *start*; a supervisor that is killed or crashes later
  just ends, and the repeating trigger is what brings it back. `IgnoreNew` makes a trigger that finds it
  still running do nothing, so there is never more than one;
- runs a small wrapper that starts `pags up --headless` again whenever it exits, and appends its
  output to `%USERPROFILE%\.config\proagentstore\pags-up.log`.

Run this once in an **elevated** PowerShell (Run as administrator), signed in as the user the
runner should run as, after `pags login` has succeeded:

```powershell
$dir  = "$env:USERPROFILE\.config\proagentstore"
$pags = (Get-Command pags.cmd).Source      # e.g. C:\Users\you\AppData\Roaming\npm\pags.cmd
New-Item -ItemType Directory -Force $dir | Out-Null

# The wrapper: start pags up, log its output, and start it again 10 seconds after it exits.
@"
@echo off
set LOG=$dir\pags-up.log
:loop
echo [%date% %time%] starting pags up>>"%LOG%"
call "$pags" up --headless >>"%LOG%" 2>&1
echo [%date% %time%] pags up exited with %errorlevel%, restarting in 10s>>"%LOG%"
ping -n 11 127.0.0.1 >nul
goto loop
"@ | Set-Content -Encoding ascii "$dir\pags-up-loop.cmd"

$action    = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$dir\pags-up-loop.cmd`""
$trigger   = New-ScheduledTaskTrigger -AtStartup
$trigger.Repetition = (New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5)).Repetition
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType S4U -RunLevel Limited
$settings  = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) `
               -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
               -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName "pags up" -Action $action -Trigger $trigger -Principal $principal -Settings $settings

Start-ScheduledTask -TaskName "pags up"
```

The wrapper uses `ping` to wait because `timeout` refuses to run without a console. The paths to
`pags.cmd` and the log are written into the wrapper when it is created, so the task does not depend
on `PATH` at boot.

To check it, read the log (`Get-Content "$env:USERPROFILE\.config\proagentstore\pags-up.log" -Tail 30`)
or look for the machine on the **Terminals** page. To stop it:
`Stop-ScheduledTask -TaskName "pags up"`. To remove it:
`Unregister-ScheduledTask -TaskName "pags up" -Confirm:$false`.

## Keep the machine reachable

A sleeping machine drops its relay connection, and its agents read offline until it wakes. On a
machine that should serve agents while plugged in:

```powershell
powercfg /change standby-timeout-ac 0      # never sleep on AC power
powercfg /change hibernate-timeout-ac 0    # never hibernate on AC power
# Closing the lid on AC power does nothing (0 = do nothing):
powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0
powercfg /setactive SCHEME_CURRENT
```

Locking the screen or turning off the display does not disconnect the runner; sleep and hibernate
do. Laptops with Modern Standby (S0 low-power idle; `powercfg /a` lists it as "Standby (S0 Low Power
Idle)") are covered by the same settings. Allowing the screen to turn off is fine.

## What works on Windows

- **The browser runtime.** The local Playwright browser that apply, browse and takeover tasks drive,
  in a dedicated Chrome profile under `%USERPROFILE%\.config\proagentstore\browser-runner\`.
- **Coding sessions**, through the stream-json engine. Claude Code runs
  as a child process with structured output (`packages/browser-runner/src/coding/headless.ts`), with
  no tmux involved. Install Git for Windows and log the engine in on the machine first.

    An `npm i -g` install works from CLI 0.4.115. npm puts only `.cmd` shims on PATH (`claude.cmd`),
    which Windows cannot start without a shell. The runner therefore resolves the engine before it
    starts it (`packages/browser-runner/src/coding/engine-spawn.ts`):

    - A real `.exe` on PATH is used first.
    - Otherwise the shim's own target is used: Claude Code's native `bin\claude.exe`, or a Node
      script (codex, gemini) run with the runner's Node.
    - Any other `.cmd` runs through `cmd.exe` with every argument quoted.

    The engine check reports the same path (`binaryPath`) and how it runs (`binaryVia`). An engine
    reached only through `cmd.exe` cannot receive a multi-line prompt, because `cmd.exe` stops at
    the first line break. Older CLIs fail with `spawn claude ENOENT`; put the native installer's
    `claude.exe` on PATH for those.

## What does not work

**Tools backed by tmux.** That covers `terminal_*`, the legacy `tmux_*` tools, and the tmux, kitty
and iTerm2 terminal Operators. They drive a terminal multiplexer or a macOS terminal app that Windows
does not have. For those agents, run `pags up` inside WSL, or pin the agent to a macOS or Linux
machine with **Runs on** (see [Coder Multi-Machine](coder-multi-machine.md)).

## Files and paths

Everything lives in `%USERPROFILE%\.config\proagentstore\`, the same layout as `~/.config/proagentstore/`
on macOS and Linux: the login session, `machine.json` (the machine's stable ID), the browser runtime's data and profile
(`browser-runner\`), and the CLI versions fetched by the self-updating stub (`cli\`). The Task Scheduler wrapper's
`pags-up-loop.cmd` and `pags-up.log` sit there too.

## The Actions runner on Windows: the machine service root

A GitHub Actions runner that PAGS installs as a Windows service (`actions_runner_setup`, #1209) lives in a **machine-scoped root**,
never in a user profile:

```text
C:\ProgramData\ProAgentStore\actions-runner\<org>          (or <owner>--<repo> for a repo-scoped runner)
    _work  _diag  _temp  _cache  _logs                       the folders the runner writes to
```

**Installing a service-managed runner under `C:\Users\<user>` is prohibited.** PAGS will not do it (the install refuses if the
machine root is unavailable rather than falling back), and a runner a person installs there by hand is treated as legacy and
migrated (below). Do not "fix" a runner that fails to start by granting `NETWORK SERVICE` (or anything else) access through a
profile — that is exactly the change this design exists to avoid (#1271 proposed it; #1272 replaced it).

### The trust boundary

A self-hosted runner executes **repository-controlled workflow code** as the service account. So:

| Who | Access to the runner root | Why |
|---|---|---|
| `NT AUTHORITY\SYSTEM`, `Administrators` | Full control | Recovery, uninstall and repair never need an ownership change. |
| The service account (`NT AUTHORITY\NETWORK SERVICE` by default, or a dedicated non-administrator account) | **Modify**, on this root only | The runner writes its work, logs and cache here and self-updates by creating sibling folders in the root. |
| Everyone else — `Users`, `Authenticated Users`, `Everyone`, the interactive owner | **None** | Nothing writable by other accounts leaks in; workflow code cannot be edited from a normal login. |

The root does **not** inherit from `ProgramData` (`icacls /inheritance:r`). The service account is given **no** access to a user's
profile, desktop, SSH material, keychains or development checkouts, and needs none: the runner's own startup check walks the
directories *above* its root, and the root's ancestors (`C:\ProgramData\ProAgentStore\…`) are readable by the service by
default. The service identity must be least-privilege — SYSTEM, an Administrator or a broad group is refused.

Setup is **idempotent**: every install, `pags up`, service restart and self-update sets the ACL if it has drifted and verifies it,
and an unchanged root is left alone. Success is reported only after (1) the ACL is read back and matches this table exactly and (2) a
one-shot task run **as the service account** can list the root, write and delete a file in `_work`, and **cannot** list the owner's
profile. (The effective-access probe runs for the built-in service accounts; a dedicated named account is verified by its ACL
because proving access as it would need its password, which PAGS never asks for.) The ACL check reads `icacls` output in English
account names; on a localised Windows the grants (made by SID) still apply but the read-back may not recognise a name — set the
display language to English for the install, or contact us.

### Host readiness is separate from the service

A running service is not usable CI capacity. Before a Windows runner is offered any routing label, the machine reports whether the
**host** is ready (`/coding/actions-runner/capabilities` → `windows`):

- Windows build 17763 (Windows 10 1809 / Server 2019) or newer;
- `git`, `bash` (Git for Windows — workflow steps written as `shell: bash`), `node`, `pnpm` and the AWS CLI all on the **machine** `PATH`.
  A tool installed inside a user profile does not count: the service account cannot see a profile.

If anything is missing the runner is still installed, but it is registered **without** `pags` / `pags-<node>`, carrying
`pags-unavailable` instead, so nothing that routes by label can reach it. The answer to the setup call lists each reason and its fix
(for example *"`aws` is not on PATH — needed for deploys that run `aws s3 sync`. Install the AWS CLI v2 MSI for all users."*). Fix it and run
`actions_runner_setup` again: the labels are swapped on the registered runner; it is not reinstalled.

### Migrating a profile-scoped install

A runner still under `%USERPROFILE%\.proagentstore\actions-runner\<org>` is **migrated, never repaired in place**. Running
`actions_runner_setup` for its org does it:

1. **Drain** — wait for a running job to finish; if one never does, stop with nothing changed.
2. **Stop** the old service. (It is never modified.)
3. **Prepare** the machine root and its ACL (above), before anything is copied into it.
4. **Copy** the runner's program files — *not* its old registration, credentials or working data.
5. **Re-register** with a **fresh, short-lived registration token** minted for this migration (never stored, masked in every record),
   as the service account, under a **staged name** (`<name>-m`). The old name is not reused: re-registering under it would invalidate the old
   runner's credentials at GitHub and leave nothing to roll back to.
6. **Verify** — GitHub must show the new runner online, and a platform-owned smoke job must complete on exactly that runner. Until both
   pass it carries only `pags-unavailable` and receives no work.
7. **Hand over** — only then does it get the routing labels, and the old install is marked **removable**. It is **not removed**.

Any failure before step 7 rolls back: the new service and the folder this migration created are removed, the old service is started
again and reported running, and the answer says what failed. The staged registration GitHub still lists is reported for the platform
to deregister. A migration that is repeated after it reached verification does nothing new.

The smoke job is not configured in every deployment. Without it the migrated runner is online but **stays unrouted** and the old
install stays stopped-but-intact, and the answer says so — it is never promoted on the strength of "it started".

### Verifying a Windows runner (a person, on the machine)

The code is proven against a fake Windows. These steps need the real one and are **not** automated or done by an agent; do them on
the machine before relying on it, and never use a real candidate-facing or production repository as the test:

1. On a **fresh** machine: run `actions_runner_setup` for a test org. In an **elevated** PowerShell, `icacls C:\ProgramData\ProAgentStore\actions-runner\<org>`
   must list only `NT AUTHORITY\SYSTEM`, `BUILTIN\Administrators` and the service account, none marked `(I)`.
2. `Get-Service actions.runner.*` shows it **Running** with log-on `NT AUTHORITY\NETWORK SERVICE`; `C:\Users\<you>` and `.proagentstore` carry no extra ACE for it
   (`icacls C:\Users\<you>` unchanged).
3. GitHub → the org's Actions → Runners shows it **Idle/online**; a trivial workflow that targets `[self-hosted, pags-<node>]` (a single `echo`) completes on it.
4. Run `actions_runner_setup` again and restart the service: `icacls` output is identical and nothing is reinstalled.
5. Uninstall `aws` (or install it per-user only): `actions_runner_setup` reports the runner **unavailable** with the AWS CLI reason, and the runner shows `pags-unavailable`.
6. **Legacy migration** (only on a machine that still has a profile install, with no job running): run `actions_runner_setup`; confirm the new runner appears
   as `<name>-m`, comes online, passes the smoke job, and takes the routing labels; confirm the old folder is **untouched** and that its service is stopped.
   Remove the old install yourself afterwards (`config.cmd remove` with a removal token, then delete the folder) — PAGS never does.
7. To test **rollback**, make the destination unwritable before migrating (or stop the new service so GitHub never shows it online): the old service must be running again afterwards.

## Updates

**Updates run on Windows from CLI 0.4.117.** Up to 0.4.116 every npm call in the self-update path (the
version check, `npm i -g`, and the stub's install into its cache) ran `npm` without a shell. On Windows
`npm` is `npm.cmd`, which cannot be started that way, so the Auto-update policy reported "npm could not
be asked for the latest @proagentstore/cli" and `runner_update` was refused (seen on dell-laptop,
2026-10-12). 0.4.117 runs npm's own `npm-cli.js` with Node instead, or `npm.cmd` through `cmd.exe` with
every argument quoted (see [runner auto-update](https://github.com/ProAgentStore/platform/blob/main/docs/runner-auto-update.md#windows)). *Covered by tests with
the Windows paths simulated; not yet confirmed by an update on a Windows machine.*

A machine on 0.4.116 or older still has the old npm call, so it cannot fetch the fix itself. Update it
once by hand:

```powershell
npm i -g @proagentstore/cli
Stop-ScheduledTask -TaskName "pags up"; Start-ScheduledTask -TaskName "pags up"
```

Then check the **Terminals** page: the machine should reconnect on the new version. If a
`pags up` from before the update is still running and holds the account, `pags up --replace`
stops it gracefully and takes over. A self-update's restart needs no extra setup on Windows: `pags up` supervises its own
runner, so `PAGS_RESTART_COMMAND` is not required. See
[runner auto-update](https://github.com/ProAgentStore/platform/blob/main/docs/runner-auto-update.md#windows).

## Older CLI versions (0.4.111 and earlier)

Before 0.4.112, `pags up` started the runtime through `cmd.exe` without quoting, so a Node installed
in `C:\Program Files\nodejs` (the default) made the browser runtime exit with code 1 and
`'C:\Program' is not recognized` (#1033). Update to 0.4.112 or later. If you cannot update yet, the
workaround is a junction to a path with no space, and starting the CLI through it:

```bat
mklink /J C:\nodejs "C:\Program Files\nodejs"
C:\nodejs\node.exe "%APPDATA%\npm\node_modules\@proagentstore\cli\dist\index.js" up --headless
```

Remove the junction once the machine runs 0.4.112 or later.
