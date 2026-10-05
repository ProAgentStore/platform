/**
 * What a runner's machine is doing — CPU load, memory, active coding sessions (#924).
 *
 * A relay drop and a "connected but not responding" (#913, #922) could only be read off their
 * symptoms: every connectivity tool reported the socket, none the machine behind it. The suspected
 * trigger — a laptop running a test suite beside several engines and browsers — was inferred from
 * its fan. So the runner's existing heartbeat carries a sample of the machine's own `os` readings,
 * and the platform reports it beside the socket state, with a warning past a high-water mark.
 *
 * Cheap by construction: the runner reads `os.loadavg()` / `os.freemem()` in-process once per 30s
 * heartbeat (no exec, no timer of its own), and the session count is the platform's own
 * `coding_sessions` table — the runner is asked nothing more.
 *
 * Backward compatible: a CLI before {@link RESOURCES_MIN_CLI} sends no sample, the column stays
 * NULL, and every reader answers `resources: null` — "not reported", never a zero reading.
 */
import type { Env } from "../types.js";

/** The first CLI whose heartbeat carries a resource sample. */
export const RESOURCES_MIN_CLI = "0.4.71";

/** What the runner sends, validated — it is a system boundary, so nothing is trusted unread. */
export interface RunnerResourceSample {
	loadAvg: [number, number, number];
	cpus: number;
	memTotalBytes: number;
	memFreeBytes: number;
	/** `process.platform` — it decides what `memFreeBytes` means (see {@link resourcesView}). */
	platform: string;
	/** Epoch ms, the runner's clock. */
	sampledAt: number;
}

/** Load per core at or above which the machine is called CPU-saturated. */
export const CPU_HIGH_WATER = 1.5;
/** Memory in use (percent) at or above which the machine is called short of memory. */
export const MEMORY_HIGH_WATER_PCT = 90;

const finite = (v: unknown, max: number): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max ? v : null);

/** A runner's sample, or null when it is absent or malformed. Accepts the object or its stored JSON. */
export function parseResourceSample(raw: unknown): RunnerResourceSample | null {
	let o: unknown = raw;
	if (typeof raw === "string") {
		try {
			o = JSON.parse(raw);
		} catch {
			return null;
		}
	}
	if (!o || typeof o !== "object") return null;
	const r = o as Record<string, unknown>;
	const load = Array.isArray(r.loadAvg) ? r.loadAvg.map((v) => finite(v, 10_000)) : [];
	const cpus = finite(r.cpus, 4096);
	const memTotalBytes = finite(r.memTotalBytes, 2 ** 53);
	const memFreeBytes = finite(r.memFreeBytes, 2 ** 53);
	const sampledAt = finite(r.sampledAt, 2 ** 53);
	if (load.length !== 3 || load.some((v) => v === null) || !cpus || !memTotalBytes || memFreeBytes === null || memFreeBytes > memTotalBytes || !sampledAt) return null;
	const platform = typeof r.platform === "string" ? r.platform.slice(0, 32) : "unknown";
	return { loadAvg: load as [number, number, number], cpus, memTotalBytes, memFreeBytes, platform, sampledAt };
}

/** What list_runner_nodes and coding_diagnostics report for a machine. */
export interface RunnerResourcesView {
	/** 1/5/15-minute load averages, and the 1-minute one per core. */
	load1: number;
	load5: number;
	load15: number;
	cpus: number;
	loadPerCpu: number;
	memTotalBytes: number;
	memFreeBytes: number;
	memUsedPct: number;
	platform: string;
	/** ISO time of the sample. A stale one means the heartbeat stopped, not that the machine is idle. */
	sampledAt: string;
	/** Coding sessions active on this machine, from the platform's own records; null when not counted. */
	activeSessions: number | null;
	/** High-water marks crossed, each a sentence. `[]` when the machine looks fine. */
	warnings: string[];
}

const round = (n: number, places = 2) => Math.round(n * 10 ** places) / 10 ** places;

/**
 * The reported view of a stored sample, or null when the runner has not reported one.
 *
 * Memory is judged only off Linux. On macOS `os.freemem()` counts only free pages — the kernel
 * keeps "inactive" and file-cache memory that is reclaimable at once, so a healthy Mac reads 95%+
 * used and the warning would cry wolf on every machine. The numbers are still reported there; only
 * the alarm is withheld, and CPU load (which means the same thing everywhere) still warns.
 */
export function resourcesView(raw: unknown, activeSessions: number | null): RunnerResourcesView | null {
	const s = parseResourceSample(raw);
	if (!s) return null;
	const loadPerCpu = round(s.loadAvg[0] / s.cpus);
	const memUsedPct = round(((s.memTotalBytes - s.memFreeBytes) / s.memTotalBytes) * 100, 1);
	const warnings: string[] = [];
	if (loadPerCpu >= CPU_HIGH_WATER) {
		warnings.push(`CPU saturated: 1-minute load ${round(s.loadAvg[0])} on ${s.cpus} cores (${loadPerCpu} per core). A runner this loaded answers its relay late — the "connected but not responding" failure (#913). Move agents to another machine or stop work running beside them.`);
	}
	if (s.platform === "linux" && memUsedPct >= MEMORY_HIGH_WATER_PCT) {
		warnings.push(`Memory nearly exhausted: ${memUsedPct}% in use. Expect slow or failed engine starts, clones and builds on this machine.`);
	}
	return {
		load1: round(s.loadAvg[0]),
		load5: round(s.loadAvg[1]),
		load15: round(s.loadAvg[2]),
		cpus: s.cpus,
		loadPerCpu,
		memTotalBytes: s.memTotalBytes,
		memFreeBytes: s.memFreeBytes,
		memUsedPct,
		platform: s.platform,
		sampledAt: new Date(s.sampledAt).toISOString(),
		activeSessions,
		warnings,
	};
}

/** Record a heartbeat's sample on this machine's row. A missing or malformed sample writes nothing. */
export async function saveResourceSample(env: Pick<Env, "DB">, instanceId: string, userId: string, node: string, raw: unknown): Promise<void> {
	const sample = parseResourceSample(raw);
	if (!sample || !node) return;
	await env.DB.prepare("UPDATE instance_runtime_nodes SET resources = ?1 WHERE instance_id = ?2 AND user_id = ?3 AND runner_node = ?4")
		.bind(JSON.stringify(sample), instanceId, userId, node)
		.run();
}

/** Coding sessions active on these machine names, for this user. */
export async function activeSessionsOn(env: Pick<Env, "DB">, userId: string, nodes: readonly string[]): Promise<number | null> {
	const names = nodes.filter(Boolean).slice(0, 20);
	if (!names.length) return null;
	const marks = names.map((_, i) => `?${i + 2}`).join(", ");
	const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM coding_sessions WHERE user_id = ?1 AND status = 'active' AND runner_node IN (${marks})`)
		.bind(userId, ...names)
		.first<{ n: number }>()
		.catch(() => null);
	return row ? Number(row.n) : null;
}

/** The freshest sample any of this machine's rows carries, for this user — by the runner's own clock. */
export async function latestResourceSample(env: Pick<Env, "DB">, userId: string, nodes: readonly string[]): Promise<RunnerResourceSample | null> {
	const names = nodes.filter(Boolean).slice(0, 20);
	if (!names.length) return null;
	const marks = names.map((_, i) => `?${i + 2}`).join(", ");
	const { results } = await env.DB.prepare(`SELECT resources FROM instance_runtime_nodes WHERE user_id = ?1 AND resources IS NOT NULL AND runner_node IN (${marks})`)
		.bind(userId, ...names)
		.all<{ resources: string }>()
		.catch(() => ({ results: [] as { resources: string }[] }));
	let best: RunnerResourceSample | null = null;
	for (const r of results ?? []) {
		const s = parseResourceSample(r.resources);
		if (s && (!best || s.sampledAt > best.sampledAt)) best = s;
	}
	return best;
}
