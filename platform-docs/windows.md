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

On macOS or Linux a launchd or systemd unit keeps `pags up` running. On Windows the equivalent is a
Task Scheduler task that:

- starts **at startup**;
- runs as your user with logon type **S4U** ("Run whether user is logged on or not", with no
  password stored), so it uses your `%USERPROFILE%` and therefore your `pags login` session;
- has **no execution time limit**, and **restarts on failure**;
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
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType S4U -RunLevel Limited
$settings  = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) `
               -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
               -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
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

    *From the source, not yet run on Windows:* the runner starts the engine binary without a shell.
    Windows does not start a `.cmd` file that way, and that is what `npm i -g` installs for an npm
    package (`claude.cmd`). Install Claude Code with its native installer instead, which provides
    `claude.exe`, or set the engine preset's command to the full path of an `.exe`. The engine check
    on the machine can report an npm-installed `claude.cmd` as found even though starting it fails.

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

## Updates

**Update by hand on Windows for now.** *From the source, not yet run on Windows:* every npm call in
the self-update path (the version check, `npm i -g`, and the stub's install into its cache) runs
`npm` without a shell. On Windows `npm` is `npm.cmd`, which cannot be started that way. So expect the
Auto-update policy and a remote `runner_update` to be refused with "npm could not be asked for the
latest @proagentstore/cli", and the stub never to fetch a newer version by itself.

To update:

```powershell
npm i -g @proagentstore/cli
Stop-ScheduledTask -TaskName "pags up"; Start-ScheduledTask -TaskName "pags up"
```

Then check the **Terminals** page: the machine should reconnect on the new version. If a
`pags up` from before the update is still running and holds the account, `pags up --replace`
stops it gracefully and takes over. Once
self-update works on Windows, its restart needs no extra setup there: `pags up` supervises its own
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
