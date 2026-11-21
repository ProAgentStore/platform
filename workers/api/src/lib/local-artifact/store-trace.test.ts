import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "../d1-sqlite.js";
import { createTailorRun, getTailorRun, MAX_TRACE, updateTailorRun, type TailorRun, type TailorRunPolicy, type TraceEvent } from "./store.js";

let d1: RealSchemaD1;
let env: { DB: D1Database };
const policy = { maxMinutes: 10 } as TailorRunPolicy;
const runner = (n: number): TraceEvent => ({ type: "note", at: new Date(n * 1000).toISOString(), seq: n }) as TraceEvent;
const platform: TraceEvent = { type: "run.ended", at: new Date(100_000).toISOString(), detail: { status: "failed" } };
const read = async (): Promise<TailorRun> => (await getTailorRun(env, "tailor", "u", "run"))!;

beforeEach(async () => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u", instanceIds: ["tailor"] });
	d1.exec("INSERT INTO job_applications(id, instance_id, user_id, source_instance_id, lead_id, lifecycle_version, idempotency_key, status, lead, created_at, updated_at) VALUES ('app','tailor','u','scout','lead',1,'k','tailoring','{}',1,1)");
	env = { DB: d1.DB };
	await createTailorRun(env, { id: "run", instanceId: "tailor", userId: "u", applicationId: "app", requestId: "r", policy, trace: [], now: 1 });
	await updateTailorRun(env, await read(), { to: "running" }, 2);
});
afterEach(() => d1.close());

describe("tailor trace persistence (#1525)", () => {
	it("keeps events a concurrent writer persisted when a stale same-status snapshot appends", async () => {
		const stale = await read();
		await updateTailorRun(env, await read(), { events: [runner(1), runner(2)], runnerSeq: 2 }, 3);
		expect(await updateTailorRun(env, stale, { events: [platform] }, 4)).not.toBeNull();
		expect(await read()).toMatchObject({ trace: [runner(1), runner(2), platform], runnerSeq: 2 });
	});

	it("persists an overlapping runner batch once and refuses an older cursor", async () => {
		const stale = await read();
		await updateTailorRun(env, stale, { events: [runner(1), runner(2)], runnerSeq: 2 }, 3);
		await updateTailorRun(env, await read(), { events: [runner(2), runner(3)], runnerSeq: 3 }, 4);
		expect((await read()).trace).toEqual([runner(1), runner(2), runner(3)]);
		expect(await updateTailorRun(env, stale, { events: [runner(1), runner(2)], runnerSeq: 2 }, 5)).toBeNull();
		expect(await read()).toMatchObject({ trace: [runner(1), runner(2), runner(3)], runnerSeq: 3 });
	});

	it("still retains the first MAX_TRACE events", async () => {
		await updateTailorRun(env, await read(), { events: Array.from({ length: MAX_TRACE + 5 }, (_, i) => runner(i + 1)), runnerSeq: MAX_TRACE + 5 }, 3);
		const trace = (await read()).trace;
		expect(trace).toHaveLength(MAX_TRACE);
		expect(trace[0]).toEqual(runner(1));
		expect(trace[MAX_TRACE - 1]).toEqual(runner(MAX_TRACE));
	});
});
