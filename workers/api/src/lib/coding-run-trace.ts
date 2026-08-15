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
import { logEvent } from "./events.js";
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
	/** The run reached a terminal state. Carries the outcome and the stop reason. */
	| "coding.run.end";

export interface CodingTraceCtx {
	userId: string;
	instanceId: string;
	sessionId: string;
	/** The loop-run id — the key `agent_trace?trace_id=` is queried by. Falls back to the session. */
	runId?: string | null;
	repo?: string | null;
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
		// `warn` for the two events that mean the run is NOT progressing, `info` for the rest. A park
		// and an interruption are explained, not broken — the same distinction `codingFailureLevel`
		// draws, so a reader filtering `level` gets one consistent answer across both writers.
		level: event === "coding.run.park" || event === "coding.run.interrupted" ? "warn" : "info",
		message: message.slice(0, 400),
		userId: ctx.userId,
		instanceId: ctx.instanceId,
		traceId: ctx.runId ?? ctx.sessionId,
		context: { sessionId: ctx.sessionId, runId: ctx.runId ?? null, repo: ctx.repo ?? null, ...context },
	}).catch(() => undefined);
}
