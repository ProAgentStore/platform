// Read and withdraw queued objectives (#788).
//
// A helper module rather than more lines in `routes/tools.ts`, which is already the largest route
// file in the tree and pinned by the #302 ratchet. `registerLoopQueueRoutes(toolRoutes)` is called
// from there at the point in the file these must be registered — see the ORDER note below.
//
// The START side is not here: `queue_if_busy` is a branch inside the existing `POST /loop` handler,
// because "start it, or queue it if you cannot" is one decision and splitting it across two routes
// would let a caller reach the queue without ever attempting the start.

import type { Hono } from "hono";
import { HttpError, requireUser } from "../lib/auth.js";
import { cancelQueueEntry, getQueueEntry, listQueue } from "../lib/objective-queue.js";
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
		const repoParam = c.req.query("repo_id");
		const entries = await listQueue(c.env, instanceId, repoParam === undefined ? undefined : repoParam || null);
		return c.json({ entries });
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
		if (await cancelQueueEntry(c.env, entryId, session.uid)) return c.json({ ok: true, status: "cancelled" });
		const existing = await getQueueEntry(c.env, entryId, session.uid);
		if (!existing) throw new HttpError(404, "queued objective not found");
		throw new HttpError(409, `that objective is already ${existing.status} and can no longer be cancelled`);
	});
}
