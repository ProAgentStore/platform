// Read and withdraw queued objectives (#788).
//
// A helper module rather than more lines in `routes/tools.ts`, which is already the largest route
// file in the tree and pinned by the #302 ratchet. `registerLoopQueueRoutes(toolRoutes)` is called
// from there at the point in the file these must be registered — see the ORDER note below.
//
// The START side is not here: `queue_if_busy` is a branch inside the existing `POST /loop` handler,
// because "start it, or queue it if you cannot" is one decision and splitting it across two routes
// would let a caller reach the queue without ever attempting the start.

import { objectiveJobKey, objectiveNextFlags } from "../lib/board-order.js";
import type { Hono } from "hono";
import { HttpError, requireUser } from "../lib/auth.js";
import { describeBusyHolder } from "../lib/loop-busy.js";
import { storedHandoff } from "../lib/coding-handoff-store.js";
import { listBlockedOnAnswerWithHolder } from "../lib/blocked-on-answer.js";
import { cancelQueueEntry, getQueueEntry, listQueue, listQueueHistory } from "../lib/objective-queue.js";
import { clientClaimFrom, listLifecycle, recordLifecycle } from "../lib/objective-lifecycle.js";
import { cursorParam } from "../lib/keyset-cursor.js";
import { requireOwnedInstance } from "./instances-runtime.js";
import type { Env } from "../types.js";

/**
 * ORDER MATTERS. Hono matches in registration order, so `/:id/loop/queue` must be registered BEFORE
 * `/:id/loop/:runId` or every read of the queue is answered as a lookup for a run whose id is the
 * literal string "queue" — a 404 that says "loop run not found" and gives no hint why.
 */
export function registerLoopQueueRoutes(router: Hono<{ Bindings: Env }>): void {
	/**
	 * What is queued behind the current run.
	 *
	 * `repo_id` narrows to the ELIGIBLE set for one repo — its own entries plus the repo-agnostic
	 * ones — which is exactly what the next drain of that repo will take from. Without it, everything
	 * still pending on the instance, which is the answer to "what have I lined up".
	 *
	 * Pending only. A queue is what has not happened yet; a started entry's account is its run, and
	 * returning both from one list would put two lifecycles behind one word.
	 */
	router.get("/:id/loop/queue", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("id");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		// `status=all` (#1017): every entry, any status, newest first and paged — what became of each.
		if (c.req.query("status") === "all") {
			// `cursor` (#1017) is the stable continuation; `offset` the weaker legacy one (shifted by entries queued between reads).
			const after = cursorParam(c.req.query("cursor"), "cursor");
			const { more, ...page } = await listQueueHistory(c.env, instanceId, session.uid, { offset: Number(c.req.query("offset")), limit: Number(c.req.query("limit")), after });
			return c.json({ scope: "all", ...page, complete: !more });
		}
		const repoParam = c.req.query("repo_id");
		// In start order (#1097: board order), each with its card key and whether it starts next.
		const pending = await listQueue(c.env, instanceId, repoParam === undefined ? undefined : repoParam || null);
		const next = objectiveNextFlags(pending);
		const entries = pending.map((e, i) => ({ ...e, jobKey: objectiveJobKey(e.id), next: next[i] }));
		// What the queue sits BEHIND, and the starts still on their way INTO it (#935). A start inside
		// its confirmation window has not enqueued anything yet, so a caller that fanned out N
		// `queue_if_busy` starts and then read this saw an empty queue — read as "none of them landed".
		// `describeBusyHolder` is the reading the busy refusal already gives (#886), for the same repo.
		const { activeRun, inFlightStarts } = await describeBusyHolder(c.env, { userId: session.uid, instanceId, repoId: repoParam || undefined }).catch(() => ({ activeRun: null, inFlightStarts: [] }));
		// WHY a non-empty queue may not be draining (#984). An entry that is first in line and still
		// pending has exactly two explanations — something is working, or the repo is mid-handover —
		// and before this only the first was reportable, so a queue held up by an interrupted run's
		// uncommitted work looked like a queue nobody was draining. Stored, never probed: a listing
		// must not make a relay round trip, and the state is cached at each admission attempt.
		const handoff = repoParam ? await storedHandoff(c.env, instanceId, session.uid, repoParam).catch(() => null) : null;
		// Runs parked on a question with their checkout released (#1228): they hold nothing, so the queue
		// runs past them. Listed apart from `activeRun` so a pending answer is never just "waiting".
		const blockedOnAnswer = await listBlockedOnAnswerWithHolder(c.env, instanceId, session.uid, repoParam || undefined).catch(() => []);
		return c.json({
			// Labelled (#1017): an entry leaves this list when it starts, is cancelled or fails admission —
			// `status=all` and `/loop/lifecycle` say what became of it.
			scope: "pending",
			entries,
			activeRun,
			inFlightStarts,
			blockedOnAnswer,
			handoff: handoff ?? (repoParam ? { state: activeRun ? "working" : "safe_to_start_next", detail: "" } : null),
		});
	});

	/**
	 * One objective's lifecycle — or the instance's, oldest first — with a stable `seq` cursor (#1017).
	 * Any one handle (`request_id`, `queue_entry_id`, `run_id`) reconstructs that objective's whole
	 * history through the stored links, and nothing outside it is returned.
	 */
	router.get("/:id/loop/lifecycle", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("id");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		const cursor = c.req.query("cursor");
		if (cursor !== undefined && !/^\d+$/.test(cursor)) throw new HttpError(400, "cursor must be the nextCursor of a previous page");
		const filter = { requestId: c.req.query("request_id") || undefined, queueEntryId: c.req.query("queue_entry_id") || undefined, runId: c.req.query("run_id") || undefined };
		const page = await listLifecycle(c.env, { userId: session.uid, instanceId, filter, afterSeq: cursor ? Number(cursor) : 0, limit: Number(c.req.query("limit")) || undefined });
		// `complete` is paging; `coverage` / `coverage_gaps` say whether the history itself is whole (#1017).
		return c.json({
			...page,
			historyNote:
				"Recorded since migration 0212; recording is best-effort. `coverage` compares this objective's receipt, queue entry and run with its recorded events: `incomplete` names each missing transition in `coverage_gaps` (a lost `deferred` is detectable only while its entry is still pending), `unknown` means it predates the ledger or was not started through a tracked path (or no handle was given). The rows still say what became of it either way.",
		});
	});

	/**
	 * Withdraw a queued objective before it starts.
	 *
	 * 409 rather than 404 when the entry exists but has left `pending`: "you were too late, and here
	 * is what it became" is a different fact from "there is no such entry", and a caller that reads
	 * the second for the first goes looking for a bug in its own id handling.
	 */
	router.delete("/:id/loop/queue/:entryId", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("id");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		const entryId = c.req.param("entryId");
		if (await cancelQueueEntry(c.env, entryId, session.uid)) {
			const entry = await getQueueEntry(c.env, entryId, session.uid);
			await recordLifecycle(c.env, { userId: session.uid, instanceId, queueEntryId: entryId, requestId: entry?.requestId ?? null, event: "cancelled", actor: { kind: "owner", uid: session.uid, clientClaimed: clientClaimFrom(c.req.header("X-PAGS-Client")) } });
			return c.json({ ok: true, status: "cancelled" });
		}
		const existing = await getQueueEntry(c.env, entryId, session.uid);
		if (!existing) throw new HttpError(404, "queued objective not found");
		throw new HttpError(409, `that objective is already ${existing.status} and can no longer be cancelled`);
	});
}
