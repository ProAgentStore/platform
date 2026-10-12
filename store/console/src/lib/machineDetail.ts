/**
 * The terminal-detail endpoint is intentionally allowed to return either its machine directly
 * or in a `{ machine }` envelope. The latter leaves room for response metadata; accepting both
 * lets the console stay compatible while an older API deployment drains during a release.
 */
export interface AutoUpdateStatus {
	state?: string | null;
	detail?: string | null;
	reason?: string | null;
	lastAttemptAt?: string | null;
	last_attempt_at?: string | null;
	updatedAt?: string | null;
	updated_at?: string | null;
}

export interface MachineDetail {
	machineId: string;
	node?: string | null;
	aka?: string[] | null;
	placement?: string | null;
	connected?: boolean;
	runnerVersion?: string | null;
	latest_version?: string | null;
	latestVersion?: string | null;
	last_attempt_at?: string | null;
	lastAttemptAt?: string | null;
	last_error?: string | null;
	lastError?: string | null;
	lastSeenAt?: string | null;
	auto_update_policy?: boolean;
	autoUpdatePolicy?: boolean;
	auto_update_status?: AutoUpdateStatus | string | null;
	autoUpdateStatus?: AutoUpdateStatus | string | null;
	auto_update_diagnostics?: AutoUpdateDiagnostics | null;
	auto_update_stuck?: AutoUpdateStuck | null;
}

/**
 * Auto-update is ON but not happening (#1034): the platform compared this connected machine's CLI, and
 * the release its own check last saw, with the registry. The runner's status can still read
 * `waiting_for_idle`; this overrides it. Absent on an older API, null when not stuck.
 */
export interface AutoUpdateStuck {
	reason: "behind_published" | "stale_latest" | "cannot_fetch_update" | string;
	behind_since: string;
	published_version: string;
	releases_behind: number;
	/** `manual_npm_install` (#1054): only an install at the machine helps — Update CLI is not offered. */
	remedy: "runner_update" | "manual_npm_install" | string;
	detail: string;
}

/** One paired work observation the runner's update guard made (#1020). `malformed`: it answered, unreadably. */
export interface UpdateObservation {
	success: boolean;
	sampled_at: string;
	source: string;
	malformed?: boolean;
	/** A readable `sessions` look, by lifecycle state (#1020). `active_turns` and `unknown` block an update. */
	session_states?: { active_turns: number; idle_retained: number; stopped: number; unknown: number } | null;
}

/**
 * What the automatic updater last did, and when — read-only (#1020). Receipt time (`last_heartbeat_at`) is
 * deliberately separate from the runner's own check and decision times: a heartbeat is not an attempt.
 */
export interface AutoUpdateDiagnostics {
	last_heartbeat_at?: string | null;
	last_check_at?: string | null;
	last_decision_at?: string | null;
	next_retry_due_at?: string | null;
	blocker_class?: string | null;
	observations?: UpdateObservation[] | null;
}

/** The first CLI release containing the runner-side automatic-update controller. */
export const AUTO_UPDATE_CONTROLLER_MIN_CLI = "0.4.92";

export type MachineDetailResponse = MachineDetail | { machine: MachineDetail };

export function machineFromResponse(response: MachineDetailResponse): MachineDetail {
	return "machine" in response ? response.machine : response;
}

export function machineAutoUpdateEnabled(machine: MachineDetail): boolean {
	return machine.auto_update_policy === true || machine.autoUpdatePolicy === true;
}

export function machineLatestVersion(machine: MachineDetail): string | null {
	return machine.latest_version ?? machine.latestVersion ?? null;
}

/**
 * A policy can be stored for any identified machine. It becomes executable only after this CLI
 * release; do not let a visible toggle imply that an already-running older CLI will bootstrap
 * itself. This intentionally accepts normal semver prerelease/build suffixes but treats an absent
 * or malformed version as unsupported until the runner reports a known release.
 */
export function machineCanRunAutomaticUpdates(machine: MachineDetail): boolean {
	const match = machine.runnerVersion?.trim().replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
	if (!match) return false;
	const current = match.slice(1, 4).map(Number);
	const required = AUTO_UPDATE_CONTROLLER_MIN_CLI.split(".").map(Number);
	for (let index = 0; index < required.length; index += 1) {
		if (current[index] !== required[index]) return current[index] > required[index];
	}
	return true;
}

export function machineAutoUpdateStatus(machine: MachineDetail): AutoUpdateStatus {
	const status = machine.auto_update_status ?? machine.autoUpdateStatus;
	return typeof status === "string" ? { state: status } : status ?? {};
}

/** Statuses that can advance remotely and deserve the active polling cadence. */
export function machineAutoUpdateIsBusy(machine: MachineDetail | null): boolean {
	if (!machine) return true;
	const state = machineAutoUpdateStatus(machine).state;
	return !machine.connected || state === "checking" || state === "waiting-for-idle" || state === "waiting_for_idle" || state === "running" || state === "installing" || state === "restarting";
}

export function machineStatusLabel(status: AutoUpdateStatus): string {
	if (status.detail) return status.detail;
	if (status.reason) return status.reason;
	const state = status.state;
	if (!state) return "No automatic update has run yet.";
	return state.replace(/[-_]/g, " ");
}

export function machineLastAttempt(machine: MachineDetail): string | null {
	const status = machineAutoUpdateStatus(machine);
	return machine.lastAttemptAt ?? machine.last_attempt_at ?? status.lastAttemptAt ?? status.last_attempt_at ?? status.updatedAt ?? status.updated_at ?? null;
}

export function machineStatusDetail(machine: MachineDetail): string {
	return machine.lastError ?? machine.last_error ?? machineStatusLabel(machineAutoUpdateStatus(machine));
}

/** Absent on an older API: the diagnostics card is then not shown at all, rather than shown empty. */
export function machineUpdateDiagnostics(machine: MachineDetail): AutoUpdateDiagnostics | null {
	return machine.auto_update_diagnostics ?? null;
}

const BLOCKERS: Record<string, string> = {
	active_sessions: "A coding session on this machine is not proven idle, so it waits rather than interrupt it.",
	observation_failure: "It could not read whether this machine is busy, so it waits (it never assumes idle).",
	idle_wait: "It found the machine idle, but the final safety check before installing refused; it will check again.",
	unknown: "It is waiting, but did not report why.",
};

/** The blocker in plain words. Null when nothing is blocking; an unrecognised class is shown as reported. */
export function machineBlockerLabel(blocker: string | null | undefined): string | null {
	if (!blocker) return null;
	return BLOCKERS[blocker] ?? blocker.replace(/_/g, " ");
}

/** How long heartbeats may run past a due retry before it reads as a timer that is not running. */
export const RETRY_OVERDUE_GRACE_MS = 60_000;

/**
 * The retry was due, and the runner has kept reporting well after it without a new decision: its timer is not
 * running. A runner that has gone quiet is not "overdue" — no heartbeat after the due time says nothing either way.
 */
export function machineRetryOverdue(d: AutoUpdateDiagnostics | null): boolean {
	const due = d?.next_retry_due_at ? Date.parse(d.next_retry_due_at) : Number.NaN;
	const heard = d?.last_heartbeat_at ? Date.parse(d.last_heartbeat_at) : Number.NaN;
	const decided = d?.last_decision_at ? Date.parse(d.last_decision_at) : Number.NaN;
	if (!Number.isFinite(due) || !Number.isFinite(heard)) return false;
	if (Number.isFinite(decided) && decided >= due) return false;
	return heard - due > RETRY_OVERDUE_GRACE_MS;
}

/**
 * The engines a sessions look saw, in words (#1020): what blocks an update (active turns, unknown) is named
 * first, and idle retained engines are counted apart from them. Null when the look carried no counts.
 */
export function machineSessionStatesLine(o: UpdateObservation): string | null {
	const c = o.session_states;
	if (!c) return null;
	return [`${c.active_turns} active ${c.active_turns === 1 ? "turn" : "turns"}`, `${c.unknown} unknown`, `${c.idle_retained} idle retained`, `${c.stopped} stopped`].join(" · ");
}

/** One observation's outcome: an unreadable answer is not the same as no answer. */
export function machineObservationOutcome(o: UpdateObservation): "ok" | "failed" | "unreadable" {
	return o.success ? "ok" : o.malformed ? "unreadable" : "failed";
}
