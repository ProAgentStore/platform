// What a NEW run is told about the one the platform cut off before it (#523, item 4).
//
// ── The defect
//
// A run killed by a class that is not resumed — `platform_ceiling`, `provider_stall`,
// `provider_credentials` — loses its plan entirely: `runCodingLoop`'s `actionLog` and `transcript`
// are function-local arrays (`coding-loop.ts`), so they die with the invocation. The next run on
// that session starts from the objective and re-does work that is already pushed. #523 opens with a
// run that closed ten issues and pushed fifteen times; starting it again would have re-implemented
// all ten.
//
// ── Why nothing new is persisted
//
// This is option (b) from the ticket — checkpoint the OBJECTIVE, not the transcript — and it needs
// no new column and no per-step durable write, because the facts are ALREADY durable. Every
// consequential act is an `agent_events` row, and the run's own ending is on `agent_loop_runs` with
// its `stop_reason`. So the checkpoint is not written at all — it is COMPOSED at the start of the
// next run, from what the last one left behind.
//
// The acts are read by TIME WINDOW (`actsInWindow`), never by `trace_id`. That is not a shortcut:
// a run's acts are drained by whichever caller captures first, and the console's 3s terminal poll
// stamps the SESSION id rather than the run id. Keying on the trace would therefore return a run's
// acts only when nobody had the terminal open — arbitrary, and backwards, since an unwatched run is
// the one whose record matters most. `instance-work.ts` says this at the query itself.
//
// Option (a), persisting the action log per Pilot step, would have bought a durable write on every
// step of every run to serve the minority that die, and it restores the model's REASONING, which is
// the part a new run should be forming fresh anyway. What a cut-off run's successor actually needs
// is a truthful statement of what already landed — which is this ticket's own opening complaint.
//
// ── What this note does NOT claim
//
// "What remains." The platform cannot know it: it has the objective and the acts, not the plan that
// connected them. Inventing a remainder would be a guess presented in the platform's voice, and the
// brain would plan against it. So the note states what landed, names it as already done, and tells
// the run to continue from there — the inference is left where the evidence is.
//
// ── ok:true / ok:false / ok:null are three different claims (#594)
//
// The dangerous sentence here is "this is already done" about something that is not. So only acts
// OBSERVED to succeed are listed as landed. An act that FAILED is omitted entirely — repeating it
// may well be the right move. An act whose outcome was never observed (only a stream-json engine
// reports one) is counted but not asserted: it gets a separate clause telling the run to VERIFY.
// Collapsing the third into either of the others is exactly the inversion #594 was filed about.

import { lastInterruptedRunForSession } from "./agent-loop-store.js";
import { type ActItem, actsInWindow } from "./instance-work.js";
import type { Env } from "../types.js";

/**
 * How many landed acts are named before the note switches to a count.
 *
 * Bounded because this text is prepended to every prompt of the resumed run, and an unbounded list
 * of a 26-step run's pushes would crowd out the objective it is supposed to be serving. Eight is
 * enough to recognise the shape of what happened; the tail is a number, which is what a reader
 * needs from it.
 */
export const MAX_LISTED_ACTS = 8;

/** Per-act cap. `toActItem` already clamps a summary to 200; this is the prompt's own budget. */
export const MAX_ACT_CHARS = 120;

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/**
 * The note, or `null` when there is nothing worth saying.
 *
 * Null is the common case and the important one: a run that was cut off having done nothing
 * consequential needs no briefing, and a note that says "nothing landed" is pure prompt noise on
 * every ordinary restart. The ticket's acceptance says "after consequential progress" — this is
 * where that gate lives.
 */
/**
 * Deliberately takes ONLY the acts.
 *
 * The interrupted run's objective is not an input: the new run already carries its own, and they
 * can legitimately differ — an owner who restarts with a narrower objective after a cut-off would
 * be told the old one in the platform's voice and plan against it. Its terminal `detail` is not an
 * input either; that string is composed for a HUMAN reading a board card, vendor advice and all
 * (`coding-run-report.ts`), and the one fact from it worth carrying — that the platform interrupted
 * the run — is stated below in this file's own words.
 */
export function codingResumeNote(acts: ReadonlyArray<ActItem>): string | null {
	// FAILED acts are dropped here and never counted below: "attempted and failed" is not progress
	// to preserve, and a run told to skip it would skip the retry that fixes it.
	const landed = acts.filter((a) => a.ok === true);
	const unobserved = acts.filter((a) => a.ok === null);
	if (!landed.length && !unobserved.length) return null;

	const lines: string[] = [
		"PLATFORM NOTE (not from the human): a previous run on this session was interrupted by the platform before it could report. It was not your objective failing, and it did not finish — but the work below had ALREADY landed and is on the record.",
	];

	if (landed.length) {
		const shown = landed.slice(0, MAX_LISTED_ACTS);
		lines.push("Already done — do NOT do these again:");
		for (const a of shown) lines.push(`- ${truncate(a.summary, MAX_ACT_CHARS)}`);
		const rest = landed.length - shown.length;
		if (rest > 0) lines.push(`- …and ${rest} more action${rest === 1 ? "" : "s"} of the same kind.`);
	}

	if (unobserved.length) {
		// Counted, never listed as done. The engine that ran them reported no outcome, so the only
		// honest instruction is to go and look.
		lines.push(
			`${unobserved.length} further action${unobserved.length === 1 ? " was" : "s were"} attempted whose outcome was never observed. VERIFY ${unobserved.length === 1 ? "it" : "them"} against the repository before repeating ${unobserved.length === 1 ? "it" : "them"}.`,
		);
	}

	lines.push(
		"Check the repository and the issue tracker FIRST, treat the listed work as done, and continue from there rather than starting the objective over.",
	);

	return lines.join("\n");
}

// ── Reading the facts ───────────────────────────────────────────────────────
//
// Kept beside the composition rather than injected behind a `Deps` interface the way
// `coding-pause.ts` does it. That pattern earns its keep when the effects are a WAIT — a poll, a
// tick, an announcement — whose timing is the thing under test. Here the effects are two ordinary
// reads with no ordering to get wrong, and every decision worth a test (which acts count as landed,
// what the note says, when there is no note at all) is already in the pure function above. A second
// file and an interface for a ten-line read would be ceremony, not a seam.

/**
 * The note the next run on this session should be told, or `null` when there is none.
 *
 * Never throws: this sits on the start path of every coding run, and a resume note is an
 * IMPROVEMENT to a run that is otherwise fine. A failed read here must cost the briefing, not the
 * run — so the caller gets `null` and the run starts exactly as it did before #523.
 */
export async function pendingCodingResumeNote(
	env: Env,
	params: { userId: string; instanceId: string; sessionId: string },
	now: number = Date.now(),
): Promise<string | null> {
	try {
		const prev = await lastInterruptedRunForSession(env, params.userId, params.instanceId, params.sessionId, now);
		if (!prev) return null;
		// The window is the interval during which that run was the one driving the session.
		const acts = await actsInWindow(env, params.userId, params.instanceId, prev.startedAt, prev.finishedAt ?? now, 100);
		return codingResumeNote(acts);
	} catch {
		// The briefing is lost, the run is not. `api()`-side errors are already filed durably by the
		// readers themselves; swallowing here would hide nothing that is not recorded elsewhere.
		return null;
	}
}
