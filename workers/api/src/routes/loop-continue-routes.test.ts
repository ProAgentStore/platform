/**
 * `POST /:id/loop/:runId/continue` (#806 item 3(c)) — the guards, and the two things the route
 * hands downstream that nothing else can check.
 *
 * ── What is worth testing here, and what is not
 *
 * Not the start. `driver.start()` is mocked, because picking the repo, opening the session, taking
 * the single-flight claim and refusing an unusable checkout are `loop-drivers.ts`'s job and have
 * their own tests. Re-asserting them through this route would test the mock.
 *
 * What only this route decides is: WHICH runs may be continued, what the new run is started WITH
 * (objective, ceiling, repo, a fresh budget), and that the resume-note lookback is widened — the
 * last of which is the entire difference between a continue and a plain restart, and is invisible
 * in the response. So it is asserted on the `start` call.
 */
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { CONTINUE_RESUME_LOOKBACK_MS } from "../lib/agent-loop-store.js";
import type { Env } from "../types.js";

const getLoopRun = vi.fn();
const requireOwnedInstance = vi.fn();
const getSession = vi.fn();
const openBudget = vi.fn();
const resolveAccountCeilings = vi.fn();
const capabilitiesForInstance = vi.fn();
const start = vi.fn();

vi.mock("../lib/auth.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/auth.js")>("../lib/auth.js");
	return { ...actual, requireUser: async () => ({ uid: "u1" }) };
});
vi.mock("../lib/agent-loop-store.js", async () => {
	// The real `isResumableStopReason` and the real lookback constant: which stop reasons are
	// continuable is exactly what these tests are about, and a mocked predicate would let the
	// route and `RESUMABLE_STOP_REASONS` drift apart without a single test going red.
	const actual = await vi.importActual<typeof import("../lib/agent-loop-store.js")>("../lib/agent-loop-store.js");
	return { ...actual, getLoopRun: (...a: unknown[]) => getLoopRun(...a) };
});
vi.mock("../lib/coding-store.js", () => ({ getSession: (...a: unknown[]) => getSession(...a) }));
vi.mock("../lib/delegation-budget-store.js", () => ({
	openBudget: (...a: unknown[]) => openBudget(...a),
	resolveAccountCeilings: (...a: unknown[]) => resolveAccountCeilings(...a),
}));
vi.mock("../lib/agent-capabilities.js", () => ({ capabilitiesForInstance: (...a: unknown[]) => capabilitiesForInstance(...a) }));
vi.mock("../lib/loop-drivers.js", () => ({ loopDriverFor: () => ({ id: "coding", label: "x", start }) }));
vi.mock("./instances-runtime.js", () => ({ requireOwnedInstance: (...a: unknown[]) => requireOwnedInstance(...a) }));

const { registerLoopContinueRoutes } = await import("./loop-continue-routes.js");

function app() {
	const router = new Hono<{ Bindings: Env }>();
	registerLoopContinueRoutes(router);
	router.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 404) : c.json({ error: String(e) }, 500)));
	return router;
}

/** A run that stopped at its step limit — #806's own case, and the happy path everywhere below. */
const stoppedRun = {
	runId: "run-1",
	instanceId: "i1",
	objective: "finish the migration",
	status: "failed",
	stopReason: "max_iterations",
	iteration: 20,
	maxIterations: 20,
	startedAt: 1_000,
	finishedAt: 2_000,
	sessionId: "csess_a",
};

const post = (path: string, body?: unknown) =>
	app().request(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json" } }, {} as Env);

beforeEach(() => {
	vi.clearAllMocks();
	requireOwnedInstance.mockResolvedValue(undefined);
	getLoopRun.mockResolvedValue({ ...stoppedRun });
	getSession.mockResolvedValue({ id: "csess_a", repoId: "repo-7" });
	openBudget.mockResolvedValue({ id: "budget-new" });
	resolveAccountCeilings.mockResolvedValue({ loopMaxIterations: 50 });
	capabilitiesForInstance.mockResolvedValue({ workflow: "CODING_SESSION" });
	start.mockResolvedValue({ ok: true, runId: "run-2", driver: "coding" });
});

describe("the happy path", () => {
	it("starts a new run on the stopped one's objective and answers 201", async () => {
		const res = await post("/i1/loop/run-1/continue", {});
		expect(res.status).toBe(201);
		expect(await res.json()).toEqual({
			runId: "run-2",
			driver: "coding",
			budgetId: "budget-new",
			maxIterations: 20,
			status: "running",
			// The lineage is reported so a caller can tell a continue's run from a fresh one.
			continuedFromRunId: "run-1",
		});
		expect(start.mock.calls[0][0]).toMatchObject({ instanceId: "i1", userId: "u1", objective: "finish the migration", depth: 0 });
	});

	it("widens the resume-note lookback — the whole difference from a restart", async () => {
		await post("/i1/loop/run-1/continue", {});
		expect(start.mock.calls[0][0].resumeLookbackMs).toBe(CONTINUE_RESUME_LOOKBACK_MS);
		// Not merely "a number": the default floor is six hours, and a continue pressed the next
		// morning under it would brief its successor on nothing, which is #806 item 4.
		expect(CONTINUE_RESUME_LOOKBACK_MS).toBeGreaterThan(24 * 60 * 60 * 1000);
	});

	it("continues on the stopped run's own repo, not the driver's first one", async () => {
		await post("/i1/loop/run-1/continue", {});
		expect(getSession).toHaveBeenCalledWith({}, "i1", "u1", "csess_a");
		expect(start.mock.calls[0][0].repoId).toBe("repo-7");
	});

	it("opens a FRESH budget rather than inheriting the stopped run's", async () => {
		await post("/i1/loop/run-1/continue", { budget: { costMicros: 5 } });
		expect(openBudget).toHaveBeenCalledWith({}, "u1", "i1", { costMicros: 5 });
		expect(start.mock.calls[0][0].budgetId).toBe("budget-new");
	});

	it("passes no repo for a chat run, which has no session", async () => {
		getLoopRun.mockResolvedValue({ ...stoppedRun, sessionId: null });
		await post("/i1/loop/run-1/continue", {});
		expect(getSession).not.toHaveBeenCalled();
		expect(start.mock.calls[0][0].repoId).toBeUndefined();
	});
});

describe("the iteration ceiling", () => {
	it("defaults to the stopped run's own ceiling when the caller names no number", async () => {
		await post("/i1/loop/run-1/continue", {});
		expect(start.mock.calls[0][0].maxIterations).toBe(20);
	});

	it("takes the caller's number when they grant more", async () => {
		const res = await post("/i1/loop/run-1/continue", { maxIterations: 40 });
		expect(start.mock.calls[0][0].maxIterations).toBe(40);
		expect((await res.json() as { maxIterations: number }).maxIterations).toBe(40);
	});

	it("clamps to the account ceiling — a continue is not a way around #477", async () => {
		resolveAccountCeilings.mockResolvedValue({ loopMaxIterations: 25 });
		await post("/i1/loop/run-1/continue", { maxIterations: 900 });
		expect(start.mock.calls[0][0].maxIterations).toBe(25);
	});
});

describe("which runs may be continued", () => {
	it("404s when there is no such run", async () => {
		getLoopRun.mockResolvedValue(null);
		const res = await post("/i1/loop/nope/continue", {});
		expect(res.status).toBe(404);
		expect(start).not.toHaveBeenCalled();
	});

	it("404s when the run belongs to another instance of the same owner", async () => {
		// `getLoopRun` is user-scoped but not instance-scoped, so without this guard the new run
		// would open on whichever instance was in the URL.
		getLoopRun.mockResolvedValue({ ...stoppedRun, instanceId: "i2" });
		const res = await post("/i1/loop/run-1/continue", {});
		expect(res.status).toBe(404);
		expect(start).not.toHaveBeenCalled();
	});

	it("409s while the run is still going, and says so", async () => {
		getLoopRun.mockResolvedValue({ ...stoppedRun, status: "running", stopReason: null, finishedAt: null });
		const res = await post("/i1/loop/run-1/continue", {});
		expect(res.status).toBe(409);
		expect((await res.json() as { error: string }).error).toContain("still going");
		expect(start).not.toHaveBeenCalled();
	});

	it("409s on a run that is cancelling but has not stopped yet", async () => {
		// `cancelRequested` is cooperative: the run keeps going until the top of its next
		// iteration. Reading it as stopped would start a second run against the same session,
		// which is the single-flight collision #208 exists to prevent.
		getLoopRun.mockResolvedValue({ ...stoppedRun, status: "running", stopReason: "max_iterations", finishedAt: null, cancelRequested: true });
		const res = await post("/i1/loop/run-1/continue", {});
		expect(res.status).toBe(409);
		// Refused for being UNFINISHED, not for its reason — a run carrying a continuable reason
		// while still in flight is exactly the case the reason test alone would wave through.
		expect((await res.json() as { error: string }).error).toContain("still going");
		expect(start).not.toHaveBeenCalled();
	});

	it.each([
		["done", "new one"],
		["failed", "read its outcome"],
		["cancelled", "clean start"],
		["escalated", "handoff"],
		["no_progress", "repeating"],
		["budget", "spend limit"],
	])("409s on a %s run, naming what to do instead", async (reason, phrase) => {
		getLoopRun.mockResolvedValue({ ...stoppedRun, stopReason: reason });
		const res = await post("/i1/loop/run-1/continue", {});
		expect(res.status).toBe(409);
		expect((await res.json() as { error: string }).error).toContain(phrase);
		expect(start).not.toHaveBeenCalled();
	});

	it.each(["interrupted", "max_iterations", "engine_limit", "provider_credit"])("continues a %s run", async (reason) => {
		getLoopRun.mockResolvedValue({ ...stoppedRun, stopReason: reason });
		expect((await post("/i1/loop/run-1/continue", {})).status).toBe(201);
	});

	it("is owner-scoped before it reads the run", async () => {
		requireOwnedInstance.mockRejectedValue(new HttpError(404, "instance not found"));
		const res = await post("/i1/loop/run-1/continue", {});
		expect(res.status).toBe(404);
		expect(getLoopRun).not.toHaveBeenCalled();
	});
});

describe("when the driver refuses", () => {
	it("passes the driver's own status and sentence through", async () => {
		// The refusal names the real blocker — a runner that is off, a checkout that failed
		// admission. Replacing it with a generic "could not continue" is what #271 was about.
		start.mockResolvedValue({ ok: false, status: 409, error: "repo-7 is already being worked on — wait for the current run to finish, or stop it first with stop_work." });
		const res = await post("/i1/loop/run-1/continue", {});
		expect(res.status).toBe(409);
		expect((await res.json() as { error: string }).error).toContain("already being worked on");
	});
});
