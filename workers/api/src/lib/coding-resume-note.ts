// What a NEW run is told about the one before it that ended without a verdict (#523 item 4, #806).
//
// Written for the platform cutting a run off; #806 widened it to the other endings that leave work
// half-done without the run having judged it — a spent step budget, an engine usage window, an empty
// provider balance. Which endings those are is `RESUMABLE_STOP_REASONS` in `agent-loop-store.ts`.
// Everything below about what the note may and may not claim holds for all of them unchanged.
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
// ── Uncommitted work is not an act (#806)
//
// The note was built from `agent_events`, and an edit that was never committed is not an event. So
// the run #806 was filed about — cut off at step 4 of 20 with a good partial fix on disk and nothing
// pushed — briefed its successor about nothing, and the successor found the diff by luck. The count
// comes from the start-of-run `git status` the workflow has ALREADY read (`repo-state-start`), so
// nothing new is captured or stored. What the platform knows is that the tree is dirty NOW and that
// an unfinished run ended on this repo inside the lookback; it did not see who wrote the files, and says so. It
// agrees with the REPOSITORY STATE instruction beside it on the one thing that matters: read it,
// build on it, never discard it. A REPAIR run (#804) is handed zero by the workflow: its brief
// already carries the tree's state in its own words, and exists to deal with exactly that tree.
//
// ── The Pilot's own notes ARE on the record now (#822 → #806 items 1, 2 and 3(b))
//
// Everything above about the plan dying with the invocation was true when it was written, and
// #822 changed one fact under it: a Pilot now records what it `learned` as it goes, and each of
// those is a `brain` row on the session's timeline (`LEARNED_PREFIX`). They were added so the
// Pilot could remember across its OWN steps; they are also, exactly, the part of a stopped run's
// reasoning that survives it — what it had worked out, where it had got to, and very often what it
// meant to do next, in its own words. So the successor is handed them. This is still option (b):
// nothing new is written, no transcript is kept, and the checkpoint is still COMPOSED at the next
// start from rows that already exist.
//
// They are QUOTED, never adopted. "What remains" is still not a claim the platform makes — a note
// that says "next: rebase and push" is the stopped Pilot's intention at the moment it wrote it, not
// a fact about the repository now, and the note says so in as many words. Read by the predecessor's
// own session and run window, the same way its acts are (#809), so a human-opened session shared by
// several runs hands over only the stopped run's notes.
//
// ── ok:true / ok:false / ok:null are three different claims (#594)
//
// The dangerous sentence here is "this is already done" about something that is not. So only acts
// OBSERVED to succeed are listed as landed. An act that FAILED is omitted entirely — repeating it
// may well be the right move. An act whose outcome was never observed (only a stream-json engine
// reports one) is counted but not asserted: it gets a separate clause telling the run to VERIFY.
// Collapsing the third into either of the others is exactly the inversion #594 was filed about.

import { lastUnfinishedRunForRepo, type ResumableStopReason } from "./agent-loop-store.js";
import { LEARNED_MAX, LEARNED_PREFIX } from "./coding-loop.js";
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

/**
 * How many of the stopped Pilot's own notes are handed over — the NEWEST ones (#806).
 *
 * Newest, because a Pilot's notes converge on where it had got to: the last few are the state it
 * stopped in, and the first few are what it learned while still finding its feet. Bounded for the
 * same reason as {@link MAX_LISTED_ACTS} — at `LEARNED_MAX` characters each this is at most ~3,600
 * characters in a prompt that is re-sent on every step of the round.
 */
export const MAX_LEARNED_NOTES = 12;

/**
 * How the note opens, per the way the predecessor ended.
 *
 * Every row says the same two things, because they are what the successor must not get wrong: the
 * run did NOT finish, and it did NOT fail — so its landed work is to be kept, and the objective is
 * still open. What differs is only the cause, and the cause must be the true one: telling a run that
 * spent its step budget it was "interrupted by the platform" would put a false claim in the platform's
 * voice, which is the exact thing #523 was filed against. The `interrupted` row is the pre-#806 text
 * except for one word: "on this session" became "on this repository" when the lookup was re-keyed
 * (#806). The predecessor is usually on an EARLIER session of the repo, so the old word told the run
 * to look for history in a session that does not have it.
 */
const PREDECESSOR_ENDING: Record<ResumableStopReason, string> = {
	interrupted: "a previous run on this repository was interrupted by the platform before it could report. It was not your objective failing, and it did not finish",
	max_iterations: "a previous run on this repository used up its step limit before it could report. It was not your objective failing, and it did not finish",
	engine_limit: "a previous run on this repository stopped because the coding CLI's own usage limit had not reset in time. It was not your objective failing, and it did not finish",
	provider_credit: "a previous run on this repository stopped because the owner's AI provider account ran out of credit. It was not your objective failing, and it did not finish",
};

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/**
 * The three-way split {@link codingResumeNote} composes from, and the preview reports (#806 item 2).
 *
 * Exported so the two cannot drift. The owner's review surface shows what a Continue would carry
 * forward, and if it recomputed "landed" with its own filter, the day the two disagreed the page
 * would be describing a briefing the run does not get — which is worse than showing nothing, and
 * is the failure the whole review surface exists to prevent.
 *
 * FAILED acts (`ok === false`) are in neither list. "Attempted and failed" is not progress to
 * preserve, and a run told to skip it would skip the retry that fixes it (#594).
 */
export function splitActs(acts: ReadonlyArray<ActItem>): { landed: ActItem[]; unobserved: ActItem[] } {
	return { landed: acts.filter((a) => a.ok === true), unobserved: acts.filter((a) => a.ok === null) };
}

/**
 * The note, or `null` when there is nothing worth saying.
 *
 * Null is the common case and the important one: a run that was cut off having done nothing
 * consequential needs no briefing, and a note that says "nothing landed" is pure prompt noise on
 * every ordinary restart. The ticket's acceptance says "after consequential progress" — this is
 * where that gate lives.
 */
/**
 * Deliberately takes ONLY the acts, the stop reason and how many files sit uncommitted at the
 * successor's start (#806 — see the header; zero, the default, is a clean tree or an unknown one).
 *
 * The earlier run's objective is not an input: the new run already carries its own, and they
 * can legitimately differ — an owner who restarts with a narrower objective after a cut-off would
 * be told the old one in the platform's voice and plan against it. Its terminal `detail` is not an
 * input either; that string is composed for a HUMAN reading a board card, vendor advice and all
 * (`coding-run-report.ts`), and the one fact from it worth carrying — WHY the run ended without a
 * verdict — comes from the recorded stop reason and is stated in this file's own words
 * ({@link PREDECESSOR_ENDING}).
 */
export function codingResumeNote(
	acts: ReadonlyArray<ActItem>,
	endedBy: ResumableStopReason,
	uncommittedFiles = 0,
	learned: ReadonlyArray<string> = [],
): string | null {
	const { landed, unobserved } = splitActs(acts);
	const onRecord = landed.length > 0 || unobserved.length > 0;
	if (!onRecord && uncommittedFiles <= 0 && learned.length === 0) return null;

	const lines: string[] = [
		onRecord
			? `PLATFORM NOTE (not from the human): ${PREDECESSOR_ENDING[endedBy]} — but the work below had ALREADY landed and is on the record.`
			: `PLATFORM NOTE (not from the human): ${PREDECESSOR_ENDING[endedBy]} — and nothing it did is on the record as landed.`,
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

	if (uncommittedFiles > 0) {
		// "May be", never "is": the platform saw the tree, not the author (#806). A human's own
		// half-finished edit looks identical from here, and the instruction is the same either way.
		lines.push(
			`The working tree holds ${uncommittedFiles} uncommitted file${uncommittedFiles === 1 ? "" : "s"} right now. The platform did not see who wrote ${uncommittedFiles === 1 ? "it" : "them"}, but ${uncommittedFiles === 1 ? "it" : "they"} may be that run's unfinished work: READ the diff before you write anything, and build on it if it serves your objective rather than writing the same change again. Do NOT discard it.`,
		);
	}

	if (learned.length) {
		// QUOTED, in the stopped Pilot's voice, and dated to when they were written (#806). The one
		// thing this must not become is the platform asserting a plan: an intention recorded before
		// the run stopped is not a fact about the repository the successor is standing in.
		const shown = learned.slice(-MAX_LEARNED_NOTES);
		const earlier = learned.length - shown.length;
		lines.push(
			`That run's Pilot wrote these notes to itself as it worked, oldest first${earlier > 0 ? ` (the last ${shown.length} of ${learned.length})` : ""}. They are ITS words, not something the platform checked: each was true when it was written, and the repository may have moved since. Use them so you do not re-derive what it had already worked out, and verify any one you are about to rely on:`,
		);
		for (const note of shown) lines.push(`- ${truncate(note, LEARNED_MAX)}`);
	}

	lines.push(
		onRecord
			? "Check the repository and the issue tracker FIRST, treat the listed work as done, and continue from there rather than starting the objective over."
			: "Check the repository and the issue tracker FIRST, and continue from what is there rather than starting the objective over.",
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
 * The note the next run on this session's REPO should be told, or `null` when there is none. Keyed on
 * the repo, not the session: a run-opened session is closed when its run ends, so its successor runs
 * on a new one (#806, see {@link lastUnfinishedRunForRepo}).
 *
 * Never throws: this sits on the start path of every coding run, and a resume note is an
 * IMPROVEMENT to a run that is otherwise fine. A failed read here must cost the briefing, not the
 * run — so the caller gets `null` and the run starts exactly as it did before #523.
 *
 * `lookbackMs` is how far back the predecessor may be, and is passed only by a CONTINUE (#806 item
 * 4): the owner named one stopped run, possibly the morning after it stopped, and the default
 * six-hour floor would have briefed that run's successor on nothing. It widens the SEARCH and
 * nothing else — every rule about what the note may claim is downstream of it and untouched.
 */
export async function pendingCodingResumeNote(
	env: Env,
	params: { userId: string; instanceId: string; sessionId: string; uncommittedFiles?: number; lookbackMs?: number },
	now: number = Date.now(),
): Promise<string | null> {
	return (await pendingCodingResumeCheckpoint(env, params, now))?.note ?? null;
}

/**
 * What the next run on this repo WOULD be told, with the facts it was composed from (#806 item 2).
 *
 * The same computation as {@link pendingCodingResumeNote} — that function is now a projection of
 * this one — for a reason that is the whole point of the review surface: the owner deciding
 * whether to press Continue needs to see the briefing the run will ACTUALLY receive, not a second
 * estimate of it. Two code paths answering "what carries forward" is how a page comes to promise
 * work that the run then re-does.
 *
 * The structure is what the note cannot carry. A note is prose for a model; an owner deciding
 * needs to know WHICH run it is about, because the immediate-predecessor rule
 * ({@link lastUnfinishedRunForRepo}) means the answer is sometimes "a different run than the one
 * you are looking at", and sometimes "none at all — a verdict in between ended the note's job".
 * In that case Continue is a plain restart, and that is exactly the fact worth knowing BEFORE
 * spending a budget on it. `note: null` with a non-null checkpoint is a real and distinct state:
 * there IS an unfinished predecessor, and it left nothing worth saying.
 *
 * Never throws, for the same reason as its projection: this sits on the start path of every coding
 * run, and a failed read must cost the briefing, not the run.
 */
export interface ResumeCheckpoint {
	/** The run the note is about. Not necessarily the run a caller asked about — see above. */
	predecessorRunId: string;
	/**
	 * That run's session, which is the window the acts were read over (#809).
	 *
	 * Nullable because `LoopRunView` is. In practice the `JOIN coding_sessions` in
	 * {@link lastUnfinishedRunForRepo} cannot match a row whose `session_id` is null, so a matched
	 * predecessor always has one — but that is a fact about the query, not one the type can see,
	 * and asserting it here would be a claim with nothing holding it up.
	 */
	predecessorSessionId: string | null;
	endedBy: ResumableStopReason;
	/** Acts OBSERVED to have landed, in the order the note lists them. */
	landed: ActItem[];
	/** Acts attempted whose outcome was never observed. Counted, never asserted as done (#594). */
	unobserved: ActItem[];
	/** What the caller told us was sitting uncommitted; zero is a clean tree or an unknown one. */
	uncommittedFiles: number;
	/**
	 * Everything the stopped run's Pilot recorded as `learned`, oldest first, without the prefix (#806).
	 * All of them: the note carries only the newest {@link MAX_LEARNED_NOTES}, the review surface may show more.
	 */
	learned: string[];
	/** Exactly the text the successor is given, or null when there is nothing worth saying. */
	note: string | null;
}

/** Read cap for one run's notes. A 50-step run writing one per step fits; nothing sane exceeds it. */
const LEARNED_READ_LIMIT = 100;

/**
 * What one run's Pilot recorded as `learned`, oldest first, prefix stripped (#822, #806).
 *
 * By SESSION and by the run's own interval, like its acts (#809): a session a human opened outlives
 * its runs, so the session alone would hand run B the notes of a run A that reached its verdict.
 * `coding_timeline.created_at` is SQLite's `datetime('now')` — UTC, whole seconds — while a run's
 * bounds are milliseconds, so a note written in the run's first second is stamped BEFORE its start.
 * The window is therefore widened to the second on both sides: losing a note to a rounding edge is
 * the failure, and one extra from a neighbouring second is not one.
 */
export async function learnedInWindow(env: Env, sessionId: string | null, fromMs: number, toMs: number): Promise<string[]> {
	if (!sessionId) return [];
	const res = await env.DB.prepare(
		`SELECT content FROM coding_timeline
		  WHERE session_id = ?1 AND type = 'brain' AND substr(content, 1, ?5) = ?4
		    AND created_at >= datetime(?2, 'unixepoch') AND created_at <= datetime(?3, 'unixepoch')
		  ORDER BY seq DESC LIMIT ?6`,
	)
		.bind(sessionId, Math.floor(fromMs / 1000), Math.ceil(toMs / 1000), LEARNED_PREFIX, LEARNED_PREFIX.length, LEARNED_READ_LIMIT)
		.all<{ content: string }>();
	// Newest-first from the query so the cap drops the OLDEST; handed back oldest-first, as written.
	return (res.results ?? []).reverse().map((r) => r.content.slice(LEARNED_PREFIX.length).trim()).filter(Boolean);
}

export async function pendingCodingResumeCheckpoint(
	env: Env,
	params: { userId: string; instanceId: string; sessionId: string; uncommittedFiles?: number; lookbackMs?: number },
	now: number = Date.now(),
): Promise<ResumeCheckpoint | null> {
	try {
		const prev = await lastUnfinishedRunForRepo(env, params.userId, params.instanceId, params.sessionId, now, params.lookbackMs);
		if (!prev) return null;
		// That run's OWN session over the interval it drove it (#809) — not `params.sessionId`, which since
		// #806 is usually a different, later session of the same repo.
		const acts = await actsInWindow(env, params.userId, params.instanceId, prev.sessionId, prev.startedAt, prev.finishedAt ?? now, 100);
		// Its own failure costs the notes, not the acts: what LANDED is the half a successor must not
		// lose, and the notes are an improvement to a briefing that is otherwise whole.
		const learned = await learnedInWindow(env, prev.sessionId, prev.startedAt, prev.finishedAt ?? now).catch(() => []);
		const uncommittedFiles = params.uncommittedFiles ?? 0;
		const { landed, unobserved } = splitActs(acts);
		return {
			predecessorRunId: prev.runId,
			predecessorSessionId: prev.sessionId,
			endedBy: prev.stopReason,
			landed,
			unobserved,
			uncommittedFiles,
			learned,
			note: codingResumeNote(acts, prev.stopReason, uncommittedFiles, learned),
		};
	} catch {
		// The briefing is lost, the run is not. `api()`-side errors are already filed durably by the
		// readers themselves; swallowing here would hide nothing that is not recorded elsewhere.
		return null;
	}
}
