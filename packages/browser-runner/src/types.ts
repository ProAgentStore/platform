export type RunnerCapability =
	| "browser.playwright"
	| "browser.screenshot"
	| "downloads"
	| "file.upload"
	| "human.approval"
	| "human.takeover";

export type TaskStatus =
	| "queued"
	| "running"
	| "needs_approval"
	| "needs_human"
	| "blocked"
	| "completed"
	| "failed"
	| "cancelled";

export interface RunnerConfig {
	host: string;
	port: number;
	dataDir: string;
	token?: string;
	instanceId?: string;
	headless: boolean;
}

export interface RunnerSession {
	id: string;
	createdAt: string;
	status: "active" | "closed";
}

export interface RunnerTask {
	id: string;
	type: string;
	status: TaskStatus;
	input: Record<string, unknown>;
	output?: unknown;
	error?: string;
	requiresApproval: boolean;
	approval?: {
		prompt: string;
		approvedAt?: string;
	};
	createdAt: string;
	updatedAt: string;
	completedAt?: string;
}

export interface RunnerEvent {
	id: string;
	taskId?: string;
	type: string;
	message: string;
	createdAt: string;
	data?: unknown;
}

export interface CreateTaskRequest {
	type: string;
	input?: Record<string, unknown>;
	requiresApproval?: boolean;
	approvalPrompt?: string;
}

/** A remote-control input event relayed to a human-takeover session. */
export interface TakeoverInput {
	type: "move" | "down" | "up" | "click" | "scroll" | "key" | "text";
	x?: number;
	y?: number;
	deltaX?: number;
	deltaY?: number;
	key?: string;
	code?: string;
	keyCode?: number;
	text?: string;
}
