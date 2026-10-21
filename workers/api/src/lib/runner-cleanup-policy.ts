// Runner post-run cleanup policy (#1265) — the ONE resolver of "what does this machine's cleanup do".
//
// Each machine has a mode (`gentle` | `harsh`) and six behaviours the console shows as checkboxes. The mode
// sets the checkboxes' DEFAULTS; a machine may override any one. This module turns (mode, overrides) into the
// resolved set of switches, validates what an owner sends, and shapes the runner's own report for storage
// and display. The runner (packages/browser-runner/src/coding/cleanup.ts) receives the RESOLVED policy on the
// heartbeat answer and only obeys — it has no resolution logic of its own, so the two cannot disagree.
//
// What the modes MEAN (gentle touches only what the runner can prove it started; harsh also sweeps orphaned
// build tooling and prunes caches) is the runner's business and is documented in
// platform-docs/runner-cleanup.md; this file only carries the switches.
import { HttpError } from "./auth.js";
import { clipMarked } from "./clip-marked.js";

/** The first CLI that carries the cleanup behaviours. An older runner ignores the policy it is sent and reports nothing. */
export const CLEANUP_MIN_CLI = "0.4.167";

export const CLEANUP_MODES = ["gentle", "harsh"] as const;
export type CleanupMode = (typeof CLEANUP_MODES)[number];

/** The six switches, in the order the console lists them. `label` is the checkbox text. */
export const CLEANUP_BEHAVIOURS = [
	{ key: "processGroupKill", label: "Kill the engine's whole process tree on end, timeout and abort" },
	{ key: "leftoverSweep", label: "Sweep leftover processes after a session" },
	{ key: "browserCleanup", label: "Clean up Playwright browsers it launched" },
	{ key: "tempCleanup", label: "Delete the run's temp folder and worktrees" },
	{ key: "loadWarning", label: "Warn when load is far above what sessions account for" },
	{ key: "cachePruning", label: "Prune package caches and build outputs when disk is over 90%" },
] as const;

export type CleanupBehaviourKey = (typeof CLEANUP_BEHAVIOURS)[number]["key"];
export type CleanupBehaviours = Record<CleanupBehaviourKey, boolean>;
export type CleanupOverrides = Partial<CleanupBehaviours>;

const KEYS = CLEANUP_BEHAVIOURS.map((b) => b.key) as readonly CleanupBehaviourKey[];

/** Gentle: everything on except cache pruning, which stays off (a warning is shown instead). Harsh: everything on. */
export function behaviourDefaults(mode: CleanupMode): CleanupBehaviours {
	return { processGroupKill: true, leftoverSweep: true, browserCleanup: true, tempCleanup: true, loadWarning: true, cachePruning: mode === "harsh" };
}

export interface CleanupConfig {
	mode: CleanupMode;
	overrides: CleanupOverrides;
}

export const DEFAULT_CLEANUP: CleanupConfig = { mode: "gentle", overrides: {} };

/** The switches in force: the mode's defaults with this machine's overrides on top. */
export function resolveBehaviours(config: CleanupConfig): CleanupBehaviours {
	return { ...behaviourDefaults(config.mode), ...config.overrides };
}

/** What the runner is sent on the heartbeat answer. */
export function runnerPolicy(config: CleanupConfig): { mode: CleanupMode; behaviours: CleanupBehaviours } {
	return { mode: config.mode, behaviours: resolveBehaviours(config) };
}

/** A stored mode, tolerant: anything unrecognised is the safe end. */
export function normalizeMode(raw: unknown): CleanupMode {
	return raw === "harsh" ? "harsh" : "gentle";
}

/** Stored overrides (JSON text or object) → known keys with boolean values only. */
export function parseOverrides(raw: unknown): CleanupOverrides {
	let v: unknown = raw;
	if (typeof raw === "string") {
		try {
			v = JSON.parse(raw);
		} catch {
			return {};
		}
	}
	if (!v || typeof v !== "object" || Array.isArray(v)) return {};
	const out: CleanupOverrides = {};
	for (const k of KEYS) if (typeof (v as Record<string, unknown>)[k] === "boolean") out[k] = (v as Record<string, boolean>)[k];
	return out;
}

/** An owner's request to change cleanup settings, validated. Throws HttpError(400) naming the bad field. */
export interface CleanupChange {
	mode?: CleanupMode;
	/** A key set to null removes that override (back to the mode's default). */
	overrides?: Record<string, boolean | null>;
	now?: true;
}

export function parseCleanupChange(body: Record<string, unknown>): CleanupChange | null {
	const nested = body.cleanup && typeof body.cleanup === "object" && !Array.isArray(body.cleanup) ? (body.cleanup as Record<string, unknown>) : {};
	const rawMode = body.cleanup_mode ?? body.cleanupMode ?? nested.mode;
	const rawOverrides = body.cleanup_overrides ?? body.cleanupOverrides ?? nested.overrides ?? nested.behaviours;
	const rawNow = body.cleanup_now ?? body.cleanupNow ?? nested.now;
	if (rawMode === undefined && rawOverrides === undefined && rawNow === undefined) return null;
	const change: CleanupChange = {};
	if (rawMode !== undefined) {
		if (rawMode !== "gentle" && rawMode !== "harsh") throw new HttpError(400, `cleanup_mode must be "gentle" or "harsh".`);
		change.mode = rawMode;
	}
	if (rawOverrides !== undefined) {
		if (!rawOverrides || typeof rawOverrides !== "object" || Array.isArray(rawOverrides)) throw new HttpError(400, "cleanup_overrides must be an object of behaviour: true | false | null.");
		const out: Record<string, boolean | null> = {};
		for (const [k, v] of Object.entries(rawOverrides as Record<string, unknown>)) {
			if (!KEYS.includes(k as CleanupBehaviourKey)) throw new HttpError(400, `Unknown cleanup behaviour "${clipMarked(k, 40, { within: true })}". Known: ${KEYS.join(", ")}.`);
			if (typeof v !== "boolean" && v !== null) throw new HttpError(400, `cleanup_overrides.${k} must be true, false or null (null returns it to the mode's default).`);
			out[k] = v;
		}
		change.overrides = out;
	}
	if (rawNow !== undefined) {
		if (rawNow !== true) throw new HttpError(400, "cleanup_now must be true (it asks the machine to run a cleanup pass now).");
		change.now = true;
	}
	return change;
}

/** The config after a change. A mode change clears the overrides (the master toggle resets the checkboxes) unless the same request sets some. */
export function applyChange(current: CleanupConfig, change: CleanupChange): CleanupConfig {
	const mode = change.mode ?? current.mode;
	let overrides: CleanupOverrides = change.mode !== undefined && change.mode !== current.mode ? {} : { ...current.overrides };
	if (change.overrides) {
		overrides = { ...overrides };
		for (const [k, v] of Object.entries(change.overrides)) {
			if (v === null) delete overrides[k as CleanupBehaviourKey];
			else overrides[k as CleanupBehaviourKey] = v;
		}
	}
	return { mode, overrides };
}

// ── The runner's report ─────────────────────────────────────────────────────────────────────

export interface CleanupReportView {
	mode: CleanupMode;
	orphanedProcesses: number;
	orphans: Array<{ pid: number; reason: string; sessionId: string | null; command: string }>;
	loadMismatch: boolean;
	unexplainedLoad: number;
	diskUsedPct: number | null;
	warnings: string[];
	lastPass: {
		at: string | null;
		reason: string;
		killedProcesses: number;
		orphansFound: number;
		browsersReaped: number;
		tempFoldersRemoved: number;
		worktreesRemoved: number;
		cachesPruned: number;
		buildOutputsRemoved: number;
		freedBytes: number | null;
	} | null;
}

const int = (v: unknown, max = 1_000_000): number => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(max, Math.round(v))) : 0);
/** A runner-reported string: control characters blanked, and cut WITH a marker when over its bound (never silently). */
const text = (v: unknown, max: number): string => (typeof v === "string" ? clipMarked(blankControls(v), max, { within: true }) : "");

/** Control characters (a terminal escape, a NUL) become spaces, by code point rather than a control-character regex. */
const blankControls = (s: string): string => [...s].map((c) => (c.charCodeAt(0) < 32 ? " " : c)).join("");

/** A short identifier-like value (a reason code, a session id) or null — validated, not clipped: a cut id names something else. */
const token = (v: unknown, max: number): string | null => (typeof v === "string" && v.length <= max && /^[A-Za-z0-9_.:-]+$/.test(v) ? v : null);

/** At most `max` mapped items of a list, by loop — a list cap that is read beside the count it caps. */
function capped<T>(raw: unknown, max: number, map: (v: unknown) => T): T[] {
	const out: T[] = [];
	if (!Array.isArray(raw)) return out;
	for (const item of raw) {
		if (out.length >= max) break;
		out.push(map(item));
	}
	return out;
}

/**
 * Keep only the safe, bounded fields of what a runner reports. Everything is clipped and typed; a command
 * line (which can hold a path or a flag value) is capped, and nothing the runner says is ever an instruction.
 */
export function sanitizeReport(raw: unknown): CleanupReportView | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;
	const pass = r.lastPass && typeof r.lastPass === "object" ? (r.lastPass as Record<string, unknown>) : null;
	return {
		mode: normalizeMode(r.mode),
		orphanedProcesses: int(r.orphanedProcesses),
		// At most ten, beside `orphanedProcesses`, which is the real count; an entry without a numeric pid is dropped.
		orphans: capped(r.orphans, 10, (o) => o).flatMap((o) => {
			const v = (o ?? {}) as Record<string, unknown>;
			return typeof v.pid === "number" ? [{ pid: int(v.pid, 99_999_999), reason: token(v.reason, 30) ?? "unknown", sessionId: token(v.sessionId, 80), command: text(v.command, 180) }] : [];
		}),
		loadMismatch: r.loadMismatch === true,
		unexplainedLoad: typeof r.unexplainedLoad === "number" && Number.isFinite(r.unexplainedLoad) ? Math.round(Math.min(100_000, Math.max(0, r.unexplainedLoad)) * 10) / 10 : 0,
		diskUsedPct: typeof r.diskUsedPct === "number" && Number.isFinite(r.diskUsedPct) ? Math.max(0, Math.min(100, r.diskUsedPct)) : null,
		warnings: capped(r.warnings, 5, (w) => text(w, 200)).filter(Boolean),
		lastPass: pass
			? {
					at: typeof pass.at === "string" ? text(pass.at, 40) : null,
					reason: text(pass.reason, 80),
					killedProcesses: int(pass.killedProcesses),
					orphansFound: int(pass.orphansFound),
					browsersReaped: int(pass.browsersReaped),
					tempFoldersRemoved: int(pass.tempFoldersRemoved),
					worktreesRemoved: int(pass.worktreesRemoved),
					cachesPruned: int(pass.cachesPruned),
					buildOutputsRemoved: int(pass.buildOutputsRemoved),
					freedBytes: typeof pass.freedBytes === "number" && Number.isFinite(pass.freedBytes) ? Math.max(0, Math.round(pass.freedBytes)) : null,
				}
			: null,
	};
}
