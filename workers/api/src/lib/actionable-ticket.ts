/**
 * Actionable board tickets — a human approval gate for RUNNER-LESS agents.
 *
 * The board already carries tickets, and `POST /tasks/direct` (#150 P3) lets a cloud-only
 * agent put one there. What was missing is the other half: approving one did nothing a
 * pipeline agent could act on. `POST /tasks/:id/approve` calls `requireLiveRuntime`, so it
 * only ever worked for agents with a machine running `pags up` — a pipeline agent could
 * raise a ticket and then had no way to have it carried out.
 *
 * An actionable ticket closes that. The ticket carries the work it represents —
 * `{ action, config, params }`, the SAME (action, config) vocabulary a trigger and an
 * agent-to-agent connection already use — and approving it runs exactly that through
 * `executeTriggerAction`. So a human gate is expressible wherever an automatic edge is:
 *
 *     lead.created ──connection(create_task)──▶ ticket ──you approve──▶ run_pipeline
 *
 * Two properties worth keeping:
 *   • The action is fixed when the ticket is CREATED, by the owner's own agent. Approving
 *     chooses whether the declared work runs — it never supplies new work — so a ticket is
 *     an approval, not an instruction channel.
 *   • It reuses the trigger action vocabulary rather than inventing a parallel one, so a
 *     ticket can do exactly what a trigger can do, and no more.
 *
 * This module is PURE (no env, no I/O) so the parsing/validation is unit-testable; the
 * routes own the dispatch.
 */
import type { TriggerAction, TriggerConfig } from "./triggers.js";

/** Actions a ticket may carry. Mirrors CONNECTION_ACTIONS: data-moving work only — never
 *  `sync_connector` (an external sync isn't a unit of approvable agent work) and never
 *  `log_event` (nothing to approve). */
export const TICKET_ACTIONS: readonly TriggerAction[] = ["run_pipeline", "insert_record", "add_knowledge", "create_task", "run_browse"];

export interface TicketAction {
	action: TriggerAction;
	config: TriggerConfig;
	/** The payload handed to the action — for run_pipeline these become the run params. */
	params: Record<string, unknown>;
}

/** Ticket statuses that an approval may act on. Anything else has already been decided. */
const RUNNABLE_STATUSES = new Set(["needs_approval", "queued", "blocked", "needs_human", "failed"]);

function isRecord(v: unknown): v is Record<string, unknown> {
	return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * Read the action off a mirrored ticket payload, or null when it carries none (an ordinary
 * informational ticket — the overwhelming majority). Unknown/invalid actions read as null
 * rather than throwing, so a malformed payload degrades to "not actionable" instead of
 * wedging the board.
 */
export function readTicketAction(payload: unknown): TicketAction | null {
	if (!isRecord(payload)) return null;
	const raw = isRecord(payload.action) ? payload.action : payload;
	const action = typeof raw.action === "string" ? raw.action : typeof payload.action === "string" ? payload.action : "";
	if (!action || !TICKET_ACTIONS.includes(action as TriggerAction)) return null;
	return {
		action: action as TriggerAction,
		config: isRecord(raw.config) ? (raw.config as TriggerConfig) : isRecord(payload.actionConfig) ? (payload.actionConfig as TriggerConfig) : {},
		params: isRecord(raw.params) ? raw.params : isRecord(payload.actionParams) ? payload.actionParams : {},
	};
}

/** Validate an action supplied when CREATING a ticket. Returns an error string, or null. */
export function validateTicketAction(action: unknown, config: unknown, params: unknown): string | null {
	if (action === undefined || action === null || action === "") return null; // plain ticket
	if (typeof action !== "string" || !TICKET_ACTIONS.includes(action as TriggerAction)) {
		return `action must be one of ${TICKET_ACTIONS.join(", ")}`;
	}
	if (config !== undefined && !isRecord(config)) return "action config must be an object";
	if (params !== undefined && !isRecord(params)) return "action params must be an object";
	if (action === "run_pipeline") {
		const name = isRecord(config) ? config.pipeline : undefined;
		const fromParams = isRecord(params) ? params.pipeline : undefined;
		if (typeof name !== "string" && typeof fromParams !== "string") {
			return "run_pipeline tickets need config.pipeline (the pipeline name)";
		}
	}
	return null;
}

/** Whether a ticket in this status may still be approved/run. */
export function isRunnableStatus(status: unknown): boolean {
	return typeof status === "string" && RUNNABLE_STATUSES.has(status);
}

/** The stored shape for a ticket's action (what `/tasks/direct` persists on the payload). */
export function buildTicketAction(action: string, config: unknown, params: unknown): TicketAction {
	return {
		action: action as TriggerAction,
		config: (isRecord(config) ? config : {}) as TriggerConfig,
		params: isRecord(params) ? params : {},
	};
}
