/**
 * Which coding session is using the machine (#924).
 *
 * The heartbeat says a machine is loaded; this says WHICH agent is loading it. Each session's engine
 * is a child process that spawns its own (an engine's tools, a test runner, a build), so a session's
 * share is its engine process plus every descendant. One `ps` per heartbeat reads the whole process
 * table — the attribution is computed here from it, never by a `ps` per session.
 *
 * Not on Windows (no `ps`): the reading is absent there, which the platform reports as "not
 * reported", never as zero.
 */
import { execFileSync } from "node:child_process";

export interface ProcessRow {
	pid: number;
	ppid: number;
	/** Resident memory, KiB — what `ps -o rss` reports on Linux and macOS. */
	rssKb: number;
	/** CPU percent of one core, as `ps -o pcpu` reports it. */
	cpuPct: number;
}

export interface SessionResources {
	sessionId: string;
	engineLabel: string;
	pid: number;
	/** The engine and every process under it. */
	processes: number;
	rssBytes: number;
	cpuPct: number;
}

/** `ps -A -o pid=,ppid=,rss=,pcpu=` output → rows. A line that does not parse is skipped. */
export function parsePs(text: string): ProcessRow[] {
	const rows: ProcessRow[] = [];
	for (const line of text.split("\n")) {
		const [pid, ppid, rss, cpu] = line.trim().split(/\s+/).map(Number);
		if ([pid, ppid, rss, cpu].every((n) => Number.isFinite(n))) rows.push({ pid, ppid, rssKb: rss, cpuPct: cpu });
	}
	return rows;
}

/** Each root's own row plus all its descendants', summed. Pure, so the tree walk is testable. */
export function attribute(rows: readonly ProcessRow[], roots: ReadonlyArray<{ sessionId: string; engineLabel: string; pid: number }>): SessionResources[] {
	const children = new Map<number, ProcessRow[]>();
	const byPid = new Map<number, ProcessRow>();
	for (const r of rows) {
		byPid.set(r.pid, r);
		children.set(r.ppid, [...(children.get(r.ppid) ?? []), r]);
	}
	return roots.flatMap((root) => {
		const top = byPid.get(root.pid);
		if (!top) return [];
		let processes = 0;
		let rssKb = 0;
		let cpuPct = 0;
		const seen = new Set<number>();
		const stack = [top];
		while (stack.length) {
			const r = stack.pop() as ProcessRow;
			if (seen.has(r.pid)) continue;
			seen.add(r.pid);
			processes++;
			rssKb += r.rssKb;
			cpuPct += r.cpuPct;
			stack.push(...(children.get(r.pid) ?? []));
		}
		return [{ sessionId: root.sessionId, engineLabel: root.engineLabel, pid: root.pid, processes, rssBytes: rssKb * 1024, cpuPct: Math.round(cpuPct * 10) / 10 }];
	});
}

/** Read the process table once and attribute it to the live engines. Null when it cannot be read. */
export function readSessionResources(roots: ReadonlyArray<{ sessionId: string; engineLabel: string; pid: number }>): SessionResources[] | null {
	if (process.platform === "win32") return null;
	if (!roots.length) return [];
	try {
		const out = execFileSync("ps", ["-A", "-o", "pid=,ppid=,rss=,pcpu="], { encoding: "utf-8", timeout: 2000, maxBuffer: 8 * 1024 * 1024 });
		return attribute(parsePs(out), roots);
	} catch {
		// A `ps` that failed or timed out is "not read this beat", which the null says — never zeros.
		return null;
	}
}
