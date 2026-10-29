/**
 * `GET /my/activity` surfaces a queued objective the drain could not start (#1404).
 *
 * "the repo freed up, admission failed: Issue #1249 is closed on GitHub. ... The fleet-wide router
 * migration was believed to be running for hours when it never started." The entry left `pending`
 * the instant it failed, so `queueDepth` read 0, and it never became a run, so there was no
 * `lastOutcome` either — an instance in this state was indistinguishable from one that had simply
 * never been asked to do anything. This is the real schema, not a mock: `instance_objective_queue`
 * seeded exactly as `objective-queue-start.ts`'s `finishQueueEntry("failed", ...)` leaves it.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import type { Env } from "../types.js";

vi.mock("../lib/auth.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/auth.js")>("../lib/auth.js");
	return { ...actual, requireUser: async () => ({ uid: "u1", roles: [] }) };
});

const { instanceRoutes } = await import("./instances.js");

let d1: RealSchemaD1;
const NOW = Date.now();

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["i1"] });
});
afterEach(() => d1.close());

async function activity(): Promise<{ instances: Array<Record<string, unknown>> }> {
	const app = new Hono<{ Bindings: Env }>();
	app.route("/v1/instances", instanceRoutes);
	app.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500)));
	const res = await app.request("/v1/instances/my/activity", {}, { DB: d1.DB } as unknown as Env);
	expect(res.status).toBe(200);
	return (await res.json()) as { instances: Array<Record<string, unknown>> };
}

describe("GET /my/activity — a failed admission is visible, not plain idle (#1404)", () => {
	it("an instance with a failed queue entry and NO run reports queueDepth 0, no lastOutcome, and the failure itself", async () => {
		d1.exec(
			`INSERT INTO instance_objective_queue (id, instance_id, user_id, objective, status, stop_reason, created_at, finished_at)
			 VALUES ('objq-1', 'i1', 'u1', 'Implement GitHub issue #1249', 'failed', 'Issue #1249 is closed on GitHub. Pass force: true with force_reason to start it anyway.', ${NOW - 60_000}, ${NOW - 1000})`,
		);
		const { instances } = await activity();
		const i1 = instances.find((i) => i.instanceId === "i1");
		expect(i1).toMatchObject({
			health: "idle",
			queueDepth: 0,
			lastOutcome: null,
			lastAdmissionFailure: {
				queueEntryId: "objq-1",
				reason: "Issue #1249 is closed on GitHub. Pass force: true with force_reason to start it anyway.",
				objective: "Implement GitHub issue #1249",
				failedAt: NOW - 1000,
			},
		});
	});

	it("a still-PENDING entry is unaffected — only a terminal `failed` row is an admission failure", async () => {
		d1.exec(`INSERT INTO instance_objective_queue (id, instance_id, user_id, objective, status, created_at) VALUES ('objq-2', 'i1', 'u1', 'later', 'pending', ${NOW})`);
		const { instances } = await activity();
		const i1 = instances.find((i) => i.instanceId === "i1");
		expect(i1).toMatchObject({ queueDepth: 1, lastAdmissionFailure: null });
	});

	it("only the NEWEST failed entry is reported when an instance has failed admission more than once", async () => {
		d1.exec(
			`INSERT INTO instance_objective_queue (id, instance_id, user_id, objective, status, stop_reason, created_at, finished_at) VALUES
			 ('objq-old', 'i1', 'u1', 'old one', 'failed', 'old reason', ${NOW - 20_000}, ${NOW - 10_000}),
			 ('objq-new', 'i1', 'u1', 'new one', 'failed', 'new reason', ${NOW - 5_000}, ${NOW - 2_000})`,
		);
		const { instances } = await activity();
		const i1 = instances.find((i) => i.instanceId === "i1");
		expect((i1?.lastAdmissionFailure as { queueEntryId: string }).queueEntryId).toBe("objq-new");
	});

	it("an admission failure older than the activity lookback is not reported — same window as a closed run", async () => {
		const stale = NOW - 40 * 24 * 60 * 60 * 1000; // past the 30-day window
		d1.exec(
			`INSERT INTO instance_objective_queue (id, instance_id, user_id, objective, status, stop_reason, created_at, finished_at)
			 VALUES ('objq-stale', 'i1', 'u1', 'ancient', 'failed', 'ancient reason', ${stale}, ${stale})`,
		);
		const { instances } = await activity();
		expect(instances.find((i) => i.instanceId === "i1")).toBeUndefined();
	});
});
