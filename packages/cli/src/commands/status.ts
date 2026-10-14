/**
 * `pags status` and `pags logs` (#499) — what is running here for this account, and its output.
 *
 * Status is read from the #896 lock and its holder's own `/health`, the same verdict `pags up` uses
 * to refuse a second runner, so the two can never disagree. `pags status` was already named in that
 * refusal before it existed. Logs exist only for a background runner: a foreground `pags up` keeps
 * its output in its own window (`l`).
 */
import { readFileSync, statSync, watchFile } from "node:fs";
import { Command } from "commander";
import { requireSession } from "./login.js";
import { type BackgroundState, backgroundLogPath, backgroundStatePath, readBackgroundState, tailLines } from "../background.js";
import { type HolderVerdict, holderWhere, inspectHolder, lockPath, type RunnerLockFile } from "../runner-lock.js";
import { writeLine } from "../output.js";

/** What `pags status` says, and whether it counts as running. Pure. */
export function describeStatus(lock: RunnerLockFile | null, verdict: HolderVerdict | null, bg: BackgroundState | null, now = Date.now()): { running: boolean; lines: string[] } {
	if (!lock || verdict === "dead") {
		const lines = ["Not running — no runner of yours is connected from this machine."];
		if (bg) lines.push(`The last background runner (pid ${bg.pid}, started ${new Date(bg.startedAt).toLocaleString()}) has stopped. Its log: ${bg.logPath} (\`pags logs\`).`);
		lines.push("", "Start one with `pags up` (this terminal) or `pags up --background` (no terminal).");
		return { running: false, lines };
	}
	const mins = Math.max(0, Math.round((now - lock.startedAt) / 60_000));
	const state = verdict === "live" ? "Running" : verdict === "unresponsive" ? "Running, but NOT answering its health check (asleep, stopped or overloaded)" : "Probably running (its lock could not be fully read)";
	const lines = [
		`${state} — pid ${lock.pid}, up ${mins < 120 ? `${mins} min` : `${Math.round(mins / 60)} h`}, CLI ${lock.version || "?"}, machine ${lock.node}.`,
		`Launched from ${holderWhere(lock)}.`,
	];
	if (lock.launch === "background" && bg && bg.pid === lock.pid) {
		lines.push(`Started with ${bg.instances.length} agent${bg.instances.length === 1 ? "" : "s"}${bg.watching ? " (newly eligible ones attach as they appear)" : " (scoped: only these)"}:`);
		for (const i of bg.instances) lines.push(`  ${i.name} (${i.id.slice(0, 8)})`);
		lines.push("", `Logs: \`pags logs\` (${bg.logPath}). Stop: \`pags down\`.`);
	} else if (lock.launch === "background") {
		lines.push("", "Logs: `pags logs`. Stop: `pags down`.");
	}
	return { running: true, lines };
}

export const statusCommand = new Command("status")
	.description("Is a runner running on this machine for your account — and how was it started")
	.action(async () => {
		const session = requireSession();
		const held = await inspectHolder(lockPath(session.user.login));
		const { running, lines } = describeStatus(held.lock, held.lock ? held.verdict : null, readBackgroundState(backgroundStatePath(session.user.login)));
		writeLine("");
		for (const line of lines) writeLine(`  ${line}`);
		writeLine("");
		// Scriptable: 0 when a runner is running here, 1 when none is.
		if (!running) process.exitCode = 1;
	});

export const logsCommand = new Command("logs")
	.description("Show the background runner's log (`pags up --background`)")
	.option("-n, --lines <n>", "How many recent lines to show", "50")
	.option("-f, --follow", "Keep printing new lines as they are written")
	.action((opts: { lines: string; follow?: boolean }) => {
		const session = requireSession();
		const path = backgroundLogPath(session.user.login);
		const n = Math.max(1, Number.parseInt(opts.lines, 10) || 50);
		const lines = tailLines(path, n);
		if (!lines) {
			writeLine("");
			writeLine("  No background runner log here yet — one is written by `pags up --background`.");
			writeLine("  A foreground `pags up` shows its output in its own window (press `l`).");
			writeLine("");
			return;
		}
		for (const line of lines) writeLine(line);
		if (!opts.follow) return;
		let offset = statSync(path).size;
		watchFile(path, { interval: 1000 }, (cur) => {
			// Rotated or truncated underneath us: start from the top of the new file.
			if (cur.size < offset) offset = 0;
			if (cur.size === offset) return;
			process.stdout.write(readFileSync(path).subarray(offset, cur.size));
			offset = cur.size;
		});
	});
