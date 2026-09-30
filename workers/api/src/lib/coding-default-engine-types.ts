export type ApplyDefaultEngineSkipReason =
	| "already-default"
	| "explicit-instance-default"
	| "active-run"
	| "offline"
	| "busy"
	| "unreadable"
	| "stop-failed"
	| "start-failed"
	/** A queued objective is waiting on this repo; its run will start on the new default anyway. */
	| "queued-objective"
	/** The machine definitely cannot run the default engine: not installed, or not signed in. */
	| "engine-unavailable"
	/** The machine's CLI is too old to confirm it can run the default engine. */
	| "runner-outdated";

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
	/** The sentence to relay for a skip that needs the owner to act (engine-unavailable, runner-outdated). */
	detail?: string;
}

export interface ApplyDefaultEngineResult {
	defaultEngineId: string;
	restarted: number;
	skipped: Record<ApplyDefaultEngineSkipReason, number>;
	items: ApplyDefaultEngineItem[];
}
