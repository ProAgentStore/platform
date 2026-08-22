// The platform's own record, rendered for an ENGINE to read (ADR 0005, #693).
//
// ── What was missing
//
// `coding_timeline` is append-only in D1 at 100 000 characters per entry, repo-scoped since #257,
// and interleaves the instructions that were sent, the engine's own output, the Pilot's decisions
// and how turns ended. It is complete enough that a human can reconstruct a run from it — the
// console reloads history from it, and the co-pilot reads a recent slice to answer "what did we
// discuss".
//
// **It was read only ever FOR THE HUMAN. Nothing fed it back INTO an engine.** What the engine got
// on wake was `--resume`, which is a pointer into `~/.claude`: a file on one machine, owned by
// another program, that we cannot read, compact or measure. So every path where that pointer was
// unavailable — past the four-day window, a different engine, a raw engine that never had one, a
// session relocated to another laptop (#694), a `pags up` older than #408 — started stone cold and
// said so politely. ADR 0005 removes that: the timeline is the source of truth for what a run
// knows, and the engine's own memory is an optimisation preferred when present.
//
// ── Reconstruction, not restoration — and the wording is a deliverable
//
// The ADR is explicit that this is the one claim that must never be made: "a brief built from our
// record gives continuity of *understanding*, not a byte-identical context… it must never be
// described to a user as 'as if it never died'." That constraint binds THIS FILE hardest, because
// the preamble below is what the engine itself is told, and an engine told it has its old context
// back will speak to the user as if it does. `SEED_PREAMBLE` therefore says what is missing before
// it says what is present, and instructs the engine to verify rather than assume — the failure this
// prevents is not a wrong answer, it is a confident one about a working tree that has moved on.
//
// ── Why the budget is here and not left to the model
//
// The ADR names compaction as a cost this change takes on ("owning the conversation means owning
// its growth… an unbounded brief is a token bill that grows every turn"). The brief is delivered
// ONCE, on the first turn of a cold engine, so it is not literally per-turn — but it does enter a
// context that is re-sent every turn afterwards, which is the same bill with a slower start. So it
// is bounded twice: per entry, so one 100 000-character terminal snapshot cannot be the whole
// brief, and in total.
//
// PURE. The D1 read is one function at the bottom and everything above it is testable without an
// `Env`, for the same reason `resolveSessionContinuity` is pure: what the engine is told is a
// product decision, and a product decision embedded in a query is one nobody re-reads.

import { loadRepoTimeline, type TimelineEntry, type TimelineType } from "./coding-timeline.js";
import type { Env } from "../types.js";

/** How many timeline rows the brief is built from. Newest-last after the read reverses them. */
export const SEED_BRIEF_ENTRIES = 60;

/**
 * Total size of the rendered brief.
 *
 * Roughly three thousand tokens — enough to carry a session's worth of instructions and outcomes,
 * small enough that it is a fraction of the context a coding engine allocates for a repository it
 * is about to read anyway. Bigger would be easy and would be the wrong trade: the value of a brief
 * is that it is a summary someone bounded, and a transcript pasted whole is exactly the "bloated
 * transcript" the ADR says a curated brief beats.
 */
export const SEED_BRIEF_MAX_CHARS = 12_000;

/** Per-entry ceiling for a terminal snapshot — the TAIL, which is where a run's outcome is. */
const TERMINAL_CHARS = 700;

/** Per-entry ceiling for everything else — the HEAD, which is where an instruction's point is. */
const NARRATIVE_CHARS = 1_200;

/**
 * How each timeline row is introduced to the engine.
 *
 * Deliberately NOT the labels `contextForCopilot` uses. Those are written from the co-pilot's
 * seat ("You(user)", "You(copilot)") and the reader here is the engine, for whom "you" is a third
 * party: `chat_assistant` is the co-pilot talking ABOUT the engine to the human, and an engine that
 * reads those lines as its own words will attribute to itself a summary it never wrote.
 */
const LABEL: Record<TimelineType, string> = {
	chat_user: "the user said",
	chat_assistant: "the co-pilot told the user",
	command: "an instruction sent to the engine",
	terminal: "engine output (tail)",
	brain: "the Pilot decided",
	outcome: "outcome",
	system: "the platform noted",
};

/**
 * What the engine is told about the brief before it reads a word of it.
 *
 * Every sentence is load-bearing and none of it is decoration:
 *
 *  - **"NOT your previous conversation"** first, because the ADR's one prohibited claim is the one
 *    an engine would otherwise make on the user's behalf.
 *  - **What is missing, named.** File contents, tool state and un-narrated reasoning are the three
 *    things `coding_timeline` structurally cannot hold, and an engine that knows which parts are
 *    absent asks about them instead of inventing them.
 *  - **"the working tree may have moved on"**, because between the reap and this turn a human may
 *    have committed, rebased or reverted. A brief that reads as current state is how an engine
 *    re-does finished work or edits a file that no longer exists.
 *  - **"background for the instruction that follows"**, because the brief is prepended to a real
 *    turn. Without it the engine treats the last line of the brief as the request.
 */
export const SEED_PREAMBLE = [
	"[pags] CONTEXT BRIEF — reconstructed by ProAgentStore from its own record of this repository.",
	"",
	"This is NOT your previous conversation. That conversation is gone; what follows is a summary the",
	"platform assembled from what it logged: instructions that were sent, output you produced, and how",
	"turns ended. Detail has been lost — file contents, tool state, and anything you worked out but",
	"never said are not in here, and the working tree may have moved on since. Treat this as BACKGROUND",
	"for the instruction that follows it, not as the instruction. Do not redo work described as done,",
	"do not assume anything here is still true of the files on disk, and check rather than guess. If",
	"something you need is missing from it, say so instead of filling the gap.",
].join("\n");

/** Closing marker, so the engine can tell the reconstruction from the live request. */
export const SEED_CLOSING = "END OF BRIEF. The instruction follows.";

/**
 * One rendered line, or "" when the row carries nothing worth a line.
 *
 * The `typeof` guard is not defensive noise. These rows come off D1, where `content` is nullable in
 * principle and absent in practice on any row written before a column existed, and this function is
 * called on the critical path of OPENING A SESSION. A `TypeError` here would propagate out of
 * `seedBriefForRepo` past the read's own `.catch` and fail the launch — turning a missing memory
 * into a missing session, which is the one trade this whole file is not allowed to make.
 */
function renderEntry(e: TimelineEntry): string {
	const content = typeof e?.content === "string" ? e.content : "";
	const body = (e.type === "terminal" ? content.slice(-TERMINAL_CHARS) : content.slice(0, NARRATIVE_CHARS)).trim();
	if (!body) return "";
	return `[${LABEL[e.type] ?? e.type}] ${body}`;
}

/**
 * Render a repo's recent timeline as a brief an engine can be seeded with. `""` when there is
 * nothing to say — an empty brief must be an empty STRING, never a preamble with no content, which
 * would tell an engine it has history and then show it none.
 *
 * Entries arrive oldest-first (as `loadRepoTimeline` returns them) and the budget is spent from the
 * NEWEST backwards, because the tail of the record is what the next instruction will refer to. The
 * result is still rendered oldest-first: a reader that has to work out the direction of time is a
 * reader that will get it wrong.
 */
export function composeSeedBrief(entries: TimelineEntry[], opts: { repoName?: string } = {}): string {
	if (!Array.isArray(entries)) return "";
	const lines: string[] = [];
	let budget = SEED_BRIEF_MAX_CHARS;
	for (let i = entries.length - 1; i >= 0; i--) {
		const line = renderEntry(entries[i]);
		if (!line) continue;
		// Stop rather than skip-and-continue: a budget that keeps looking for a smaller line further
		// back produces a brief with a hole in the middle of it, and nothing in the text says so.
		if (line.length + 1 > budget) break;
		budget -= line.length + 1;
		lines.push(line);
	}
	if (!lines.length) return "";
	lines.reverse();
	const where = opts.repoName ? `\n\nRepository: ${opts.repoName}` : "";
	return `${SEED_PREAMBLE}${where}\n\nRecent history, oldest first:\n\n${lines.join("\n")}\n\n${SEED_CLOSING}`;
}

/**
 * The brief for a repo, or `""` when the platform holds no record of it.
 *
 * Never throws. A D1 hiccup here has to degrade to "no brief", which is exactly what every open did
 * before this existed — failing the launch instead would trade a missing memory for a missing
 * session, which is the worse of the two by a distance.
 */
export async function seedBriefForRepo(
	env: Env,
	args: { instanceId: string; userId: string; repoId: string; repoName?: string },
): Promise<string> {
	try {
		const entries = await loadRepoTimeline(env, {
			instanceId: args.instanceId,
			userId: args.userId,
			repoId: args.repoId,
			limit: SEED_BRIEF_ENTRIES,
		});
		// The RENDER is inside the try as well as the read. A `.catch` on the query alone was the
		// first version of this function and it was not enough: a row whose `content` came back
		// undefined threw inside `composeSeedBrief`, past the read's catch, and took down the session
		// open that was waiting on it. The guarantee is about this function, not about one await
		// inside it.
		return composeSeedBrief(entries, { repoName: args.repoName });
	} catch {
		return "";
	}
}
