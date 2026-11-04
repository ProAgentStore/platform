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
	env = { DB: d1.DB } as Env;
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
