// The two writes a domain needs to put its work on the board (#206, #207A).
//
// A domain owns the SHAPE of its card (`coding-board.ts`, `pipeline-board.ts`); this owns only the
// SQL, so there is one definition of "upsert a card" and "close these cards" rather than one per
// domain. Extracted when the second domain arrived, not before.
//
// Deliberately NOT `mirrorRuntimeTask`: that lives in `routes/instances-runtime.ts`, and importing
// a routes module from lib drags the Hono router into every caller — the same reason
// `workflows/pipeline-run.ts` and `workflows/coding-session.ts` already inline their own.
//
// Every function here is best-effort by construction. Losing a card is a visibility bug; failing
// the operation that triggered the write is a work bug, and strictly worse.
import type { Env } from "../types.js";

/** Upsert one card by id. The `task` object is stored verbatim as the payload. */
export async function upsertWorkCard(
	env: Env,
	opts: { instanceId: string; userId: string; id: string; task: Record<string, unknown> },
): Promise<void> {
	const { task } = opts;
	await env.DB.prepare(
		`INSERT INTO instance_runtime_tasks (id, instance_id, user_id, type, status, payload, created_at, updated_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, datetime('now'), datetime('now'))
		 ON CONFLICT(id) DO UPDATE SET type = excluded.type, status = excluded.status,
		   payload = excluded.payload, updated_at = excluded.updated_at`,
	)
		.bind(opts.id, opts.instanceId, opts.userId, task.type, task.status, JSON.stringify(task))
		.run()
		.catch(() => undefined);
}

/**
 * Move existing cards to another status, patching the payload rather than rebuilding it.
 *
 * Bulk close paths generally don't hold the detail the open path had (a reaper knows a session id
 * and nothing else), so patching keeps whatever title was already written instead of inventing one
 * or wiping it.
 *
 * `openOnly` restricts the write to cards that have NOT already reached a terminal status (#553).
 * A domain uses it where the caller's authority is weaker than whatever wrote the card first: the
 * coding reapers close a session six hours after a run died, and their `"ended"` is a fact about
 * the session being untouched, not about how the work went. Without it, a cron overwrote a run's
 * own `failed` with `completed`. Opt-in, because the pipeline domain has one writer and needs no
 * such rule; see `coding-board.ts` for the full argument.
 */
export async function closeWorkCards(
	env: Env,
	instanceId: string,
	userId: string,
	cardIds: readonly string[],
	status: string,
	opts?: { openOnly?: boolean },
): Promise<void> {
	if (!cardIds.length) return;
	const placeholders = cardIds.map((_, i) => `?${i + 4}`).join(",");
	// The statuses a card is passing THROUGH. Anything else is a verdict somebody recorded, and an
	// `openOnly` caller does not outrank it.
	const guard = opts?.openOnly ? " AND status IN ('running', 'needs_human')" : "";
	await env.DB.prepare(
		`UPDATE instance_runtime_tasks
		    SET status = ?1,
		        payload = json_set(json_set(payload, '$.status', ?1), '$.updatedAt', datetime('now')),
		        updated_at = datetime('now')
		  WHERE instance_id = ?2 AND user_id = ?3 AND id IN (${placeholders})${guard}`,
	)
		.bind(status, instanceId, userId, ...cardIds)
		.run()
		.catch(() => undefined);
}

/**
 * Write a short human progress line onto a card that is still running (#207B).
 *
 * A partial update, NOT an upsert, and guarded on `status = 'running'`. Two reasons:
 * - It cannot resurrect a finished card. A late progress write racing the terminal one would
 *   otherwise flip a completed card back to running — a supervisor would then wait on work that
 *   already finished, which is the exact failure the board exists to prevent.
 * - It needs nothing but the card id, so the caller doesn't have to rebuild the whole record (and
 *   risk rebuilding it WRONG) just to add one line of text.
 */
export async function setWorkCardProgress(
	env: Env,
	instanceId: string,
	userId: string,
	cardId: string,
	progress: string,
): Promise<void> {
	const line = progress.trim().slice(0, 300);
	if (!line) return;
	await env.DB.prepare(
		`UPDATE instance_runtime_tasks
		    SET payload = json_set(json_set(payload, '$.description', ?1), '$.updatedAt', datetime('now')),
		        updated_at = datetime('now')
		  WHERE id = ?2 AND instance_id = ?3 AND user_id = ?4 AND status = 'running'`,
	)
		.bind(line, cardId, instanceId, userId)
		.run()
		.catch(() => undefined);
}
