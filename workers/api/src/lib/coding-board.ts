// A coding session as a GENERIC board record (#206).
//
// Mirrors `lib/delegation.ts`, whose comment states the pattern: "Generic so the board card
// doesn't have to be re-shaped per target kind." The coding domain owns the SHAPE; what it emits
// is an ordinary `instance_runtime_tasks` row that any reader — the console board, MCP, a
// supervisor — understands without knowing what tmux is.
//
// Why this exists: a human-driven coding session (the Coding tab, not a delegation) wrote only
// `coding_sessions`. It produced no board card and no loop run, so a supervisor could not answer
// "is anyone working in the API repo right now" — the most common case, and half of what the
// hardcoded Overseer assembles per repo. Rather than let supervision read `coding_sessions` (the
// coupling reverted in 3f14bd3), the domain writes a record supervision already reads.
//
// The SQL lives in `work-card.ts`, shared with the other domains that put work on the board; this
// module owns only the card's SHAPE.
import { cardDetail } from "./card-detail.js";
import { closeWorkCards, upsertWorkCard } from "./work-card.js";
import type { LoopRunStatus } from "./agent-loop.js";
import type { Env } from "../types.js";

/**
 * Board status for a session. Maps onto `defaultBoardColumns(["coding"])` with no declaration:
 * running → "Running", needs_human → "Needs you", completed/cancelled → "Done"/"Cancelled",
 * failed → "Failed".
 *
 * Written as `"running" | LoopRunStatus` rather than spelled out, because the terminal half IS
 * the loop run's status (#553): the card, the loop-run row and the delegation card all describe
 * one run, and this is what stops them being able to disagree about it. `LoopRunStatus` is what
 * `statusFor` returns, so adding a stop reason cannot produce a card status the board has no
 * column for — `coding-board.test.ts` asserts that over every declared reason.
 *
 * `needs_human` arrived last, and its absence was the defect: three Pilot runs sat waiting on the
 * owner for 15 minutes each with `grep -c needs_human workflows/coding-session.ts` returning 0,
 * while both peer workflows had it. The push notification fired for all four handoffs. The board —
 * the durable surface, with a column literally named for this — showed three successes and one
 * in-flight job for four dead runs.
 */
export type CodingCardStatus = "running" | LoopRunStatus;

/**
 * Is this a status the card RESTS at, or one it is passing through?
 *
 * `needs_human` is not terminal. It is the run parked mid-flight waiting for somebody, and it goes
 * back to `running` when they answer — so it must not carry `completedAt`, which is what the board
 * and every reader treat as "this finished at".
 */
export function isCodingCardOpen(status: CodingCardStatus): boolean {
	return status === "running" || status === "needs_human";
}

/** Stable per-session card id, so every transition upserts the SAME row rather than piling up. */
export const codingCardId = (sessionId: string): string => `csess-${sessionId}`;

export function codingSessionTaskRecord(opts: {
	sessionId: string;
	repoName: string;
	engine: string;
	status: CodingCardStatus;
	now: string;
	note?: string;
}): Record<string, unknown> {
	return {
		id: codingCardId(opts.sessionId),
		type: "coding.session",
		status: opts.status,
		title: `Coding: ${opts.repoName}`.slice(0, 200),
		subtitle: opts.engine,
		// Marked when it is cut (#568). This was the same blind `note.slice(0, 300)` the delegation
		// card carried, and the reason to fix both at once is that neither reader can tell which
		// writer produced the card it is looking at: a detail that ends mid-word has to mean the
		// same thing everywhere, or "it just ends there" stays a plausible reading of a full one.
		// No act headline here — a session card is written by the session, which has no run's acts.
		...(opts.note ? { description: cardDetail(opts.note) } : {}),
		createdAt: opts.now,
		updatedAt: opts.now,
		...(isCodingCardOpen(opts.status) ? {} : { completedAt: opts.now }),
	};
}

/**
 * Upsert the card for one session. Best-effort by design: a board write must never fail the
 * session operation that triggered it — losing a card is a visibility bug, losing the session is
 * a work bug.
 */
export async function upsertCodingSessionCard(
	env: Env,
	opts: { instanceId: string; userId: string; sessionId: string; repoName: string; engine: string; status: CodingCardStatus; note?: string },
): Promise<void> {
	const now = new Date().toISOString();
	const task = codingSessionTaskRecord({ ...opts, now });
	await upsertWorkCard(env, { instanceId: opts.instanceId, userId: opts.userId, id: codingCardId(opts.sessionId), task });
}

/**
 * THE RUN'S verdict on its own card. Unconditional, because the run is the authority (#553).
 *
 * A card is about the WORK, and the run is the only thing that knows how the work went. It writes
 * `running` when it starts, `needs_human` when it parks in a handoff, and `statusFor(reason)` when
 * it ends — whatever the session is doing, and whether or not the run owns the session.
 *
 * Patches the STATUS of whatever card exists rather than rebuilding it: an upsert would overwrite
 * `$.description`, which is the live progress line `setWorkCardProgress` maintains (#207B).
 */
export async function setCodingSessionCardStatus(
	env: Env,
	instanceId: string,
	userId: string,
	sessionId: string,
	status: CodingCardStatus,
): Promise<void> {
	await closeWorkCards(env, instanceId, userId, [codingCardId(sessionId)], status);
}

/**
 * THE SESSION'S verdict. Only ever fills a card the run left open — see `openOnly` below.
 *
 * Needed because a session leaves `active` in FIVE places and only one of them knows the repo
 * name: the explicit end route, the idle reaper, the orphan reconciler, a `--force` takeover on
 * another machine, and the Pilot workflow's own close. Writing the card only on the route would
 * strand a permanently "running" card on the other four — the exact failure this feature exists to
 * remove, and the same shape as the two stranded-row bugs memorialised in `coding-session.ts`.
 *
 * ## Why it cannot overwrite a terminal card (#553)
 *
 * This is what produced "the board showed three dead runs as completed". `endSession` maps
 * `error → failed` and EVERYTHING ELSE → `completed`, and four of its five callers pass the
 * default `"ended"`. Two of them are crons: the 6-hour idle reaper (`reapSession`) and the orphan
 * reconciler. So a run that died could have its card written `completed` hours later by a sweep
 * whose `"ended"` is a statement about the session being untouched, not about the work.
 *
 * The issue guessed the End button or a `--force` takeover. Neither: `--force` writes `cancelled`,
 * and the End button is a human act. The reapers are the ones that say `completed` silently, on a
 * schedule, with nobody there.
 *
 * `openOnly` is the same rule `setWorkCardProgress` already states for the other direction ("it
 * cannot resurrect a finished card"), applied to the close. Together they mean the card can only
 * move in one direction once a run has spoken.
 */
export async function closeCodingSessionCards(
	env: Env,
	instanceId: string,
	userId: string,
	sessionIds: readonly string[],
	status: Exclude<CodingCardStatus, "running" | "needs_human">,
): Promise<void> {
	await closeWorkCards(env, instanceId, userId, sessionIds.map(codingCardId), status, { openOnly: true });
}
