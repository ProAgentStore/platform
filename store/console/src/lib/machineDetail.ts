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
