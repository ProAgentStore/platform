// What pressing Continue would actually carry forward, BEFORE the owner presses it (#806 item 2).
//
// ── The gap this closes
//
// #806 item 2 asks for "a way to review why it stopped — what it had completed, what it was
// mid-way through, what it still intended — before deciding what to do next". Two of those three
// are answerable today and one is not: "what it still intended" is the run's PLAN, which option
// (b) deliberately does not persist (`coding-resume-note.ts`'s header sets out why, and this
// module does not attempt to reconstruct it — a guessed remainder in the platform's voice is the
// thing that header refuses). What it completed, and what is sitting half-written in the tree, the
// platform already knows: it composes exactly that into the resume note at the start of the next
// run.
//
// The problem is WHEN. The note is composed inside the successor's own start, injected into its
// prompt and appended to its timeline — so the owner can read it a minute AFTER committing a
// budget to the run, and not before. The console offers a Continue button and, beside it, the
// stopped run's ending label. Neither says what continuing would inherit.
//
// ── The fact that changes the decision
//
// `lastUnfinishedRunForRepo` takes the most recent FINISHED run on the repo and only then asks
// what ended it. That rule is right — it stops a checkpoint being handed out twice (its own header
// explains the bug) — but it has a consequence nobody can see from outside: a Continue pressed on
// run A carries A's work forward only while A is still the newest finished run on its repo. Let a
// run B reach a verdict in between, and a Continue on A is briefed on NOTHING. It is a plain
// restart that spends a fresh budget, and today it looks identical to one that resumes.
//
// So the preview's job is not to pretty-print a note. It is to answer which of three situations
// the owner is in ({@link ContinueBriefingKind}), and it answers it by running the SAME
// computation the run will run — `pendingCodingResumeCheckpoint`, whose projection is the note
// itself. A second estimate would be a page describing a briefing the run does not get.
//
// ── Why the working tree is tri-state
//
// The uncommitted-file count comes from a live `git status` on the owner's machine, and item 4's
// whole scenario is an owner checking back hours later — when the runner is very likely off. A
// preview that reported `0` there would state a clean tree it never saw, on the exact surface
// built to stop the platform over-claiming. So `workingTree` says whether the read happened, and
// `uncommittedFiles` is null when it did not.
//
// That also makes the preview's note a LOWER BOUND rather than a promise: if the tree is dirty at
// continue time, the real note gains a clause this one could not include. Said in
// {@link CONTINUE_PREVIEW_TREE_UNAVAILABLE} rather than left for the reader to work out.

import type { ResumeCheckpoint } from "./coding-resume-note.js";

/**
 * Which run the briefing would be about — the question the owner cannot answer from the UI today.
 *
 *   * `this-run`  — the run you are looking at. Continue carries its landed work forward.
 *   * `other-run` — a DIFFERENT, more recent unfinished run on the same repo is the immediate
 *                   predecessor, so the new run is briefed on that one instead. Continuing here
 *                   is still useful (the objective is carried) but the checkpoint is not this
 *                   run's, and saying so is the only way the owner can tell.
 *   * `none`      — no briefing at all. Either a run reached a verdict in between (the note's job
 *                   is done), or nothing landed and the tree is clean, or the predecessor is
 *                   outside the lookback. Continue is a restart with a fresh budget.
 */
export type ContinueBriefingKind = "this-run" | "other-run" | "none";

/** Did we manage to look at the checkout, or are we reporting an absence we cannot fill? */
export type WorkingTreeRead = "read" | "unavailable";

/** Said whenever the tree could not be read, so "no uncommitted files" is never implied. */
export const CONTINUE_PREVIEW_TREE_UNAVAILABLE =
	"The working tree could not be read just now (the runner is not connected), so this does not say whether the stopped run left uncommitted changes. If it did, and the machine is back when you continue, the run's briefing will say so.";

/**
 * How many landed acts the preview lists before it switches to a count.
 *
 * Bigger than the note's {@link MAX_LISTED_ACTS} of 8 on purpose, and the difference is not an
 * oversight: the note's cap is a PROMPT budget — every line it spends crowds out the objective it
 * is serving — while this is a page a human scrolls. The two answer to different pressures, so
 * they get different numbers rather than one number that is wrong for both.
 */
export const MAX_PREVIEW_ACTS = 25;

export interface ContinueBriefingPreview {
	kind: ContinueBriefingKind;
	/** The run the briefing is about, or null when there is none. */
	predecessorRunId: string | null;
	/** Acts observed to have landed, newest-first as `actsInWindow` returns them. */
	landed: string[];
	/** How many landed acts exist beyond the ones listed. */
	landedOverflow: number;
	/** Attempted, outcome never observed. A count, never a claim (#594). */
	unobserved: number;
	/** Files uncommitted in the checkout, or null when the tree could not be read. */
	uncommittedFiles: number | null;
	workingTree: WorkingTreeRead;
	/** Stated only when {@link workingTree} is `unavailable`. */
	caveat: string | null;
	/** The exact text the run would be given, or null when it would be given none. */
	note: string | null;
}

/**
 * Compose the briefing half of the preview.
 *
 * Pure, and takes the checkpoint rather than the env: every decision worth a test is here, and the
 * two reads that produce its inputs have no ordering to get wrong. Same reasoning
 * `coding-resume-note.ts` records for keeping its own reads beside its composition.
 *
 * `runId` is the run the OWNER asked about. It is compared against the checkpoint's predecessor
 * rather than assumed equal to it — that comparison is the whole `other-run` case.
 */
export function continueBriefingPreview(
	runId: string,
	checkpoint: ResumeCheckpoint | null,
	tree: { files: number | null; read: WorkingTreeRead },
): ContinueBriefingPreview {
	const caveat = tree.read === "unavailable" ? CONTINUE_PREVIEW_TREE_UNAVAILABLE : null;
	if (!checkpoint) {
		return {
			kind: "none",
			predecessorRunId: null,
			landed: [],
			landedOverflow: 0,
			unobserved: 0,
			uncommittedFiles: tree.files,
			workingTree: tree.read,
			caveat,
			note: null,
		};
	}
	const shown = checkpoint.landed.slice(0, MAX_PREVIEW_ACTS);
	return {
		// A checkpoint whose note is null still has a predecessor, and the owner is still better
		// off knowing which run it is — but the BRIEFING is what this field is about, and there
		// isn't one. `none` is the honest answer to "what would it carry forward".
		kind: checkpoint.note === null ? "none" : checkpoint.predecessorRunId === runId ? "this-run" : "other-run",
		predecessorRunId: checkpoint.predecessorRunId,
		landed: shown.map((a) => a.summary),
		landedOverflow: Math.max(0, checkpoint.landed.length - shown.length),
		unobserved: checkpoint.unobserved.length,
		uncommittedFiles: tree.files,
		workingTree: tree.read,
		caveat,
		note: checkpoint.note,
	};
}

/**
 * One sentence for the owner, derived from the same fields rather than composed beside them.
 *
 * Here and not in the console because the refusal sentences on the POST route are here too, and a
 * surface that phrased "this would carry nothing forward" in its own words would be a second
 * voice for one fact — the divergence `platform-docs` keeps having to re-sync. The console renders
 * this string.
 */
export function continueBriefingSentence(p: ContinueBriefingPreview): string {
	const dirty =
		p.workingTree === "unavailable"
			? ""
			: p.uncommittedFiles && p.uncommittedFiles > 0
				? ` The checkout has ${p.uncommittedFiles} uncommitted file${p.uncommittedFiles === 1 ? "" : "s"}, which the new run is told to read before it writes anything.`
				: "";
	if (p.kind === "none") {
		return `Nothing carries forward: the new run would start from the objective alone${p.workingTree === "unavailable" ? "" : " and whatever is in the repository"}.${dirty}`;
	}
	const landed = p.landed.length + p.landedOverflow;
	const acts = landed > 0 ? `${landed} action${landed === 1 ? "" : "s"} already landed` : "no landed action";
	const unobserved = p.unobserved > 0 ? `, plus ${p.unobserved} whose outcome was never observed and which it is told to verify` : "";
	const whose = p.kind === "this-run" ? "this run" : "a more recent stopped run on the same repository";
	return `The new run would be told what ${whose} left behind — ${acts}${unobserved}.${dirty}`;
}
