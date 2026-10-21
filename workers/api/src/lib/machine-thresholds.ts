/**
 * A machine's admission thresholds (#1275) — what the gate (`runner-admission-gate.ts`) judges it against, owned by the
 * MACHINE rather than by an agent: stored on `machine_policies` (user_id, machine_id), shared by every instance that runs
 * there, and changed through `get/set/reset_machine_thresholds`, `GET/PUT/DELETE /v1/terminals/machines/:id/thresholds`,
 * the console's machine page and `pags runner thresholds`.
 *
 * Precedence, lowest to highest: the defaults table in code -> the deploy's `RUNNER_GATE_DEFAULTS` -> this machine's override.
 * `maxSessions` follows the same rule, with the cores/memory formula as what "no override" means.
 */
import type { Env } from "../types.js";
import { type GateState, type GateThresholds, DEFAULT_GATE_STATE, gateDefaults, gateStateLabel, parseGateState, parseGateThresholds } from "./runner-admission-gate.js";
import { parseResourceSample, recommendedMaxSessions } from "./runner-resources.js";

/** The keys an override may carry, with the range each is validated to. The single table the API, the MCP tool and the docs all read. */
export const THRESHOLD_FIELDS = {
	maxSessions: { kind: "int", min: 1, max: 64, doc: "Reject a new session once this many are running on the machine (every runtime kind). Replaces the cores/memory formula." },
	cpuLoad1PerCpu: { kind: "number", min: 0.1, max: 64, doc: "Reject when the 1-minute load per core exceeds this." },
	cpuLoad5PerCpu: { kind: "number", min: 0.1, max: 64, doc: "Reject when the 5-minute load per core exceeds this." },
	memUsedPctMax: { kind: "number", min: 1, max: 100, doc: "Reject when memory in use exceeds this percent (not judged on macOS until the runner reports available memory)." },
	memAvailableMinBytes: { kind: "int", min: 0, max: 2 ** 50, doc: "Reject when available memory falls under this many bytes. 0 never rejects on it." },
	diskUsedPctMax: { kind: "number", min: 1, max: 100, doc: "Reject when the checkout volume in use exceeds this percent." },
	diskFreeMinBytes: { kind: "int", min: 0, max: 2 ** 50, doc: "Reject when the checkout volume's free space falls under this many bytes. 0 never rejects on it." },
	recoveryBand: { kind: "number", min: 0.5, max: 0.99, doc: "The gate reopens only when every metric is under this fraction of its reject line (0.9 = 10% under)." },
	recoveryStreak: { kind: "int", min: 1, max: 20, doc: "Consecutive clear samples (one per ~30s heartbeat) required before a rejecting gate reopens." },
} as const;

export type ThresholdKey = keyof typeof THRESHOLD_FIELDS;
export const THRESHOLD_KEYS = Object.keys(THRESHOLD_FIELDS) as ThresholdKey[];

/** A partial update: a number sets a field, `null` clears it back to the default. Absent fields are left alone. */
export type ThresholdPatch = Partial<Record<ThresholdKey, number | null>>;

/** What is wrong with a patch, or the patch itself with its non-null values checked. Validated at the boundary so a stored value is always usable. */
export function parseThresholdPatch(raw: unknown): { patch: ThresholdPatch } | { error: string } {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "Send an object of thresholds to change, e.g. { \"maxSessions\": 2 }." };
	const o = raw as Record<string, unknown>;
	const unknown = Object.keys(o).filter((k) => !(k in THRESHOLD_FIELDS));
	if (unknown.length) return { error: `Unknown threshold(s): ${unknown.join(", ")}. Known: ${THRESHOLD_KEYS.join(", ")}.` };
	const patch: ThresholdPatch = {};
	for (const key of THRESHOLD_KEYS) {
		if (!(key in o)) continue;
		const v = o[key];
		const f = THRESHOLD_FIELDS[key];
		if (v === null) {
			patch[key] = null;
			continue;
		}
		if (typeof v !== "number" || !Number.isFinite(v) || (f.kind === "int" && !Number.isInteger(v)) || v < f.min || v > f.max) {
			return { error: `${key} must be ${f.kind === "int" ? "a whole number" : "a number"} from ${f.min} to ${f.max} (or null to go back to the default).` };
		}
		patch[key] = v;
	}
	if (!Object.keys(patch).length) return { error: `Name at least one threshold to change: ${THRESHOLD_KEYS.join(", ")}.` };
	return { patch };
}

/** The stored override object, each known field kept only if it is valid — a hand-edited or old row cannot poison the gate. */
export function storedOverrides(raw: unknown): ThresholdPatch {
	let o: unknown = raw;
	if (typeof raw === "string") {
		try {
			o = JSON.parse(raw);
		} catch {
			return {};
		}
	}
	if (!o || typeof o !== "object" || Array.isArray(o)) return {};
	const checked = parseThresholdPatch(o);
	if ("patch" in checked) return Object.fromEntries(Object.entries(checked.patch).filter(([, v]) => v !== null)) as ThresholdPatch;
	// One bad field must not drop the rest: keep each valid one on its own.
	const out: ThresholdPatch = {};
	for (const key of THRESHOLD_KEYS) {
		const one = parseThresholdPatch({ [key]: (o as Record<string, unknown>)[key] });
		if ("patch" in one && one.patch[key] !== null && one.patch[key] !== undefined) out[key] = one.patch[key];
	}
	return out;
}

/** An override merged with a patch: a number sets, null removes, absent stays. */
export function applyThresholdPatch(current: ThresholdPatch, patch: ThresholdPatch): ThresholdPatch {
	const next: ThresholdPatch = { ...current };
	for (const key of THRESHOLD_KEYS) {
		if (!(key in patch)) continue;
		if (patch[key] === null || patch[key] === undefined) delete next[key];
		else next[key] = patch[key];
	}
	return next;
}

export interface EffectiveThresholds {
	/** Every threshold in force, after defaults and this machine's override. `maxSessions` is the number the gate uses. */
	effective: Record<ThresholdKey, number>;
	/** Where each came from. */
	source: Record<ThresholdKey, "machine" | "default">;
	/** Only what this machine overrides. */
	overrides: ThresholdPatch;
	/** The session limit in force and why: an explicit override, or the cores/memory formula (null until a sample reports cores and memory). */
	maxSessions: { value: number | null; source: "machine" | "default" | "formula"; formula: number | null };
}

/** The thresholds in force for a machine, with where each came from. `cpus`/`memTotalBytes` (from its last sample) resolve the session formula. */
export function effectiveThresholds(env: { RUNNER_GATE_DEFAULTS?: string }, overridesRaw: unknown, machine?: { cpus: number; memTotalBytes: number } | null): EffectiveThresholds {
	const base = gateDefaults(env);
	const overrides = storedOverrides(overridesRaw);
	const merged: GateThresholds = parseGateThresholds(overrides, base);
	const formula = machine ? recommendedMaxSessions(machine.cpus, machine.memTotalBytes) : null;
	const effective = {} as Record<ThresholdKey, number>;
	const source = {} as Record<ThresholdKey, "machine" | "default">;
	for (const key of THRESHOLD_KEYS) {
		const v = key === "maxSessions" ? (merged.maxSessions ?? formula ?? 0) : (merged[key] as number);
		effective[key] = v;
		source[key] = key in overrides ? "machine" : "default";
	}
	const explicit = merged.maxSessions;
	return {
		effective,
		source,
		overrides,
		maxSessions: { value: explicit ?? formula, source: "maxSessions" in overrides ? "machine" : explicit !== null ? "default" : "formula", formula },
	};
}

/** The machine's stored override JSON, or null. */
export async function readMachineThresholds(env: Pick<Env, "DB">, userId: string, machineId: string): Promise<{ overrides: ThresholdPatch; state: GateState }> {
	const row = await env.DB.prepare("SELECT gate_thresholds, gate_state FROM machine_policies WHERE user_id = ?1 AND machine_id = ?2")
		.bind(userId, machineId)
		.first<{ gate_thresholds: string | null; gate_state: string | null }>()
		.catch(() => null);
	return { overrides: storedOverrides(row?.gate_thresholds ?? null), state: row ? parseGateState(row.gate_state) : DEFAULT_GATE_STATE };
}

/**
 * Apply a validated patch to a machine's override (creating its policy row if it has none) and return the new override.
 * Changing the thresholds also clears the gate state's streak is NOT needed: the next heartbeat judges the new lines against
 * the same state, and a rejecting machine that now sits inside them recovers through the normal streak.
 */
export async function setMachineThresholds(env: Pick<Env, "DB">, userId: string, machineId: string, patch: ThresholdPatch, now = Date.now()): Promise<ThresholdPatch> {
	const { overrides } = await readMachineThresholds(env, userId, machineId);
	const next = applyThresholdPatch(overrides, patch);
	const json = Object.keys(next).length ? JSON.stringify(next) : null;
	await env.DB.prepare(
		`INSERT INTO machine_policies (user_id, machine_id, auto_update, status, updated_at, gate_thresholds) VALUES (?1, ?2, 0, 'disabled', ?3, ?4)
		 ON CONFLICT(user_id, machine_id) DO UPDATE SET gate_thresholds = excluded.gate_thresholds, updated_at = excluded.updated_at`,
	)
		.bind(userId, machineId, now, json)
		.run();
	return next;
}

/** Remove every override on a machine: it goes back to the defaults and the session formula. */
export async function resetMachineThresholds(env: Pick<Env, "DB">, userId: string, machineId: string, now = Date.now()): Promise<void> {
	await env.DB.prepare("UPDATE machine_policies SET gate_thresholds = NULL, updated_at = ?3 WHERE user_id = ?1 AND machine_id = ?2").bind(userId, machineId, now).run();
}

/** The full read for a machine: thresholds in force + where each came from + the current verdict. */
export function thresholdsView(env: { RUNNER_GATE_DEFAULTS?: string }, overridesRaw: unknown, stateRaw: unknown, machine?: { cpus: number; memTotalBytes: number } | null) {
	const t = effectiveThresholds(env, overridesRaw, machine);
	const state = parseGateState(stateRaw);
	return {
		maxSessions: t.maxSessions,
		thresholds: t.effective,
		source: t.source,
		overrides: t.overrides,
		verdict: {
			gate: gateStateLabel(state),
			...(state.state === "rejecting" ? { metric: state.metric, value: state.value, threshold: state.threshold, since: state.since ? new Date(state.since).toISOString() : null, recoveryStreak: state.streak } : {}),
		},
		fields: Object.fromEntries(THRESHOLD_KEYS.map((k) => [k, THRESHOLD_FIELDS[k].doc])),
	};
}

/**
 * The gate as `coding_loop_status` shows it (#1275): the machine this instance last ran on, the limits in force there and
 * its verdict now — so "why is my queued run waiting" is answered next to the runs, not only on the fleet view. Null for an
 * instance with no registration yet, or on a runner too old to send a machine id (it has no machine-level policy to show).
 */
export async function instanceGateView(env: Pick<Env, "DB"> & { RUNNER_GATE_DEFAULTS?: string }, instanceId: string, userId: string) {
	const row = await env.DB.prepare("SELECT runner_node, machine_id, resources FROM instance_runtime_nodes WHERE instance_id = ?1 AND user_id = ?2 AND machine_id IS NOT NULL ORDER BY updated_at DESC LIMIT 1")
		.bind(instanceId, userId)
		.first<{ runner_node: string; machine_id: string; resources: string | null }>()
		.catch(() => null);
	if (!row) return null;
	const { overrides, state } = await readMachineThresholds(env, userId, row.machine_id);
	const sample = parseResourceSample(row.resources);
	return { node: row.runner_node, machineId: row.machine_id, ...thresholdsView(env, overrides, state, sample ? { cpus: sample.cpus, memTotalBytes: sample.memTotalBytes } : null) };
}
