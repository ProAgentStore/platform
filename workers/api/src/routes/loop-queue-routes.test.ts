/**
 * The queue's read/withdraw routes (#788), and the one thing about them that is not in a handler.
 *
 * ── Why there is a SOURCE assertion at the bottom
 *
 * `GET /:id/loop/queue` and `GET /:id/loop/:runId` are the same shape to Hono, which matches in
 * REGISTRATION order. Register the queue second and every read of it is answered by the run lookup
 * with `runId = "queue"` — a 404 reading "loop run not found", on a route that exists, with nothing
 * anywhere saying why. No handler test can see that: both handlers are correct in isolation and the
 * defect lives entirely in the order two `router.get` calls appear in a third file.
 */
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { HttpError } from "../lib/auth.js";
import type { Env } from "../types.js";

const listQueue = vi.fn();
const cancelQueueEntry = vi.fn();
const getQueueEntry = vi.fn();
const requireOwnedInstance = vi.fn();

vi.mock("../lib/auth.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/auth.js")>("../lib/auth.js");
	return { ...actual, requireUser: async () => ({ uid: "u1" }) };
});
vi.mock("../lib/objective-queue.js", () => ({
	listQueue: (...a: unknown[]) => listQueue(...a),
	cancelQueueEntry: (...a: unknown[]) => cancelQueueEntry(...a),
	getQueueEntry: (...a: unknown[]) => getQueueEntry(...a),
}));
vi.mock("./instances-runtime.js", () => ({ requireOwnedInstance: (...a: unknown[]) => requireOwnedInstance(...a) }));

const { registerLoopQueueRoutes } = await import("./loop-queue-routes.js");

function app() {
	const router = new Hono<{ Bindings: Env }>();
	registerLoopQueueRoutes(router);
	// The route the queue must be registered BEFORE, in the same relative position tools.ts puts
	// it — so this harness would reproduce the shadowing bug rather than hide it.
	router.get("/:id/loop/:runId", (c) => c.json({ runLookupFor: c.req.param("runId") }));
	router.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 404) : c.json({ error: String(e) }, 500)));
	return router;
}

beforeEach(() => {
	vi.clearAllMocks();
	requireOwnedInstance.mockResolvedValue(undefined);
	listQueue.mockResolvedValue([]);
});

describe("GET /:id/loop/queue", () => {
	it("is not shadowed by the run-lookup route", async () => {
		listQueue.mockResolvedValue([{ id: "objq-1" }]);
		const res = await app().request("/i1/loop/queue", {}, {} as Env);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ entries: [{ id: "objq-1" }] });
	});

	it("returns everything pending when no repo is named", async () => {
		await app().request("/i1/loop/queue", {}, {} as Env);
		// `undefined`, not `null` — the store treats those differently, and null would silently
		// narrow the answer to the repo-agnostic entries only.
		expect(listQueue.mock.calls[0][2]).toBeUndefined();
	});

	it("narrows to one repo's eligible set when repo_id is given", async () => {
		await app().request("/i1/loop/queue?repo_id=r1", {}, {} as Env);
		expect(listQueue.mock.calls[0][2]).toBe("r1");
	});

	it("is owner-scoped before it reads anything", async () => {
		requireOwnedInstance.mockRejectedValue(new HttpError(404, "instance not found"));
		const res = await app().request("/i1/loop/queue", {}, {} as Env);
		expect(res.status).toBe(404);
		expect(listQueue).not.toHaveBeenCalled();
	});

	it("a real run id still reaches the run lookup", async () => {
		const res = await app().request("/i1/loop/run-1", {}, {} as Env);
		expect(await res.json()).toEqual({ runLookupFor: "run-1" });
	});
});

describe("DELETE /:id/loop/queue/:entryId", () => {
	it("cancels a pending entry", async () => {
		cancelQueueEntry.mockResolvedValue(true);
		const res = await app().request("/i1/loop/queue/objq-1", { method: "DELETE" }, {} as Env);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, status: "cancelled" });
		expect(cancelQueueEntry).toHaveBeenCalledWith({}, "objq-1", "u1");
	});

	it("404s when the entry is not this user's", async () => {
		cancelQueueEntry.mockResolvedValue(false);
		getQueueEntry.mockResolvedValue(null);
		const res = await app().request("/i1/loop/queue/nope", { method: "DELETE" }, {} as Env);
		expect(res.status).toBe(404);
	});

	it("409s — naming the state it reached — when the entry has already started", async () => {
		// A distinct answer from 404 on purpose: "too late, it is a run now" and "no such entry"
		// send a caller to completely different places.
		cancelQueueEntry.mockResolvedValue(false);
		getQueueEntry.mockResolvedValue({ id: "objq-1", status: "started" });
		const res = await app().request("/i1/loop/queue/objq-1", { method: "DELETE" }, {} as Env);
		expect(res.status).toBe(409);
		expect(((await res.json()) as { error: string }).error).toContain("started");
	});
});

describe("registration order in routes/tools.ts", () => {
	const source = readFileSync(new URL("./tools.ts", import.meta.url).pathname, "utf8");

	it("registers the queue routes before the run-lookup route", () => {
		const queue = source.indexOf("registerLoopQueueRoutes(toolRoutes)");
		const runLookup = source.indexOf('toolRoutes.get("/:id/loop/:runId"');
		expect(queue).toBeGreaterThan(-1);
		expect(runLookup).toBeGreaterThan(-1);
		expect(queue).toBeLessThan(runLookup);
	});
});
