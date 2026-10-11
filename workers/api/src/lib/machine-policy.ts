import { normalizeMachineId } from "./machine-identity.js";
import type { Env } from "../types.js";

export type AutoUpdateStatus = "disabled" | "enabled" | "checking" | "waiting_for_idle" | "installing" | "restarting" | "verified_success" | "offline" | "unsupported" | "failed";
const STATUSES = new Set<AutoUpdateStatus>(["disabled", "enabled", "checking", "waiting_for_idle", "installing", "restarting", "verified_success", "offline", "unsupported", "failed"]);

/** Why an enabled runner is not installing yet, normalized by the runner (#1020). Never raw session data. */
export type BlockerClass = "idle_wait" | "active_sessions" | "observation_failure" | "unknown";
const BLOCKERS = new Set<BlockerClass>(["idle_wait", "active_sessions", "observation_failure", "unknown"]);

/** One paired work observation the updater made: which request, whether it answered, and when. */
export interface UpdateObservation {
	success: boolean;
	sampledAt: string;
	source: "sessions" | "health" | "unknown";
	/** It ANSWERED but in a shape the guard cannot read (#1020): unreadable, which is not the same as failing to answer. */
	malformed?: true;
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

/** Only the three safe keys of each observation survive — nothing else from the runner is stored. */
function parseObservations<T extends string | number>(raw: unknown, stamp: (ms: number) => T): Array<{ success: boolean; sampledAt: T; source: UpdateObservation["source"]; malformed?: true }> {
	if (!Array.isArray(raw)) return [];
	return raw
		.flatMap((o) => {
			if (!o || typeof o !== "object") return [];
			const v = o as Record<string, unknown>;
			const at = epochMs(v.sampledAt ?? v.sampled_at, Number.MAX_SAFE_INTEGER);
			if (typeof v.success !== "boolean" || at === null) return [];
			const source: UpdateObservation["source"] = v.source === "sessions" || v.source === "health" ? v.source : "unknown";
			// Only a FAILED observation can be unreadable; the flag never rides on a success.
			return [{ success: v.success, sampledAt: stamp(at), source, ...(v.success === false && v.malformed === true ? { malformed: true as const } : {}) }];
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
		auto_update_diagnostics: {
			last_heartbeat_at: policy.lastHeartbeatAt,
			last_check_at: policy.lastCheckAt,
			last_decision_at: policy.lastDecisionAt,
			next_retry_due_at: policy.nextRetryDueAt,
			blocker_class: policy.blockerClass,
			observations: policy.observations.map((o) => ({ success: o.success, sampled_at: o.sampledAt, source: o.source, ...(o.malformed ? { malformed: true } : {}) })),
		},
	};
}

/** Absence is the backwards-compatible, rollout-safe default: OFF. */
export async function getMachinePolicy(env: Pick<Env, "DB">, userId: string, rawMachineId: string | null | undefined): Promise<MachinePolicy> {
	const machineId = normalizeMachineId(rawMachineId);
	if (!machineId) return present(null);
	const row = await env.DB.prepare(`SELECT auto_update, status, latest_version, last_attempt_at, last_error, last_heartbeat_at, last_check_at, last_decision_at,
		next_retry_due_at, blocker_class, observations FROM machine_policies WHERE user_id = ?1 AND machine_id = ?2`)
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

/** Runner observations are accepted only for a policy that already belongs to this owner/id. */
export async function reportMachinePolicyStatus(env: Pick<Env, "DB">, userId: string, rawMachineId: string | null | undefined, raw: unknown): Promise<void> {
	const machineId = normalizeMachineId(rawMachineId);
	if (!machineId || !raw || typeof raw !== "object") return;
	const value = raw as Record<string, unknown>;
	const rawStatus = typeof value.status === "string" ? value.status : typeof value.autoUpdateStatus === "string" ? value.autoUpdateStatus : null;
	const aliases: Record<string, AutoUpdateStatus> = { "waiting-for-idle": "waiting_for_idle", running: "installing", "verified-success": "verified_success", failure: "failed" };
	const status = rawStatus && STATUSES.has((aliases[rawStatus] ?? rawStatus) as AutoUpdateStatus) ? (aliases[rawStatus] ?? rawStatus) as AutoUpdateStatus : null;
	const now = Date.now();
	if (!status) {
		// Interrupted/partial telemetry still proves the runner reported — receipt only, nothing else changes.
		await env.DB.prepare("UPDATE machine_policies SET last_heartbeat_at = ?1 WHERE user_id = ?2 AND machine_id = ?3").bind(now, userId, machineId).run().catch(() => undefined);
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
	const errorCandidate = typeof value.error === "string" ? value.error : null;
	// A lifecycle record is evidence, not display text: never silently turn an arbitrary client
	// value into a plausible-but-incomplete version or error. Invalid telemetry is omitted.
	const latest = latestCandidate && latestCandidate.length <= 80 ? latestCandidate : null;
	const error = errorCandidate && errorCandidate.length <= 500 ? errorCandidate : null;
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
		last_heartbeat_at = ?4, updated_at = ?4 WHERE user_id = ?5 AND machine_id = ?6`)
		.bind(status, latest, error, now, userId, machineId, decisionAt, checkAt, nextRetry, blocker, observations, diagnostics ? 1 : 0)
		.run()
		.catch(() => undefined);
}
