/** Owner-visible application DTOs. Type-only leaf; safe for browser consumers. */
import type { ApplicationExecutionProjection } from "../../agent-types.js";

export type ApplicationQueueStatus = "new" | "apply_requested" | "tailoring" | "materials_ready" | "filling" | "awaiting_review" | "submitted" | "blocked" | "deferred" | "skipped" | "archived" | "failed";
export type ApplicationQueueAction = "apply" | "skip" | "defer" | "archive" | "generate_materials" | "retry_tailoring" | "start_fill" | "request_review" | "retry_fill" | "cancel" | "resume" | "mark_not_interested" | "approve_and_proceed" | "assert_not_submitted";

export type ApplicationArtifactHandle = import("../local-artifact/contract.js").LocalArtifactFile;

export interface ApplicationQueueItem {
	key: string;
	kind: "lead" | "application";
	status: ApplicationQueueStatus;
	title: string;
	company: string | null;
	location: string | null;
	url: string | null;
	source: string | null;
	postedDate: string | null;
	matchRationale: string | null;
	scoutInstanceId: string | null;
	leadId: string;
	leadVersion: number | null;
	applicationId: string | null;
	tailorInstanceId: string | null;
	stateVersion: number | null;
	blockReason: string | null;
	questions: string[];
	artifacts: { resume: ApplicationArtifactHandle | null; coverLetter: ApplicationArtifactHandle | null } | null;
	profileVersion: string | null;
	tailoringRunId: string | null;
	fillRunId: string | null;
	toolAccess?: "guarded" | "full";
	submissionVerification?: "unverified";
	fillRun: { id: string; status: string; mode: string | null; pause: { reason: string; url?: string; domain?: string; question?: string } | null } | null;
	submittedAt: string | null;
	submittedUrl: string | null;
	submitAttempted: boolean;
	submitPolicy: { allowed: boolean; failing: string[] } | null;
	/**
	 * How far the fill actually got, from the runner's own facts (#986). `label` is the server's
	 * sentence — the same one the Board card and MCP carry — and it never says a form was filled
	 * without `filled`/`uploaded` to show for it.
	 */
	fillProgress: ApplicationExecutionProjection["progress"];
	/** #988 redacted execution projection. No raw browser payload, form values, credentials or artefact content. */
	execution: ApplicationExecutionProjection | null;
	/** Why nothing reached the page (#975): the structured cause, the counts and the runner's signals. */
	diagnostic: { cause: string; bridgeCalls: number; engineExit: number; activeMs: number; pages: number; filled: number; signals: string[] } | null;
	/** Why this card's run is waiting for the machine rather than working (#974). */
	queue: { position: number; attempts: number; nextAttemptAt: string | null; reason: string | null; exhausted: boolean; label: string } | null;
	/** The owner's per-application submission approval (#973), once one has been granted. */
	submitAuthorization: { id: string; usable: boolean; label: string; approvedBy: string; approvedAt: string; approvedStateVersion: number; idempotencyKey: string; consumedAt: string | null; consumedRunId: string | null; recoveryPending?: boolean } | null;
	updatedAt: string;
	actions: ApplicationQueueAction[];
}


/** GET /application-queue/item. Pipeline metadata remains internal to the lookup. */
export interface ApplicationQueueItemResponse { item: ApplicationQueueItem }
