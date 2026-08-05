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
// The upsert is inline rather than calling `mirrorRuntimeTask`: that lives in
// `routes/instances-runtime.ts`, and importing a routes module from lib drags the Hono router into
// every caller. `workflows/coding-session.ts` already made the same choice for the same reason
// ("Inline upsert keeps the workflow off a routes import").
import type { Env } from "../types.js";

/** Board status for a session. Maps onto `defaultBoardColumns(["coding"])` with no declaration:
 *  running → "Running", completed/cancelled → "Done"/"Cancelled", failed → "Failed". */
export type CodingCardStatus = "running" | "completed" | "cancelled" | "failed";

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
		...(opts.note ? { description: opts.note.slice(0, 300) } : {}),
		createdAt: opts.now,
		updatedAt: opts.now,
		...(opts.status === "running" ? {} : { completedAt: opts.now }),
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
	await env.DB.prepare(
		`INSERT INTO instance_runtime_tasks (id, instance_id, user_id, type, status, payload, created_at, updated_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, datetime('now'), datetime('now'))
		 ON CONFLICT(id) DO UPDATE SET type = excluded.type, status = excluded.status,
		   payload = excluded.payload, updated_at = excluded.updated_at`,
	)
		.bind(codingCardId(opts.sessionId), opts.instanceId, opts.userId, task.type, task.status, JSON.stringify(task))
		.run()
		.catch(() => undefined);
}

/**
 * Move every card for the given sessions to a terminal status.
 *
 * Needed because a session leaves `active` in FOUR places and only one of them knows the repo
 * name: the explicit end route, the orphan reaper, a `--force` takeover on another machine, and
 * the Pilot workflow's own close. Writing the card only on the route would strand a permanently
 * "running" card on the other three — the exact failure this feature exists to remove, and the
 * same shape as the two stranded-row bugs already memorialised in `coding-session.ts`.
 *
 * Bulk paths therefore patch the STATUS of whatever card exists rather than rebuilding it, so
 * they need no repo name and cannot invent one.
 */
export async function closeCodingSessionCards(
	env: Env,
	instanceId: string,
	userId: string,
	sessionIds: readonly string[],
	status: Exclude<CodingCardStatus, "running">,
): Promise<void> {
	if (!sessionIds.length) return;
	const ids = sessionIds.map((s) => codingCardId(s));
	const placeholders = ids.map((_, i) => `?${i + 4}`).join(",");
	await env.DB.prepare(
		`UPDATE instance_runtime_tasks
		    SET status = ?1,
		        payload = json_set(json_set(payload, '$.status', ?1), '$.updatedAt', datetime('now')),
		        updated_at = datetime('now')
		  WHERE instance_id = ?2 AND user_id = ?3 AND id IN (${placeholders})`,
	)
		.bind(status, instanceId, userId, ...ids)
		.run()
		.catch(() => undefined);
}
