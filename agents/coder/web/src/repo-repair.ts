// A repo the machine has looked at and found unusable, and the two-second edit that fixes it (#67).
//
// ── The incident this is about
//
// On 2026-08-08 a `coder-repo` instance was created against
// `~/dev/stores/pas/platform/apps/chess-academy`. The path had one extra segment and did not
// exist; the real checkout was `~/dev/stores/pas/apps/chess-academy`. The clone check said so, in
// its own words, on the repo row. **Three minutes and forty seconds later a SECOND instance was
// subscribed against the same repository** — and that one is the one that has been used ever
// since. The first lived 1m51s, holds five messages and has never run a coding session, and its
// repo row was still being probed four days later.
//
// #67 is the ticket for cleaning up duplicates like that pair. This module is about the other
// half: the product made "subscribe again" the easiest recovery, so the cleanup has to be redone
// every time. Three separate audits on that ticket cancelled duplicates and each time a new one
// appeared within hours — which is the argument for fixing the mechanism rather than the list.
//
// ── Why the affordance was missing
//
// The two halves of the answer existed and never met. The repo row knew it was broken — the
// server writes `clone_status = needs_attention` from a probe that actually looked, with a
// sentence naming the path and the condition (`coding-workdir.ts`). And the folder is editable:
// `updateRepo` takes `workdir`, and `RepoSettingsModal` exposes it as "Folder on your machine",
// which is what #410/#411 built. But the list's banner only NAMED the control — "Point it at the
// real checkout (⚙ Repo settings)" — and the single-repo surface, which is where `coder-repo`
// actually lives, rendered no banner at all: an unusable checkout showed as the two truncated
// words "Path unusable" in a header caption, beside an Open button that would fail.
//
// A sign pointing at a control instead of the control is the exact shape #411 removed once
// already, from the empty state one file over (`AddRepoForm`'s heading comment).
//
// ── Why the wording says what it says
//
// {@link RepoRepairNotice.detail} exists to counter the move that produced the duplicate, at the
// moment the owner is deciding: correcting the path keeps the sessions and the timeline, because
// `coding_sessions` and `coding_timeline` hang off this row — and starting over does not. That is
// a fact about the schema, not encouragement, which is why it can be stated in the platform's
// voice.

/** A repo the machine has looked at and refused, with the remedy. Null when there is nothing wrong. */
export interface RepoRepairNotice {
	/**
	 * The SERVER's sentence when it sent one — it names the path and the condition, and it is the
	 * same sentence the agent is handed to relay (`repo-status-prompt.ts`), so the console and the
	 * chat cannot describe one directory two ways. The fallback is deliberately vaguer than any
	 * real verdict: it is what a client shows when it has a status and no reason, and inventing a
	 * cause there would be the platform guessing in its own voice.
	 */
	sentence: string;
	/**
	 * The label for the control that opens the folder field, or null when this client cannot
	 * justify offering one.
	 *
	 * Null should be unreachable: `needs_attention` is documented as a verdict about a LOCAL path
	 * (`coding-types.ts` — a failed clone is `error`, an unlooked-at path is `unknown`), so a row
	 * carrying it has a `workdir` by construction. It is still handled, because this runs on JSON
	 * from a server the console does not ship with, and offering "fix the folder" for a repo that
	 * has no folder would be a button that cannot work.
	 */
	action: string | null;
	/** What repairing costs against what replacing costs. See the header. */
	detail: string;
}

export const REPO_REPAIR_ACTION = "Fix the folder";

/**
 * What the checkout costs to repair, said where the failure is reported.
 *
 * Names the alternative on purpose. The owner in the incident did not choose a new instance over
 * an edit — they never saw the edit, and a new agent was the only move the screen offered.
 */
export const REPO_REPAIR_DETAIL =
	"Correcting the path keeps this repo's sessions and history — they hang off this row. Subscribing to the agent again would start an empty one beside it instead.";

/** Shown only when the server sent a status with no reason; never a guess at a cause. */
export const REPO_REPAIR_FALLBACK = "This path could not be used on your machine.";

export function repoRepairNotice(repo: { cloneStatus?: string; cloneError?: string; workdir?: string } | null | undefined): RepoRepairNotice | null {
	// The ONE status that is a verdict rather than a stage (`coding-store.ts` says so at the
	// column). `cloning`, `unknown` and `missing_url` are all "not yet", and a banner offering to
	// repair a path nobody has looked at would be the platform crying wolf on its own slowness.
	if (repo?.cloneStatus !== "needs_attention") return null;
	return {
		sentence: (repo.cloneError || "").trim() || REPO_REPAIR_FALLBACK,
		action: (repo.workdir || "").trim() ? REPO_REPAIR_ACTION : null,
		detail: REPO_REPAIR_DETAIL,
	};
}
