/**
 * In-flight chat turns — the durable record that a turn STARTED (#251).
 *
 * A chat turn used to exist only as the inbound request: `handleChat` awaited `think()` and
 * returned the reply inline, with no `waitUntil` and no run row anywhere. Tools execute DURING
 * `think()` and commit as they go (memory writes, created tasks, a filed issue, a started
 * pipeline), but the assistant message is appended only AFTER it returns. So a turn that died
 * with its request left **work done and nothing in the transcript** — and the next turn was then
 * built from a history that contradicts what actually happened.
 *
 * A marker is written before the turn runs and deleted when it finishes. What makes it useful is
 * the pairing with the DO's IN-MEMORY set of live turn ids: a marker whose turn is not live in
 * this instance means the object restarted (deploy, eviction) or the turn was killed — i.e. the
 * turn is abandoned, and the gap in the transcript can finally be stated instead of being silent.
 *
 * Pure + unit-tested here; the DO owns the storage and the messages.
 */

/** DO storage key prefix — one key per in-flight turn, so concurrent turns can't clobber. */
export const INFLIGHT_PREFIX = "inflight:";

/**
 * Belt and braces for the liveness set: a marker older than this is abandoned even if something
 * still claims it is live. Generous — a BYOK turn with several tool rounds is minutes, not
 * seconds — because declaring a RUNNING turn dead is the worse error (it would announce an
 * interruption that never happened).
 */
export const INFLIGHT_MAX_MS = 15 * 60_000;

export interface InflightTurn {
	turnId: string;
	/** Epoch ms the turn started. */
	startedAt: number;
	userId?: string | null;
	channel?: string;
	/** First words of the user message, so an interrupted turn can be named in the transcript. */
	preview?: string;
}

/** Storage key for a turn's marker. */
export function inflightKey(turnId: string): string {
	return `${INFLIGHT_PREFIX}${turnId}`;
}

/**
 * Is this marker a turn that is really still running, or the residue of one that died?
 *
 * `isLive` is the DO instance's own memory of the promises it is currently running. It is the
 * only thing that can distinguish "still working" from "the object restarted underneath it" —
 * the marker itself looks identical in both cases.
 */
export function turnLiveness(
	turn: InflightTurn,
	opts: { isLive: (turnId: string) => boolean; now: number; maxMs?: number },
): "running" | "abandoned" {
	const maxMs = opts.maxMs ?? INFLIGHT_MAX_MS;
	if (opts.now - turn.startedAt >= maxMs) return "abandoned";
	return opts.isLive(turn.turnId) ? "running" : "abandoned";
}

/** Split the persisted markers into what is still working and what has to be reaped. */
export function partitionTurns(
	turns: InflightTurn[],
	opts: { isLive: (turnId: string) => boolean; now: number; maxMs?: number },
): { running: InflightTurn[]; abandoned: InflightTurn[] } {
	const running: InflightTurn[] = [];
	const abandoned: InflightTurn[] = [];
	for (const t of turns) {
		(turnLiveness(t, opts) === "running" ? running : abandoned).push(t);
	}
	return { running, abandoned };
}

/**
 * What the transcript says about a turn that never finished. Deliberately explicit that the
 * agent's ACTIONS may have landed: the whole failure is that side effects outlive the reply, so
 * a vague "something went wrong" would leave the user believing nothing happened.
 */
export function interruptedNotice(turn: InflightTurn): string {
	const what = turn.preview ? ` (“${turn.preview}”)` : "";
	return `⚠ The previous turn${what} was interrupted before its reply was saved. Any actions the agent already took did happen — check the activity log before repeating the request.`;
}

/** Trim a user message down to a marker preview (the notice above quotes it). */
export function previewOf(message: string, max = 80): string {
	const flat = message.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
