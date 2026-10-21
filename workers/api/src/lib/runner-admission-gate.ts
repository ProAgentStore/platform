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
import { activeWorkOn, latestResourceSample, parseResourceSample, recommendedMaxSessions, type RunnerResourceSample } from "./runner-resources.js";

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
	/** Reject a new session once this many are active. null = the formula (one per two cores, one per 4 GiB), #1275. */
	maxSessions: number | null;
	/** How much more forgiving the recovery line is than the reject line: 0.9 = every metric under 90% of its line. */
	recoveryBand: number;
	/** Consecutive clear samples required before a rejecting gate reopens. */
	recoveryStreak: number;
}

/**
 * The defaults table (#1264's own numbers, plus the recovery rule and the session limit #1275 made settable).
 * A deploy can replace any of them with the `RUNNER_GATE_DEFAULTS` variable (a JSON object of the same keys) —
 * see {@link gateDefaults}; a machine`s own override (machine_policies.gate_thresholds) wins over both.
 */
export const DEFAULT_GATE_THRESHOLDS: GateThresholds = {
	cpuLoad1PerCpu: 1.5,
	cpuLoad5PerCpu: 1.2,
	memUsedPctMax: 92,
	memAvailableMinBytes: 1 * 1024 ** 3,
	diskUsedPctMax: 95,
	diskFreeMinBytes: 10 * 1024 ** 3,
	maxSessions: null,
	recoveryBand: 0.9, // #1264: "threshold minus 10%"
	recoveryStreak: 2,
};

/** The defaults in force on this deploy: the table above, with any valid key of `RUNNER_GATE_DEFAULTS` laid over it. */
export function gateDefaults(env?: { RUNNER_GATE_DEFAULTS?: string }): GateThresholds {
	if (!env?.RUNNER_GATE_DEFAULTS) return DEFAULT_GATE_THRESHOLDS;
	return parseGateThresholds(safeParse(env.RUNNER_GATE_DEFAULTS), DEFAULT_GATE_THRESHOLDS);
}

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
	/** null = the machine reports no load (Windows, #1258): CPU is simply not judged, as it never effectively was at 0. */
	cpuLoad1PerCpu: number | null;
	cpuLoad5PerCpu: number | null;
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

function readingOf(sample: RunnerResourceSample, activeSessions: number | null, maxSessions: number | null = null): GateReading {
	const reportedAvailableMemory = sample.memAvailableBytes;
	const hasAvailableMemory = typeof reportedAvailableMemory === "number";
	const memAvailableBytes = reportedAvailableMemory ?? sample.memFreeBytes;
	// `os.freemem()` on Darwin is only genuinely free pages, not the reclaimable pages a new
	// process can use. Keep this decision consistent with `resourcesView`, which reports but does
	// not warn on the same sample. A future runner reports memAvailableBytes and re-enables it.
	const memoryUsedPctMeasurable = sample.platform.toLowerCase() !== "darwin";
	const memoryMeasurable = memoryUsedPctMeasurable || hasAvailableMemory;
	return {
		cpuLoad1PerCpu: sample.loadAvg ? sample.loadAvg[0] / sample.cpus : null,
		cpuLoad5PerCpu: sample.loadAvg ? sample.loadAvg[1] / sample.cpus : null,
		memUsedPct: ((sample.memTotalBytes - sample.memFreeBytes) / sample.memTotalBytes) * 100,
		memAvailableBytes,
		memoryMeasurable,
		memoryUsedPctMeasurable,
		diskUsedPct: sample.disk ? ((sample.disk.totalBytes - sample.disk.freeBytes) / sample.disk.totalBytes) * 100 : null,
		diskFreeBytes: sample.disk?.freeBytes ?? null,
		activeSessions,
		recommendedMaxSessions: maxSessions ?? recommendedMaxSessions(sample.cpus, sample.memTotalBytes),
	};
}

/**
 * Every metric currently over its REJECT line, in the table's own order (cpu, memory, disk,
 * sessions) — the order {@link worstBreach} reports when more than one is breached at once.
 */
function breaches(r: GateReading, t: GateThresholds): GateBreach[] {
	const out: GateBreach[] = [];
	if (r.cpuLoad1PerCpu !== null && r.cpuLoad1PerCpu > t.cpuLoad1PerCpu) out.push({ metric: "cpu", value: r.cpuLoad1PerCpu, threshold: t.cpuLoad1PerCpu });
	else if (r.cpuLoad5PerCpu !== null && r.cpuLoad5PerCpu > t.cpuLoad5PerCpu) out.push({ metric: "cpu", value: r.cpuLoad5PerCpu, threshold: t.cpuLoad5PerCpu });
	if (r.memoryUsedPctMeasurable && r.memUsedPct > t.memUsedPctMax) out.push({ metric: "memory", value: r.memUsedPct, threshold: t.memUsedPctMax });
	else if (r.memoryMeasurable && r.memAvailableBytes < t.memAvailableMinBytes) out.push({ metric: "memory", value: r.memAvailableBytes, threshold: t.memAvailableMinBytes });
	if (r.diskUsedPct !== null && r.diskUsedPct > t.diskUsedPctMax) out.push({ metric: "disk", value: r.diskUsedPct, threshold: t.diskUsedPctMax });
	else if (r.diskFreeBytes !== null && r.diskFreeBytes < t.diskFreeMinBytes) out.push({ metric: "disk", value: r.diskFreeBytes, threshold: t.diskFreeMinBytes });
	if (r.activeSessions !== null && r.activeSessions >= r.recommendedMaxSessions) out.push({ metric: "sessions", value: r.activeSessions, threshold: r.recommendedMaxSessions });
	return out;
}

/** The one breach a rejection reports — the FIRST in table order, matching the issue's priority. */
export function worstBreach(sample: RunnerResourceSample, activeSessions: number | null, thresholds: GateThresholds = DEFAULT_GATE_THRESHOLDS): GateBreach | null {
	return breaches(readingOf(sample, activeSessions, thresholds.maxSessions), thresholds)[0] ?? null;
}

/** True only when EVERY metric sits inside the recovery band — the gate reopens on ALL of them, never on one. */
function withinRecoveryBand(r: GateReading, t: GateThresholds): boolean {
	if (r.cpuLoad1PerCpu !== null && r.cpuLoad1PerCpu >= t.cpuLoad1PerCpu * t.recoveryBand) return false;
	if (r.cpuLoad5PerCpu !== null && r.cpuLoad5PerCpu >= t.cpuLoad5PerCpu * t.recoveryBand) return false;
	if (r.memoryUsedPctMeasurable && r.memUsedPct >= t.memUsedPctMax * t.recoveryBand) return false;
	if (r.memoryMeasurable && r.memAvailableBytes <= t.memAvailableMinBytes / t.recoveryBand) return false;
	if (r.diskUsedPct !== null && r.diskUsedPct >= t.diskUsedPctMax * t.recoveryBand) return false;
	if (r.diskFreeBytes !== null && r.diskFreeBytes <= t.diskFreeMinBytes / t.recoveryBand) return false;
	if (r.activeSessions !== null && r.activeSessions >= r.recommendedMaxSessions * t.recoveryBand) return false;
	return true;
}

/**
 * The gate's whole decision, pure: given where it stood and what this sample shows, where does it
 * stand now? See the module doc for the hysteresis rule. `now` is for {@link GateState.since} only.
 */
export function nextGateState(prev: GateState, sample: RunnerResourceSample, activeSessions: number | null, thresholds: GateThresholds = DEFAULT_GATE_THRESHOLDS, now: number = Date.now()): GateState {
	const reading = readingOf(sample, activeSessions, thresholds.maxSessions);
	const breach = breaches(reading, thresholds)[0];
	if (breach) return { state: "rejecting", metric: breach.metric, value: breach.value, threshold: breach.threshold, streak: 0, since: prev.state === "rejecting" ? prev.since ?? now : now };
	if (prev.state === "accepting") return { state: "accepting", streak: 0 };
	if (!withinRecoveryBand(reading, thresholds)) return { ...prev, streak: 0 };
	const streak = prev.streak + 1;
	return streak >= thresholds.recoveryStreak ? { state: "accepting", streak: 0 } : { ...prev, streak };
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
export function describeRejection(r: GateRejection, what: { work?: string; retries?: boolean } = {}): string {
	const units: Record<GateMetric, (v: number) => string> = {
		cpu: (v) => `${v.toFixed(2)} load/core (threshold ${r.threshold})`,
		memory: (v) => (v > 1024 ? `${(v / 1024 ** 3).toFixed(1)} GiB available (threshold ${(r.threshold / 1024 ** 3).toFixed(1)} GiB)` : `${v.toFixed(1)}% used (threshold ${r.threshold}%)`),
		disk: (v) => (v > 1024 ? `${(v / 1024 ** 3).toFixed(1)} GiB free (threshold ${(r.threshold / 1024 ** 3).toFixed(1)} GiB)` : `${v.toFixed(1)}% used (threshold ${r.threshold}%)`),
		sessions: (v) => `${v} active sessions (recommended max ${r.threshold})`,
	};
	return `${r.node} is overloaded (${r.metric}: ${units[r.metric](r.value)}). New ${what.work ?? "coding sessions"} are refused until it recovers; ${what.retries === false ? "start it again once it has" : "this run is deferred and will retry automatically"} — nothing already running is touched.`;
}

/**
 * The admission gate for a browser, application-tailor or application-runner start (#1175). A machine over its limit refuses a new
 * coding session (#1264); a browser or apply run is the same engine and browser load, so it is refused the same way — before a run
 * row or an application move exists — with the same reason. Null when the machine is accepting (or its state is unknown: the gate
 * never refuses on a read failure). Reads the verdict the last heartbeat wrote; it does not re-sample.
 */
export async function overloadRefusal(env: Pick<Env, "DB">, instanceId: string, userId: string, node: string | null | undefined, work: string, retries: boolean): Promise<string | null> {
	if (!node) return null;
	const gate = await currentGateState(env, instanceId, userId, node).catch(() => DEFAULT_GATE_STATE);
	const rejection = rejectionFor(gate, node);
	return rejection ? describeRejection(rejection, { work, retries }) : null;
}

/**
 * A threshold override (a node's, a machine's, or the deploy's defaults), merged over `base` — absent or malformed
 * fields keep the base value. Byte floors may be 0 (that metric then never rejects); every other number must be > 0.
 */
export function parseGateThresholds(raw: unknown, base: GateThresholds = DEFAULT_GATE_THRESHOLDS): GateThresholds {
	if (!raw || typeof raw !== "object") return base;
	const o = raw as Record<string, unknown>;
	const num = (v: unknown, fallback: number, allowZero = false) => (typeof v === "number" && Number.isFinite(v) && (allowZero ? v >= 0 : v > 0) ? v : fallback);
	const int = (v: unknown, fallback: number | null, lo: number, hi: number) => (typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi ? v : fallback);
	return {
		cpuLoad1PerCpu: num(o.cpuLoad1PerCpu, base.cpuLoad1PerCpu),
		cpuLoad5PerCpu: num(o.cpuLoad5PerCpu, base.cpuLoad5PerCpu),
		memUsedPctMax: num(o.memUsedPctMax, base.memUsedPctMax),
		memAvailableMinBytes: num(o.memAvailableMinBytes, base.memAvailableMinBytes, true),
		diskUsedPctMax: num(o.diskUsedPctMax, base.diskUsedPctMax),
		diskFreeMinBytes: num(o.diskFreeMinBytes, base.diskFreeMinBytes, true),
		maxSessions: int(o.maxSessions, base.maxSessions, 1, 64),
		recoveryBand: typeof o.recoveryBand === "number" && o.recoveryBand >= 0.5 && o.recoveryBand <= 0.99 ? o.recoveryBand : base.recoveryBand,
		recoveryStreak: int(o.recoveryStreak, base.recoveryStreak, 1, 20) ?? base.recoveryStreak,
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

/** What the gate needs of an instance's node row: its sample, its legacy per-row state, and which machine it is. */
interface GateRow {
	resources: string | null;
	gate_state: string | null;
	gate_thresholds: string | null;
	machine_id: string | null;
}

/** Samples closer together than this, for one machine, count as ONE toward the recovery streak (several instances heartbeat it). */
export const GATE_SAMPLE_SPACING_MS = 20_000;

const NODE_SQL = "SELECT resources, gate_state, gate_thresholds, machine_id FROM instance_runtime_nodes WHERE instance_id = ?1 AND user_id = ?2 AND runner_node = ?3";

interface MachineGateRow {
	gate_thresholds: string | null;
	gate_state: string | null;
	gate_evaluated_at: number | null;
}

async function machineGateRow(env: Pick<Env, "DB">, userId: string, machineId: string): Promise<MachineGateRow | null> {
	return env.DB.prepare("SELECT gate_thresholds, gate_state, gate_evaluated_at FROM machine_policies WHERE user_id = ?1 AND machine_id = ?2").bind(userId, machineId).first<MachineGateRow>().catch(() => null);
}

/** Every hostname this machine has used for this owner — the names its sessions and runs are recorded under. */
export async function machineNodeNames(env: Pick<Env, "DB">, userId: string, machineId: string, alsoNode?: string): Promise<string[]> {
	const { results } = await env.DB.prepare("SELECT DISTINCT runner_node FROM instance_runtime_nodes WHERE user_id = ?1 AND machine_id = ?2 AND runner_node IS NOT NULL")
		.bind(userId, machineId)
		.all<{ runner_node: string }>()
		.catch(() => ({ results: [] as { runner_node: string }[] }));
	const names = new Set((results ?? []).map((r) => r.runner_node));
	if (alsoNode) names.add(alsoNode);
	return [...names];
}

/**
 * Re-evaluate one machine's gate from its freshest stored sample, persist the new state, and report
 * whether this is a NEW overload episode (accepting -> rejecting) — the one signal #1264 wants ONE
 * notification per, never one per rejected job. Best-effort: a read/write failure keeps the gate
 * open rather than risk wedging admission shut on a transient D1 error.
 *
 * #1275: the gate is the MACHINE's. Thresholds and the session limit come from its machine_policies row
 * (over the deploy's defaults), the state is stored there once, and the sessions counted are everything of
 * every kind on every hostname the machine has used — so two agents on one laptop share one verdict. A runner
 * too old to send a machine id keeps the per-row behaviour of #1264.
 */
export async function updateGateState(env: Pick<Env, "DB"> & { RUNNER_GATE_DEFAULTS?: string }, instanceId: string, userId: string, node: string, now: number = Date.now()): Promise<{ state: GateState; enteredOverload: boolean }> {
	try {
		const row = await env.DB.prepare(NODE_SQL).bind(instanceId, userId, node).first<GateRow>();
		const own = row ? parseResourceSample(row.resources) : null;
		// No sample yet (an older CLI, or the first heartbeat before one arrives) — nothing to judge, stay open.
		if (!own) return { state: DEFAULT_GATE_STATE, enteredOverload: false };
		const defaults = gateDefaults(env);
		if (!row?.machine_id) {
			const activeSessions = await activeWorkOn(env, userId, [node]);
			const thresholds = parseGateThresholds(row?.gate_thresholds ? safeParse(row.gate_thresholds) : null, defaults);
			const prev = parseGateState(row?.gate_state ?? null);
			const next = nextGateState(prev, own, activeSessions, thresholds, now);
			await env.DB.prepare("UPDATE instance_runtime_nodes SET gate_state = ?1 WHERE instance_id = ?2 AND user_id = ?3 AND runner_node = ?4").bind(JSON.stringify(next), instanceId, userId, node).run();
			return { state: next, enteredOverload: prev.state === "accepting" && next.state === "rejecting" };
		}
		const machine = await machineGateRow(env, userId, row.machine_id);
		const names = await machineNodeNames(env, userId, row.machine_id, node);
		const sample = (await latestResourceSample(env, userId, names)) ?? own;
		const prev = parseGateState(machine?.gate_state ?? null);
		// One sample, one count: a second instance on this machine reporting seconds later is not another clear reading.
		if (machine?.gate_evaluated_at && sample.sampledAt < machine.gate_evaluated_at + GATE_SAMPLE_SPACING_MS) return { state: prev, enteredOverload: false };
		const thresholds = parseGateThresholds(machine?.gate_thresholds ? safeParse(machine.gate_thresholds) : null, defaults);
		const next = nextGateState(prev, sample, await activeWorkOn(env, userId, names), thresholds, now);
		await env.DB.prepare(
			`INSERT INTO machine_policies (user_id, machine_id, auto_update, status, updated_at, gate_state, gate_evaluated_at) VALUES (?1, ?2, 0, 'disabled', ?3, ?4, ?5)
			 ON CONFLICT(user_id, machine_id) DO UPDATE SET gate_state = excluded.gate_state, gate_evaluated_at = excluded.gate_evaluated_at`,
		)
			.bind(userId, row.machine_id, now, JSON.stringify(next), sample.sampledAt)
			.run();
		return { state: next, enteredOverload: prev.state === "accepting" && next.state === "rejecting" };
	} catch {
		return { state: DEFAULT_GATE_STATE, enteredOverload: false };
	}
}

/** The CURRENT gate state for this instance's machine, as last written by {@link updateGateState} — a cheap read, no re-evaluation. */
export async function currentGateState(env: Pick<Env, "DB">, instanceId: string, userId: string, node: string): Promise<GateState> {
	const row = await env.DB.prepare("SELECT gate_state, machine_id FROM instance_runtime_nodes WHERE instance_id = ?1 AND user_id = ?2 AND runner_node = ?3")
		.bind(instanceId, userId, node)
		.first<{ gate_state: string | null; machine_id: string | null }>()
		.catch(() => null);
	if (row?.machine_id) return parseGateState((await machineGateRow(env, userId, row.machine_id))?.gate_state ?? null);
	return parseGateState(row?.gate_state ?? null);
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
