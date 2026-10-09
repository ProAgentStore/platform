/**
 * The owner-visible, durable execution view for one job application (#988).
 *
 * This is deliberately a leaf: it describes only closed-vocabulary lifecycle and runner facts.
 * It never carries browser snapshots, page text, form values, credentials, artefact contents, or
 * raw runner results. The queue/API, Board payload, Console and MCP all pass this same shape on
 * rather than each inferring a story from a lifecycle status word.
 */
import type { FillProgress } from "./fill-progress.js";
import type { ApplicationExecutionProjection as SharedApplicationExecutionProjection } from "../../agent-types.js";

export type ExecutionKind = "tailor" | "fill";
export type DirectiveDelivery = "queued" | "delivery_attempted" | "delivered" | "acknowledged_by_runner";
export type DirectiveReconciliation = "not_applicable" | "terminal" | "decision_pending" | "delivery_pending" | "retry_pending" | "acknowledged";

export interface ExecutionCheckpoint {
	id: string;
	phase: "initial" | "post_navigation" | "before_submit" | "uncertain";
	/** Redacted bridge facts only; URL/title are intentionally excluded. */
	facts: { actions: number; filled: number; uploaded: number; blockers: string[]; domain: string | null };
	directive: { kind: "continue" | "request_review" | "stop"; delivery: DirectiveDelivery } | null;
}

/** Worker/Console contract with the Worker-side exact progress/checkpoint refinements. */
export type ApplicationExecutionProjection = SharedApplicationExecutionProjection & {
	currentRun: { id: string; kind: ExecutionKind; status: string; instanceId: string; mode: string | null } | null;
	checkpoint: ExecutionCheckpoint | null;
	progress: FillProgress | null;
	directiveReconciliation: DirectiveReconciliation;
};

export function directiveReconciliation(input: { terminal: boolean; checkpoint: ExecutionCheckpoint | null }): DirectiveReconciliation {
	if (input.terminal) return "terminal";
	const directive = input.checkpoint?.directive;
	if (!input.checkpoint) return "not_applicable";
	if (!directive) return "decision_pending";
	if (directive.delivery === "acknowledged_by_runner") return "acknowledged";
	if (directive.delivery === "delivered") return "delivery_pending";
	return directive.delivery === "delivery_attempted" ? "retry_pending" : "delivery_pending";
}

/** Constructed only from durable, already-redacted facts read by the application service. */
export function projectApplicationExecution(input: {
	lifecycle: ApplicationExecutionProjection["lifecycle"];
	currentRun: ApplicationExecutionProjection["currentRun"];
	checkpoint: ExecutionCheckpoint | null;
	progress: FillProgress | null;
	permittedActions: string[];
}): ApplicationExecutionProjection {
	const terminal = ["submitted", "archived", "failed", "cancelled"].includes(input.lifecycle.status);
	return {
		schemaVersion: 1,
		lifecycle: input.lifecycle,
		currentRun: input.currentRun,
		checkpoint: input.checkpoint,
		progress: input.progress,
		permittedActions: [...input.permittedActions],
		directiveReconciliation: directiveReconciliation({ terminal, checkpoint: input.checkpoint }),
	};
}
