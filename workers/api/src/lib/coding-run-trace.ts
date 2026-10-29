/**
 * What the coding driver puts in the unified trace (#580 AC4).
 *
 * ── The measurement
 *
 *     grep -c logEvent workflows/coding-session.ts   → 0   (browser-task 6, job-apply 6,
 *     grep -c logError workflows/coding-session.ts   → 0    pipeline-run 7, agent-loop 3)
 *
 * Coding events DID reach `agent_trace`, but only through `coding-failure.ts` — on a CLASSIFIED
 * CRASH. A run that merely stopped classified nothing and therefore recorded nothing, which is how
 * run 70ea298e existed for 4.35 hours with no trace row of any kind: `agent_trace source:"coding"`
 * returned nothing for it, and its newest coding event was two days old. The only durable account of
 * that run was the terminal pane, reachable only by somebody who already knew the session id.
 *
 * The flagship agent's driver was the least instrumented one in the Worker, and the trace is the
 * platform's primary debugging tool (`agent_trace` is what the MCP surface tells you to call first).
 *
 * ── Why a module and not four inline `logEvent` calls
 *
 * `workflows/coding-session.ts` sits one line under the 800-line limit `check-file-size.mjs`
 * enforces, so four call sites plus their arguments would have to be paid for somewhere. More
 * importantly the EVENT NAMES are a vocabulary: `agent_trace` filters on them, `work-report` and the
 * MCP tools read them back, and a vocabulary spelled out at four call sites drifts. Here they are one
 * table, and `workflow-trace.test.ts` asserts the driver is not an exception to it.
 *
 * Every write is best-effort. The trace is a RECORD of the run, never the run: losing a row must not
 * cost the objective. That is the same rule `recordCodingFailure` states, and the reason both
 * swallow.
 */
import { codingCardId } from "./coding-board.js";
import { logEvent } from "./events.js";
import { type ActionStatus, writeActionEntry } from "./task-action-log.js";
import type { Env } from "../types.js";

/**
 * The closed vocabulary of coding-run trace events.
 *
 * `coding.` prefixed to match the `source: "coding"` rows `recordEngineActs` and
 * `recordCodingFailure` already write, so one `agent_trace?trace_id=<runId>` query returns the run's
 * lifecycle, its acts and its death interleaved rather than three disjoint views.
 */
export type CodingRunEvent =
	/** The Pilot began driving. Carries the objective, so a trace read alone says what was asked. */
	| "coding.run.start"
	/** The run parked deliberately — a usage limit or a human handoff. The state #580 could not see. */
	| "coding.run.park"
	/** A platform event interrupted the run and it is being resumed rather than failed (#583). */
	| "coding.run.interrupted"
	/** The gate refused to start it — the base it would build on could not be confirmed (#801). */
	| "coding.run.blocked"
	/** The platform fast-forwarded (or tried to) a behind checkout before the run started (#802). */
	| "coding.run.self_heal"
	/** Whether the run's objective reached the engine verbatim: delivered, unsupported, unconfirmed or unknown (#1019). */
	| "coding.run.objective"
	/** An act whose reply was lost and could not be reconciled: not re-sent, because it may already have run (#1019). */
	| "coding.run.input_unknown"
	/** A turn a runner restart or engine relaunch cut off: resumed exactly once, or the run stopped `turn_lost` (#1053). */
	| "coding.run.turn_recovery"
	/** A failed engine turn's words were matched to a provider rule (kind, provider, rule, exit code, the whole error text) (#1391). */
	| "coding.run.provider_error_classified"
	/** What was decided about a failed turn and WHY — resend, park, end, or a strike because no rule matched / the runner sent no output (#1391). */
	| "coding.run.provider_retry_decision"
	/** A transient provider failure parked the run for a backoff: attempt n of m, the wait, the next attempt's time (#1391). */
	| "coding.run.provider_retry_scheduled"
	/** The backoff elapsed and the run resumed to resend (#1391). */
	| "coding.run.provider_retry_attempt"
	/** The attempts ran out: the final status, every wait served, and the provider's whole error (#1391). */
	| "coding.run.provider_retry_exhausted"
	/** The run reached a terminal state. Carries the outcome and the stop reason. */
	| "coding.run.end";

export interface CodingTraceCtx {
	userId: string;
	instanceId: string;
	sessionId: string;
	/** The loop-run id — the key `agent_trace?trace_id=` is queried by. Falls back to the session. */
	runId?: string | null;
	repo?: string | null;
	/** The board ticket this run works, when it was started from one — its log is that card's (#1108). Else the session's card. */
	cardId?: string | null;
}

/** How a lifecycle event reads on the card's action log (#1108). Null: trace only. */
function cardAction(event: CodingRunEvent, context: Record<string, unknown>): { actionType: string; status: ActionStatus } | null {
	switch (event) {
		case "coding.run.start":
			return { actionType: "checkpoint", status: "running" };
		case "coding.run.park":
			return { actionType: "checkpoint", status: "skipped" };
		case "coding.run.interrupted":
		case "coding.run.self_heal":
		case "coding.run.turn_recovery":
			return { actionType: "checkpoint", status: "running" };
		case "coding.run.blocked":
		case "coding.run.input_unknown":
			return { actionType: "blocker", status: "error" };
		case "coding.run.end": {
			const outcome = String(context.outcome ?? "");
			return { actionType: "outcome", status: outcome === "done" ? "ok" : outcome === "cancelled" ? "skipped" : "error" };
		}
		default:
			return null;
	}
}

/** The card a coding run's actions land on: its board ticket, else its session's card. */
export function codingActionCard(ctx: Pick<CodingTraceCtx, "cardId" | "sessionId">): string {
	return ctx.cardId || codingCardId(ctx.sessionId);
}

/**
 * File one lifecycle event.
 *
 * `traceId` follows exactly the rule `recordCodingFailure` uses — the run id when there is one, the
 * session id otherwise — so a chat-initiated `start_work` with no run row is still findable, and a
 * delegated run's lifecycle joins to the acts recorded under the same key.
 */
export async function traceCodingRun(
	env: Env,
	ctx: CodingTraceCtx,
	event: CodingRunEvent,
	message: string,
	context: Record<string, unknown> = {},
): Promise<void> {
	await logEvent(env, {
		source: "coding",
		event,
		// `warn` for the events that mean the run is NOT progressing, `info` for the rest. A park
		// and an interruption are explained, not broken — the same distinction `codingFailureLevel`
		// draws, so a reader filtering `level` gets one consistent answer across both writers.
		// A BLOCKED run joins them: it is the third way a run can exist without progressing, and an
		// operator filtering `level` for "why is nothing happening" has to find all three (#801).
		level: event === "coding.run.park" || event === "coding.run.interrupted" || event === "coding.run.blocked" || event === "coding.run.provider_retry_exhausted" ? "warn" : "info",
		message: message.slice(0, 400),
		userId: ctx.userId,
		instanceId: ctx.instanceId,
		traceId: ctx.runId ?? ctx.sessionId,
		context: { sessionId: ctx.sessionId, runId: ctx.runId ?? null, repo: ctx.repo ?? null, ...context },
	}).catch(() => undefined);
	const action = cardAction(event, context);
	if (action) {
		const runKey = ctx.runId ?? ctx.sessionId;
		await writeActionEntry(env, {
			instanceId: ctx.instanceId,
			userId: ctx.userId,
			taskId: codingActionCard(ctx),
			actor: "coding-engine",
			...action,
			summary: event === "coding.run.start" ? `Coding run started — ${message}` : message,
			// A replayed workflow step must not log its start or end twice.
			...(event === "coding.run.start" || event === "coding.run.end" ? { dedupeKey: `${runKey}:${event}` } : {}),
		});
	}
}
