/**
 * #1071 — a caller that lost a `coding_loop_start` answer polls that start by its request id alone.
 *
 * `GET /v1/instances/:id/loop/starts/:requestId` over the real schema and the real route; receipts are
 * made by the real `withLoopStartReceipt`, the same path a start takes. The lost-response path end to
 * end: a start whose answer never came back is still found — provisioning while it settles, then what
 * it became — and a start that never arrived is `not_received`, not an error.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { realSchemaD1, type RealSchemaD1, seedTenant } from "../lib/d1-sqlite.js";
import { withLoopStartReceipt } from "../lib/loop-start-receipts.js";
import type { Env } from "../types.js";

vi.mock("../lib/auth.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/auth.js")>("../lib/auth.js");
	return { ...actual, requireUser: async (c: { req: { header(n: string): string | undefined } }) => ({ uid: c.req.header("x-test-uid") ?? "u1", roles: [] }) };
});
const { toolRoutes } = await import("./tools.js");

let d1: RealSchemaD1;
let env: Env;
const app = new Hono<{ Bindings: Env }>();
app.route("/v1/instances", toolRoutes);
app.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500)));

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["i1", "i2"] });
	seedTenant(d1, { userId: "u2", instanceIds: ["j1"] });
	env = { DB: d1.DB } as unknown as Env;
});
afterEach(() => d1.close());

async function poll(instance: string, requestId: string, uid = "u1") {
	const res = await app.request(`/v1/instances/${instance}/loop/starts/${requestId}`, { headers: { "x-test-uid": uid } }, env);
	// biome-ignore lint/suspicious/noExplicitAny: read field by field
	return { status: res.status, body: (await res.json()) as Record<string, any> };
}
const input = { objective: "fix issue #12", repoId: "r1" };
const started = () => Promise.resolve(Response.json({ runId: "run-1" }));

describe("polling one start by its request id (#1071)", () => {
	it("a start whose answer was lost: provisioning while it settles, then what it became — never a missing-argument error", async () => {
		let finish!: (r: Response) => void;
		const inFlight = withLoopStartReceipt(env, "u1", "i1", "req-lost", input, () => new Promise<Response>((r) => (finish = r)));
		await new Promise((r) => setTimeout(r, 0));
		const during = await poll("i1", "req-lost");
		expect(during.status).toBe(200);
		expect(during.body).toMatchObject({ found: true, start: { requestId: "req-lost", startState: "provisioning" } });

		finish(Response.json({ runId: "run-1" }));
		await inFlight;
		const after = await poll("i1", "req-lost");
		expect(after.body).toMatchObject({ found: true, start: { requestId: "req-lost", startState: "started", result: { runId: "run-1" } } });
	});

	it("a queued start reads back as queued with its entry", async () => {
		await withLoopStartReceipt(env, "u1", "i1", "req-q", input, () => Promise.resolve(Response.json({ queued: true, entry: { id: "q-1" } })));
		expect((await poll("i1", "req-q")).body).toMatchObject({ found: true, start: { startState: "queued", result: { queueEntryId: "q-1" } } });
	});

	it("a start that never arrived is `not_received` — an answer, and it says retrying the same request_id is safe", async () => {
		const r = await poll("i1", "req-never");
		expect(r.status).toBe(200);
		expect(r.body).toEqual({ found: false, requestId: "req-never", startState: "not_received", detail: expect.stringMatching(/SAME request_id is safe/) });
	});

	it("a request id is the instance's: the same id on another instance, or another owner's, is not this start", async () => {
		await withLoopStartReceipt(env, "u1", "i1", "req-a", input, started);
		expect((await poll("i2", "req-a")).body).toMatchObject({ found: false, startState: "not_received" });
		expect((await poll("i1", "req-a", "u2")).status).toBe(404);
	});

	it("refuses an id coding_loop_start could never have accepted", async () => {
		expect((await poll("i1", "bad%20id")).status).toBe(400);
	});

	it("the lost-response answers name the exact poll: request_id is in every `polling` hint", async () => {
		// The first start never settles — its answer is the one the caller lost.
		void withLoopStartReceipt(env, "u1", "i1", "req-p", input, () => new Promise<Response>(() => {}));
		await new Promise((r) => setTimeout(r, 0));
		// A replay while the first is still provisioning is the 202 a caller re-sending a lost start sees.
		const again = (await (await withLoopStartReceipt(env, "u1", "i1", "req-p", input, started)).json()) as { polling?: Record<string, string> };
		expect(again.polling).toEqual({ tool: "coding_loop_status", instance_id: "i1", request_id: "req-p" });
	});
});
