/**
 * `POST /:id/loop` with queue_if_busy does not queue the same GitHub issue twice on one repo (#925).
 *
 * The live failure, replayed: a caller queued a start, got a deferred answer, and retried with a NEW
 * request_id. The receipt table could not catch it (different key), so both landed. Real schema and
 * the real queue, receipts and duplicate lookup; only the driver (always busy here) and the account
 * gates are faked — the same seams `tools-loop-repo.test.ts` uses.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import type { Env } from "../types.js";

const driverStart = vi.fn();

vi.mock("../lib/auth.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/auth.js")>("../lib/auth.js");
	return { ...actual, requireUser: async () => ({ uid: "u1", roles: [] }) };
});
vi.mock("./instances-runtime.js", async () => {
	const actual = await vi.importActual<typeof import("./instances-runtime.js")>("./instances-runtime.js");
	return { ...actual, requireOwnedInstance: async () => undefined };
});
vi.mock("../lib/billing.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/billing.js")>("../lib/billing.js");
	return { ...actual, requirePro: async () => undefined };
});
vi.mock("../lib/agent-capabilities.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/agent-capabilities.js")>("../lib/agent-capabilities.js");
	return { ...actual, capabilitiesForInstance: async () => ({ workflow: "CODING_SESSION" }) };
});
vi.mock("../lib/loop-limits-store.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/loop-limits-store.js")>("../lib/loop-limits-store.js");
	return { ...actual, readLoopLimits: async () => ({}) };
});
vi.mock("../lib/delegation-budget-store.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/delegation-budget-store.js")>("../lib/delegation-budget-store.js");
	return { ...actual, openBudget: async () => ({ id: "bud-1" }), resolveAccountCeilings: async () => ({ loopMaxIterations: 50 }) };
});
vi.mock("../lib/loop-drivers.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/loop-drivers.js")>("../lib/loop-drivers.js");
	return { ...actual, loopDriverFor: () => ({ id: "coding", label: "coding", start: (...a: unknown[]) => driverStart(...a) }) };
});

const { toolRoutes } = await import("./tools.js");

let d1: RealSchemaD1;
beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["i1"] });
	d1.exec(`INSERT INTO coding_repos (id, instance_id, user_id, name) VALUES ('r1', 'i1', 'u1', 'platform'), ('r2', 'i1', 'u1', 'other')`);
	driverStart.mockReset();
	driverStart.mockResolvedValue({ ok: false, status: 409, reason: "busy", error: "platform is already being worked on" });
});
afterEach(() => d1.close());

function post(body: Record<string, unknown>) {
	const router = new Hono<{ Bindings: Env }>();
	router.route("/v1/instances", toolRoutes);
	router.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 409) : c.json({ error: String(e) }, 500)));
	return router.request(
		"/v1/instances/i1/loop",
		{ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
		{ DB: d1.DB } as unknown as Env,
		{ waitUntil: () => undefined, passThroughOnException: () => undefined, props: {} } as never,
	);
}
const pendingRows = () => d1.sqlite.prepare("SELECT id, objective, repo_id FROM instance_objective_queue WHERE status = 'pending'").all() as { id: string; objective: string; repo_id: string }[];

describe("POST /:id/loop — a retried queued start is not queued twice (#925)", () => {
	it("a retry with a NEW request_id for the same issue returns the first entry as duplicate_of", async () => {
		const first = await post({ requestId: "req-a", objective: "Work issue #925 on ProAgentStore/platform.", repoId: "r1", queueIfBusy: true });
		expect(first.status).toBe(202);
		const firstBody = (await first.json()) as { queued: boolean; entry: { id: string }; startState: string };
		expect(firstBody).toMatchObject({ queued: true, startState: "queued" });
		expect(firstBody).not.toHaveProperty("duplicate_of");

		const retry = await post({ requestId: "req-b", objective: "Work issue #925 on ProAgentStore/platform.", repoId: "r1", queueIfBusy: true });
		expect(retry.status).toBe(202);
		expect(await retry.json()).toMatchObject({ queued: true, entry: { id: firstBody.entry.id }, duplicate_of: firstBody.entry.id, startState: "queued" });
		expect(pendingRows()).toHaveLength(1);
	});

	it("request_id keeps its own behaviour: the SAME key replays the stored answer, with no lookup at all", async () => {
		const a = (await (await post({ requestId: "req-a", objective: "Work issue #925", repoId: "r1", queueIfBusy: true })).json()) as { entry: { id: string } };
		const replay = (await (await post({ requestId: "req-a", objective: "Work issue #925", repoId: "r1", queueIfBusy: true })).json()) as { entry: { id: string } };
		expect(replay.entry.id).toBe(a.entry.id);
		expect(replay).not.toHaveProperty("duplicate_of");
		expect(driverStart).toHaveBeenCalledTimes(1);
	});

	it("a different issue, or the same issue on another repo, is queued as its own entry", async () => {
		await post({ requestId: "a", objective: "Work issue #925", repoId: "r1", queueIfBusy: true });
		const other = (await (await post({ requestId: "b", objective: "Work issue #926", repoId: "r1", queueIfBusy: true })).json()) as Record<string, unknown>;
		const elsewhere = (await (await post({ requestId: "c", objective: "Work issue #925", repoId: "r2", queueIfBusy: true })).json()) as Record<string, unknown>;
		expect(other).not.toHaveProperty("duplicate_of");
		expect(elsewhere).not.toHaveProperty("duplicate_of");
		expect(pendingRows()).toHaveLength(3);
	});

	it("names the RUN when the busy repo is already working the same issue, and queues nothing", async () => {
		d1.exec(`INSERT INTO coding_sessions (id, instance_id, repo_id, user_id) VALUES ('s1', 'i1', 'r1', 'u1')`);
		d1.exec(`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, max_iterations, started_at, session_id) VALUES ('run-1', 'u1', 'i1', 'Work issue #925', 'running', 10, 1, 's1')`);
		const res = await post({ requestId: "req-x", objective: "Retry issue #925", repoId: "r1", queueIfBusy: true });
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ runId: "run-1", status: "running", duplicate_of: "run-1", startState: "started" });
		expect(pendingRows()).toHaveLength(0);
	});

	it("only the queue_if_busy path looks: without it a busy repo is still the plain refusal", async () => {
		await post({ requestId: "a", objective: "Work issue #925", repoId: "r1", queueIfBusy: true });
		const res = await post({ requestId: "b", objective: "Work issue #925", repoId: "r1" });
		expect(res.status).toBe(409);
		expect(await res.json()).not.toHaveProperty("duplicate_of");
	});
});
