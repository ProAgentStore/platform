// Shared shape for a delegated-goal board task (#155). ONE source of truth for the observable
// "Overseer delegated on your behalf" card — used by both the route that CREATES it (running,
// routes/coding.ts) and the durable Pilot that CLOSES it (workflows/coding-session.ts). Kept in
// lib/ so the workflow doesn't import a routes module.
import { actHeadline, type CardAct, cardDetail } from "./card-detail.js";
import type { LoopRunStatus } from "./agent-loop.js";

/** Build the board-task record for a delegated goal. Attributed to the Overseer on the user's
 *  behalf — never a user turn. `note` (e.g. the terminal outcome) is appended to the reasoning. */
export function delegationTaskRecord(opts: {
	id: string;
	/** Human name of whatever the goal went TO — a repo today, an instance once supervision is
	 *  configurable (#183). Generic so the board card doesn't have to be re-shaped per target
	 *  kind; the rendered text is unchanged for repos. */
	targetLabel: string;
	objective: string;
	/**
	 * The run's status, from `statusFor` — NOT a local ok/fail judgement (#553).
	 *
	 * It was `"running" | "completed" | "failed"` off `runSucceeded(outcome)`, which meant a
	 * delegated run that stopped waiting on the owner was closed `failed` on the board while its
	 * own loop-run row said `needs_human`. Two records of one run, in different columns. `#541`
	 * made that reachable by letting an unanswered handoff survive as `stuck` instead of being
	 * rewritten to `failed` first, and `#546` added a second way in.
	 */
	status: "running" | LoopRunStatus;
	now: string;
	note?: string;
	/**
	 * What the run DID, as records rather than as prose (#568).
	 *
	 * The note already ENDS with `summarizeActs`' sentence, and that is exactly the problem: the
	 * acts are its LAST clause, and the "and N more" carrying the real total begins past character
	 * 300 — so a run that pushed to `origin main` fourteen times had a card naming two of them.
	 * Passed as data so {@link actHeadline} can state the COUNT before anything competes for the
	 * space; the card cannot recover a fact the writer flattened away.
	 *
	 * Absent on the card's `running` write, which carries no note either; the count is only knowable
	 * once the run has ended.
	 */
	acts?: readonly CardAct[];
}): Record<string, unknown> {
	const label = opts.objective.length > 120 ? `${opts.objective.slice(0, 117)}…` : opts.objective;
	const reasoning = `Overseer delegated on your behalf → ${opts.targetLabel}: ${opts.objective}${opts.note ? ` — ${opts.note}` : ""}`.slice(0, 8000);
	return {
		id: opts.id,
		type: "delegation",
		status: opts.status,
		title: `Delegated: ${label}`.slice(0, 200),
		reasoning,
		// ALSO as `description`, because that is the field every generic reader takes a card's
		// one-line detail from (`board.ts`, and `instance-work.ts` for a supervisor) — `reasoning`
		// is in neither chain, so the outcome text reached the console and nothing else. While the
		// run is live this field carries the Pilot's progress line instead (#207B); the terminal
		// write replaces it with what actually happened.
		//
		// BUDGETED, not `note.slice(0, 300)` (#568). That prefix cut the acts off the end of the
		// note and left a sentence that read as finished, so a card for a run that pushed to the
		// trunk fourteen times named two pushes and gave the reader no reason to think anything was
		// missing. `cardDetail` puts the count first and marks whatever it cuts; the complete text
		// stays on `reasoning` above, which `board.ts` returns alongside the detail it cut.
		...(opts.note ? { description: cardDetail(opts.note, actHeadline(opts.acts ?? [])) } : {}),
		createdAt: opts.now,
		updatedAt: opts.now,
	};
}
