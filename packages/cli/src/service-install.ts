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
 *   - Windows: a Scheduled Task at startup, as this user (S4U), restarted on failure (platform-docs/windows.md).
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
	child.on("error", (e) => say(\`could not start pags up: \${e.message}\`));
	child.on("exit", (code, signal) => {
		child = null;
		if (stopping) return;
		if (Date.now() - startedAt >= RESET) delay = MIN;
		const wait = code === RESTART_CODE ? 1_000 : delay;
		say(\`pags up exited (\${signal ?? code}); starting it again in \${Math.round(wait / 1000)}s\`);
		if (code !== RESTART_CODE) delay = Math.min(delay * 2, MAX);
		setTimeout(start, wait);
	});
}

for (const sig of ["SIGTERM", "SIGINT"]) {
	process.on(sig, () => {
		stopping = true;
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
$principal = New-ScheduledTaskPrincipal -UserId ${ps(principal)} -LogonType S4U -RunLevel Limited
$settings  = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
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
		notes: [`systemd user unit ${unit}. Logs: ${log} (and journalctl --user -u ${SYSTEMD_UNIT}).`, `Remove it with: pags up --uninstall-service`],
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
	const plan = servicePlan(ctx);
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
	const plan = serviceRemovalPlan(ctx);
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
