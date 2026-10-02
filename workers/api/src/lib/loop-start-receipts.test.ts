import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { realSchemaD1, type RealSchemaD1 } from "./d1-sqlite.js";
import { dispatchLoopStartReceipt, listLoopStarts, withLoopStartReceipt } from "./loop-start-receipts.js";
import type { Env } from "../types.js";

let d1: RealSchemaD1;
let env: Env;
beforeEach(() => {
	d1 = realSchemaD1();
	env = { DB: d1.DB } as unknown as Env;
});
afterEach(() => { vi.useRealTimers(); d1.close(); });

const input = { objective: "fix the bug", repoId: "r1" };
const receipt = (start: () => Promise<Response>, key = "request-1", args = input, user = "u1", instance = "i1") => withLoopStartReceipt(env, user, instance, key, args, start);

describe("durable loop start receipts (#886)", () => {
	it("returns provisioning by the confirmation deadline and keeps settling the original start", async () => {
		vi.useFakeTimers();
		let finish!: (response: Response) => void;
		let entered!: () => void;
		const ready = new Promise<void>((resolve) => { entered = resolve; });
		const start = vi.fn(() => { entered(); return new Promise<Response>((resolve) => { finish = resolve; }); });
		const retained: Promise<unknown>[] = [];
		const response = dispatchLoopStartReceipt(env, "u1", "i1", "request-1", input, start, (operation) => { retained.push(operation); });
		await ready;
		await vi.advanceTimersByTimeAsync(15_000);
		expect((await response).status).toBe(202);
		expect(await (await response).json()).toMatchObject({ requestId: "request-1", startState: "provisioning" });
		expect(await (await receipt(start)).json()).toMatchObject({ startState: "provisioning" });
		finish(Response.json({ runId: "run-1" }, { status: 201 }));
		await Promise.all(retained);
		expect(await (await receipt(start)).json()).toMatchObject({ startState: "started", runId: "run-1" });
		expect(start).toHaveBeenCalledTimes(1);
	});

	it("exposes dispatched provisioning before run creation and shares concurrent requests", async () => {
		let finish!: (response: Response) => void;
		let entered!: () => void;
		const ready = new Promise<void>((resolve) => { entered = resolve; });
		const start = vi.fn(() => { entered(); return new Promise<Response>((resolve) => { finish = resolve; }); });
		const first = receipt(start);
		await ready;
		expect(await listLoopStarts(env, "u1", "i1")).toEqual([expect.objectContaining({ requestId: "request-1", startState: "provisioning", approval: "dispatched" })]);
		const pending = await receipt(start);
		expect(pending.status).toBe(202);
		expect(await pending.json()).toMatchObject({ startState: "provisioning", polling: { tool: "coding_loop_status" } });
		finish(Response.json({ runId: "run-1" }, { status: 201 }));
		expect(await (await first).json()).toMatchObject({ startState: "started", runId: "run-1" });
		expect(await (await receipt(start)).json()).toMatchObject({ startState: "started", runId: "run-1" });
		expect(start).toHaveBeenCalledTimes(1);
	});
	it("replays a busy refusal without inferring another request was approved", async () => {
		const start = vi.fn(async () => Response.json({ error: "busy", reason: "busy" }, { status: 409 }));
		expect(await (await receipt(start)).json()).toMatchObject({ startState: "not_started", reason: "busy" });
		expect((await receipt(start)).status).toBe(409);
		expect(start).toHaveBeenCalledTimes(1);
	});
	it("preserves queued outcomes and entry ids", async () => {
		const start = vi.fn(async () => Response.json({ queued: true, entry: { id: "q1" } }, { status: 202 }));
		expect(await (await receipt(start)).json()).toMatchObject({ startState: "queued", entry: { id: "q1" } });
	});
	it("does not re-execute an uncertain dispatch", async () => {
		const start = vi.fn(async () => { throw new Error("connection lost after dispatch"); });
		const failed = await receipt(start);
		expect(failed.status).toBe(503);
		expect(await failed.json()).toMatchObject({ startState: "unknown", polling: { tool: "coding_loop_status" } });
		expect((await receipt(start)).status).toBe(503);
		expect(start).toHaveBeenCalledTimes(1);
	});
	it("reports an abandoned provisioning receipt as unknown without starting again", async () => {
		await d1.DB.prepare("INSERT INTO loop_start_receipts (user_id, instance_id, request_id, input_json, state, created_at, updated_at) VALUES (?, ?, ?, ?, 'provisioning', 0, 0)").bind("u1", "i1", "request-1", JSON.stringify(input)).run();
		const start = vi.fn(async () => Response.json({ runId: "unsafe-duplicate" }));
		expect(await (await receipt(start)).json()).toMatchObject({ startState: "unknown" });
		expect(await listLoopStarts(env, "u1", "i1")).toEqual([expect.objectContaining({ startState: "unknown" })]);
		expect(start).not.toHaveBeenCalled();
	});
	it("refuses key reuse with changed arguments and scopes keys and reads by owner and instance", async () => {
		const start = vi.fn(async () => Response.json({ runId: "run-1" }, { status: 201 }));
		await receipt(start);
		const conflict = await receipt(start, "request-1", { ...input, objective: "different" });
		expect(conflict.status).toBe(409);
		expect(await conflict.json()).toMatchObject({ reason: "request_key_conflict", submissionState: "not_started", startState: "started", originalStart: { requestId: "request-1", startState: "started" } });
		expect(await listLoopStarts(env, "u2", "i1")).toEqual([]);
		expect(await listLoopStarts(env, "u1", "i2")).toEqual([]);
		await receipt(start, "request-1", input, "u2");
		await receipt(start, "request-1", input, "u1", "i2");
		expect(start).toHaveBeenCalledTimes(3);
	});
});
