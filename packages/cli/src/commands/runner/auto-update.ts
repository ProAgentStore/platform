/**
 * The runner-side half of the account policy for unattended CLI updates.
 *
 * The platform remains the authority for the switch.  This tiny local cache is deliberately
 * machine-local: it lets an already-enabled runner keep its conservative schedule through a
 * brief outage, and gives the next registration something useful to report.  A successful
 * registration or heartbeat always replaces it, so an owner disabling the policy while the
 * machine is offline wins before any later install can begin.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { configDir } from "../../runner-lock.js";

export type AutoUpdateStatus =
	| "enabled"
	| "checking"
	| "waiting-for-idle"
	| "running"
	| "restarting"
	| "verified-success"
	| "offline"
	| "unsupported"
	| "failure";

/** The public CLI spelling is readable; the D1 status enum is deliberately snake_case. */
export function autoUpdateStatusWire(status: AutoUpdateStatus | undefined): string | undefined {
	if (!status) return undefined;
	return ({
		"waiting-for-idle": "waiting_for_idle",
		running: "installing",
		"verified-success": "verified_success",
		failure: "failed",
	} as Partial<Record<AutoUpdateStatus, string>>)[status] ?? status;
}

export interface AutoUpdatePolicy {
	autoUpdate: boolean;
	status?: AutoUpdateStatus;
	latestVersion?: string;
	lastAttemptAt?: string;
	reason?: string;
}

interface PersistedPolicies {
	v: 1;
	policies: Record<string, AutoUpdatePolicy>;
}

const statuses = new Set<AutoUpdateStatus>([
	"enabled", "checking", "waiting-for-idle", "running", "restarting",
	"verified-success", "offline", "unsupported", "failure",
]);

function parseStatus(value: unknown): AutoUpdateStatus | undefined {
	if (typeof value !== "string") return undefined;
	const readable = ({
		waiting_for_idle: "waiting-for-idle",
		installing: "running",
		verified_success: "verified-success",
		failed: "failure",
	} as Record<string, AutoUpdateStatus | undefined>)[value] ?? value;
	return statuses.has(readable as AutoUpdateStatus) ? readable as AutoUpdateStatus : undefined;
}

/** A policy is owner-scoped on the service, so its local cache must not bleed between accounts. */
export function autoUpdatePolicyKey(machineId: string, env: NodeJS.ProcessEnv = process.env): string {
	return `${env.PAGS_LOCK_ACCOUNT?.trim() || "default"}:${machineId.trim() || "unidentified"}`;
}

export function autoUpdatePolicyPath(env: NodeJS.ProcessEnv = process.env): string {
	return env.PAGS_AUTO_UPDATE_POLICY_FILE?.trim() || join(configDir(env), "auto-update.json");
}

/** Accept both the JSON casing used by the CLI and API's snake_case wire fields. */
export function parseAutoUpdatePolicy(value: unknown): AutoUpdatePolicy | null {
	if (!value || typeof value !== "object") return null;
	const raw = value as Record<string, unknown>;
	const autoUpdate = raw.autoUpdate ?? raw.auto_update;
	if (typeof autoUpdate !== "boolean") return null;
	const status = parseStatus(raw.status ?? raw.autoUpdateStatus ?? raw.auto_update_status);
	const latestVersion = raw.latestVersion ?? raw.latest_version;
	const lastAttemptAt = raw.lastAttemptAt ?? raw.last_attempt_at;
	const reason = raw.reason;
	return {
		autoUpdate,
		...(status ? { status } : {}),
		...(typeof latestVersion === "string" ? { latestVersion } : {}),
		...(typeof lastAttemptAt === "string" ? { lastAttemptAt } : {}),
		...(typeof reason === "string" ? { reason } : {}),
	};
}

/** Pull a policy from either a direct response field or the API's `{ machine: … }` wrapper. */
export function policyFromResponse(value: unknown): AutoUpdatePolicy | null {
	if (!value || typeof value !== "object") return null;
	const raw = value as Record<string, unknown>;
	const direct = raw.autoUpdatePolicy ?? raw.auto_update_policy ?? raw.policy;
	if (typeof direct === "boolean") {
		return parseAutoUpdatePolicy({
			autoUpdate: direct,
			status: raw.autoUpdateStatus ?? raw.auto_update_status,
			latestVersion: raw.latestVersion ?? raw.latest_version,
			lastAttemptAt: raw.lastAttemptAt ?? raw.last_attempt_at,
			reason: raw.reason,
		});
	}
	return parseAutoUpdatePolicy(direct)
		?? parseAutoUpdatePolicy(raw.machine && typeof raw.machine === "object"
			? (raw.machine as Record<string, unknown>).autoUpdatePolicy ?? (raw.machine as Record<string, unknown>).auto_update_policy
			: undefined);
}

export function loadAutoUpdatePolicy(key: string, env: NodeJS.ProcessEnv = process.env): AutoUpdatePolicy | null {
	try {
		const data = JSON.parse(readFileSync(autoUpdatePolicyPath(env), "utf8")) as PersistedPolicies;
		if (data.v !== 1 || !data.policies || typeof data.policies !== "object") return null;
		return parseAutoUpdatePolicy(data.policies[key]);
	} catch {
		return null;
	}
}

/** Atomic rewrite; a cache failure never blocks a runner or turns a policy on by guesswork. */
export function saveAutoUpdatePolicy(key: string, policy: AutoUpdatePolicy, env: NodeJS.ProcessEnv = process.env): boolean {
	const path = autoUpdatePolicyPath(env);
	try {
		let old: PersistedPolicies = { v: 1, policies: {} };
		if (existsSync(path)) {
			const parsed = JSON.parse(readFileSync(path, "utf8")) as PersistedPolicies;
			if (parsed.v === 1 && parsed.policies && typeof parsed.policies === "object") old = parsed;
		}
		mkdirSync(dirname(path), { recursive: true });
		const next: PersistedPolicies = { v: 1, policies: { ...old.policies, [key]: policy } };
		const temp = `${path}.${process.pid}.tmp`;
		writeFileSync(temp, JSON.stringify(next, null, 2), { mode: 0o600 });
		renameSync(temp, path);
		return true;
	} catch {
		return false;
	}
}

/**
 * Jittered, bounded retry delay. A registry outage never turns into one npm subprocess per
 * heartbeat, while a successful check returns to a few checks per day.
 */
export function nextAutoUpdateDelayMs(failures: number, random: () => number = Math.random): number {
	const base = failures > 0
		? Math.min(60 * 60_000, 60_000 * 2 ** Math.min(failures - 1, 6))
		: 6 * 60 * 60_000;
	const jitter = 0.85 + Math.max(0, Math.min(1, random())) * 0.3;
	return Math.round(base * jitter);
}

/**
 * A policy response arrives every heartbeat.  It must not continually move an already due
 * automatic check into the future; only first authoritative confirmation and a real enable/disable
 * transition affect the timer.  Kept pure so the relay's timer policy has a clock-driven test.
 */
export function policyScheduleAction(previous: AutoUpdatePolicy, next: AutoUpdatePolicy, wasAuthoritative: boolean): "start" | "cancel" | "keep" {
	if (!next.autoUpdate) return "cancel";
	if (!wasAuthoritative || !previous.autoUpdate) return "start";
	return "keep";
}

/** The final unattended admission gate: unknown work is unsafe, never idle. */
export function mayAutomaticallyRestart(input: { authoritative: boolean; enabled: boolean; workObserved: boolean; busy: readonly string[] }): boolean {
	return input.authoritative && input.enabled && input.workObserved && input.busy.length === 0;
}
