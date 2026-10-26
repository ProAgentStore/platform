export type ActionsScope = { org: string } | { repo: string };

export interface ActionsRecoveryResponse {
	node: string;
	scope: ActionsScope;
	recovery: { id: string; state: "queued" | "deferred_active_job"; requestedAt: number };
}

export interface ActionsRunnerItem {
	dir: string;
	managed: boolean;
	name: string | null;
	url: string | null;
	serviceMode?: string;
	serviceState?: string;
	acRecoveryEnabled?: boolean;
	localHealth?: "current" | "stale" | "unknown";
	supervisor?: {
		health: string;
		updatedAt: number;
		acPower?: string;
		activeJob?: boolean;
		lastAcReturnAt?: number;
		lastRestartAt?: number;
		lastRestartReason?: string;
		lastReadyAt?: number;
		lastError?: string;
		lastRecovery?: { id: string; state: string; reason?: string; requestedAt: number; completedAt?: number; error?: string };
	} | null;
	supervisorNote?: string;
	ci?: { registered: boolean; online: boolean; busy: boolean; routable: boolean; labels: string[]; summary: string };
	ciNote?: string;
}

export interface ActionsRunnerStatus {
	node: string | null;
	machineHealth: "current" | "unknown";
	machineNote?: string;
	installed: ActionsRunnerItem[];
}

/** The API takes a scope, never a filesystem path supplied by a browser. */
export function actionsScope(url: string | null): ActionsScope | null {
	const match = /^https:\/\/github\.com\/([A-Za-z0-9-]+)(?:\/([A-Za-z0-9._-]+))?\/?$/.exec(url ?? "");
	if (!match) return null;
	return match[2] ? { repo: `${match[1]}/${match[2]}` } : { org: match[1] };
}

/** Only an identified PAGS supervisor with a fresh local sample can accept this control. */
export function canRequestActionsRecovery(item: ActionsRunnerItem): boolean {
	return item.managed && item.serviceMode === "macos_system" && item.localHealth === "current" && !!item.supervisor && !!actionsScope(item.url);
}

export function recoveryPending(item: ActionsRunnerItem): boolean {
	return ["queued", "deferred_active_job", "waiting_network", "restarting"].includes(item.supervisor?.lastRecovery?.state ?? "");
}
