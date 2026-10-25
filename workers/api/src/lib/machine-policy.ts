import { clipMarked } from "./clip-marked.js";
import { logError } from "./error-log.js";
import { normalizeMachineId } from "./machine-identity.js";
import { applyChange, resolveBehaviours, type CleanupChange, type CleanupConfig, normalizeMode, parseOverrides, sanitizeReport, type CleanupReportView } from "./runner-cleanup-policy.js";
import type { Env } from "../types.js";

export type AutoUpdateStatus = "disabled" | "enabled" | "checking" | "waiting_for_idle" | "installing" | "restarting" | "verified_success" | "offline" | "unsupported" | "failed";
const STATUSES = new Set<AutoUpdateStatus>(["disabled", "enabled", "checking", "waiting_for_idle", "installing", "restarting", "verified_success", "offline", "unsupported", "failed"]);

/** Why an enabled runner is not installing yet, normalized by the runner (#1020). Never raw session data. */
export type BlockerClass = "idle_wait" | "active_sessions" | "observation_failure" | "fleet_stagger" | "unknown";
const BLOCKERS = new Set<BlockerClass>(["idle_wait", "active_sessions", "observation_failure", "fleet_stagger", "unknown"]);

/** The statuses of a machine that has begun an update and not verified it: what a fleet stagger waits on (#1141). */
const MID_UPDATE = ["installing", "restarting"] as const;
/** A machine silent this long after reporting an install is failed and flagged `auto_update_stuck` (#1141). */
export const UPDATE_SILENCE_MS = 5 * 60_000;
/** Only a machine heard from this recently holds the fleet's one update slot — a dead one must not block the rest forever. */
export const FLEET_SLOT_FRESH_MS = 10 * 60_000;
/** The `last_error` the silence sweep writes; the stuck verdict reads it back, and the machine's own next report replaces it. */
export const SILENT_UPDATE_ERROR = "No heartbeat within 5 minutes of installing an update";
/** The most of a runner's update log one report stores (#1151) — the CLI sends ≤4000; this bounds a hand-made body. */
const UPDATE_LOG_MAX_CHARS = 8000;

/** One paired work observation the updater made: which request, whether it answered, and when. */
export interface UpdateObservation {
	success: boolean;
	sampledAt: string;
	source: "sessions" | "health" | "unknown";
	/** It ANSWERED but in a shape the guard cannot read (#1020): unreadable, which is not the same as failing to answer. */
	malformed?: true;
	/** A readable `sessions` look: engines per lifecycle state, by the guard's own rule (#1020). Counts only. */
	sessionStates?: SessionStateCounts;
}

/** `active_turn` and `unknown` block an update; `idle_retained` and `stopped` do not. */
export interface SessionStateCounts {
	activeTurns: number;
	idleRetained: number;
	stopped: number;
	unknown: number;
}
const MAX_SESSIONS_COUNTED = 10_000;

/** Four whole counts, or nothing: a partial or nonsensical set is dropped rather than shown as a fact. */
function parseSessionStates(raw: unknown): SessionStateCounts | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const v = raw as Record<string, unknown>;
	const pick = (camel: string, snake: string) => {
		const n = v[camel] ?? v[snake];
		return typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= MAX_SESSIONS_COUNTED ? n : null;
	};
	const counts = { activeTurns: pick("activeTurns", "active_turns"), idleRetained: pick("idleRetained", "idle_retained"), stopped: pick("stopped", "stopped"), unknown: pick("unknown", "unknown") };
	return Object.values(counts).every((n) => n !== null) ? (counts as SessionStateCounts) : null;
}
const MAX_OBSERVATIONS = 5;

export interface MachinePolicy {
	autoUpdate: boolean;
	status: AutoUpdateStatus;
	latestVersion: string | null;
	/**
	 * The runner's last controller DECISION (#1020). A heartbeat alone no longer advances it; an older
	 * runner that reports no decision time advances it only when its reported status changes.
	 */
	lastAttemptAt: string | null;
	lastError: string | null;
	/** When the last status report ARRIVED — telemetry receipt, not evidence the updater ran. */
	lastHeartbeatAt: string | null;
	lastCheckAt: string | null;
	lastDecisionAt: string | null;
	/** When the controller's next timer is due. Overdue while heartbeats continue = a timer that is not running. */
	nextRetryDueAt: string | null;
	blockerClass: BlockerClass | null;
	observations: UpdateObservation[];
	/** The runner's own step-by-step update log, as its last restart uploaded it (#1151). */
	updateLog: string | null;
	/** Releases this machine rolled back from and will not install again until retried (#1150). */
	rollbacks: MachineRollback[];
	/** Whether an automatic update here can be rolled back: true under the bootstrap stub, false when it updates in place; null = not reported (#1147). */
	rollbackAvailable: boolean | null;
	/** Post-run cleanup (#1265): the mode and overrides the owner set, and what the runner last reported. */
	cleanup: MachineCleanup;
}

/** One release the machine's bootstrap stub gave up on: what it was, what it fell back to, why, and when (ISO, null if unknown). */
export interface MachineRollback {
	from: string;
	to: string | null;
	reason: string;
	at: string | null;
}

const ROLLBACKS_MAX = 10;
/** The runner's `rollbacks` report, kept only where it reads as one: bounded count and text, no stray fields. */
export function parseRollbacks(raw: unknown): MachineRollback[] | null {
	if (!Array.isArray(raw)) return null;
	const out: MachineRollback[] = [];
	for (const r of raw) {
		if (out.length >= ROLLBACKS_MAX) break;
		const v = r as Record<string, unknown> | null;
		if (!v || typeof v.from !== "string" || !v.from || v.from.length > 80 || typeof v.reason !== "string") continue;
		const at = typeof v.at === "number" && Number.isFinite(v.at) && v.at > 0 ? new Date(v.at).toISOString() : typeof v.at === "string" && !Number.isNaN(Date.parse(v.at)) ? new Date(v.at).toISOString() : null;
		out.push({ from: v.from, to: typeof v.to === "string" && v.to.length <= 80 ? v.to : null, reason: clipMarked(v.reason, 300, { what: "the reason" }), at });
	}
	return out;
}

export interface MachineCleanup extends CleanupConfig {
	/** The runner's last status, as it reported it (sanitized). Telemetry, never an instruction. */
	report: CleanupReportView | null;
	reportAt: string | null;
	/** An owner's "clean now": when it was asked for, and when the machine reported finishing it. */
	nowRequestedAt: number | null;
	nowDoneAt: number | null;
}

interface Row {
	auto_update: number;
	status: string;
	latest_version: string | null;
	last_attempt_at: number | null;
	last_error: string | null;
	last_heartbeat_at?: number | null;
	last_check_at?: number | null;
	last_decision_at?: number | null;
	next_retry_due_at?: number | null;
	blocker_class?: string | null;
	observations?: string | null;
	update_log?: string | null;
	rollbacks?: string | null;
	rollback_available?: number | null;
	cleanup_mode?: string | null;
	cleanup_overrides?: string | null;
	cleanup_report?: string | null;
	cleanup_report_at?: number | null;
	cleanup_now_requested_at?: number | null;
	cleanup_now_done_at?: number | null;
}
const iso = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString() : null);
const present = (row: Row | null, enabled = false): MachinePolicy => ({
	autoUpdate: row?.auto_update === 1 || enabled,
	status: row && STATUSES.has(row.status as AutoUpdateStatus) ? row.status as AutoUpdateStatus : enabled ? "enabled" : "disabled",
	latestVersion: row?.latest_version ?? null,
	lastAttemptAt: iso(row?.last_attempt_at),
	lastError: row?.last_error ?? null,
	lastHeartbeatAt: iso(row?.last_heartbeat_at),
	lastCheckAt: iso(row?.last_check_at),
	lastDecisionAt: iso(row?.last_decision_at),
	nextRetryDueAt: iso(row?.next_retry_due_at),
	blockerClass: row?.blocker_class && BLOCKERS.has(row.blocker_class as BlockerClass) ? (row.blocker_class as BlockerClass) : null,
	observations: parseObservations(row?.observations ? safeJson(row.observations) : null, (ms) => new Date(ms).toISOString()),
	updateLog: row?.update_log ?? null,
	rollbacks: parseRollbacks(row?.rollbacks ? safeJson(row.rollbacks) : null) ?? [],
	rollbackAvailable: row?.rollback_available === 1 ? true : row?.rollback_available === 0 ? false : null,
	cleanup: {
		mode: normalizeMode(row?.cleanup_mode),
		overrides: parseOverrides(row?.cleanup_overrides),
		report: row?.cleanup_report ? sanitizeReport(safeJson(row.cleanup_report)) : null,
		reportAt: iso(row?.cleanup_report_at),
		nowRequestedAt: row?.cleanup_now_requested_at ?? null,
		nowDoneAt: row?.cleanup_now_done_at ?? null,
	},
});

function safeJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/** A timestamp from the runner: epoch ms or ISO, not in the future beyond clock skew. Anything else is dropped. */
function epochMs(value: unknown, now: number): number | null {
	const ms = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : Number.NaN;
	if (!Number.isFinite(ms) || ms <= 0 || ms > now + 5 * 60_000) return null;
	return Math.round(ms);
}

/** Only the safe keys of each observation survive — nothing else from the runner is stored. */
function parseObservations<T extends string | number>(raw: unknown, stamp: (ms: number) => T): Array<{ success: boolean; sampledAt: T; source: UpdateObservation["source"]; malformed?: true; sessionStates?: SessionStateCounts }> {
	if (!Array.isArray(raw)) return [];
	return raw
		.flatMap((o) => {
			if (!o || typeof o !== "object") return [];
			const v = o as Record<string, unknown>;
			const at = epochMs(v.sampledAt ?? v.sampled_at, Number.MAX_SAFE_INTEGER);
			if (typeof v.success !== "boolean" || at === null) return [];
			const source: UpdateObservation["source"] = v.source === "sessions" || v.source === "health" ? v.source : "unknown";
			// Only a FAILED observation can be unreadable; the flag never rides on a success.
			// Session counts ride only on a readable sessions look — a failed one has nothing to count.
			const states = source === "sessions" && v.success === true ? parseSessionStates(v.sessionStates ?? v.session_states) : null;
			return [{ success: v.success, sampledAt: stamp(at), source, ...(v.success === false && v.malformed === true ? { malformed: true as const } : {}), ...(states ? { sessionStates: states } : {}) }];
		})
		.slice(-MAX_OBSERVATIONS);
}

/**
 * The policy as the machine-detail wire carries it (snake_case) — the existing five fields, unchanged,
 * plus the #1020 diagnostics. Shared by the detail read and the policy write so they cannot drift.
 */
export function machinePolicyWire(policy: MachinePolicy) {
	return {
		auto_update_policy: policy.autoUpdate,
		latest_version: policy.latestVersion,
		auto_update_status: policy.status,
		last_attempt_at: policy.lastAttemptAt,
		last_error: policy.lastError,
		update_log: policy.updateLog,
		rollbacks: policy.rollbacks,
		rollback_available: policy.rollbackAvailable,
		// #1265: the mode, the six resolved switches and any per-machine overrides, and the runner's own last report.
		cleanup: {
			mode: policy.cleanup.mode,
			behaviours: resolveBehaviours(policy.cleanup),
			overrides: policy.cleanup.overrides,
			report: policy.cleanup.report,
			report_at: policy.cleanup.reportAt,
			now_requested_at: policy.cleanup.nowRequestedAt ? new Date(policy.cleanup.nowRequestedAt).toISOString() : null,
			now_done_at: policy.cleanup.nowDoneAt ? new Date(policy.cleanup.nowDoneAt).toISOString() : null,
		},
		auto_update_diagnostics: {
			last_heartbeat_at: policy.lastHeartbeatAt,
			last_check_at: policy.lastCheckAt,
			last_decision_at: policy.lastDecisionAt,
			next_retry_due_at: policy.nextRetryDueAt,
			blocker_class: policy.blockerClass,
			observations: policy.observations.map((o) => ({
				success: o.success,
				sampled_at: o.sampledAt,
				source: o.source,
				...(o.malformed ? { malformed: true } : {}),
				...(o.sessionStates ? { session_states: { active_turns: o.sessionStates.activeTurns, idle_retained: o.sessionStates.idleRetained, stopped: o.sessionStates.stopped, unknown: o.sessionStates.unknown } } : {}),
			})),
		},
	};
}

/** Absence is the backwards-compatible, rollout-safe default: OFF. */
export async function getMachinePolicy(env: Pick<Env, "DB">, userId: string, rawMachineId: string | null | undefined): Promise<MachinePolicy> {
	const machineId = normalizeMachineId(rawMachineId);
	if (!machineId) return present(null);
	const row = await env.DB.prepare(`SELECT auto_update, status, latest_version, last_attempt_at, last_error, last_heartbeat_at, last_check_at, last_decision_at,
		next_retry_due_at, blocker_class, observations, update_log, rollbacks, rollback_available, cleanup_mode, cleanup_overrides, cleanup_report, cleanup_report_at,
		cleanup_now_requested_at, cleanup_now_done_at FROM machine_policies WHERE user_id = ?1 AND machine_id = ?2`)
		.bind(userId, machineId).first<Row>().catch(() => null);
	return present(row);
}

export async function setMachinePolicy(env: Pick<Env, "DB">, userId: string, rawMachineId: string, autoUpdate: boolean): Promise<MachinePolicy> {
	const machineId = normalizeMachineId(rawMachineId);
	if (!machineId) throw new Error("A stable machine id is required for machine settings.");
	const now = Date.now();
	await env.DB.prepare(`INSERT INTO machine_policies (user_id, machine_id, auto_update, status, updated_at)
		VALUES (?1, ?2, ?3, ?4, ?5)
		ON CONFLICT(user_id, machine_id) DO UPDATE SET auto_update = excluded.auto_update,
		status = CASE WHEN excluded.auto_update = 0 THEN 'disabled' WHEN machine_policies.status = 'disabled' THEN 'enabled' ELSE machine_policies.status END,
		updated_at = excluded.updated_at`)
		.bind(userId, machineId, autoUpdate ? 1 : 0, autoUpdate ? "enabled" : "disabled", now).run();
	return getMachinePolicy(env, userId, machineId);
}

/**
 * Set a machine's cleanup mode and/or per-behaviour overrides (#1265), and optionally ask it to run a pass now.
 * An upsert that never touches Auto-update: a machine with no policy row gets one with Auto-update OFF, which is
 * exactly what absence already meant. Durable, so it works while the runner is offline — the machine picks it
 * up on its next heartbeat.
 */
export async function setMachineCleanup(env: Pick<Env, "DB">, userId: string, rawMachineId: string, change: CleanupChange, now = Date.now()): Promise<MachinePolicy> {
	const machineId = normalizeMachineId(rawMachineId);
	if (!machineId) throw new Error("A stable machine id is required for machine settings.");
	const current = await getMachinePolicy(env, userId, machineId);
	const next = applyChange({ mode: current.cleanup.mode, overrides: current.cleanup.overrides }, change);
	await env.DB.prepare(`INSERT INTO machine_policies (user_id, machine_id, auto_update, status, updated_at, cleanup_mode, cleanup_overrides, cleanup_now_requested_at)
		VALUES (?1, ?2, 0, 'disabled', ?3, ?4, ?5, ?6)
		ON CONFLICT(user_id, machine_id) DO UPDATE SET cleanup_mode = excluded.cleanup_mode, cleanup_overrides = excluded.cleanup_overrides,
		cleanup_now_requested_at = COALESCE(?6, machine_policies.cleanup_now_requested_at), updated_at = excluded.updated_at`)
		.bind(userId, machineId, now, next.mode, JSON.stringify(next.overrides), change.now ? now : null).run();
	return getMachinePolicy(env, userId, machineId);
}

/** How long an unchanged runner report is trusted before it is written again — the heartbeat is every 30s. */
export const CLEANUP_REPORT_REFRESH_MS = 5 * 60_000;

/**
 * Store what the runner says about its own cleanup (#1265): the status it reports and, when a "clean now" has
 * finished, the request time it finished. Written only when the report changed or the stored one is stale, so a
 * 30-second heartbeat per agent does not become a D1 write per beat. A report is TELEMETRY: it is sanitized to
 * bounded fields and can never change the mode — only the owner can.
 */
export async function reportMachineCleanup(env: Pick<Env, "DB">, userId: string, rawMachineId: string | null | undefined, current: MachinePolicy, rawStatus: unknown, rawDoneAt: unknown, now = Date.now()): Promise<void> {
	const machineId = normalizeMachineId(rawMachineId);
	if (!machineId) return;
	const view = sanitizeReport(rawStatus);
	const doneAt = typeof rawDoneAt === "number" && Number.isFinite(rawDoneAt) && rawDoneAt > (current.cleanup.nowDoneAt ?? 0) && rawDoneAt <= now + 60_000 ? Math.round(rawDoneAt) : null;
	const changed = view !== null && JSON.stringify(view) !== JSON.stringify(current.cleanup.report);
	const stale = view !== null && (!current.cleanup.reportAt || now - Date.parse(current.cleanup.reportAt) >= CLEANUP_REPORT_REFRESH_MS);
	if (!changed && !stale && doneAt === null) return;
	await env.DB.prepare(`INSERT INTO machine_policies (user_id, machine_id, auto_update, status, updated_at, cleanup_report, cleanup_report_at, cleanup_now_done_at)
		VALUES (?1, ?2, 0, 'disabled', ?3, ?4, ?5, ?6)
		ON CONFLICT(user_id, machine_id) DO UPDATE SET cleanup_report = COALESCE(?4, machine_policies.cleanup_report),
		cleanup_report_at = CASE WHEN ?4 IS NOT NULL THEN ?5 ELSE machine_policies.cleanup_report_at END,
		cleanup_now_done_at = COALESCE(?6, machine_policies.cleanup_now_done_at)`)
		.bind(userId, machineId, now, view ? JSON.stringify(view) : null, view ? now : null, doneAt).run().catch(() => undefined);
}

/** The compact cleanup view a node in `list_runner_nodes` carries (#1265). */
export function cleanupNodeView(policy: MachinePolicy) {
	const c = policy.cleanup;
	return {
		mode: c.mode,
		behaviours: resolveBehaviours(c),
		orphaned_processes: c.report?.orphanedProcesses ?? null,
		warnings: c.report?.warnings ?? [],
		last_pass: c.report?.lastPass ?? null,
		reported_at: c.reportAt,
		now_pending: c.nowRequestedAt !== null && (c.nowDoneAt ?? 0) < c.nowRequestedAt,
	};
}

/** What the heartbeat answer tells the runner about cleanup: the resolved policy, and a pending "clean now". */
export function cleanupAnswer(policy: MachinePolicy) {
	const c = policy.cleanup;
	const pending = c.nowRequestedAt !== null && (c.nowDoneAt ?? 0) < c.nowRequestedAt;
	return { cleanupPolicy: { mode: c.mode, behaviours: resolveBehaviours(c) }, cleanupNow: pending ? { requestedAt: c.nowRequestedAt } : null };
}


/** Runner observations are accepted only for a policy that already belongs to this owner/id. */
export async function reportMachinePolicyStatus(env: Pick<Env, "DB">, userId: string, rawMachineId: string | null | undefined, raw: unknown): Promise<void> {
	const machineId = normalizeMachineId(rawMachineId);
	if (!machineId || !raw || typeof raw !== "object") return;
	const value = raw as Record<string, unknown>;
	const rawStatus = typeof value.status === "string" ? value.status : typeof value.autoUpdateStatus === "string" ? value.autoUpdateStatus : null;
	const aliases: Record<string, AutoUpdateStatus> = { "waiting-for-idle": "waiting_for_idle", running: "installing", "verified-success": "verified_success", failure: "failed" };
	const status = rawStatus && STATUSES.has((aliases[rawStatus] ?? rawStatus) as AutoUpdateStatus) ? (aliases[rawStatus] ?? rawStatus) as AutoUpdateStatus : null;
	const now = Date.now();
	// #1151: sent once per start, with its first report; absent on every other report, which then leaves it as it was.
	const updateLog = typeof value.updateLog === "string" && value.updateLog.trim() ? value.updateLog.slice(-UPDATE_LOG_MAX_CHARS) : null;
	if (!status) {
		// Interrupted/partial telemetry still proves the runner reported — receipt only, nothing else changes.
		await env.DB.prepare("UPDATE machine_policies SET last_heartbeat_at = ?1, update_log = COALESCE(?4, update_log) WHERE user_id = ?2 AND machine_id = ?3").bind(now, userId, machineId, updateLog).run().catch(() => undefined);
		return;
	}
	// The runner's OWN check/decision times (#1020). Absent on an older runner, and absent is not "now".
	const decisionAt = epochMs(value.decisionAt ?? value.decision_time ?? value.lastDecisionAt, now);
	const checkAt = epochMs(value.checkAt ?? value.check_time ?? value.lastCheckAt, now);
	const retryRaw = value.nextRetryDueAt ?? value.next_retry_due_at;
	const nextRetry = retryRaw === null ? null : epochMs(retryRaw, Number.MAX_SAFE_INTEGER);
	const blockerRaw = value.blockerClass ?? value.blocker_class;
	const blocker = typeof blockerRaw === "string" && BLOCKERS.has(blockerRaw as BlockerClass) ? blockerRaw : null;
	const diagnostics = decisionAt !== null || checkAt !== null || "blockerClass" in value || "observations" in value;
	const observations = Array.isArray(value.observations) ? JSON.stringify(parseObservations(value.observations, (ms) => ms)) : null;
	const latestCandidate = typeof value.latestVersion === "string" ? value.latestVersion : typeof value.latest_version === "string" ? value.latest_version : null;
	const rollbacks = parseRollbacks(value.rollbacks);
	// Only a boolean is an answer; anything else leaves what the machine last said.
	const rollbackAvailable = typeof value.rollbackAvailable === "boolean" ? (value.rollbackAvailable ? 1 : 0) : null;
	const errorCandidate = typeof value.error === "string" ? value.error : null;
	// A lifecycle record is evidence, not display text: never silently turn an arbitrary client
	// value into a plausible-but-incomplete version or error. Invalid telemetry is omitted.
	const latest = latestCandidate && latestCandidate.length <= 80 ? latestCandidate : null;
	const error = errorCandidate && errorCandidate.length <= 500 ? errorCandidate : null;
	// #1141: a failure the runner reports is an error-log row, once per distinct failure — a failed install, a rollback
	// — not one per heartbeat re-sending it. Read before the write so the transition is visible.
	const before = status === "failed"
		? await env.DB.prepare("SELECT status, last_error FROM machine_policies WHERE user_id = ?1 AND machine_id = ?2").bind(userId, machineId).first<{ status: string; last_error: string | null }>().catch(() => null)
		: null;
	// `last_attempt_at` is a DECISION, never a receipt (#1020): the runner's decision time when it sends
	// one; for an older runner that sends none, only a real status transition (an act of its controller)
	// — a heartbeat re-sending the same cached status no longer fabricates a new attempt.
	await env.DB.prepare(`UPDATE machine_policies SET status = ?1, latest_version = COALESCE(?2, latest_version), last_error = ?3,
		last_attempt_at = CASE WHEN ?7 IS NOT NULL THEN MAX(COALESCE(last_attempt_at, 0), ?7) WHEN status <> ?1 THEN ?4 ELSE last_attempt_at END,
		last_decision_at = CASE WHEN ?7 IS NOT NULL THEN MAX(COALESCE(last_decision_at, 0), ?7) ELSE last_decision_at END,
		last_check_at = CASE WHEN ?8 IS NOT NULL THEN MAX(COALESCE(last_check_at, 0), ?8) ELSE last_check_at END,
		next_retry_due_at = CASE WHEN ?12 = 1 THEN ?9 ELSE next_retry_due_at END,
		blocker_class = CASE WHEN ?12 = 1 THEN ?10 ELSE blocker_class END,
		observations = CASE WHEN ?11 IS NOT NULL THEN ?11 ELSE observations END,
		update_log = COALESCE(?13, update_log),
		rollbacks = CASE WHEN ?14 IS NOT NULL THEN ?14 ELSE rollbacks END,
		rollback_available = CASE WHEN ?15 IS NOT NULL THEN ?15 ELSE rollback_available END,
		last_heartbeat_at = ?4, updated_at = ?4 WHERE user_id = ?5 AND machine_id = ?6`)
		.bind(status, latest, error, now, userId, machineId, decisionAt, checkAt, nextRetry, blocker, observations, diagnostics ? 1 : 0, updateLog, rollbacks ? JSON.stringify(rollbacks) : null, rollbackAvailable)
		.run()
		.catch(() => undefined);
	if (before && (before.status !== "failed" || before.last_error !== error)) {
		await logError(env, { source: "runner-auto-update", level: "warn", message: error ?? "The runner reported a failed automatic update.", userId, context: { machineId, latestVersion: latest } }).catch(() => undefined);
	}
}

/**
 * How many OTHER machines of this owner are mid-update and still heard from (#1141) — sent back on every
 * registration and heartbeat, and an automatic install waits while it is above zero. While THIS machine is itself
 * mid-update only the machines that began before it count (attempt time, then machine id), so when two start
 * together exactly one goes ahead.
 */
export async function fleetUpdatingFor(env: Pick<Env, "DB">, userId: string, rawMachineId: string | null | undefined, now = Date.now()): Promise<number> {
	const machineId = normalizeMachineId(rawMachineId);
	if (!machineId) return 0;
	const rows = (await env.DB.prepare(
		`SELECT machine_id, status, COALESCE(last_attempt_at, 0) AS attempt FROM machine_policies
		  WHERE user_id = ?1 AND auto_update = 1 AND status IN ('installing', 'restarting') AND COALESCE(last_heartbeat_at, 0) >= ?2`,
	).bind(userId, now - FLEET_SLOT_FRESH_MS).all<{ machine_id: string; status: string; attempt: number }>().catch(() => ({ results: [] }))).results ?? [];
	const mine = rows.find((r) => r.machine_id === machineId);
	return rows.filter((r) => r.machine_id !== machineId && (!mine || r.attempt < mine.attempt || (r.attempt === mine.attempt && r.machine_id < machineId))).length;
}

/**
 * The machines that reported an install and then went silent (#1141): `installing`/`restarting` with no report for
 * {@link UPDATE_SILENCE_MS}. Each becomes `failed` with {@link SILENT_UPDATE_ERROR} — never `installing` forever — and
 * one error-log row. Run by the cron; the machine's own next report overwrites it.
 */
export async function failSilentUpdates(env: Pick<Env, "DB"> & Partial<Pick<Env, "OAUTH_KV" | "API_BUILD">>, now = Date.now()): Promise<number> {
	const stale = (await env.DB.prepare(
		`SELECT user_id, machine_id, status, latest_version, last_heartbeat_at FROM machine_policies
		  WHERE status IN ('installing', 'restarting') AND COALESCE(last_heartbeat_at, updated_at, 0) <= ?1 LIMIT 200`,
	).bind(now - UPDATE_SILENCE_MS).all<{ user_id: string; machine_id: string; status: string; latest_version: string | null; last_heartbeat_at: number | null }>()).results ?? [];
	let failed = 0;
	for (const row of stale) {
		const message = `${SILENT_UPDATE_ERROR}${row.latest_version ? ` (${row.latest_version})` : ""}: the machine reported "${row.status}" and then stopped reporting. If nothing restarts \`pags up\` there, it needs a restart at the machine — install a supervisor with \`pags up --install-service\` so the next one does not.`;
		// Guarded on the status it was read with: a report that arrived in between wins.
		const res = await env.DB.prepare(
			`UPDATE machine_policies SET status = 'failed', last_error = ?1, updated_at = ?2 WHERE user_id = ?3 AND machine_id = ?4 AND status = ?5 AND COALESCE(last_heartbeat_at, 0) = COALESCE(?6, 0)`,
		).bind(message, now, row.user_id, row.machine_id, row.status, row.last_heartbeat_at).run();
		if (!res.meta?.changes) continue;
		failed++;
		await logError(env, { source: "runner-auto-update", level: "error", message, userId: row.user_id, context: { machineId: row.machine_id, status: row.status, latestVersion: row.latest_version } }).catch(() => undefined);
	}
	return failed;
}

/** Whether this policy is the silence sweep's verdict, or the state it is about to sweep (#1141). */
export function silentAfterInstall(policy: Pick<MachinePolicy, "status" | "lastError" | "lastHeartbeatAt">, now = Date.now()): boolean {
	if (policy.status === "failed") return (policy.lastError ?? "").startsWith(SILENT_UPDATE_ERROR);
	if (!(MID_UPDATE as readonly string[]).includes(policy.status)) return false;
	const heard = policy.lastHeartbeatAt ? Date.parse(policy.lastHeartbeatAt) : 0;
	return now - heard >= UPDATE_SILENCE_MS;
}
