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
 * ── `call_tool`, and the one place a ticket does MORE than a trigger (#722)
 *
 * The second sentence above stopped being wholly true, deliberately and in one direction. A
 * connector write consent can now be set to "ask each time", and an ask-mode write does not
 * dispatch: `runRegistryTool` writes it here as a `call_tool` ticket carrying the exact
 * `{tool, args}` it refused, and approving runs that one call.
 *
 * It is the only action a ticket has that an automatic edge does not, and it must stay that way —
 * the whole value of the gate is that a HUMAN is the thing between the model and the send, so an
 * action that exists to be approved must not also be reachable from a cron. That is enforced by
 * the type (`TicketActionName` widens `TriggerAction`, never the reverse — see trigger-types.ts)
 * and by {@link GATE_ONLY_TICKET_ACTIONS} at every create-time door.
 *
 * This module is PURE (no env, no I/O) so the parsing/validation is unit-testable; the
 * routes own the dispatch.
 */
import type { TicketActionName, TriggerConfig } from "./trigger-types.js";

/** Actions a ticket may carry. Mirrors CONNECTION_ACTIONS: data-moving work only — never
 *  `sync_connector` (an external sync isn't a unit of approvable agent work) and never
 *  `log_event` (nothing to approve) — plus `call_tool`, which is GATE-ONLY (see below). */
export const TICKET_ACTIONS: readonly TicketActionName[] = ["run_pipeline", "insert_record", "add_knowledge", "create_task", "run_browse", "call_tool"];

/**
 * Actions no AGENT may put on a ticket — only the platform's own gates may (#722).
 *
 * This is the boundary the whole per-call approval design rests on, and it is worth stating
 * plainly because it is the one way the gate could be turned inside out:
 *
 *   An agent refused a write must not be able to raise its own approval ticket for that same
 *   call, wait for a human to click Approve on a card whose action it chose, and so obtain the
 *   very dispatch the gate withheld.
 *
 * `create_ticket` (the registry tool an agent can call) and `POST /tasks/direct` both validate
 * with `allowGateOnly` unset, so both refuse. The ask-gate in `runRegistryTool` is the only
 * caller that passes it, and the call it writes is the call it just refused to dispatch —
 * never one supplied by a model.
 *
 * The module's existing invariant does the rest: the action is fixed when the ticket is CREATED,
 * so approving chooses whether the declared work runs and can never substitute new work.
 */
export const GATE_ONLY_TICKET_ACTIONS: ReadonlySet<TicketActionName> = new Set<TicketActionName>(["call_tool"]);

export interface TicketAction {
	action: TicketActionName;
	config: TriggerConfig;
	/** The payload handed to the action — for run_pipeline these become the run params, and for
	 *  `call_tool` it is `{ tool, args }` (see {@link readCallToolTicket}). */
	params: Record<string, unknown>;
}

/** The call a `call_tool` ticket stands for: a registry tool name and the exact arguments the
 *  agent passed when the ask-gate refused to dispatch it. */
export interface CallToolTicket {
	tool: string;
	args: Record<string, unknown>;
}

/**
 * Read the `{tool, args}` off a `call_tool` ticket, or null when it is not one (or is malformed).
 *
 * Malformed reads as null rather than throwing, for the same reason `readTicketAction` does: a
 * payload nobody can parse must degrade to "not runnable", never to a call with guessed arguments.
 */
export function readCallToolTicket(ticket: TicketAction | null): CallToolTicket | null {
	if (ticket?.action !== "call_tool") return null;
	const tool = typeof ticket.params.tool === "string" ? ticket.params.tool.trim() : "";
	if (!tool) return null;
	return { tool, args: isRecord(ticket.params.args) ? ticket.params.args : {} };
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
	if (!action || !TICKET_ACTIONS.includes(action as TicketActionName)) return null;
	return {
		action: action as TicketActionName,
		config: isRecord(raw.config) ? (raw.config as TriggerConfig) : isRecord(payload.actionConfig) ? (payload.actionConfig as TriggerConfig) : {},
		params: isRecord(raw.params) ? raw.params : isRecord(payload.actionParams) ? payload.actionParams : {},
	};
}

/**
 * Validate an action supplied when CREATING a ticket. Returns an error string, or null.
 *
 * `allowGateOnly` is the platform's own key to {@link GATE_ONLY_TICKET_ACTIONS}. It defaults to
 * false so that every caller reachable by a model — `create_ticket`, `POST /tasks/direct` — is
 * refused by DEFAULT rather than by remembering to pass a flag.
 */
export function validateTicketAction(
	action: unknown,
	config: unknown,
	params: unknown,
	opts: { allowGateOnly?: boolean } = {},
): string | null {
	if (action === undefined || action === null || action === "") return null; // plain ticket
	if (typeof action !== "string" || !TICKET_ACTIONS.includes(action as TicketActionName)) {
		// The offered vocabulary never names a gate-only action: it is not something a caller can
		// choose, so listing it would advertise a door that is always locked.
		const offered = TICKET_ACTIONS.filter((a) => !GATE_ONLY_TICKET_ACTIONS.has(a));
		return `action must be one of ${offered.join(", ")}`;
	}
	if (GATE_ONLY_TICKET_ACTIONS.has(action as TicketActionName) && !opts.allowGateOnly) {
		return `"${action}" tickets are raised by the platform's approval gate, not by an agent — it cannot be requested.`;
	}
	if (action === "call_tool") {
		const tool = isRecord(params) ? params.tool : undefined;
		if (typeof tool !== "string" || !tool.trim()) return "call_tool tickets need params.tool (the tool name)";
		if (params !== undefined && isRecord(params) && params.args !== undefined && !isRecord(params.args)) {
			return "call_tool params.args must be an object";
		}
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
		action: action as TicketActionName,
		config: (isRecord(config) ? config : {}) as TriggerConfig,
		params: isRecord(params) ? params : {},
	};
}
