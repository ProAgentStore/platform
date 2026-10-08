/**
 * Waking an agent when work it is responsible for finishes (#968) — the decisions, pure.
 *
 * The gap this closes: a run ends, its outcome is written, and nothing starts the next turn of
 * whatever should react to it. `TRIGGER_ACTIONS` had ten actions and none of them started a loop,
 * so "when X finishes, have agent Y decide what is next" had no expression. A supervisor either
 * waited for a person to prompt it, or burned loop iterations polling `subordinate_status`.
 *
 * Both halves of the transport already existed, which is why this adds no delivery machinery:
 *
 *   · `run.finished` / `run.stalled` are recorded per terminal transition (#579, `run-events.ts`)
 *     and handed to the connection outbox every minute (`run-event-routing.ts`).
 *   · the outbox persists, retries with backoff, dead-letters and de-duplicates by
 *     (connection, emitting run, payload hash) — `connection-deliveries.ts`.
 *
 * So the missing piece was one ACTION: `start_loop`. What lives here is the only part of it with a
 * decision in it — what the woken agent is told, and how much of the finished run's record it is
 * told with. The dispatch itself is `triggers.ts`, through `loopDriverFor`, the same door
 * `start_work`, the Loop button and the ticket queue use.
 */
import { clipMarked } from "./clip-marked.js";
import type { RunEventPayload } from "./run-events.js";

/** The longest event précis appended to a standing objective — the rest of the budget is theirs. */
export const WAKE_CONTEXT_CHARS = 600;

/**
 * The run facts a wake-up carries. A subset of {@link RunEventPayload}, because this is also fed by
 * a plain webhook or a `log_event`-shaped payload: a wake-up must still read sensibly when the
 * thing that finished was not one of our own runs.
 */
export type WakeFacts = Partial<Pick<RunEventPayload, "event" | "runId" | "instanceId" | "status" | "stopReason" | "detail" | "finishedAt" | "traceId">>;

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Read the wake facts out of an arbitrary delivered payload, taking only what is recognisable. */
export function wakeFactsOf(payload: unknown): WakeFacts {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {};
	const o = payload as Record<string, unknown>;
	const facts: WakeFacts = {};
	const event = str(o.event);
	if (event === "run.finished" || event === "run.stalled") facts.event = event;
	for (const key of ["runId", "instanceId", "status", "stopReason", "detail", "traceId"] as const) {
		const v = str(o[key]);
		if (v) facts[key] = v;
	}
	const finishedAt = num(o.finishedAt);
	if (finishedAt !== null) facts.finishedAt = finishedAt;
	return facts;
}

/**
 * Is there anything to react to? A wake-up fires on a TERMINAL outcome; a routed event that is not
 * one is not an error, it is simply not a reason to spend a turn.
 *
 * `run.stalled` counts: the platform closed a run because it went quiet, and "the work you were
 * waiting on died" is exactly the case a supervisor must be told about — it is the one a polling
 * loop never learns, because the row says `running` for ever.
 */
export function isWakeableEvent(facts: WakeFacts): boolean {
	return facts.event === "run.finished" || facts.event === "run.stalled";
}

/**
 * What the woken agent is asked to do.
 *
 * The standing instruction comes from the wiring (`config.objective`) — it is the owner's, written
 * once, and it is what makes the turn purposeful rather than "something happened, go". The event
 * précis is appended because the agent otherwise has to go and find out what finished, which costs
 * it a tool call and can read the record AFTER something else moved it.
 *
 * `clipMarked`, not `slice`: a cut objective must say it was cut, or the agent treats a truncated
 * sentence as the whole instruction. The précis is deliberately facts-only — ids, a status, a
 * reason, the run's own `detail` — and carries no prose this platform did not write, because the
 * `detail` of a foreign run is the one field a remote producer controls.
 */
export function wakeObjective(standing: string, facts: WakeFacts): string {
	const instruction = standing.trim();
	const parts: string[] = [];
	if (facts.event) parts.push(facts.event === "run.stalled" ? "A run you depend on STALLED (the platform closed it because it went quiet)" : "A run you depend on finished");
	if (facts.instanceId) parts.push(`agent ${facts.instanceId}`);
	if (facts.runId) parts.push(`run ${facts.runId}`);
	if (facts.status) parts.push(`status ${facts.status}`);
	if (facts.stopReason) parts.push(`stopped on ${facts.stopReason}`);
	if (facts.finishedAt) parts.push(`finished ${new Date(facts.finishedAt).toISOString()}`);
	const precis = parts.join(" · ");
    // The run's own words last, and bounded on their own, so a long `detail` cannot crowd out the ids.
	const detail = facts.detail ? `\n${clipMarked(facts.detail, WAKE_CONTEXT_CHARS)}` : "";
	if (!precis && !detail) return instruction;
	return `${instruction}\n\n${precis}${detail}`.trim();
}

/**
 * Why a wake-up was not acted on, when it was not. Returned rather than thrown for `not_wakeable`
 * — nothing is wrong, there was just nothing to do — and thrown by the caller for `busy`, because
 * a busy agent WILL be free later and the outbox's backoff is exactly the right wait.
 */
export type WakeSkip = "not_wakeable" | "busy";
