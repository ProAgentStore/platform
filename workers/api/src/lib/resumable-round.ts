// A failed turn's completed tool rounds, kept so a retry can continue instead of re-paying (#442).
//
// #427 item 5, deliberately not attempted there. Its production evidence:
//
//     05:08:52  "Start implementing"  → github_read_issue (1658 chars)  → timeout
//     05:15:38  "Start implementing"  → github_read_issue (1982 chars)  → timeout
//
// The same issue fetched twice, six minutes apart, because the retry had no way to say "you
// already have this". The retry was not CHOOSING to re-call the tool — it had no alternative:
// everything the next round would have needed (the full `content`, the `tool_use` id, the
// arguments, `is_error`) was function-local in `runAgentThink` and died with the throw. Only a
// 120-character preview survived, as prose in the transcript — the shape #398 removed from the
// live path for good reasons.
//
// Streaming (#427) makes this rarer; it does not remove it. Any provider error in round 2+ — a
// 5xx, an overloaded model, a stall, the 180s ceiling — lands in exactly the same place, after the
// tool has run. Where the round's tools are WRITES rather than reads, the retry re-executes side
// effects: the cross-round dedup is scoped to one turn and cannot see the previous request.
//
// ── What is stored, and what is deliberately not
//
// The provider-shaped messages the failed turn had accumulated — the assistant `tool_use` blocks
// and the `tool_result` blocks answering them — NOT the `I called tools:\n…` prose. Re-entering
// through the prose shape would undo #398 and re-teach the format #395's fabrication imitated.
//
// The results are already capped by `capToolResult` at the one seam where a result re-enters the
// prompt, so what lands here is prompt-sized by construction. `roundBudget` is a second, blunt
// bound on the serialized whole, because a stored round is written to DO storage and a cap that
// depends on every producer having remembered to cap is not a cap.

/** A provider-shaped message, as `runAgentThink` accumulates them. */
export interface RoundMessage {
	role: string;
	content: unknown;
}

export interface ResumableRound {
	/**
	 * The user message whose turn failed.
	 *
	 * A resume is only valid for a retry of the SAME question. Anything else is a new turn and the
	 * stored round is stale by definition — resuming it would answer a question nobody asked with
	 * results fetched for a different one.
	 */
	prompt: string;
	/** When the round was stored, for the TTL. */
	savedAt: number;
	/** Rounds already completed, so a resumed turn does not get a fresh round budget. */
	roundsUsed: number;
	/** `[signature, mutationCount]`, so the cross-round dedup survives the resume. */
	executed: [string, number][];
	/** The mutation counter, which the dedup's read-repeat rule is keyed to. */
	mutations: number;
	/** Tool names actually executed, in order — `honestReply`'s ground truth (#395). */
	executedTools: string[];
	/** The display log, so the transcript can say what was carried over. */
	toolLog: string[];
	/** The accumulated `tool_use` / `tool_result` turns, in order. */
	messages: RoundMessage[];
}

/**
 * How long a stored round stays valid.
 *
 * A resumable round is only worth resuming while its results are still TRUE. Ten minutes covers
 * the retry a user performs immediately — #427's own evidence is six minutes apart — and expires
 * well before a `github_read_issue` from a different working day. A resumed stale read is worse
 * than a re-fetch, because it is confidently wrong where the re-fetch is merely slow.
 */
export const RESUMABLE_TTL_MS = 10 * 60 * 1000;

/** Serialized ceiling for a stored round. Well above a capped round, far below DO storage's limit. */
export const RESUMABLE_MAX_BYTES = 96 * 1024;

/**
 * Is this stored round the answer to the question being asked, right now?
 *
 * Three ways to be invalid and they are all silent failures if missed: expired, a different
 * question, or nothing actually completed. The last one matters because a round with no executed
 * tools has nothing to save and resuming it would skip straight to the final answer with an empty
 * transcript.
 */
export function isResumableFor(round: ResumableRound | null | undefined, prompt: string, now: number): round is ResumableRound {
	if (!round) return false;
	if (!round.messages.length || !round.executedTools.length) return false;
	if (now - round.savedAt > RESUMABLE_TTL_MS) return false;
	return round.prompt === prompt;
}

/**
 * Build the round to store, or `null` when there is nothing worth storing.
 *
 * Returns null rather than an empty round so the caller has one thing to check. Over the byte
 * ceiling it also returns null: falling back to today's behaviour (re-run the tool) is always
 * correct, where storing a truncated round would feed the model a `tool_result` that answers a
 * `tool_use` it can no longer see.
 */
export function buildResumableRound(input: Omit<ResumableRound, "savedAt">, now: number): ResumableRound | null {
	if (!input.messages.length || !input.executedTools.length) return null;
	const round: ResumableRound = { ...input, savedAt: now };
	let size: number;
	try {
		size = JSON.stringify(round).length;
	} catch {
		// A content block that will not serialize cannot be stored, and must not take down the
		// error path that is already handling a failure.
		return null;
	}
	return size > RESUMABLE_MAX_BYTES ? null : round;
}

/** The transcript line for a turn that continued from results already in hand. */
export const RESUMED_NOTICE = "Continued from the tool results already fetched — the tools from the failed attempt were not run again.";

/**
 * Attach a resumable round to a thrown error, the way `withPartialToolLog` attaches the log.
 *
 * The same seam for the same reason: `runAgentThink` does not own storage, and the DO does. The
 * error is the only thing that crosses between them on this path.
 */
export function withResumableRound(err: unknown, round: ResumableRound | null): unknown {
	if (round && err && typeof err === "object") {
		(err as { resumableRound?: ResumableRound }).resumableRound = round;
	}
	return err;
}

/** Read one back off an error, without asserting anything about the error's type. */
export function resumableRoundOf(err: unknown): ResumableRound | null {
	if (!err || typeof err !== "object") return null;
	return (err as { resumableRound?: ResumableRound }).resumableRound ?? null;
}
