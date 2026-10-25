/**
 * #1189: a queued objective waiting on an offline runner has an upper bound. Real schema; the cron sweep, the store's clock
 * column and the drain-time check are driven for real, with the runner's availability the only thing scripted.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./d1-sqlite.js";
import { cancelQueueEntry, dequeueNext, enqueueObjective, requeueEntry } from "./objective-queue.js";
import { offlineWaitExpired, offlineWaitSentence, QUEUE_OFFLINE_MAX_MS } from "./objective-queue-offline.js";
import { failExpiredOfflineWaits } from "./objective-queue-start.js";
import { RUNNER_PARK_MS } from "./runner-availability.js";
import type { Env } from "../types.js";

const HOUR = 3600_000;
const T0 = Date.parse("2026-10-26T00:00:00Z");
let d1: RealSchemaD1;
let env: Env;

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["i1", "i2"] });
	env = { DB: d1.DB } as unknown as Env;
});
afterEach(() => d1.close());

const row = (id: string) => d1.sqlite.prepare("SELECT status, stop_reason, defer_reason, offline_since, finished_at FROM instance_objective_queue WHERE id = ?").get(id) as {
	status: string;
	stop_reason: string | null;
	defer_reason: string | null;
	offline_since: number | null;
	finished_at: number | null;
};
const lifecycle = (id: string) => d1.sqlite.prepare("SELECT event, reason, actor_kind FROM objective_lifecycle_events WHERE queue_entry_id = ?").all(id) as Array<{ event: string; reason: string | null; actor_kind: string }>;

/** An entry that has been drained and refused once for `reason`, so it is back to pending carrying that reason. */
async function waiting(instanceId: string, reason: string | null, at = T0) {
	const e = await enqueueObjective(env, { instanceId, userId: "u1", repoId: null, objective: "ship it" });
	const claimed = await dequeueNext(env, instanceId, null);
	expect(claimed?.id).toBe(e.id);
	d1.sqlite.prepare("UPDATE instance_objective_queue SET deferred_at = NULL").run();
	const realNow = Date.now;
	Date.now = () => at;
	try {
		await requeueEntry(env, e.id, "No coding runner connected — run `pags up`.", { reason });
	} finally {
		Date.now = realNow;
	}
	return e.id;
}

describe("the bound", () => {
	it("is the day a run parked on its machine gets, so a queued objective is promised no more patience than a running one", () => {
		expect(QUEUE_OFFLINE_MAX_MS).toBe(RUNNER_PARK_MS);
		expect(QUEUE_OFFLINE_MAX_MS).toBe(24 * HOUR);
	});
	it("is reached at the bound, not before; no clock means no bound", () => {
		expect(offlineWaitExpired(T0, T0 + QUEUE_OFFLINE_MAX_MS - 1)).toBe(false);
		expect(offlineWaitExpired(T0, T0 + QUEUE_OFFLINE_MAX_MS)).toBe(true);
		expect(offlineWaitExpired(null, T0 + 10 * QUEUE_OFFLINE_MAX_MS)).toBe(false);
		expect(offlineWaitExpired(undefined, T0)).toBe(false);
	});
	it("fails with a sentence that names how long it waited, the bound, and what to do", () => {
		const s = offlineWaitSentence(T0, T0 + 25 * HOUR);
		expect(s).toContain("waited 25 hours for the runner to come back online");
		expect(s).toContain("the longest a queued objective waits");
		expect(s).toContain("(24 hours)");
		expect(s).toMatch(/pags up.*queue it again/);
	});
});

describe("the clock column", () => {
	it("starts at the first runner_offline deferral and is kept by later ones", async () => {
		const id = await waiting("i1", "runner_offline", T0);
		expect(row(id)).toMatchObject({ status: "pending", defer_reason: "runner_offline", offline_since: T0 });
		// drained again an hour later, still offline: the wait is still measured from the first
		await dequeueNext(env, "i1", null);
		const realNow = Date.now;
		Date.now = () => T0 + HOUR;
		try {
			await requeueEntry(env, id, "still away", { reason: "runner_offline" });
		} finally {
			Date.now = realNow;
		}
		expect(row(id).offline_since).toBe(T0);
	});
	it("is cleared when the entry waits for anything else: the machine was back, and this is a different wait", async () => {
		const id = await waiting("i1", "runner_offline", T0);
		await dequeueNext(env, "i1", null);
		await requeueEntry(env, id, "the repo is busy", { reason: "recovery_required" });
		expect(row(id)).toMatchObject({ defer_reason: "recovery_required", offline_since: null });
		await dequeueNext(env, "i1", null);
		await requeueEntry(env, id, "away again", { reason: "runner_offline" });
		expect(row(id).offline_since).not.toBe(T0); // a NEW stretch, not the old one
		expect(row(id).offline_since).toBeGreaterThan(0);
	});
	it("never starts for a reason that is not an offline runner", async () => {
		for (const reason of ["runner_overloaded", "busy", null]) {
			const id = await waiting("i2", reason);
			expect(row(id).offline_since).toBeNull();
			d1.sqlite.prepare("DELETE FROM instance_objective_queue").run();
		}
	});
});

describe("the cron sweep (a machine that never comes back sends no event)", () => {
	it("fails an entry that has waited the whole bound, with the sentence, and records it as the platform's doing", async () => {
		const id = await waiting("i1", "runner_offline", T0);
		const now = T0 + QUEUE_OFFLINE_MAX_MS + 5 * 60_000;
		expect(await failExpiredOfflineWaits(env, now)).toBe(1);
		const r = row(id);
		expect(r).toMatchObject({ status: "failed", finished_at: now });
		expect(r.stop_reason).toContain("the longest a queued objective waits");
		expect(lifecycle(id)).toEqual([expect.objectContaining({ event: "admission_failed", actor_kind: "platform", reason: expect.stringContaining("longest a queued objective waits") })]);
	});
	it("leaves an entry still inside the bound, and one waiting for anything but an offline runner, however old", async () => {
		const inside = await waiting("i1", "runner_offline", T0);
		const overloaded = await waiting("i2", "runner_overloaded", T0 - 10 * QUEUE_OFFLINE_MAX_MS);
		expect(await failExpiredOfflineWaits(env, T0 + QUEUE_OFFLINE_MAX_MS - 60_000)).toBe(0);
		expect(row(inside).status).toBe("pending");
		expect(row(overloaded).status).toBe("pending");
		expect(await failExpiredOfflineWaits(env, T0 + 100 * QUEUE_OFFLINE_MAX_MS)).toBe(1);
		expect(row(overloaded).status).toBe("pending");
	});
	it("never overwrites an entry that was started or cancelled in the meantime", async () => {
		const id = await waiting("i1", "runner_offline", T0);
		expect(await cancelQueueEntry(env, id, "u1")).toBe(true);
		expect(await failExpiredOfflineWaits(env, T0 + 2 * QUEUE_OFFLINE_MAX_MS)).toBe(0);
		expect(row(id).status).not.toBe("failed");
	});
	it("is idempotent, and a second tick finds nothing", async () => {
		await waiting("i1", "runner_offline", T0);
		const now = T0 + 2 * QUEUE_OFFLINE_MAX_MS;
		expect(await failExpiredOfflineWaits(env, now)).toBe(1);
		expect(await failExpiredOfflineWaits(env, now + 60_000)).toBe(0);
	});
	it("fails every instance's overdue entries in one tick, oldest wait first", async () => {
		const a = await waiting("i1", "runner_offline", T0 + 2 * HOUR);
		const b = await waiting("i2", "runner_offline", T0);
		expect(await failExpiredOfflineWaits(env, T0 + QUEUE_OFFLINE_MAX_MS + 3 * HOUR)).toBe(2);
		expect([row(a).status, row(b).status]).toEqual(["failed", "failed"]);
	});
	it("an unreadable queue is not an error: it answers 0 and the next tick tries again", async () => {
		d1.exec("DROP TABLE instance_objective_queue");
		await expect(failExpiredOfflineWaits(env, T0)).resolves.toBe(0);
	});
});
