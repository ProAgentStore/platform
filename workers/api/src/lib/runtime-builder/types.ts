/** Durable audit record for a site authored on a subscriber's local CLI. */
export type RuntimeBuilderEngine = "claude" | "codex";
export type RuntimeBuilderStatus = "drafting" | "paused" | "awaiting_review" | "approved" | "cancelled" | "failed";

export interface FwsToolCall {
	tool: string;
	args?: Record<string, unknown>;
	at: string;
	result?: "ok" | "error";
}

export interface ScreenshotArtifact {
	device: "desktop" | "mobile";
	url: string;
	capturedAt: string;
}

export interface RuntimeBuilderEvidence {
	engine: RuntimeBuilderEngine;
	model?: string | null;
	taskId?: string | null;
	fwsTranscript: FwsToolCall[];
	qualityReport?: Record<string, unknown> | null;
	screenshots: ScreenshotArtifact[];
	refinementCount: number;
	approvalState: "not_requested" | "awaiting_review" | "approved" | "denied";
	offline: { pausedAt?: string; resumedAt?: string; reason?: string };
	/** The FWS draft session. Never an OAuth credential. */
	sessionId?: string | null;
	deployParams?: Record<string, unknown> | null;
}

export interface RuntimeBuilderRun {
	id: string;
	instanceId: string;
	userId: string;
	engine: RuntimeBuilderEngine;
	status: RuntimeBuilderStatus;
	evidence: RuntimeBuilderEvidence;
	refinementCount: number;
	createdAt: string;
	updatedAt: string;
}

export function emptyEvidence(engine: RuntimeBuilderEngine): RuntimeBuilderEvidence {
	return { engine, fwsTranscript: [], screenshots: [], refinementCount: 0, approvalState: "not_requested", offline: {} };
}
