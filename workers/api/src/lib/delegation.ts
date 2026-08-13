// Shared shape for a delegated-goal board task (#155). ONE source of truth for the observable
// "Overseer delegated on your behalf" card — used by both the route that CREATES it (running,
// routes/coding.ts) and the durable Pilot that CLOSES it (workflows/coding-session.ts). Kept in
// lib/ so the workflow doesn't import a routes module.
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
		...(opts.note ? { description: opts.note.slice(0, 300) } : {}),
		createdAt: opts.now,
		updatedAt: opts.now,
	};
}
