import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../types.js";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "../d1-sqlite.js";
import { getApplyRun, insertApplyRun, updateApplyRun, type ApplyRun, type ApplyRunPolicy } from "./store.js";

const { runtimeCall, afterUpdate } = vi.hoisted(() => ({ runtimeCall: vi.fn(), afterUpdate: vi.fn() }));
vi.mock("./store.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./store.js")>();
	return { ...actual, updateApplyRun: async (...args: Parameters<typeof actual.updateApplyRun>) => {
		const result = await actual.updateApplyRun(...args);
		await afterUpdate(args[2]);
		return result;
	} };
});
vi.mock("../../routes/instances-runtime.js", () => ({
	getLiveRuntime: async () => ({ runner_node: "mac", runner_version: "0.6.0", instance_id: "runner" }),
	callRuntime: runtimeCall,
	runtimeJson: (res: Response) => res.json(),
}));
const { syncApplyRun } = await import("./apply.js");
let d1: RealSchemaD1;
let env: Env;
const read = async (): Promise<ApplyRun> => (await getApplyRun(env, "runner", "u", "run"))!;
const event = (seq: number) => ({ seq, type: "field.filled" as const, at: new Date(seq * 1000).toISOString(), detail: { target: `field ${seq}` } });

beforeEach(async () => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u", instanceIds: ["runner"] });
	env = { DB: d1.DB } as unknown as Env;
	await insertApplyRun(env, { id: "run", instanceId: "runner", userId: "u", applicationId: "app", requestId: "request", policy: { mode: "fill_and_review", screenshots: false, limits: { maxMinutes: 20 } } as ApplyRunPolicy, trace: [], now: 1 });
	await updateApplyRun(env, await read(), { to: "paused" }, 2);
	runtimeCall.mockReset();
	afterUpdate.mockReset();
});
afterEach(() => d1.close());

describe("application sync trace races (#1524)", () => {
	it("does not settle an old ended response after a newer poll has advanced the cursor", async () => {
		const stale = await read();
		runtimeCall.mockImplementation(async (_env: unknown, _runtime: unknown, path: string) => {
			if (path !== "/local-apply/status") return new Response(null, { status: 404 });
			await updateApplyRun(env, await read(), { events: [event(1), event(2)], runnerSeq: 2, pause: { reason: "missing_answer", question: "Current question?" } }, 3);
			return Response.json({ state: "ended", lastSeq: 1, events: [event(1)], result: { runId: "run", outcome: "awaiting_review", mode: "fill_and_review", traceId: "run", engineAuth: "machine-login", filled: 1, uploaded: [], submitAttempted: false, summary: "Old result" } });
		});
		const synced = await syncApplyRun(env, "u", stale, 4);
		expect(synced).toMatchObject({ status: "paused", runnerSeq: 2, result: null, trace: [event(1), event(2)], pause: { question: "Current question?" } });
		expect(await read()).toMatchObject({ status: "paused", runnerSeq: 2, result: null });
	});

	it("fences finalization if another poll advances after the accepted response was read", async () => {
		runtimeCall.mockImplementation(async (_env: unknown, _runtime: unknown, path: string) => path === "/local-apply/status"
			? Response.json({ state: "ended", lastSeq: 1, events: [event(1)], result: { runId: "run", outcome: "awaiting_review", mode: "fill_and_review", traceId: "run", engineAuth: "machine-login", filled: 1, uploaded: [], submitAttempted: false, summary: "Old result" } })
			: new Response(null, { status: 404 }));
		afterUpdate.mockImplementationOnce(async (change) => {
			expect(change.runnerSeq).toBe(1);
			await updateApplyRun(env, await read(), { events: [event(2)], runnerSeq: 2 }, 3);
		});
		expect(await syncApplyRun(env, "u", await read(), 4)).toMatchObject({ status: "paused", runnerSeq: 2, result: null, trace: [event(1), event(2)] });
		expect(await read()).toMatchObject({ status: "paused", runnerSeq: 2, result: null });
	});

	it("rejects malformed sequence transport without consuming its cursor or finalizing", async () => {
		runtimeCall.mockImplementation(async (_env: unknown, _runtime: unknown, path: string) => path === "/local-apply/status"
			? Response.json({ state: "ended", lastSeq: 1, events: [{ ...event(1), seq: undefined }], result: {} })
			: new Response(null, { status: 404 }));
		expect(await syncApplyRun(env, "u", await read(), 4)).toMatchObject({ status: "paused", runnerSeq: 0, trace: [], result: null });
	});
});

describe("application terminal trace paging (#1527)", () => {
	const result = { runId: "run", outcome: "awaiting_review", mode: "fill_and_review", traceId: "run", engineAuth: "machine-login", filled: 1, uploaded: [], submitAttempted: false, summary: "Done" };
	/** The runner's real contract (runtime.ts status): events after `afterSeq`, at most 500 per page, `lastSeq` = page end while more remain. */
	function endedRunner(total: number) {
		const afterSeqs: number[] = [];
		const answer = async (_env: unknown, _runtime: unknown, path: string, init: { body: string }) => {
			if (path !== "/local-apply/status") return new Response(null, { status: 404 });
			const after = (JSON.parse(init.body) as { afterSeq: number }).afterSeq;
			afterSeqs.push(after);
			const pending = Array.from({ length: Math.max(0, total - after) }, (_, i) => event(after + i + 1));
			const page = pending.slice(0, 500);
			return Response.json({ state: "ended", events: page, lastSeq: page.length < pending.length ? page[page.length - 1].seq : total, result });
		};
		runtimeCall.mockImplementation(answer);
		return { afterSeqs, answer };
	}

	it.each([
		["more than one page pending at termination", 700, [0, 500]],
		["exactly one full page", 500, [0, 500]],
		["a short run", 3, [0]],
	])("drains every page before settling: %s", async (_name, total, expectedAfter) => {
		const { afterSeqs } = endedRunner(total);
		const synced = await syncApplyRun(env, "u", await read(), 4);
		expect(afterSeqs).toEqual(expectedAfter);
		expect(synced).toMatchObject({ status: "awaiting_review", runnerSeq: total });
		const stored = await read();
		expect(stored.runnerSeq).toBe(total);
		expect(Math.max(...stored.trace.map((e) => e.seq ?? 0))).toBe(total);
	});

	it("does not settle while pages remain, and a later tick resumes from the stored cursor", async () => {
		const { afterSeqs, answer } = endedRunner(700);
		let secondPageUp = false;
		runtimeCall.mockImplementation((e: unknown, r: unknown, path: string, init: { body: string }) =>
			path === "/local-apply/status" && (JSON.parse(init.body) as { afterSeq: number }).afterSeq === 500 && !secondPageUp ? Promise.resolve(new Response(null, { status: 503 })) : answer(e, r, path, init));
		expect(await syncApplyRun(env, "u", await read(), 4)).toMatchObject({ status: "paused", runnerSeq: 500, result: null });
		secondPageUp = true;
		await syncApplyRun(env, "u", await read(), 5);
		expect(afterSeqs).toEqual([0, 500]);
		expect(await read()).toMatchObject({ status: "awaiting_review", runnerSeq: 700 });
	});
});
