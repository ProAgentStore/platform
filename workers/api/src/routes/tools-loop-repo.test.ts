/**
 * `POST /:id/loop` carries the caller's repo choice to the driver, and queues a busy objective under
 * THAT repo (#877). The driver is faked here: which repo it may pick and when it is busy are pinned
 * against the real driver in `lib/loop-drivers.test.ts` and `lib/loop-repo-scope.integration.test.ts`;
 * this file pins the route's half — what it forwards, and what it hands the queue.
 */
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import type { Env } from "../types.js";

const driverStart = vi.fn();
const enqueueObjective = vi.fn();

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
vi.mock("../lib/objective-queue.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/objective-queue.js")>("../lib/objective-queue.js");
	return { ...actual, enqueueObjective: (...a: unknown[]) => enqueueObjective(...a) };
});

const { toolRoutes } = await import("./tools.js");

function app() {
	const router = new Hono<{ Bindings: Env }>();
	router.route("/v1/instances", toolRoutes);
	router.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 409) : c.json({ error: String(e) }, 500)));
	return router;
}
const post = (body: unknown) =>
	app().request("/v1/instances/i1/loop", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, { DB: {} } as unknown as Env);
const startInput = () => driverStart.mock.calls[0][0] as { repoId?: string; requireRepoChoice?: boolean };

beforeEach(() => {
	vi.clearAllMocks();
	driverStart.mockResolvedValue({ ok: true, runId: "run-1", driver: "coding" });
	enqueueObjective.mockImplementation(async (_env: unknown, input: { repoId?: string }) => ({ id: "qe-1", repoId: input.repoId ?? null, status: "pending" }));
});

describe("POST /:id/loop — repo targeting (#877)", () => {
	it("hands the named repo and coding_loop_start's requireRepoChoice to the driver", async () => {
		const res = await post({ objective: "fix it", repoId: " r2 ", requireRepoChoice: true });
		expect(res.status).toBe(201);
		expect(startInput()).toMatchObject({ repoId: "r2", requireRepoChoice: true });
	});

	it("a caller that names no repo and sends no flag is unchanged: no repo, no requirement", async () => {
		const res = await post({ objective: "fix it" });
		expect(res.status).toBe(201);
		expect(startInput().repoId).toBeUndefined();
		expect(startInput().requireRepoChoice).toBe(false);
	});

	it("a BUSY targeted repo with queue_if_busy is queued under that repo — not as an any-repo entry", async () => {
		driverStart.mockResolvedValue({ ok: false, status: 409, reason: "busy", error: "second/repo is already being worked on" });
		const res = await post({ objective: "next", repoId: "r2", requireRepoChoice: true, queueIfBusy: true });
		expect(res.status).toBe(202);
		expect(enqueueObjective).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ instanceId: "i1", repoId: "r2", objective: "next" }));
		const body = (await res.json()) as { queued: boolean; entry: { repoId: string } };
		expect(body).toMatchObject({ queued: true, entry: { repoId: "r2" } });
	});

	it("a refused repo_id (not on the instance) or a missing choice is NEVER queued — waiting fixes neither", async () => {
		for (const error of ["That repository (r9) is not on this agent", "This agent has 2 repositories, so the run needs a repo_id"]) {
			driverStart.mockResolvedValueOnce({ ok: false, status: 409, error });
			const res = await post({ objective: "x", repoId: "r9", requireRepoChoice: true, queueIfBusy: true });
			expect(res.status).toBe(409);
			expect(((await res.json()) as { error: string }).error).toBe(error);
		}
		expect(enqueueObjective).not.toHaveBeenCalled();
	});
});
