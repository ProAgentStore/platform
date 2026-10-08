import { mkdirSync, readFileSync, statfsSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";

/**
 * The machine's resource sample, sent on the runner heartbeat (#924).
 *
 * Taken once per 30s heartbeat, no timer of its own, so the platform can say whether a machine was
 * out of CPU, memory or disk when its relay went quiet. The machine reading is in-process (`os`,
 * `statfs`); the per-session split comes from the local runner's one `ps` per beat. The platform
 * validates, stores (two-tier history) and interprets it (`workers/api/src/lib/runner-resources.ts`).
 */
export interface ResourceSample {
	loadAvg: [number, number, number];
	cpus: number;
	memTotalBytes: number;
	memFreeBytes: number;
	platform: string;
	sampledAt: number;
	/** The volume holding the checkouts (#924) — a full disk or inode table fails clones and writes. */
	disk?: DiskSample;
	/** This runner process: how long it has run and how often it has started lately (#924). */
	runner?: RunnerProcessSample;
	/** Round trip of one relay probe, ms — slow vs stuck. Null when this beat's probe got no echo. */
	relayRttMs?: number | null;
	/** Per-session CPU and memory, engine plus descendants. Absent when it could not be read. */
	sessions?: Array<{ sessionId: string; engineLabel: string; pid: number; processes: number; rssBytes: number; cpuPct: number }>;
}

export interface DiskSample {
	path: string;
	totalBytes: number;
	freeBytes: number;
	inodesTotal: number;
	inodesFree: number;
}

export interface RunnerProcessSample {
	startedAt: number;
	/**
	 * This runner PROCESS's id from the single-instance lock (#896), when it holds one.
	 *
	 * The server cannot otherwise tell two runners on one machine apart: heartbeats, registrations
	 * and relay sockets all carried only (instance, node), so three `pags up` processes looked
	 * exactly like one. With this, a duplicate can be NAMED rather than merely suspected.
	 */
	rsid?: string;
	pid?: number;
	/** `tty` | `tmux` | `service` | `headless` — so the fix can say where the other one is. */
	launch?: string;
	uptimeSec: number;
	/** Process starts on this machine in the last 24h, this one included — a crash loop shows here. */
	starts24h: number;
	/** Relay sockets re-opened since this process started. */
	relayReconnects: number;
}

/** Where coding checkouts live — the runner's managed repos dir (`CodingRuntime`'s default). */
export const CHECKOUT_ROOT = join(os.homedir(), ".config", "proagentstore", "repos");

/**
 * `statfs` of the checkout volume, or the home directory before any checkout exists. Null when the
 * platform cannot answer (no `statfs`, or a path it refuses) — reported as absent, never as empty.
 */
export function sampleDisk(path: string = CHECKOUT_ROOT, statfs: typeof statfsSync = statfsSync): DiskSample | null {
	for (const p of [path, os.homedir()]) {
		try {
			const s = statfs(p);
			return { path: p, totalBytes: Number(s.blocks) * Number(s.bsize), freeBytes: Number(s.bavail) * Number(s.bsize), inodesTotal: Number(s.files), inodesFree: Number(s.ffree) };
		} catch {
			// The checkout root does not exist yet on a fresh machine; the home volume is the next answer.
		}
	}
	return null;
}

/** The file that remembers this machine's recent runner starts. */
export const STARTS_FILE = join(os.homedir(), ".config", "proagentstore", "runner-starts.json");

/**
 * Record this process's start and count the starts in the last 24h (#924). A runner that crash-loops
 * restarts with a fresh uptime every time, so uptime alone would read as "healthy, just started";
 * the count across restarts is what shows the loop. Never throws: an unwritable file costs the count.
 */
export function recordRunnerStart(now: number = Date.now(), file: string = STARTS_FILE): number {
	let starts: number[] = [];
	try {
		const parsed = JSON.parse(readFileSync(file, "utf-8")) as unknown;
		if (Array.isArray(parsed)) starts = parsed.filter((t): t is number => typeof t === "number" && Number.isFinite(t));
	} catch {
		// No history yet (or unreadable) — this start is the first one we know of.
	}
	starts = [...starts.filter((t) => now - t < 24 * 60 * 60 * 1000), now].slice(-200);
	try {
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, JSON.stringify(starts));
	} catch {
		// Unwritable config dir: the count still covers this process's own start.
	}
	return starts.length;
}

export function sampleResources(
	read: Pick<typeof os, "loadavg" | "cpus" | "totalmem" | "freemem" | "platform"> = os,
	now: number = Date.now(),
	extra: Pick<ResourceSample, "disk" | "runner" | "relayRttMs" | "sessions"> = {},
): ResourceSample {
	const [l1 = 0, l5 = 0, l15 = 0] = read.loadavg();
	return {
		...Object.fromEntries(Object.entries(extra).filter(([, v]) => v !== undefined)),
		loadAvg: [l1, l5, l15],
		// `availableParallelism` would be better, but `cpus()` is what every supported Node has.
		cpus: Math.max(1, read.cpus().length),
		memTotalBytes: read.totalmem(),
		memFreeBytes: read.freemem(),
		platform: read.platform(),
		sampledAt: now,
	};
}
