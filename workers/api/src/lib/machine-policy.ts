import { normalizeMachineId } from "./machine-identity.js";
import type { Env } from "../types.js";

export type AutoUpdateStatus = "disabled" | "enabled" | "checking" | "waiting_for_idle" | "installing" | "restarting" | "verified_success" | "offline" | "unsupported" | "failed";
const STATUSES = new Set<AutoUpdateStatus>(["disabled", "enabled", "checking", "waiting_for_idle", "installing", "restarting", "verified_success", "offline", "unsupported", "failed"]);

export interface MachinePolicy {
	autoUpdate: boolean;
	status: AutoUpdateStatus;
	latestVersion: string | null;
	lastAttemptAt: string | null;
	lastError: string | null;
}

interface Row { auto_update: number; status: string; latest_version: string | null; last_attempt_at: number | null; last_error: string | null }
const present = (row: Row | null, enabled = false): MachinePolicy => ({
	autoUpdate: row?.auto_update === 1 || enabled,
	status: row && STATUSES.has(row.status as AutoUpdateStatus) ? row.status as AutoUpdateStatus : enabled ? "enabled" : "disabled",
	latestVersion: row?.latest_version ?? null,
	lastAttemptAt: row?.last_attempt_at ? new Date(row.last_attempt_at).toISOString() : null,
	lastError: row?.last_error ?? null,
});

/** Absence is the backwards-compatible, rollout-safe default: OFF. */
export async function getMachinePolicy(env: Pick<Env, "DB">, userId: string, rawMachineId: string | null | undefined): Promise<MachinePolicy> {
	const machineId = normalizeMachineId(rawMachineId);
	if (!machineId) return present(null);
	const row = await env.DB.prepare("SELECT auto_update, status, latest_version, last_attempt_at, last_error FROM machine_policies WHERE user_id = ?1 AND machine_id = ?2")
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
	if (!status) return;
	const latestCandidate = typeof value.latestVersion === "string" ? value.latestVersion : typeof value.latest_version === "string" ? value.latest_version : null;
	const errorCandidate = typeof value.error === "string" ? value.error : null;
	// A lifecycle record is evidence, not display text: never silently turn an arbitrary client
	// value into a plausible-but-incomplete version or error. Invalid telemetry is omitted.
	const latest = latestCandidate && latestCandidate.length <= 80 ? latestCandidate : null;
	const error = errorCandidate && errorCandidate.length <= 500 ? errorCandidate : null;
	await env.DB.prepare(`UPDATE machine_policies SET status = ?1, latest_version = COALESCE(?2, latest_version), last_error = ?3,
		last_attempt_at = ?4, updated_at = ?4 WHERE user_id = ?5 AND machine_id = ?6`)
		.bind(status, latest, error, Date.now(), userId, machineId).run().catch(() => undefined);
}
