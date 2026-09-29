export type ApplyDefaultEngineSkipReason =
	| "already-default"
	| "explicit-instance-default"
	| "active-run"
	| "offline"
	| "busy"
	| "unreadable"
	| "stop-failed"
	| "start-failed";

export interface ApplyDefaultEngineItem {
	instanceId: string;
	repoId: string;
	sessionId: string;
	repoName: string;
	reason?: ApplyDefaultEngineSkipReason;
	runState?: string | null;
	from?: string | null;
	to?: string;
	newSessionId?: string;
}

export interface ApplyDefaultEngineResult {
	defaultEngineId: string;
	restarted: number;
	skipped: Record<ApplyDefaultEngineSkipReason, number>;
	items: ApplyDefaultEngineItem[];
}
