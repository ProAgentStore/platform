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

/**
 * One browser action the remote LLM brain asks the runner to perform on the
 * live active page. Elements are addressed by ARIA role + accessible name (the
 * same vocabulary as the snapshot the brain reads) — no CSS selectors.
 */
export interface BrowserAction {
	action: "click" | "type" | "select" | "check" | "upload" | "navigate" | "scroll" | "key" | "wait";
	/** ARIA role of the target element, e.g. "textbox" | "button" | "link" | "combobox" | "radio" | "checkbox". */
	role?: string;
	/** Accessible name of the target (from the snapshot). */
	name?: string;
	/** Disambiguate when role+name match several elements (default: first). */
	nth?: number;
	/** Text to type / option label to select. */
	text?: string;
	/** Absolute local file path to upload (action: upload). */
	file?: string;
	/** Destination URL (action: navigate). */
	url?: string;
	/** Key to press (action: key), e.g. "Enter" | "Tab" | "Escape". */
	key?: string;
	/** Pixels to scroll vertically (action: scroll, default 600). */
	dy?: number;
	/** Milliseconds to wait (action: wait, capped at 5000). */
	ms?: number;
}
