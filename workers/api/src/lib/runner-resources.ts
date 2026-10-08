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
/** The first CLI whose sample also carries disk, the runner process, relay round trip and sessions. */
export const RESOURCE_DETAIL_MIN_CLI = "0.4.76";

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
	/** The checkout volume (CLI ≥ {@link RESOURCE_DETAIL_MIN_CLI}). */
	disk?: { path: string; totalBytes: number; freeBytes: number; inodesTotal: number; inodesFree: number };
	/** The `pags runner connect` process: start time, uptime, starts in 24h, relay reconnects. */
	runner?: { startedAt: number; uptimeSec: number; starts24h: number; relayReconnects: number; rsid?: string; pid?: number; launch?: string };
	/** One relay round trip this beat, ms; null when the probe got no echo in time. */
	relayRttMs?: number | null;
	/** Per-session CPU/memory, engine plus descendants. */
	sessions?: SessionUsage[];
}

export interface SessionUsage {
	sessionId: string;
	engineLabel: string;
	pid: number;
	processes: number;
	rssBytes: number;
	cpuPct: number;
}

/** Load per core at or above which the machine is called CPU-saturated. */
export const CPU_HIGH_WATER = 1.5;
/** Memory in use (percent) at or above which the machine is called short of memory. */
export const MEMORY_HIGH_WATER_PCT = 90;
/** Disk space or inodes in use (percent) at or above which the checkout volume is called nearly full. */
export const DISK_HIGH_WATER_PCT = 90;
/** Runner starts in 24h at or above which the process is called crash-looping. */
export const RESTARTS_HIGH_WATER = 3;
/** A relay round trip at or above the deadline the platform gives a ping (`PONG_DEADLINE_MS`) is "slow enough to fail". */
export const RELAY_RTT_HIGH_WATER_MS = 1500;
/**
 * A HEURISTIC capacity for concurrent coding sessions (#924's "6 active, recommended max ~4"): one
 * per two cores and one per 4 GiB of memory, whichever is lower, at least one. Each session is an
 * engine plus whatever it runs (builds, test suites, browsers), so this is a starting point to
 * spread agents by, not a measured limit — it is labelled as such wherever it is reported.
 */
export function recommendedMaxSessions(cpus: number, memTotalBytes: number): number {
	return Math.max(1, Math.min(Math.floor(cpus / 2), Math.floor(memTotalBytes / (4 * 1024 ** 3))));
}

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
	const sample: RunnerResourceSample = { loadAvg: load as [number, number, number], cpus, memTotalBytes, memFreeBytes, platform, sampledAt };
	// The #924 follow-up fields, each validated on its own: one malformed part is dropped, never the
	// whole sample, and an absent part stays absent ("not reported"), never zero.
	const d = r.disk as Record<string, unknown> | undefined;
	if (d && typeof d === "object") {
		const totalBytes = finite(d.totalBytes, 2 ** 60);
		const freeBytes = finite(d.freeBytes, 2 ** 60);
		const inodesTotal = finite(d.inodesTotal, 2 ** 53);
		const inodesFree = finite(d.inodesFree, 2 ** 53);
		if (totalBytes && freeBytes !== null && freeBytes <= totalBytes && inodesTotal !== null && inodesFree !== null && inodesFree <= inodesTotal) {
			sample.disk = { path: typeof d.path === "string" && d.path.length <= 300 ? d.path : "", totalBytes, freeBytes, inodesTotal, inodesFree };
		}
	}
	const p = r.runner as Record<string, unknown> | undefined;
	if (p && typeof p === "object") {
		const startedAt = finite(p.startedAt, 2 ** 53);
		const uptimeSec = finite(p.uptimeSec, 10 ** 9);
		const starts24h = finite(p.starts24h, 10_000);
		const relayReconnects = finite(p.relayReconnects, 10 ** 7);
		if (startedAt && uptimeSec !== null && starts24h !== null && relayReconnects !== null) {
			// #896: the process's own identity rides along when the CLI holds a lock. Bounded and
			// typed like everything else here; absent from an older CLI, which the detector handles.
			const rsid = typeof p.rsid === "string" && p.rsid.trim() ? p.rsid.trim().slice(0, 64) : undefined;
			const pid = finite(p.pid, 2 ** 31);
			const launch = typeof p.launch === "string" && /^(tty|tmux|service|headless)$/.test(p.launch) ? p.launch : undefined;
			sample.runner = { startedAt, uptimeSec, starts24h, relayReconnects, ...(rsid ? { rsid } : {}), ...(pid ? { pid } : {}), ...(launch ? { launch } : {}) };
		}
	}
	if (r.relayRttMs === null) sample.relayRttMs = null;
	else {
		const rtt = finite(r.relayRttMs, 600_000);
		if (rtt !== null) sample.relayRttMs = rtt;
	}
	// A runner never has 50 live engines; a list longer than that is malformed, and refused whole.
	if (Array.isArray(r.sessions) && r.sessions.length <= 50) {
		sample.sessions = r.sessions.flatMap((x): SessionUsage[] => {
			const e = (x ?? {}) as Record<string, unknown>;
			const pid = finite(e.pid, 2 ** 31);
			const processes = finite(e.processes, 100_000);
			const rssBytes = finite(e.rssBytes, 2 ** 53);
			const cpuPct = finite(e.cpuPct, 100_000);
			// Ids are never cut (two cut ids could merge): an over-long one drops its entry.
			if (typeof e.sessionId !== "string" || e.sessionId.length > 100 || pid === null || processes === null || rssBytes === null || cpuPct === null) return [];
			return [{ sessionId: e.sessionId, engineLabel: typeof e.engineLabel === "string" && e.engineLabel.length <= 100 ? e.engineLabel : "", pid, processes, rssBytes, cpuPct }];
		});
	}
	return sample;
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
	/** A heuristic ceiling for concurrent sessions on this machine — see {@link recommendedMaxSessions}. */
	recommendedMaxSessions: number;
	/** The checkout volume; null when the runner does not report it (CLI before {@link RESOURCE_DETAIL_MIN_CLI}). */
	disk: { path: string; totalBytes: number; freeBytes: number; usedPct: number; inodesUsedPct: number } | null;
	/** The runner process; null when not reported. */
	runner: { startedAt: string; uptimeSec: number; starts24h: number; relayReconnects: number; rsid?: string; pid?: number; launch?: string } | null;
	/** One relay round trip at the sample, ms. null: no echo in time, or not reported. */
	relayRttMs: number | null;
	/** Per-session usage, heaviest CPU first; null when not reported. */
	sessions: SessionUsage[] | null;
	/** High-water marks crossed, each a sentence. `[]` when the machine looks fine. */
	warnings: string[];
}

const round = (n: number, places = 2) => Math.round(n * 10 ** places) / 10 ** places;

/**
 * One row's sample as a runner-PROCESS identity (#896), or null when it carries none.
 *
 * Lives here because this file owns what a stored sample means; the duplicate detector stays pure
 * and knows nothing about rows or JSON. A CLI before #924 reported no process block at all, and a
 * CLI before #896 reports one without an `rsid` — both are handled, since the machines most likely
 * to be running duplicates are exactly the ones nobody has updated.
 */
export function runnerIdentityOf(instanceId: string, node: string, raw: unknown): { instanceId: string; node: string; startedAt: number; rsid?: string; pid?: number; launch?: string; sampledAt: number } | null {
	const s = parseResourceSample(raw);
	if (!s?.runner?.startedAt) return null;
	return {
		instanceId,
		node,
		startedAt: s.runner.startedAt,
		...(s.runner.rsid ? { rsid: s.runner.rsid } : {}),
		...(s.runner.pid ? { pid: s.runner.pid } : {}),
		...(s.runner.launch ? { launch: s.runner.launch } : {}),
		sampledAt: s.sampledAt,
	};
}

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
	const disk = s.disk
		? {
				path: s.disk.path,
				totalBytes: s.disk.totalBytes,
				freeBytes: s.disk.freeBytes,
				usedPct: round(((s.disk.totalBytes - s.disk.freeBytes) / s.disk.totalBytes) * 100, 1),
				inodesUsedPct: s.disk.inodesTotal ? round(((s.disk.inodesTotal - s.disk.inodesFree) / s.disk.inodesTotal) * 100, 1) : 0,
			}
		: null;
	if (disk && disk.usedPct >= DISK_HIGH_WATER_PCT) warnings.push(`Disk nearly full: ${disk.usedPct}% of the checkout volume in use. Clones, builds and git writes fail when it fills.`);
	if (disk && disk.inodesUsedPct >= DISK_HIGH_WATER_PCT) warnings.push(`Inodes nearly exhausted: ${disk.inodesUsedPct}% in use on the checkout volume — many small files (node_modules, build caches) can fill it with space to spare.`);
	if (s.runner && s.runner.starts24h >= RESTARTS_HIGH_WATER) warnings.push(`The runner has started ${s.runner.starts24h} times on this machine in 24 hours — it may be crash-looping, which reads as a machine flickering between online and offline.`);
	if (typeof s.relayRttMs === "number" && s.relayRttMs >= RELAY_RTT_HIGH_WATER_MS) warnings.push(`Relay round trip ${Math.round(s.relayRttMs)} ms — at or over the ${RELAY_RTT_HIGH_WATER_MS} ms a ping is given, so commands to this machine can fail as "not responding" (#913).`);
	const capacity = recommendedMaxSessions(s.cpus, s.memTotalBytes);
	if (activeSessions !== null && activeSessions > capacity) warnings.push(`${activeSessions} coding sessions active against a suggested ${capacity} for ${s.cpus} cores and ${round(s.memTotalBytes / 1024 ** 3, 0)} GiB (a heuristic). Move agents to another machine before relays start dropping.`);
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
		recommendedMaxSessions: capacity,
		disk,
		runner: s.runner
			? {
				startedAt: new Date(s.runner.startedAt).toISOString(),
				uptimeSec: s.runner.uptimeSec,
				starts24h: s.runner.starts24h,
				relayReconnects: s.runner.relayReconnects,
				...(s.runner.rsid ? { rsid: s.runner.rsid } : {}),
				...(s.runner.pid ? { pid: s.runner.pid } : {}),
				...(s.runner.launch ? { launch: s.runner.launch } : {}),
			}
			: null,
		relayRttMs: typeof s.relayRttMs === "number" ? Math.round(s.relayRttMs) : null,
		sessions: s.sessions ? [...s.sessions].sort((a, b) => b.cpuPct - a.cpuPct) : null,
		warnings,
	};
}

/**
 * Record a heartbeat's sample on this machine's row AND in its history (#924). A missing or
 * malformed sample writes nothing.
 */
export async function saveResourceSample(env: Pick<Env, "DB">, instanceId: string, userId: string, node: string, raw: unknown): Promise<void> {
	const sample = parseResourceSample(raw);
	if (!sample || !node) return;
	await env.DB.prepare("UPDATE instance_runtime_nodes SET resources = ?1 WHERE instance_id = ?2 AND user_id = ?3 AND runner_node = ?4")
		.bind(JSON.stringify(sample), instanceId, userId, node)
		.run();
	await recordHistory(env, userId, node, sample);
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

// ── History: two tiers from the same heartbeat (#924) ─────────────────────────────────────────

/** How long the dense tier (every sample) is kept. */
export const DENSE_RETENTION_MS = 2 * 60 * 60 * 1000;
/** The coarse tier's bucket, and how long it is kept. */
export const COARSE_BUCKET_MS = 5 * 60 * 1000;
export const COARSE_RETENTION_MS = 24 * 60 * 60 * 1000;

export type HistoryTier = "dense" | "coarse";

/**
 * Fold a sample into its coarse bucket, keeping the bucket's WORST readings — a 5-minute average
 * would smooth away the spike a postmortem is looking for. Pure.
 */
export function mergeCoarse(prev: RunnerResourceSample | null, next: RunnerResourceSample, counts: { prev?: number; next?: number } = {}): RunnerResourceSample & { samples: number } {
	const n = (prev ? (counts.prev ?? 1) : 0) + (counts.next ?? 1);
	if (!prev) return { ...next, samples: n };
	const max = (a: number, b: number) => Math.max(a, b);
	const rtts = [prev.relayRttMs, next.relayRttMs].filter((v): v is number => typeof v === "number");
	const disk = prev.disk && next.disk
		? { ...next.disk, freeBytes: Math.min(prev.disk.freeBytes, next.disk.freeBytes), inodesFree: Math.min(prev.disk.inodesFree, next.disk.inodesFree) }
		: (next.disk ?? prev.disk);
	const runner = prev.runner && next.runner
		? { ...next.runner, starts24h: max(prev.runner.starts24h, next.runner.starts24h), relayReconnects: max(prev.runner.relayReconnects, next.runner.relayReconnects) }
		: (next.runner ?? prev.runner);
	const heavier = (prev.sessions ?? []).reduce((a, x) => a + x.cpuPct, 0) > (next.sessions ?? []).reduce((a, x) => a + x.cpuPct, 0) ? prev.sessions : next.sessions;
	return {
		...next,
		loadAvg: [max(prev.loadAvg[0], next.loadAvg[0]), max(prev.loadAvg[1], next.loadAvg[1]), max(prev.loadAvg[2], next.loadAvg[2])],
		memFreeBytes: Math.min(prev.memFreeBytes, next.memFreeBytes),
		...(disk ? { disk } : {}),
		...(runner ? { runner } : {}),
		...(rtts.length ? { relayRttMs: Math.max(...rtts) } : "relayRttMs" in next || "relayRttMs" in prev ? { relayRttMs: null } : {}),
		...(heavier ? { sessions: heavier } : {}),
		samples: n,
	};
}

/** Append a sample to both tiers and age each out. Idempotent per sample: every agent on the machine sends the same one. */
async function recordHistory(env: Pick<Env, "DB">, userId: string, node: string, sample: RunnerResourceSample): Promise<void> {
	const ins = await env.DB.prepare("INSERT OR IGNORE INTO runner_resource_samples (user_id, node, tier, at, sample) VALUES (?1, ?2, 'dense', ?3, ?4)")
		.bind(userId, node, sample.sampledAt, JSON.stringify(sample))
		.run();
	if (!(ins.meta?.changes ?? 0)) return; // another agent's heartbeat already recorded this sample
	const bucket = Math.floor(sample.sampledAt / COARSE_BUCKET_MS) * COARSE_BUCKET_MS;
	const prev = await env.DB.prepare("SELECT sample FROM runner_resource_samples WHERE user_id = ?1 AND node = ?2 AND tier = 'coarse' AND at = ?3")
		.bind(userId, node, bucket)
		.first<{ sample: string }>();
	const merged = mergeCoarse(prev ? parseResourceSample(prev.sample) : null, sample, { prev: prev ? samplesIn(prev.sample) : 0 });
	await env.DB.batch([
		env.DB.prepare("INSERT INTO runner_resource_samples (user_id, node, tier, at, sample) VALUES (?1, ?2, 'coarse', ?3, ?4) ON CONFLICT (user_id, node, tier, at) DO UPDATE SET sample = excluded.sample")
			.bind(userId, node, bucket, JSON.stringify(merged)),
		env.DB.prepare("DELETE FROM runner_resource_samples WHERE user_id = ?1 AND node = ?2 AND tier = 'dense' AND at < ?3").bind(userId, node, sample.sampledAt - DENSE_RETENTION_MS),
		env.DB.prepare("DELETE FROM runner_resource_samples WHERE user_id = ?1 AND node = ?2 AND tier = 'coarse' AND at < ?3").bind(userId, node, sample.sampledAt - COARSE_RETENTION_MS),
	]);
}

/** How many heartbeat samples a stored coarse bucket covers (1 for a dense row). */
function samplesIn(stored: string): number {
	try {
		const n = (JSON.parse(stored) as { samples?: unknown }).samples;
		return typeof n === "number" && n > 0 ? n : 1;
	} catch {
		return 1;
	}
}

/** Sessions a history point names — the heaviest, by CPU; the field says so. */
const TOP_SESSIONS = 3;

/** One point of a machine's history — the compact shape a postmortem reads in a series. */
export interface ResourcePoint {
	at: string;
	load1: number;
	loadPerCpu: number;
	memUsedPct: number;
	diskUsedPct: number | null;
	inodesUsedPct: number | null;
	relayRttMs: number | null;
	uptimeSec: number | null;
	starts24h: number | null;
	/** The three heaviest sessions by CPU at this point. */
	topSessions: SessionUsage[] | null;
	/** Coarse only: how many samples the bucket's worst-of readings cover. */
	samples?: number;
	warnings: string[];
}

export function resourcePoint(raw: unknown): ResourcePoint | null {
	const view = resourcesView(raw, null);
	if (!view) return null;
	const samples = typeof raw === "string" ? samplesIn(raw) : typeof (raw as { samples?: unknown })?.samples === "number" ? (raw as { samples: number }).samples : undefined;
	return {
		at: view.sampledAt,
		load1: view.load1,
		loadPerCpu: view.loadPerCpu,
		memUsedPct: view.memUsedPct,
		diskUsedPct: view.disk?.usedPct ?? null,
		inodesUsedPct: view.disk?.inodesUsedPct ?? null,
		relayRttMs: view.relayRttMs,
		uptimeSec: view.runner?.uptimeSec ?? null,
		starts24h: view.runner?.starts24h ?? null,
		topSessions: view.sessions ? view.sessions.slice(0, TOP_SESSIONS) : null,
		...(typeof samples === "number" ? { samples } : {}),
		warnings: view.warnings,
	};
}

/**
 * A machine's history, oldest first, across every name it is known by, within `[from, to]` (epoch ms).
 * A machine renamed mid-bucket wrote a coarse row under each name for the same 5 minutes: those are
 * folded into one bucket here, so a rename does not split a bucket's worst-of. Dense rows are
 * distinct samples whatever name they came under, and are all kept.
 */
export async function resourceHistory(env: Pick<Env, "DB">, userId: string, nodes: readonly string[], tier: HistoryTier, from: number, to: number): Promise<ResourcePoint[]> {
	const names = nodes.filter(Boolean);
	if (!names.length) return [];
	const marks = names.map((_, i) => `?${i + 5}`).join(", ");
	const { results } = await env.DB.prepare(`SELECT at, sample FROM runner_resource_samples WHERE user_id = ?1 AND tier = ?2 AND at >= ?3 AND at <= ?4 AND node IN (${marks}) ORDER BY at ASC`)
		.bind(userId, tier, from, to, ...names)
		.all<{ at: number; sample: string }>();
	let stored = results ?? [];
	if (tier === "coarse") {
		const byAt = new Map<number, string>();
		for (const r of stored) {
			const had = byAt.get(r.at);
			const next = parseResourceSample(r.sample);
			if (!next) continue;
			byAt.set(r.at, had ? JSON.stringify(mergeCoarse(parseResourceSample(had), next, { prev: samplesIn(had), next: samplesIn(r.sample) })) : r.sample);
		}
		stored = [...byAt.entries()].map(([at, sample]) => ({ at, sample }));
	}
	return stored.flatMap((r) => {
		const p = resourcePoint(r.sample);
		return p ? [{ ...p, ...(tier === "coarse" ? { at: new Date(r.at).toISOString() } : {}) }] : [];
	});
}
