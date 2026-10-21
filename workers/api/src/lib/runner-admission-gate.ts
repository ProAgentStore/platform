/**
 * The runner admission gate (#1264): refuse a NEW coding session/job on an overloaded machine
 * instead of accepting it and going silent — the "connected but not responding" failure (#913)
 * live examples were filed from (one Mac Mini at load1 24.74 on 12 cores with 2 sessions; a
 * laptop at 99.6% memory used; another at 94.4% disk used).
 *
 * ── Where this runs, and why
 *
 * The proposal in #1264 has the RUNNER check its own heartbeat sample before accepting work. This
 * module instead evaluates the SAME stored sample on the PLATFORM, at two points:
 *
 *   1. Every heartbeat (`updateGateState`, called from the `/runtime/heartbeat` route) — so the
 *      gate state is always based on a sample at most one heartbeat (30s) old, exactly as fresh as
 *      the proposal's own "take a fresh sample if the cached one is over 30s old" asks for, without
 *      the platform needing to ask the runner to re-sample on demand.
 *   2. `coding_loop_start` (`loop-drivers.ts`'s `codingDriver`), which reads the state this wrote
 *      and refuses with `runner_overloaded` before `ensureActiveSession` would open a new engine.
 *
 * This is deliberately NOT a change to the runner binary (`packages/cli`, `packages/browser-runner`):
 * it ships today, on every existing CLI, because it only reads data every CLI already sends. The one
 * piece of the proposal this cannot do YET is macOS "available" memory (free + inactive + purgeable).
 * No shipped CLI reports it, and raw `memFreeBytes` undercounts there exactly as
 * `runner-resources.ts`'s own memory WARNING already documents. Therefore the gate deliberately
 * does not judge memory on macOS until a runner supplies `memAvailableBytes`; a false admission is
 * preferable to falsely wedging a healthy Mac. Linux keeps both memory checks unchanged.
 *
 * ── Hysteresis
 *
 * A breach rejects IMMEDIATELY — there is no reason to let a known-bad sample through once. Recovery
 * is the cautious direction: every metric must sit inside the RECOVERY band (10% more forgiving than
 * the reject line) for two CONSECUTIVE samples before the gate reopens, so a machine oscillating
 * right at the line does not flap open/closed on every heartbeat.
 */
import type { Env } from "../types.js";
import { activeSessionsOn, parseResourceSample, recommendedMaxSessions, type RunnerResourceSample } from "./runner-resources.js";

export type GateMetric = "cpu" | "memory" | "disk" | "sessions";

export interface GateThresholds {
	/** Reject when load1/cores exceeds this. */
	cpuLoad1PerCpu: number;
	/** Reject when load5/cores exceeds this — load1 alone lets a spike cause a rejection. */
	cpuLoad5PerCpu: number;
	/** Reject when memory in use exceeds this percent. */
	memUsedPctMax: number;
	/** Reject when available memory falls under this many bytes. */
	memAvailableMinBytes: number;
	/** Reject when the checkout volume in use exceeds this percent. */
	diskUsedPctMax: number;
	/** Reject when the checkout volume's free space falls under this many bytes. */
	diskFreeMinBytes: number;
}

/** The defaults from #1264's own table. */
export const DEFAULT_GATE_THRESHOLDS: GateThresholds = {
	cpuLoad1PerCpu: 1.5,
	cpuLoad5PerCpu: 1.2,
	memUsedPctMax: 92,
	memAvailableMinBytes: 1 * 1024 ** 3,
	diskUsedPctMax: 95,
	diskFreeMinBytes: 10 * 1024 ** 3,
};

/** How much more forgiving the recovery line is than the reject line (#1264: "threshold minus 10%"). */
const RECOVERY_BAND = 0.9;
/** Consecutive clear samples required before a rejecting gate reopens. */
const RECOVERY_STREAK_NEEDED = 2;

export interface GateBreach {
	metric: GateMetric;
	/** The reading that breached, in the threshold's own unit (per-core load, percent, or bytes). */
	value: number;
	threshold: number;
}

export interface GateState {
	state: "accepting" | "rejecting";
	/** The worst breach as of the last sample — absent while accepting. */
	metric?: GateMetric;
	value?: number;
	threshold?: number;
	/** Consecutive samples that cleared the recovery band while rejecting. Reset by any breach. */
	streak: number;
	/** When the CURRENT state began, ms epoch — carried across samples so an episode is one span. */
	since?: number;
}

export const DEFAULT_GATE_STATE: GateState = { state: "accepting", streak: 0 };

/** A sample's reading on the four metrics the gate judges, at one cores/memory-total resolution. */
interface GateReading {
	cpuLoad1PerCpu: number;
	cpuLoad5PerCpu: number;
	memUsedPct: number;
	memAvailableBytes: number;
	/** macOS raw free memory excludes reclaimable cache, so it is not an admission signal. */
	memoryMeasurable: boolean;
	/** macOS raw used-percent has the same cache problem even when available memory is reported. */
	memoryUsedPctMeasurable: boolean;
	diskUsedPct: number | null;
	diskFreeBytes: number | null;
	activeSessions: number | null;
	recommendedMaxSessions: number;
}

function readingOf(sample: RunnerResourceSample, activeSessions: number | null): GateReading {
	const reportedAvailableMemory = sample.memAvailableBytes;
	const hasAvailableMemory = typeof reportedAvailableMemory === "number";
	const memAvailableBytes = reportedAvailableMemory ?? sample.memFreeBytes;
	// `os.freemem()` on Darwin is only genuinely free pages, not the reclaimable pages a new
	// process can use. Keep this decision consistent with `resourcesView`, which reports but does
	// not warn on the same sample. A future runner reports memAvailableBytes and re-enables it.
	const memoryUsedPctMeasurable = sample.platform.toLowerCase() !== "darwin";
	const memoryMeasurable = memoryUsedPctMeasurable || hasAvailableMemory;
	return {
		cpuLoad1PerCpu: sample.loadAvg[0] / sample.cpus,
		cpuLoad5PerCpu: sample.loadAvg[1] / sample.cpus,
		memUsedPct: ((sample.memTotalBytes - sample.memFreeBytes) / sample.memTotalBytes) * 100,
		memAvailableBytes,
		memoryMeasurable,
		memoryUsedPctMeasurable,
		diskUsedPct: sample.disk ? ((sample.disk.totalBytes - sample.disk.freeBytes) / sample.disk.totalBytes) * 100 : null,
		diskFreeBytes: sample.disk?.freeBytes ?? null,
		activeSessions,
		recommendedMaxSessions: recommendedMaxSessions(sample.cpus, sample.memTotalBytes),
	};
}

/**
 * Every metric currently over its REJECT line, in the table's own order (cpu, memory, disk,
 * sessions) — the order {@link worstBreach} reports when more than one is breached at once.
 */
function breaches(r: GateReading, t: GateThresholds): GateBreach[] {
	const out: GateBreach[] = [];
	if (r.cpuLoad1PerCpu > t.cpuLoad1PerCpu) out.push({ metric: "cpu", value: r.cpuLoad1PerCpu, threshold: t.cpuLoad1PerCpu });
	else if (r.cpuLoad5PerCpu > t.cpuLoad5PerCpu) out.push({ metric: "cpu", value: r.cpuLoad5PerCpu, threshold: t.cpuLoad5PerCpu });
	if (r.memoryUsedPctMeasurable && r.memUsedPct > t.memUsedPctMax) out.push({ metric: "memory", value: r.memUsedPct, threshold: t.memUsedPctMax });
	else if (r.memoryMeasurable && r.memAvailableBytes < t.memAvailableMinBytes) out.push({ metric: "memory", value: r.memAvailableBytes, threshold: t.memAvailableMinBytes });
	if (r.diskUsedPct !== null && r.diskUsedPct > t.diskUsedPctMax) out.push({ metric: "disk", value: r.diskUsedPct, threshold: t.diskUsedPctMax });
	else if (r.diskFreeBytes !== null && r.diskFreeBytes < t.diskFreeMinBytes) out.push({ metric: "disk", value: r.diskFreeBytes, threshold: t.diskFreeMinBytes });
	if (r.activeSessions !== null && r.activeSessions >= r.recommendedMaxSessions) out.push({ metric: "sessions", value: r.activeSessions, threshold: r.recommendedMaxSessions });
	return out;
}

/** The one breach a rejection reports — the FIRST in table order, matching the issue's priority. */
export function worstBreach(sample: RunnerResourceSample, activeSessions: number | null, thresholds: GateThresholds = DEFAULT_GATE_THRESHOLDS): GateBreach | null {
	return breaches(readingOf(sample, activeSessions), thresholds)[0] ?? null;
}

/** True only when EVERY metric sits inside the recovery band — the gate reopens on ALL of them, never on one. */
function withinRecoveryBand(r: GateReading, t: GateThresholds): boolean {
	if (r.cpuLoad1PerCpu >= t.cpuLoad1PerCpu * RECOVERY_BAND) return false;
	if (r.cpuLoad5PerCpu >= t.cpuLoad5PerCpu * RECOVERY_BAND) return false;
	if (r.memoryUsedPctMeasurable && r.memUsedPct >= t.memUsedPctMax * RECOVERY_BAND) return false;
	if (r.memoryMeasurable && r.memAvailableBytes <= t.memAvailableMinBytes / RECOVERY_BAND) return false;
	if (r.diskUsedPct !== null && r.diskUsedPct >= t.diskUsedPctMax * RECOVERY_BAND) return false;
	if (r.diskFreeBytes !== null && r.diskFreeBytes <= t.diskFreeMinBytes / RECOVERY_BAND) return false;
	if (r.activeSessions !== null && r.activeSessions >= r.recommendedMaxSessions * RECOVERY_BAND) return false;
	return true;
}

/**
 * The gate's whole decision, pure: given where it stood and what this sample shows, where does it
 * stand now? See the module doc for the hysteresis rule. `now` is for {@link GateState.since} only.
 */
export function nextGateState(prev: GateState, sample: RunnerResourceSample, activeSessions: number | null, thresholds: GateThresholds = DEFAULT_GATE_THRESHOLDS, now: number = Date.now()): GateState {
	const reading = readingOf(sample, activeSessions);
	const breach = breaches(reading, thresholds)[0];
	if (breach) return { state: "rejecting", metric: breach.metric, value: breach.value, threshold: breach.threshold, streak: 0, since: prev.state === "rejecting" ? prev.since ?? now : now };
	if (prev.state === "accepting") return { state: "accepting", streak: 0 };
	if (!withinRecoveryBand(reading, thresholds)) return { ...prev, streak: 0 };
	const streak = prev.streak + 1;
	return streak >= RECOVERY_STREAK_NEEDED ? { state: "accepting", streak: 0 } : { ...prev, streak };
}

/** The structured rejection #1264 asks for, or null when the gate is open. */
export interface GateRejection {
	code: "runner_overloaded";
	metric: GateMetric;
	value: number;
	threshold: number;
	node: string;
}

export function rejectionFor(state: GateState, node: string): GateRejection | null {
	if (state.state !== "rejecting" || !state.metric || state.value === undefined || state.threshold === undefined) return null;
	return { code: "runner_overloaded", metric: state.metric, value: state.value, threshold: state.threshold, node };
}

/** One rejection, as a sentence a human reads — on the run's refusal, the board and the owner's notification. */
export function describeRejection(r: GateRejection): string {
	const units: Record<GateMetric, (v: number) => string> = {
		cpu: (v) => `${v.toFixed(2)} load/core (threshold ${r.threshold})`,
		memory: (v) => (v > 1024 ? `${(v / 1024 ** 3).toFixed(1)} GiB available (threshold ${(r.threshold / 1024 ** 3).toFixed(1)} GiB)` : `${v.toFixed(1)}% used (threshold ${r.threshold}%)`),
		disk: (v) => (v > 1024 ? `${(v / 1024 ** 3).toFixed(1)} GiB free (threshold ${(r.threshold / 1024 ** 3).toFixed(1)} GiB)` : `${v.toFixed(1)}% used (threshold ${r.threshold}%)`),
		sessions: (v) => `${v} active sessions (recommended max ${r.threshold})`,
	};
	return `${r.node} is overloaded (${r.metric}: ${units[r.metric](r.value)}). New coding sessions are refused until it recovers; this run is deferred and will retry automatically — nothing already running is touched.`;
}

/** A node's own threshold override, merged over the defaults — absent/malformed fields keep their default. */
export function parseGateThresholds(raw: unknown): GateThresholds {
	if (!raw || typeof raw !== "object") return DEFAULT_GATE_THRESHOLDS;
	const o = raw as Record<string, unknown>;
	const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback);
	return {
		cpuLoad1PerCpu: num(o.cpuLoad1PerCpu, DEFAULT_GATE_THRESHOLDS.cpuLoad1PerCpu),
		cpuLoad5PerCpu: num(o.cpuLoad5PerCpu, DEFAULT_GATE_THRESHOLDS.cpuLoad5PerCpu),
		memUsedPctMax: num(o.memUsedPctMax, DEFAULT_GATE_THRESHOLDS.memUsedPctMax),
		memAvailableMinBytes: num(o.memAvailableMinBytes, DEFAULT_GATE_THRESHOLDS.memAvailableMinBytes),
		diskUsedPctMax: num(o.diskUsedPctMax, DEFAULT_GATE_THRESHOLDS.diskUsedPctMax),
		diskFreeMinBytes: num(o.diskFreeMinBytes, DEFAULT_GATE_THRESHOLDS.diskFreeMinBytes),
	};
}

export function parseGateState(raw: unknown): GateState {
	let o: unknown = raw;
	if (typeof raw === "string") {
		try {
			o = JSON.parse(raw);
		} catch {
			return DEFAULT_GATE_STATE;
		}
	}
	if (!o || typeof o !== "object") return DEFAULT_GATE_STATE;
	const v = o as Record<string, unknown>;
	if (v.state !== "accepting" && v.state !== "rejecting") return DEFAULT_GATE_STATE;
	const metric = v.metric === "cpu" || v.metric === "memory" || v.metric === "disk" || v.metric === "sessions" ? v.metric : undefined;
	const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : undefined);
	return {
		state: v.state,
		...(metric ? { metric } : {}),
		...(num(v.value) !== undefined ? { value: num(v.value) } : {}),
		...(num(v.threshold) !== undefined ? { threshold: num(v.threshold) } : {}),
		streak: typeof v.streak === "number" && Number.isFinite(v.streak) && v.streak >= 0 ? v.streak : 0,
		...(num(v.since) !== undefined ? { since: num(v.since) } : {}),
	};
}

/** The node's own row — just the three columns the gate needs, so a caller does not have to know the schema. */
interface GateRow {
	resources: string | null;
	gate_state: string | null;
	gate_thresholds: string | null;
}

/**
 * Re-evaluate one node's gate from its freshest stored sample, persist the new state, and report
 * whether this is a NEW overload episode (accepting → rejecting) — the one signal #1264 wants ONE
 * notification per, never one per rejected job. Best-effort: a read/write failure keeps the gate
 * open rather than risk wedging admission shut on a transient D1 error.
 */
export async function updateGateState(env: Pick<Env, "DB">, instanceId: string, userId: string, node: string, now: number = Date.now()): Promise<{ state: GateState; enteredOverload: boolean }> {
	try {
		const row = await env.DB.prepare("SELECT resources, gate_state, gate_thresholds FROM instance_runtime_nodes WHERE instance_id = ?1 AND user_id = ?2 AND runner_node = ?3")
			.bind(instanceId, userId, node)
			.first<GateRow>();
		const sample = row ? parseResourceSample(row.resources) : null;
		// No sample yet (an older CLI, or the first heartbeat before one arrives) — nothing to judge, stay open.
		if (!sample) return { state: DEFAULT_GATE_STATE, enteredOverload: false };
		const activeSessions = await activeSessionsOn(env, userId, [node]);
		const thresholds = parseGateThresholds(row?.gate_thresholds ? safeParse(row.gate_thresholds) : null);
		const prev = parseGateState(row?.gate_state ?? null);
		const next = nextGateState(prev, sample, activeSessions, thresholds, now);
		await env.DB.prepare("UPDATE instance_runtime_nodes SET gate_state = ?1 WHERE instance_id = ?2 AND user_id = ?3 AND runner_node = ?4")
			.bind(JSON.stringify(next), instanceId, userId, node)
			.run();
		return { state: next, enteredOverload: prev.state === "accepting" && next.state === "rejecting" };
	} catch {
		return { state: DEFAULT_GATE_STATE, enteredOverload: false };
	}
}

/** The node's CURRENT gate state, as last written by {@link updateGateState} — a cheap read, no re-evaluation. */
export async function currentGateState(env: Pick<Env, "DB">, instanceId: string, userId: string, node: string): Promise<GateState> {
	const row = await env.DB.prepare("SELECT gate_state FROM instance_runtime_nodes WHERE instance_id = ?1 AND user_id = ?2 AND runner_node = ?3")
		.bind(instanceId, userId, node)
		.first<{ gate_state: string | null }>()
		.catch(() => null);
	return parseGateState(row?.gate_state ?? null);
}

/** Set (or clear, with `null`) a node's own threshold override — `get_machine_policy`'s sibling for admission. */
export async function setGateThresholds(env: Pick<Env, "DB">, instanceId: string, userId: string, node: string, overrides: Partial<GateThresholds> | null): Promise<void> {
	await env.DB.prepare("UPDATE instance_runtime_nodes SET gate_thresholds = ?1 WHERE instance_id = ?2 AND user_id = ?3 AND runner_node = ?4")
		.bind(overrides ? JSON.stringify(overrides) : null, instanceId, userId, node)
		.run();
}

function safeParse(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/** The node's display gate state for `list_runner_nodes` / `coding_diagnostics` — "accepting" or "rejecting:<metric>". */
export function gateStateLabel(state: GateState): "accepting" | `rejecting:${GateMetric}` {
	return state.state === "rejecting" && state.metric ? (`rejecting:${state.metric}` as const) : "accepting";
}
