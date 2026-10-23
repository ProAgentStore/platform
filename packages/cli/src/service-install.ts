/**
 * `pags up --install-service` — an OS supervisor that keeps `pags up` running (#1141).
 *
 * On 2026-10-17 two machines went offline mid auto-update, and `runner_restart` could not help: a
 * runner that is not running cannot be asked to restart, and the owner was remote. A service manager
 * brings `pags up` back whatever happened to it — a crash, an update that never came back, a reboot.
 *
 * Every OS runs the same small Node supervisor ({@link supervisorScript}), so the behaviour is one
 * thing everywhere: start `pags up --headless` with `PAGS_SERVICE=1`, append its output to
 * `pags-up.log`, start it again when it exits — at once for the restart code (an update or
 * `runner_restart`), otherwise after a backoff that doubles from 10s to 5 minutes and resets once a
 * run has lasted 10 minutes. The OS unit only has to keep that supervisor alive:
 *
 *   - macOS: a launchd LaunchAgent (`KeepAlive`), loaded into the user's GUI session;
 *   - Linux: a systemd user unit (`Restart=always`) — `loginctl enable-linger` lets it run with nobody logged in;
 *   - Windows: a Scheduled Task at startup, as this user (S4U), re-triggered every 5 minutes with `IgnoreNew` (#1154):
 *     Task Scheduler's own restart-on-failure only covers a task that fails to START, not a supervisor that was
 *     killed or crashed later, so the repetition is what brings it back — and `IgnoreNew` keeps it to one.
 *
 * It runs `process.argv[1]` — the bootstrap stub on an npm install — so every start picks the newest
 * payload, and a payload on trial that never registers is rolled back by the stub (bootstrap/trial.ts).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { posix, win32 } from "node:path";

export const SERVICE_LABEL = "online.proagentstore.pags-up";
export const SYSTEMD_UNIT = "pags-up.service";
export const WINDOWS_TASK = "pags up";

export interface ServiceContext {
	platform: NodeJS.Platform;
	home: string;
	/** The Node binary, and the `pags` script it runs (the stub on an npm install). */
	nodePath: string;
	script: string;
	/** The config dir (`~/.config/proagentstore`), where the supervisor and its log live. */
	configDir: string;
	/** PATH at install time, so npm and git resolve under a service manager's bare environment. */
	pathEnv: string;
	/** macOS: the numeric uid launchd's GUI domain is named by. */
	uid?: number;
	/** Linux/Windows: the account name (`loginctl enable-linger`, the task's principal). */
	user?: string;
	/** Windows: the account's domain. */
	domain?: string;
}

export interface ServiceFile {
	path: string;
	content: string;
}

export interface ServiceCommand {
	file: string;
	args: string[];
	/** A failure is reported, but does not fail the install (e.g. unloading a unit that was not loaded). */
	optional?: true;
	why: string;
}

export interface ServicePlan {
	kind: "launchd" | "systemd" | "scheduled-task";
	files: ServiceFile[];
	commands: ServiceCommand[];
	/** What to tell the owner, after the files and commands. */
	notes: string[];
}

const pathFor = (ctx: ServiceContext) => (ctx.platform === "win32" ? win32 : posix);
export const supervisorPath = (ctx: ServiceContext) => pathFor(ctx).join(ctx.configDir, "pags-up-supervisor.mjs");
export const serviceLogPath = (ctx: ServiceContext) => pathFor(ctx).join(ctx.configDir, "pags-up.log");

/**
 * The supervisor every OS runs. Node builtins only, and self-contained: it is written once and must
 * keep working across every CLI update, because the CLI it starts is what changes. The delays can be
 * shortened by env for tests (`PAGS_SUPERVISOR_MIN_MS`, `…_MAX_MS`, `…_RESET_MS`).
 */
export function supervisorScript(ctx: ServiceContext): string {
	const config = JSON.stringify({ node: ctx.nodePath, script: ctx.script, log: serviceLogPath(ctx), path: ctx.pathEnv });
	return `// Written by \`pags up --install-service\` (#1141). Keeps \`pags up\` running; see packages/cli/src/service-install.ts.
import { spawn } from "node:child_process";
import { appendFileSync, closeSync, openSync } from "node:fs";

const config = ${config};
const num = (name, fallback) => { const n = Number(process.env[name]); return Number.isFinite(n) && n > 0 ? n : fallback; };
const MIN = num("PAGS_SUPERVISOR_MIN_MS", 10_000);
const MAX = num("PAGS_SUPERVISOR_MAX_MS", 300_000);
const RESET = num("PAGS_SUPERVISOR_RESET_MS", 600_000);
const RESTART_CODE = 75; // \`pags up\` asking to be started again: an update, or runner_restart

const say = (line) => { try { appendFileSync(config.log, \`[\${new Date().toISOString()}] supervisor: \${line}\\n\`); } catch { /* a log that cannot be written must not stop the runner */ } };
let delay = MIN;
let child = null;
let retry = null;
let stopping = false;

function start() {
	if (stopping) return;
	const startedAt = Date.now();
	let out = "ignore";
	try { out = openSync(config.log, "a"); } catch { /* run without a log rather than not at all */ }
	say("starting pags up");
	child = spawn(config.node, [config.script, "up", "--headless"], {
		stdio: ["ignore", out, out],
		env: { ...process.env, PATH: config.path || process.env.PATH, PAGS_SERVICE: "1", PAGS_SERVICE_NAME: "${SERVICE_LABEL}", PAGS_NO_PROMPT: "1" },
		windowsHide: true,
	});
	if (typeof out === "number") closeSync(out);
	// One verdict per attempt (#1298): a spawn that fails (no such executable, EAGAIN) emits "error" and never "exit", so
	// retrying only on "exit" ended the supervisor silently with code 0. Either event settles the attempt, once.
	let settled = false;
	const settle = (code, signal, why) => {
		if (settled) return;
		settled = true;
		child = null;
		if (stopping) return;
		if (Date.now() - startedAt >= RESET) delay = MIN;
		const wait = code === RESTART_CODE ? 1_000 : delay;
		say(\`\${why ?? \`pags up exited (\${signal ?? code})\`}; starting it again in \${Math.round(wait / 1000)}s\`);
		if (code !== RESTART_CODE) delay = Math.min(delay * 2, MAX);
		retry = setTimeout(start, wait);
	};
	const attempt = child;
	// An "error" on a child that never got a pid is a failed spawn; on a running one (a kill that failed) it is only logged.
	attempt.on("error", (e) => (attempt.pid === undefined ? settle(null, null, \`could not start pags up: \${e.message}\`) : say(\`pags up error: \${e.message}\`)));
	attempt.on("exit", (code, signal) => settle(code, signal));
}

for (const sig of ["SIGTERM", "SIGINT"]) {
	process.on(sig, () => {
		stopping = true;
		if (retry) clearTimeout(retry);
		say(\`stopping (\${sig})\`);
		if (child) child.kill("SIGTERM");
		setTimeout(() => process.exit(0), 5_000).unref();
		if (!child) process.exit(0);
		else child.once("exit", () => process.exit(0));
	});
}
start();
`;
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** systemd unit quoting: a double-quoted word, with backslash and quote escaped. */
const unitWord = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
/** A PowerShell single-quoted literal. */
const ps = (s: string) => `'${s.replace(/'/g, "''")}'`;

/**
 * A Node binary from a version manager (nvm, fnm, volta, asdf, n, nodenv): the service is pinned to that exact
 * version, and removing it breaks the service with nothing said (#1154). Said at install so it is known.
 */
export function versionManagedNode(nodePath: string): string | null {
	if (/[\\/]n[\\/]versions[\\/]/.test(nodePath)) return "n";
	const m = /[\\/]\.?(nvm|fnm|volta|asdf|nodenv)[\\/]/i.exec(nodePath);
	return m ? m[1].toLowerCase() : null;
}

const pinnedNodeNote = (ctx: ServiceContext): string[] => {
	const manager = versionManagedNode(ctx.nodePath);
	return manager
		? [`It runs Node ${ctx.nodePath}, installed by ${manager}. Removing or switching away from that Node version stops the service; after changing Node, run \`pags up --install-service\` again.`]
		: [];
};

/** The files and commands that install the service here. Pure — {@link installService} carries it out. */
export function servicePlan(ctx: ServiceContext): ServicePlan {
	const supervisor = supervisorPath(ctx);
	const log = serviceLogPath(ctx);
	const files: ServiceFile[] = [{ path: supervisor, content: supervisorScript(ctx) }];
	if (ctx.platform === "darwin") {
		const plist = posix.join(ctx.home, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
		const domain = `gui/${ctx.uid ?? 501}`;
		files.push({
			path: plist,
			content: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>${SERVICE_LABEL}</string>
	<key>ProgramArguments</key>
	<array>
		<string>${xml(ctx.nodePath)}</string>
		<string>${xml(supervisor)}</string>
	</array>
	<key>RunAtLoad</key><true/>
	<key>KeepAlive</key><true/>
	<key>ThrottleInterval</key><integer>30</integer>
	<key>ProcessType</key><string>Background</string>
	<key>WorkingDirectory</key><string>${xml(ctx.home)}</string>
	<key>StandardOutPath</key><string>${xml(log)}</string>
	<key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`,
		});
		return {
			kind: "launchd",
			files,
			commands: [
				{ file: "launchctl", args: ["bootout", `${domain}/${SERVICE_LABEL}`], optional: true, why: "unload an earlier copy" },
				{ file: "launchctl", args: ["bootstrap", domain, plist], why: "load the LaunchAgent" },
				{ file: "launchctl", args: ["kickstart", "-k", `${domain}/${SERVICE_LABEL}`], why: "start it now" },
			],
			notes: [
				...pinnedNodeNote(ctx),
				`LaunchAgent ${plist} — runs while this user is logged in. On a machine that must survive a reboot unattended, turn on automatic login for this user.`,
				`Remove it with: pags up --uninstall-service`,
			],
		};
	}
	if (ctx.platform === "win32") {
		const task = win32.join(ctx.configDir, "pags-up-task.ps1");
		const principal = `${ctx.domain ? `${ctx.domain}\\` : ""}${ctx.user ?? ""}`;
		files.push({
			path: task,
			content: `# Written by \`pags up --install-service\` (#1141). Registers the "${WINDOWS_TASK}" Scheduled Task; needs an elevated PowerShell.
$ErrorActionPreference = 'Stop'
$action    = New-ScheduledTaskAction -Execute ${ps(ctx.nodePath)} -Argument ${ps(`"${supervisor}"`)}
$trigger   = New-ScheduledTaskTrigger -AtStartup
# Task Scheduler restarts a task that failed to START; a supervisor killed later just ends. Re-trigger it every five
# minutes, forever — MultipleInstances IgnoreNew makes a trigger that finds it running do nothing (#1154).
$trigger.Repetition = (New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5)).Repetition
$principal = New-ScheduledTaskPrincipal -UserId ${ps(principal)} -LogonType S4U -RunLevel Limited
$settings  = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew
Unregister-ScheduledTask -TaskName ${ps(WINDOWS_TASK)} -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName ${ps(WINDOWS_TASK)} -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null
Start-ScheduledTask -TaskName ${ps(WINDOWS_TASK)}
`,
		});
		return {
			kind: "scheduled-task",
			files,
			commands: [{ file: "powershell.exe", args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", task], why: "register and start the Scheduled Task" }],
			notes: [
				...pinnedNodeNote(ctx),
				`Scheduled Task "${WINDOWS_TASK}" — starts at boot as ${principal || "this user"}, with nobody logged in. Registering it needs an elevated PowerShell: if it was refused, run ${task} from one.`,
				`Remove it with: pags up --uninstall-service`,
			],
		};
	}
	const unit = posix.join(ctx.home, ".config", "systemd", "user", SYSTEMD_UNIT);
	files.push({
		path: unit,
		content: `# Written by \`pags up --install-service\` (#1141).
[Unit]
Description=ProAgentStore runner (pags up)
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
ExecStart=${unitWord(ctx.nodePath)} ${unitWord(supervisor)}
Environment=${unitWord(`PATH=${ctx.pathEnv}`)}
Restart=always
RestartSec=10
KillMode=mixed

[Install]
WantedBy=default.target
`,
	});
	return {
		kind: "systemd",
		files,
		commands: [
			{ file: "systemctl", args: ["--user", "daemon-reload"], why: "read the unit" },
			{ file: "systemctl", args: ["--user", "enable", "--now", SYSTEMD_UNIT], why: "enable and start it" },
			{ file: "loginctl", args: ["enable-linger", ...(ctx.user ? [ctx.user] : [])], optional: true, why: "keep it running with nobody logged in" },
		],
		notes: [...pinnedNodeNote(ctx), `systemd user unit ${unit}. Logs: ${log} (and journalctl --user -u ${SYSTEMD_UNIT}).`, `Remove it with: pags up --uninstall-service`],
	};
}

/** The commands and files that remove what {@link servicePlan} installed. */
export function serviceRemovalPlan(ctx: ServiceContext): { commands: ServiceCommand[]; files: string[] } {
	const plan = servicePlan(ctx);
	const files = plan.files.map((f) => f.path);
	if (plan.kind === "launchd") return { files, commands: [{ file: "launchctl", args: ["bootout", `gui/${ctx.uid ?? 501}/${SERVICE_LABEL}`], optional: true, why: "unload the LaunchAgent" }] };
	if (plan.kind === "systemd") return { files, commands: [{ file: "systemctl", args: ["--user", "disable", "--now", SYSTEMD_UNIT], optional: true, why: "stop and disable the unit" }] };
	return {
		files,
		commands: [{ file: "powershell.exe", args: ["-NoProfile", "-Command", `Stop-ScheduledTask -TaskName ${ps(WINDOWS_TASK)} -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName ${ps(WINDOWS_TASK)} -Confirm:$false`], optional: true, why: "remove the Scheduled Task" }],
	};
}

export interface ServiceDeps {
	write?: (path: string, content: string) => void;
	remove?: (path: string) => void;
	run?: (file: string, args: string[]) => void;
}

const defaultWrite = (path: string, content: string) => {
	mkdirSync(path.replace(/[\\/][^\\/]*$/, ""), { recursive: true });
	writeFileSync(path, content);
};
const defaultRun = (file: string, args: string[]) => void execFileSync(file, args, { stdio: "pipe", timeout: 60_000 });

/** One line per thing done or refused. `ok` is false when a required command failed. */
export function installService(ctx: ServiceContext, deps: ServiceDeps = {}): { ok: boolean; lines: string[] } {
	return applyPlan(servicePlan(ctx), deps);
}

function applyPlan(plan: ServicePlan, deps: ServiceDeps): { ok: boolean; lines: string[] } {
	const lines: string[] = [];
	for (const f of plan.files) {
		(deps.write ?? defaultWrite)(f.path, f.content);
		lines.push(`wrote ${f.path}`);
	}
	let ok = true;
	for (const c of plan.commands) {
		try {
			(deps.run ?? defaultRun)(c.file, c.args);
			lines.push(`${c.why}: ok`);
		} catch (e) {
			const why = String((e as { stderr?: unknown }).stderr ?? "").trim() || (e instanceof Error ? e.message : String(e));
			lines.push(`${c.why}: ${c.optional ? "skipped" : "FAILED"} — ${why.split(/\r?\n/)[0].slice(0, 200)}`);
			if (!c.optional) ok = false;
		}
	}
	return { ok, lines: [...lines, ...plan.notes] };
}

export function uninstallService(ctx: ServiceContext, deps: ServiceDeps = {}): { lines: string[] } {
	return removeByPlan(serviceRemovalPlan(ctx), deps);
}

function removeByPlan(plan: { commands: ServiceCommand[]; files: string[] }, deps: ServiceDeps): { lines: string[] } {
	const lines: string[] = [];
	for (const c of plan.commands) {
		try {
			(deps.run ?? defaultRun)(c.file, c.args);
			lines.push(`${c.why}: ok`);
		} catch (e) {
			lines.push(`${c.why}: skipped — ${(e instanceof Error ? e.message : String(e)).split(/\r?\n/)[0].slice(0, 200)}`);
		}
	}
	for (const f of plan.files) {
		(deps.remove ?? ((p: string) => rmSync(p, { force: true })))(f);
		lines.push(`removed ${f}`);
	}
	return { lines };
}

// ─── The watchdog service (#1320) ────────────────────────────────────────────────────────────────

export const WATCHDOG_LABEL = "online.proagentstore.pags-watchdog";
export const WATCHDOG_UNIT = "pags-watchdog.service";
export const WATCHDOG_TASK = "pags watchdog";
export const watchdogLogPath = (ctx: ServiceContext) => pathFor(ctx).join(ctx.configDir, "pags-watchdog.log");
export const watchdogTaskScript = (ctx: ServiceContext) => pathFor(ctx).join(ctx.configDir, "pags-watchdog-task.ps1");

/**
 * The always-on control channel's OS unit: a SECOND service beside the runner's, running `pags watchdog run` and nothing else. It
 * needs no supervisor script of its own — the OS restarts it (launchd KeepAlive, systemd Restart=always, the Scheduled Task re-trigger) —
 * and it shares nothing with `pags up` but the account's sign-in, so a runner that is dead, wedged or mid-rollback leaves it running.
 */
export function watchdogServicePlan(ctx: ServiceContext): ServicePlan {
	const args = [ctx.script, "watchdog", "run"];
	const log = watchdogLogPath(ctx);
	if (ctx.platform === "darwin") {
		const plist = posix.join(ctx.home, "Library", "LaunchAgents", `${WATCHDOG_LABEL}.plist`);
		const domain = `gui/${ctx.uid ?? 501}`;
		return {
			kind: "launchd",
			files: [
				{
					path: plist,
					content: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>${WATCHDOG_LABEL}</string>
	<key>ProgramArguments</key>
	<array>
		<string>${xml(ctx.nodePath)}</string>
${args.map((a) => `		<string>${xml(a)}</string>`).join("\n")}
	</array>
	<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(ctx.pathEnv)}</string></dict>
	<key>RunAtLoad</key><true/>
	<key>KeepAlive</key><true/>
	<key>ThrottleInterval</key><integer>30</integer>
	<key>ProcessType</key><string>Background</string>
	<key>WorkingDirectory</key><string>${xml(ctx.home)}</string>
	<key>StandardOutPath</key><string>${xml(log)}</string>
	<key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`,
				},
			],
			commands: [
				{ file: "launchctl", args: ["bootout", `${domain}/${WATCHDOG_LABEL}`], optional: true, why: "unload an earlier copy" },
				{ file: "launchctl", args: ["bootstrap", domain, plist], why: "load the watchdog LaunchAgent" },
				{ file: "launchctl", args: ["kickstart", "-k", `${domain}/${WATCHDOG_LABEL}`], why: "start the watchdog now" },
			],
			notes: [...pinnedNodeNote(ctx), `LaunchAgent ${plist}. Logs: ${log}. Remove it with: pags watchdog uninstall`],
		};
	}
	if (ctx.platform === "win32") {
		const task = watchdogTaskScript(ctx);
		const principal = `${ctx.domain ? `${ctx.domain}\\` : ""}${ctx.user ?? ""}`;
		return {
			kind: "scheduled-task",
			files: [
				{
					path: task,
					content: `# Written by \`pags watchdog install\` (#1320). Registers the "${WATCHDOG_TASK}" Scheduled Task; needs an elevated PowerShell.
$ErrorActionPreference = 'Stop'
$action    = New-ScheduledTaskAction -Execute ${ps(ctx.nodePath)} -Argument ${ps(args.map((a) => `"${a}"`).join(" "))}
$trigger   = New-ScheduledTaskTrigger -AtStartup
$trigger.Repetition = (New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5)).Repetition
$principal = New-ScheduledTaskPrincipal -UserId ${ps(principal)} -LogonType S4U -RunLevel Limited
$settings  = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew
Unregister-ScheduledTask -TaskName ${ps(WATCHDOG_TASK)} -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName ${ps(WATCHDOG_TASK)} -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null
Start-ScheduledTask -TaskName ${ps(WATCHDOG_TASK)}
`,
				},
			],
			commands: [{ file: "powershell.exe", args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", task], why: "register and start the watchdog Scheduled Task" }],
			notes: [...pinnedNodeNote(ctx), `Scheduled Task "${WATCHDOG_TASK}" — starts at boot as ${principal || "this user"}. Registering it needs an elevated PowerShell: if it was refused, run ${task} from one.`],
		};
	}
	const unit = posix.join(ctx.home, ".config", "systemd", "user", WATCHDOG_UNIT);
	return {
		kind: "systemd",
		files: [
			{
				path: unit,
				content: `# Written by \`pags watchdog install\` (#1320).
[Unit]
Description=ProAgentStore watchdog (pags watchdog)
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
ExecStart=${unitWord(ctx.nodePath)} ${args.map(unitWord).join(" ")}
Environment=${unitWord(`PATH=${ctx.pathEnv}`)}
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
`,
			},
		],
		commands: [
			{ file: "systemctl", args: ["--user", "daemon-reload"], why: "read the unit" },
			{ file: "systemctl", args: ["--user", "enable", "--now", WATCHDOG_UNIT], why: "enable and start the watchdog" },
			{ file: "loginctl", args: ["enable-linger", ...(ctx.user ? [ctx.user] : [])], optional: true, why: "keep it running with nobody logged in" },
		],
		notes: [...pinnedNodeNote(ctx), `systemd user unit ${unit}. Logs: ${log}.`, "Remove it with: pags watchdog uninstall"],
	};
}

/** What removes the watchdog service. */
export function watchdogRemovalPlan(ctx: ServiceContext): { commands: ServiceCommand[]; files: string[] } {
	const plan = watchdogServicePlan(ctx);
	const files = plan.files.map((f) => f.path);
	if (plan.kind === "launchd") return { files, commands: [{ file: "launchctl", args: ["bootout", `gui/${ctx.uid ?? 501}/${WATCHDOG_LABEL}`], optional: true, why: "unload the watchdog LaunchAgent" }] };
	if (plan.kind === "systemd") return { files, commands: [{ file: "systemctl", args: ["--user", "disable", "--now", WATCHDOG_UNIT], optional: true, why: "stop and disable the watchdog unit" }] };
	return { files, commands: [{ file: "powershell.exe", args: ["-NoProfile", "-Command", `Stop-ScheduledTask -TaskName ${ps(WATCHDOG_TASK)} -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName ${ps(WATCHDOG_TASK)} -Confirm:$false -ErrorAction SilentlyContinue`], optional: true, why: "remove the watchdog Scheduled Task" }] };
}

export function installWatchdogService(ctx: ServiceContext, deps: ServiceDeps = {}): { ok: boolean; lines: string[] } {
	return applyPlan(watchdogServicePlan(ctx), deps);
}

export function uninstallWatchdogService(ctx: ServiceContext, deps: ServiceDeps = {}): { lines: string[] } {
	return removeByPlan(watchdogRemovalPlan(ctx), deps);
}

/** The command that restarts the RUNNER's service unit, per OS — what the watchdog uses to bring a dead `pags up` back. */
export function runnerServiceRestart(ctx: ServiceContext): ServiceCommand {
	if (ctx.platform === "darwin") return { file: "launchctl", args: ["kickstart", "-k", `gui/${ctx.uid ?? 501}/${SERVICE_LABEL}`], why: "restart the runner's LaunchAgent" };
	if (ctx.platform === "win32") return { file: "powershell.exe", args: ["-NoProfile", "-Command", `Stop-ScheduledTask -TaskName ${ps(WINDOWS_TASK)} -ErrorAction SilentlyContinue; Start-ScheduledTask -TaskName ${ps(WINDOWS_TASK)}`], why: "restart the runner's Scheduled Task" };
	return { file: "systemctl", args: ["--user", "restart", SYSTEMD_UNIT], why: "restart the runner's systemd unit" };
}
