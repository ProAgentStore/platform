/**
 * A machine's admission thresholds, as the machine page shows and edits them (#1275).
 *
 * The API is authoritative: it merges the defaults, the deploy's overrides and this machine's own into `thresholds`
 * and says where each came from in `source`. This module only decides how a field is labelled and shown, and turns
 * what the owner typed into the PARTIAL body the API takes (a number sets, null clears, a field left out stays).
 */

export type ThresholdKey =
	| "maxSessions"
	| "cpuLoad1PerCpu"
	| "cpuLoad5PerCpu"
	| "memUsedPctMax"
	| "memAvailableMinBytes"
	| "diskUsedPctMax"
	| "diskFreeMinBytes"
	| "recoveryBand"
	| "recoveryStreak";

export interface ThresholdRow {
	key: ThresholdKey;
	label: string;
	hint: string;
	/** What the owner types in: bytes are entered in GiB. */
	unit: "sessions" | "load/core" | "%" | "GiB" | "fraction" | "samples";
	integer: boolean;
	min: number;
	max: number;
}

/** The fields, in the order the page shows them. Ranges mirror the server's THRESHOLD_FIELDS. */
export const THRESHOLD_ROWS: readonly ThresholdRow[] = [
	{ key: "maxSessions", label: "Max sessions", hint: "Reject a new session once this many are running on the machine — coding, browser and application runs together. Replaces the cores/memory formula.", unit: "sessions", integer: true, min: 1, max: 64 },
	{ key: "cpuLoad1PerCpu", label: "CPU, 1-minute load", hint: "Reject when the 1-minute load per core exceeds this.", unit: "load/core", integer: false, min: 0.1, max: 64 },
	{ key: "cpuLoad5PerCpu", label: "CPU, 5-minute load", hint: "Reject when the 5-minute load per core exceeds this — a spike alone does not trip it.", unit: "load/core", integer: false, min: 0.1, max: 64 },
	{ key: "memUsedPctMax", label: "Memory in use", hint: "Reject above this percent. Not judged on macOS until the runner reports available memory.", unit: "%", integer: false, min: 1, max: 100 },
	{ key: "memAvailableMinBytes", label: "Memory available, at least", hint: "Reject when available memory falls under this. 0 never rejects on it.", unit: "GiB", integer: false, min: 0, max: 2 ** 20 },
	{ key: "diskUsedPctMax", label: "Disk in use", hint: "Reject when the checkout volume is over this percent full.", unit: "%", integer: false, min: 1, max: 100 },
	{ key: "diskFreeMinBytes", label: "Disk free, at least", hint: "Reject when the checkout volume has less than this free. 0 never rejects on it.", unit: "GiB", integer: false, min: 0, max: 2 ** 20 },
	{ key: "recoveryBand", label: "Recovery band", hint: "The gate reopens only when every metric is under this fraction of its line (0.9 = 10% under).", unit: "fraction", integer: false, min: 0.5, max: 0.99 },
	{ key: "recoveryStreak", label: "Recovery streak", hint: "Consecutive clear samples (one per ~30 seconds) before a rejecting machine is accepting again.", unit: "samples", integer: true, min: 1, max: 20 },
];

const GIB = 1024 ** 3;
const BYTE_KEYS = new Set<ThresholdKey>(["memAvailableMinBytes", "diskFreeMinBytes"]);

export type ThresholdSource = "machine" | "default" | "formula";

export interface MachineThresholds {
	machineId: string;
	maxSessions: { value: number | null; source: ThresholdSource; formula: number | null };
	thresholds: Record<ThresholdKey, number>;
	source: Record<ThresholdKey, "machine" | "default">;
	overrides: Partial<Record<ThresholdKey, number>>;
	verdict: { gate: string; metric?: string; value?: number; threshold?: number; since?: string | null; recoveryStreak?: number };
}

/** The value shown in an input: bytes as GiB, the rest as they are. */
export function displayValue(key: ThresholdKey, value: number): string {
	const v = BYTE_KEYS.has(key) ? value / GIB : value;
	return String(Math.round(v * 1000) / 1000);
}

export interface ThresholdField {
	row: ThresholdRow;
	/** What the input holds now. */
	value: string;
	/** This machine sets it (rather than the default / the formula). */
	overridden: boolean;
	/** For maxSessions: what the cores/memory formula would give. */
	note: string | null;
}

/** One field per row, filled from the machine's effective thresholds. */
export function thresholdFields(t: MachineThresholds | null): ThresholdField[] {
	return THRESHOLD_ROWS.map((row) => {
		const effective = row.key === "maxSessions" ? t?.maxSessions.value : t?.thresholds[row.key];
		return {
			row,
			value: effective === null || effective === undefined ? "" : displayValue(row.key, effective),
			overridden: t ? row.key in t.overrides : false,
			note: row.key === "maxSessions" && t ? (t.maxSessions.source === "formula" ? `the cores/memory formula gives ${t.maxSessions.formula ?? "?"}` : t.maxSessions.formula !== null ? `the formula would give ${t.maxSessions.formula}` : null) : null,
		};
	});
}

/** Why an input is not acceptable, or null. */
export function fieldProblem(row: ThresholdRow, text: string): string | null {
	const s = text.trim();
	if (!s) return null;
	const n = Number(s);
	if (!Number.isFinite(n)) return `${row.label} must be a number.`;
	if (row.integer && !Number.isInteger(n)) return `${row.label} must be a whole number.`;
	if (n < row.min || n > row.max) return `${row.label} must be from ${row.min} to ${row.max} ${row.unit}.`;
	return null;
}

/**
 * The partial body for the PUT: only the fields whose text differs from what the machine shows now. An emptied
 * input on a field the machine overrides sends null (back to the default); an emptied input on one it does not
 * override is left alone.
 */
export function thresholdsBody(t: MachineThresholds | null, edited: Partial<Record<ThresholdKey, string>>): Record<string, number | null> {
	const current = new Map(thresholdFields(t).map((f) => [f.row.key, f]));
	const body: Record<string, number | null> = {};
	for (const [key, text] of Object.entries(edited) as Array<[ThresholdKey, string]>) {
		const field = current.get(key);
		if (!field || text.trim() === field.value) continue;
		if (fieldProblem(field.row, text)) continue;
		if (!text.trim()) {
			if (field.overridden) body[key] = null;
			continue;
		}
		const n = Number(text);
		body[key] = BYTE_KEYS.has(key) ? Math.round(n * GIB) : n;
	}
	return body;
}

/** The verdict as a short sentence the card shows beside the title. */
export function verdictLine(t: MachineThresholds | null): string {
	if (!t) return "";
	const v = t.verdict;
	if (v.gate === "accepting") return "Accepting new sessions";
	return `Refusing new sessions — ${v.metric ?? v.gate.replace("rejecting:", "")} over its line${v.recoveryStreak ? `, ${v.recoveryStreak} clear sample${v.recoveryStreak === 1 ? "" : "s"} so far` : ""}`;
}
