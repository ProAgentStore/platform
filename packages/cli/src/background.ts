/**
 * `pags up --background` (#499) — the runner with no terminal open, opt-in and never the default.
 *
 * Owner decision 2026-10-14: an OPTIONAL background mode; the foreground `pags up` stays the
 * default and unchanged. This is the first slice, and it adds no new lifecycle of its own. It reuses
 * the #896 machinery that already governs every runner:
 *
 *  - **One per account per machine.** The detached `runner connect` takes the same per-account lock
 *    a foreground one does, so a background runner and a terminal one cannot both run: whichever
 *    starts second is refused and told who holds it.
 *  - **Stop** is `pags down`, which already stops the lock holder gracefully (its control
 *    endpoint drains running work first). `pags up --replace` takes over from it the same way.
 *  - **Status** is `pags status`, read from that lock, so it cannot disagree with what is running.
 *  - **Logs** go to a file, because there is no `l` key without a terminal: `pags logs`.
 *  - **Remote update** (`runner_update`, #859/#860) restarts it through `PAGS_RESTART_COMMAND`,
 *    which runs `pags up --background` again with the same flags.
 *
 * What it deliberately does NOT do (yet): start at login or boot, or restart after a crash. A
 * background runner runs until `pags down`, a reboot, logout, or a crash. Auto-start is a separate,
 * explicit step (the per-user LaunchAgent in #499's option B), because a runner that holds the
 * owner's real browser profile must not come back by itself without the owner choosing that.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { accountKey, configDir, type HolderVerdict, isTakeable, type RunnerLockFile } from "./runner-lock.js";

/** Set on the detached `runner connect`, so its lock records `launch: "background"`. */
export const BACKGROUND_ENV = "PAGS_BACKGROUND";
/** The log file a background runner writes, carried into the lock's `launchDetail`. */
export const BACKGROUND_LOG_ENV = "PAGS_BACKGROUND_LOG";
/** Set on the `pags up --background` a remote update starts, so it waits for the old holder to leave. */
export const BACKGROUND_RESTART_ENV = "PAGS_BACKGROUND_RESTART";

/** A log over this is moved to `<log>.1` when the next background runner starts. */
export const LOG_ROTATE_BYTES = 5 * 1024 * 1024;

export const backgroundLogPath = (account: string, env: NodeJS.ProcessEnv = process.env): string =>
	join(configDir(env), "logs", `runner-${accountKey(account)}.log`);

export const backgroundStatePath = (account: string, env: NodeJS.ProcessEnv = process.env): string =>
	join(configDir(env), `background-${accountKey(account)}.json`);

/** What `pags up --background` recorded about the runner it started — read by `pags status`. */
export interface BackgroundState {
	v: 1;
	pid: number;
	startedAt: number;
	logPath: string;
	/** The `pags up` arguments it was started with — what a restart repeats. */
	args: string[];
	/** The agents it attached at start. With `watching`, newly eligible ones attach later too. */
	instances: Array<{ id: string; name: string }>;
	watching: boolean;
}

export function writeBackgroundState(path: string, state: BackgroundState): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(state)}\n`, { mode: 0o600 });
}

export function readBackgroundState(path: string): BackgroundState | null {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as BackgroundState;
		return parsed?.v === 1 && Number.isInteger(parsed.pid) ? parsed : null;
	} catch {
		return null;
	}
}

/** Keep one previous log: a log over `maxBytes` becomes `<log>.1` (replacing an older one). */
export function rotateLog(path: string, maxBytes = LOG_ROTATE_BYTES): boolean {
	try {
		if (statSync(path).size <= maxBytes) return false;
	} catch {
		return false;
	}
	renameSync(path, `${path}.1`);
	return true;
}

/** Quote one argument for the shell `PAGS_RESTART_COMMAND` runs under (`spawn(..., {shell: true})`). */
export function shellQuote(arg: string, platform: NodeJS.Platform = process.platform): string {
	if (platform === "win32") return `"${arg.replace(/"/g, '""')}"`;
	return /^[A-Za-z0-9_./:=@%+-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * The command that starts this background runner again after a remote update: the same node, the
 * same installed `pags`, the same `up` flags plus `--background`, marked as a restart.
 */
export function backgroundRestartCommand(execPath: string, script: string, upArgs: string[], platform: NodeJS.Platform = process.platform): string {
	const argv = [execPath, script, ...upArgs, "--background"].map((a) => shellQuote(a, platform)).join(" ");
	return platform === "win32" ? `set ${BACKGROUND_RESTART_ENV}=1&& ${argv}` : `${BACKGROUND_RESTART_ENV}=1 ${argv}`;
}

/**
 * Start `runner connect` detached from this terminal, its stdout and stderr appended to `logPath`.
 * Returns the child's pid. The child gets its own session (`detached`), so closing the terminal
 * sends it no SIGHUP, and this process can exit without taking it along.
 */
export function spawnDetached(
	command: string,
	args: string[],
	env: NodeJS.ProcessEnv,
	logPath: string,
	spawn: typeof nodeSpawn = nodeSpawn,
): number {
	mkdirSync(dirname(logPath), { recursive: true });
	rotateLog(logPath);
	const fd = openSync(logPath, "a", 0o600);
	try {
		const child = spawn(command, args, { detached: true, stdio: ["ignore", fd, fd], env, windowsHide: true });
		child.unref();
		if (!child.pid) throw new Error("the runner process did not start");
		return child.pid;
	} finally {
		closeSync(fd);
	}
}

export type HolderReader = () => Promise<{ lock: RunnerLockFile | null; verdict: HolderVerdict }>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait until the detached child holds the lock and answers its health check as itself — the same
 * proof `pags up --replace` uses — so "running in the background" is said only once it is true.
 * `exited` is the child gone before that, with nothing listening for its exit code; the log says why.
 */
export async function waitForBackgroundHolder(
	childPid: number,
	read: HolderReader,
	alive: (pid: number) => boolean,
	opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<"live" | "exited" | "timeout"> {
	const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
	while (Date.now() < deadline) {
		if (!alive(childPid)) return "exited";
		const held = await read();
		if (held.lock?.pid === childPid && held.verdict === "live") return "live";
		await sleep(opts.intervalMs ?? 500);
	}
	return alive(childPid) ? "timeout" : "exited";
}

/**
 * A restart after a remote update is started by the OLD runner as it exits, so for a moment the
 * old one can still hold the lock. Wait (bounded) for it to go; a holder that is still there after
 * that is a real one, and is refused like any other.
 */
export async function waitUntilTakeable(read: HolderReader, opts: { timeoutMs?: number; intervalMs?: number } = {}): Promise<boolean> {
	const deadline = Date.now() + (opts.timeoutMs ?? 15_000);
	for (;;) {
		const held = await read();
		if (!held.lock || isTakeable(held.verdict)) return true;
		if (Date.now() >= deadline) return false;
		await sleep(opts.intervalMs ?? 500);
	}
}

/** The last `n` lines of a file, or null when there is no such file. */
export function tailLines(path: string, n: number): string[] | null {
	if (!existsSync(path)) return null;
	const lines = readFileSync(path, "utf-8").split("\n");
	if (lines.at(-1) === "") lines.pop();
	return lines.slice(Math.max(0, lines.length - n));
}
