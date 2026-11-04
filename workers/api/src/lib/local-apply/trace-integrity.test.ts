import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "../d1-sqlite.js";
import { getApplyRun, insertApplyRun, MAX_APPLY_TRACE, updateApplyRun, type ApplyRun, type ApplyRunPolicy, type ApplyTraceEvent } from "./store.js";

let d1: RealSchemaD1;
let env: { DB: D1Database };
const policy = { mode: "fill_and_review", limits: { maxMinutes: 20 } } as ApplyRunPolicy;
const event = (n: number): ApplyTraceEvent & { seq: number } => ({ type: "field.filled", at: new Date(n * 1000).toISOString(), seq: n, detail: { target: `field ${n}` } });
const checkpoint: ApplyTraceEvent = { type: "policy.decision", at: new Date(100_000).toISOString(), detail: { decision: "request_review" } };
const read = async (): Promise<ApplyRun> => (await getApplyRun(env, "runner", "u", "run"))!;

beforeEach(async () => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u", instanceIds: ["runner"] });
	env = { DB: d1.DB };
	await insertApplyRun(env, { id: "run", instanceId: "runner", userId: "u", applicationId: "app", requestId: "request", policy, trace: [], now: 1 });
	await updateApplyRun(env, await read(), { to: "paused" }, 2);
});
afterEach(() => d1.close());

describe("application trace persistence (#1524)", () => {
	it("retains runner evidence when a checkpoint appends from a stale same-status snapshot", async () => {
		const stale = await read();
		await updateApplyRun(env, await read(), { events: [event(1), event(2)], runnerSeq: 2 }, 3);
		expect(await updateApplyRun(env, stale, { events: [checkpoint] }, 4)).not.toBeNull();
		expect((await read()).trace).toEqual([event(1), event(2), checkpoint]);
		expect((await read()).runnerSeq).toBe(2);
	});

	it("merges overlapping poll batches once by runner sequence, retaining intervening platform events", async () => {
		const stale = await read();
		await updateApplyRun(env, stale, { events: [event(1), event(2)], runnerSeq: 2 }, 3);
		await updateApplyRun(env, await read(), { events: [checkpoint] }, 4);
		await updateApplyRun(env, stale, { events: [event(1), event(2), event(3)], runnerSeq: 3 }, 5);
		expect((await read()).trace).toEqual([event(1), event(2), checkpoint, event(3)]);
		await updateApplyRun(env, stale, { events: [event(1), event(2), event(3)], runnerSeq: 3 }, 6);
		expect((await read()).trace).toEqual([event(1), event(2), checkpoint, event(3)]);
	});

	it("refuses an older runner response without regressing pause, trace or cursor", async () => {
		const stale = await read();
		const pause = { reason: "missing_answer" as const, question: "Current question?" };
		await updateApplyRun(env, stale, { pause, events: [event(1), event(2)], runnerSeq: 2 }, 3);
		expect(await updateApplyRun(env, stale, { to: "running", pause: null, events: [event(1)], runnerSeq: 1 }, 4)).toBeNull();
		expect(await read()).toMatchObject({ status: "paused", pause, runnerSeq: 2, trace: [event(1), event(2)] });
	});

	it("finalization preserves concurrent evidence and fences later stale state changes", async () => {
		const stale = await read();
		await updateApplyRun(env, stale, { events: [event(1)], runnerSeq: 1 }, 3);
		await updateApplyRun(env, stale, { to: "awaiting_review", result: { outcome: "awaiting_review" }, events: [checkpoint] }, 4);
		expect(await read()).toMatchObject({ status: "awaiting_review", trace: [event(1), checkpoint], runnerSeq: 1 });
		expect(await updateApplyRun(env, stale, { to: "running", events: [event(2)], runnerSeq: 2 }, 5)).toBeNull();
	});

	it("retains exactly the newest 500 in append order, preserving JSON values and platform repetitions", async () => {
		await updateApplyRun(env, await read(), { events: Array.from({ length: MAX_APPLY_TRACE }, (_, i) => event(i + 1)), runnerSeq: MAX_APPLY_TRACE }, 3);
		const quoted = { ...checkpoint, detail: { reason: 'quotes " and newline\n; unicode 🧪', count: 0, allowed: false } };
		await updateApplyRun(env, await read(), { events: [quoted, quoted] }, 4);
		const trace = (await read()).trace;
		expect(trace).toHaveLength(MAX_APPLY_TRACE);
		expect(trace[0]).toEqual(event(3));
		expect(trace.slice(-2)).toEqual([quoted, quoted]);
	});
});

import { parseApplyRunnerBatch } from "./trace-integrity.js";

describe("runner batch sequence validation", () => {
	it("retains sequence identity while sanitizing event content", () => {
		const batch = parseApplyRunnerBatch([{ ...event(1), detail: { target: "Company", value: "private" }, url: "https://example.test/form?token=secret" }], 1, 0);
		expect(batch).toEqual({ events: [{ ...event(1), detail: { target: "Company" }, url: "https://example.test/form" }], lastSeq: 1 });
	});
	it.each([undefined, null, -1, 0, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])("refuses a malformed runner event sequence %s without advancing a cursor", (seq) => {
		expect(parseApplyRunnerBatch([{ ...event(1), seq }], 1, 0)).toBeNull();
	});
	it("refuses cursor mismatches, duplicate or unordered batches and unsequenced legacy events", () => {
		expect(parseApplyRunnerBatch([event(2)], 1, 0)).toBeNull();
		expect(parseApplyRunnerBatch([event(2)], 2, 0)).toBeNull();
		expect(parseApplyRunnerBatch([], 100, 0)).toBeNull();
		expect(parseApplyRunnerBatch([event(1)], 2, 0)).toBeNull();
		expect(parseApplyRunnerBatch([event(1)], 1, 2)).toBeNull();
		expect(parseApplyRunnerBatch([event(1), event(1)], 1, 0)).toBeNull();
		expect(parseApplyRunnerBatch([event(2), event(1)], 2, 0)).toBeNull();
		expect(parseApplyRunnerBatch([checkpoint], 1, 0)).toBeNull();
		expect(parseApplyRunnerBatch([], 0, 0)).toEqual({ events: [], lastSeq: 0 });
	});
	it("rejects invalid direct storage appends without changing trace or cursor", async () => {
		const run = await read();
		for (const change of [
			{ events: [event(2)], runnerSeq: 1 },
			{ events: [event(1)] },
			{ events: [event(1), event(1)], runnerSeq: 1 },
			{ events: [checkpoint], runnerSeq: Number.NaN },
		]) expect(await updateApplyRun(env, run, change, 3)).toBeNull();
		expect(await read()).toMatchObject({ trace: [], runnerSeq: 0 });
	});
});
