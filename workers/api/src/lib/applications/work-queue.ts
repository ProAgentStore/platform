/**
 * Approved pipeline work waits for a busy machine (#974) — the decisions, pure.
 *
 * The Tailor and the Runner each run one local CLI at a time, and that rule is the runner's, not
 * the cloud's: it answers 409 when asked for a second. The cloud used to turn every non-ok dispatch
 * into a terminal `runner_rejected`, so approving five leads at once produced one run and four dead
 * applications. A busy machine is not a failure — it is a wait — and this module is where that
 * distinction is made, so it can be tested without a runner, a database or a clock.
 *
 * The run row is the queue entry (see migration 0191 for why there is no separate table), so what
 * is decided here is only: is this refusal worth waiting for, how long until the next attempt, and
 * what does the owner see while it waits.
 */

/** How many dispatch attempts a queued run gets before it is settled instead of waiting forever. */
export const QUEUE_MAX_ATTEMPTS = 8;

/**
 * The wait before attempt N+1, in ms: ~1m · 2m · 5m · 10m · 20m · 30m · 30m …
 *
 * It is the machine being busy with the owner's OTHER application, which finishes in minutes, not
 * someone else's outage — so the early steps are short and the ladder flattens rather than growing
 * without bound. The last value repeats, which with {@link QUEUE_MAX_ATTEMPTS} bounds the whole wait
 * at a little over two hours.
 */
const LADDER_MS = [60_000, 120_000, 300_000, 600_000, 1_200_000, 1_800_000];
export function backoffDelayMs(attempts: number): number {
	const i = Math.max(0, Math.min(attempts, LADDER_MS.length - 1));
	return LADDER_MS[i];
}

/** What the runner said when it would not take the run. */
export interface RefusalInput {
	status: number;
	/** The runner's own message, as the dispatch read it. */
	error?: string;
	/** A machine-readable reason, when the runner is new enough to send one. */
	code?: string;
}

export type RefusalVerdict =
	| { defer: true; reason: "busy" | "starting"; message: string }
	| { defer: false };

/**
 * Should this refusal be waited out, or is it terminal?
 *
 * Matching on the MESSAGE as well as a code is deliberate, and is the difference between fixing this
 * for the owner today and fixing it for whoever upgrades their CLI next. Every runner already in the
 * field answers a busy dispatch with a 409 and prose; none of them sends a code. A cloud that waited
 * only on a code would keep killing applications on exactly the machines that reported the problem.
 *
 * Status alone is not enough either, and that is the trap: these endpoints answer 409 for a genuine
 * conflict too — `Run <id> already exists with another requestId` — which must NOT be retried,
 * because retrying it would mean asking a machine forever for a run it has already bound elsewhere.
 * So a 409 defers only when it says what kind of 409 it is.
 */
export function refusalVerdict(input: RefusalInput): RefusalVerdict {
	const text = (input.error ?? "").toLowerCase();
	if (input.code === "busy" || input.code === "starting") {
		return { defer: true, reason: input.code, message: input.error?.slice(0, 300) || "the machine is busy with another application" };
	}
	if (input.status !== 409) return { defer: false };
	// "already tailoring 2 application(s) for this agent (limit 1)" / "already filling an application"
	if (/\balready (tailoring|filling)\b/.test(text)) return { defer: true, reason: "busy", message: input.error?.slice(0, 300) ?? "" };
	// "The runner is still starting; try again in a moment." — transient by its own words.
	if (/still starting/.test(text)) return { defer: true, reason: "starting", message: input.error?.slice(0, 300) ?? "" };
	return { defer: false };
}

/** A queued run as the board and MCP describe it. */
export interface QueueView {
	/** 1 = next to dispatch. Counted over the instance's queued runs, oldest first. */
	position: number;
	/** How many times the machine has been asked already. */
	attempts: number;
	/** When the next attempt is due, ISO, or null when it is due now. */
	nextAttemptAt: string | null;
	/** Why it is waiting, in the words the owner reads. */
	reason: string | null;
	/** Attempts are exhausted: the next sweep settles it instead of waiting again. */
	exhausted: boolean;
}

export function queueView(input: { position: number; attempts: number; nextAttemptAt: number | null; reason: string | null }, now: number): QueueView {
	return {
		position: input.position,
		attempts: input.attempts,
		nextAttemptAt: input.nextAttemptAt && input.nextAttemptAt > now ? new Date(input.nextAttemptAt).toISOString() : null,
		reason: input.reason,
		exhausted: input.attempts >= QUEUE_MAX_ATTEMPTS,
	};
}

/**
 * The sentence the owner reads on a queued card. Position first, because "behind two others" is the
 * answer to the question they actually have, and a machine that is offline is a different problem
 * from a queue that is simply moving.
 */
export function queuedLabel(v: QueueView): string {
	if (v.exhausted) return `Gave up waiting for the machine after ${v.attempts} attempts — retry it when the machine is free.`;
	const place = v.position <= 1 ? "Next in line" : `${v.position - 1} ahead of it in line`;
	const when = v.nextAttemptAt ? `, next attempt ${new Date(v.nextAttemptAt).toISOString().slice(11, 16)} UTC` : ", due now";
	return `Waiting for your machine — ${place}${when}.${v.reason ? ` (${v.reason})` : ""}`;
}
