/**
 * Verify a command-started restart, and start it again if it did not come up (#1151).
 *
 * `pags up --background` and anything run with `PAGS_RESTART_COMMAND` restart after a remote update by starting a detached
 * command and exiting. Nothing checked that the command ever produced a runner: on 2026-10-17 three machines went dark in
 * exactly that shape (the old process gone, the new one dead before it registered), and no later step could notice. The
 * launcher and service restarters outlive their children and retry; this one cannot — so a small detached GUARD is started
 * beside the command. It outlives the runner that is leaving, waits for it to exit, then watches the account lock directory
 * for a live runner that is not the old one. If none appears within a window it starts the command again, a few times, with
 * every step written to the update log; if it never comes up it says so there and stops, rather than retrying forever.
 *
 * The guard is a plain Node script written beside the update log (Node builtins only, like the service supervisor): it must
 * keep working when the release it is restarting onto is broken.
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { logUpdateStep, updateLogPath } from "../../bootstrap/update-log.js";
import { lockDir } from "../../runner-lock.js";

export const GUARD_ATTEMPTS = 3;
/** How long one start gets to produce a live runner: the new process waits up to 60s for the old lock, then starts. */
export const GUARD_WINDOW_MS = 150_000;
/** The old runner has this long to leave before the guard stops waiting for it. */
export const GUARD_EXIT_WAIT_MS = 120_000;

export interface GuardConfig {
	command: string;
	oldPid: number;
	lockDir: string;
	log: string;
	attempts: number;
	windowMs: number;
	exitWaitMs: number;
	pollMs: number;
}

export function guardScript(): string {
	return `// Written by \`pags up\` (#1151). Verifies a restart command produced a runner; see packages/cli/src/commands/runner/restart-guard.ts.
import { spawn } from "node:child_process";
import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const cfg = JSON.parse(process.argv[2]);
const say = (line) => { try { appendFileSync(cfg.log, \`\${new Date().toISOString()} [\${process.pid}] guard: \${line}\\n\`); } catch { /* a log that cannot be written must not stop the guard */ } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === "EPERM"; } };
const runnerUp = () => {
	try {
		return readdirSync(cfg.lockDir).filter((f) => /^up-.*\\.lock$/.test(f)).some((f) => {
			try { const lock = JSON.parse(readFileSync(join(cfg.lockDir, f), "utf8")); return Number.isInteger(lock.pid) && lock.pid !== cfg.oldPid && alive(lock.pid); } catch { return false; }
		});
	} catch { return false; }
};
const waitFor = async (check, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (check()) return true; await sleep(cfg.pollMs); } return check(); };
const start = () => { try { spawn(cfg.command, { shell: true, detached: true, stdio: "ignore", env: process.env }).unref(); } catch (e) { say(\`could not start the restart command: \${e && e.message}\`); } };

if (!(await waitFor(() => !alive(cfg.oldPid), cfg.exitWaitMs))) say(\`pid \${cfg.oldPid} did not exit within \${Math.round(cfg.exitWaitMs / 1000)}s; watching anyway\`);
for (let attempt = 1; attempt <= cfg.attempts; attempt++) {
	if (await waitFor(runnerUp, cfg.windowMs)) { say(attempt === 1 ? "the restarted runner is up" : \`the runner is up after \${attempt - 1} more start(s)\`); process.exit(0); }
	if (attempt === cfg.attempts) break;
	say(\`no live runner within \${Math.round(cfg.windowMs / 1000)}s of start \${attempt}; starting it again (\${attempt + 1}/\${cfg.attempts})\`);
	start();
}
say(\`GAVE UP: no runner came up after \${cfg.attempts} start(s); it needs starting at the machine\`);
process.exit(1);
`;
}

export interface GuardDeps {
	spawn?: typeof spawn;
	write?: (path: string, content: string) => void;
	log?: (line: string) => void;
	env?: NodeJS.ProcessEnv;
}

/** Start the guard for a restart command already launched by the caller. Never throws: a guard that cannot start must not stop the restart. */
export function startRestartGuard(command: string, oldPid: number, over: Partial<GuardConfig> = {}, deps: GuardDeps = {}): boolean {
	const env = deps.env ?? process.env;
	const log = deps.log ?? ((line: string) => logUpdateStep(line));
	const logFile = updateLogPath(env);
	const config: GuardConfig = { command, oldPid, lockDir: lockDir(), log: logFile, attempts: GUARD_ATTEMPTS, windowMs: GUARD_WINDOW_MS, exitWaitMs: GUARD_EXIT_WAIT_MS, pollMs: 2_000, ...over };
	try {
		const script = join(dirname(logFile), "pags-restart-guard.mjs");
		(deps.write ?? ((path: string, content: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); }))(script, guardScript());
		(deps.spawn ?? spawn)(process.execPath, [script, JSON.stringify(config)], { detached: true, stdio: "ignore", windowsHide: true, env }).unref();
		log(`restart: guard started — it starts the command again (up to ${config.attempts - 1} times) if no runner comes up`);
		return true;
	} catch (e) {
		log(`restart: guard could not start (${e instanceof Error ? e.message : String(e)}); the restart is unverified`);
		return false;
	}
}
