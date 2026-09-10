/**
 * The auto-start-on-completion half of #788.
 *
 * The store's tests cover the SQL. What is asserted here is the DECISION table — what a claimed
 * entry becomes for each way a start can go — because every branch of it writes a terminal status
 * and getting one wrong is silent:
 *
 *   start succeeds        → `started`, with the run id, so the entry has a forwarding address
 *   budget throws         → `failed`, and NOT started (the #184 admission point for this new entry)
 *   busy again (a race)   → back to `pending`, keeping its place — the winner's drain takes it
 *   any other refusal     → `failed`, with the driver's own sentence, rather than pending forever
 *
 * And the property that makes it safe to call from a workflow's terminal path: it NEVER THROWS. The
 * run whose end triggers it has already been recorded as finished; a queue that cannot be drained
 * must not retroactively turn that into a failed step.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../types.js";

const dequeueNext = vi.fn();
const finishQueueEntry = vi.fn();
const requeueEntry = vi.fn();
const start = vi.fn();
const openBudget = vi.fn();
const resolveAccountCeilings = vi.fn();
const logError = vi.fn();

vi.mock("./objective-queue.js", () => ({
	dequeueNext: (...a: unknown[]) => dequeueNext(...a),
	finishQueueEntry: (...a: unknown[]) => finishQueueEntry(...a),
	requeueEntry: (...a: unknown[]) => requeueEntry(...a),
}));
vi.mock("./loop-drivers.js", () => ({ loopDriverFor: () => ({ id: "coding", label: "the engine", start: (...a: unknown[]) => start(...a) }) }));
vi.mock("./agent-capabilities.js", () => ({ capabilitiesForInstance: async () => ({ workflow: "CODING_SESSION" }) }));
vi.mock("./delegation-budget-store.js", () => ({
	openBudget: (...a: unknown[]) => openBudget(...a),
	resolveAccountCeilings: (...a: unknown[]) => resolveAccountCeilings(...a),
}));
vi.mock("./error-log.js", () => ({ logError: (...a: unknown[]) => logError(...a) }));

const { tryDequeueAndStart } = await import("./objective-queue-start.js");

const env = {} as Env;

const entry = (over: Record<string, unknown> = {}) => ({
	id: "objq-1",
	instanceId: "i1",
	repoId: "r1",
	userId: "owner-1",
	objective: "ship it",
	maxIterations: 12,
	metadata: null,
	status: "running",
	stopReason: null,
	runId: null,
	createdAt: 1000,
	startedAt: 2000,
	finishedAt: null,
	...over,
});

beforeEach(() => {
	vi.clearAllMocks();
	// The real ones return promises the drain chains `.catch` onto; a bare `vi.fn()` returns
	// undefined and would fail for a reason that has nothing to do with the code under test.
	logError.mockResolvedValue(undefined);
	finishQueueEntry.mockResolvedValue(undefined);
	requeueEntry.mockResolvedValue(undefined);
	resolveAccountCeilings.mockResolvedValue({ loopMaxIterations: 50 });
	openBudget.mockResolvedValue({ id: "budget-1" });
	start.mockResolvedValue({ ok: true, runId: "run-1", driver: "coding" });
});

describe("nothing queued", () => {
	it("reports no drain and starts nothing", async () => {
		dequeueNext.mockResolvedValue(null);
		expect(await tryDequeueAndStart(env, "i1", "r1", "owner-1")).toEqual({ drained: false });
		expect(start).not.toHaveBeenCalled();
		expect(openBudget).not.toHaveBeenCalled();
	});
});

describe("a successful start", () => {
	it("marks the entry started and records the run it became", async () => {
		dequeueNext.mockResolvedValue(entry());
		const out = await tryDequeueAndStart(env, "i1", "r1", "owner-1");
		expect(out).toEqual({ drained: true, entryId: "objq-1", started: true, runId: "run-1", driver: "coding" });
		expect(finishQueueEntry).toHaveBeenCalledWith(env, "objq-1", "started", null, "run-1");
	});

	it("opens its OWN budget pool — this is a new autonomous entry point (#184)", async () => {
		dequeueNext.mockResolvedValue(entry());
		await tryDequeueAndStart(env, "i1", "r1", "owner-1");
		expect(openBudget).toHaveBeenCalledWith(env, "owner-1", "i1");
		expect(start.mock.calls[0][0]).toMatchObject({ budgetId: "budget-1" });
	});

	it("clamps max_iterations against the ceiling in force AT START, not at enqueue", async () => {
		resolveAccountCeilings.mockResolvedValue({ loopMaxIterations: 5 });
		dequeueNext.mockResolvedValue(entry({ maxIterations: 40 }));
		await tryDequeueAndStart(env, "i1", "r1", "owner-1");
		expect(start.mock.calls[0][0].maxIterations).toBe(5);
	});

	it("an entry that named no iteration count gets the same default a plain coding_loop_start gets", async () => {
		dequeueNext.mockResolvedValue(entry({ maxIterations: null }));
		await tryDequeueAndStart(env, "i1", "r1", "owner-1");
		expect(start.mock.calls[0][0].maxIterations).toBe(10);
	});

	it("runs as the ENTRY's owner, not as whoever's run happened to finish", async () => {
		dequeueNext.mockResolvedValue(entry({ userId: "owner-1" }));
		await tryDequeueAndStart(env, "i1", "r1", "someone-else");
		expect(start.mock.calls[0][0]).toMatchObject({ userId: "owner-1" });
		expect(openBudget).toHaveBeenCalledWith(env, "owner-1", "i1");
	});

	it("starts at depth 0 — a queued objective is the owner's, not the finished run's subordinate", async () => {
		dequeueNext.mockResolvedValue(entry());
		await tryDequeueAndStart(env, "i1", "r1", "owner-1");
		expect(start.mock.calls[0][0]).toMatchObject({ depth: 0 });
	});
});

describe("which repo a drained entry runs on", () => {
	it("uses the entry's own repo when it named one", async () => {
		dequeueNext.mockResolvedValue(entry({ repoId: "r-named" }));
		await tryDequeueAndStart(env, "i1", "r1", "owner-1");
		expect(start.mock.calls[0][0]).toMatchObject({ repoId: "r-named" });
	});

	it("a repo-agnostic entry runs on the repo whose lock just cleared", async () => {
		dequeueNext.mockResolvedValue(entry({ repoId: null }));
		await tryDequeueAndStart(env, "i1", "r-freed", "owner-1");
		expect(start.mock.calls[0][0]).toMatchObject({ repoId: "r-freed" });
	});

	it("with neither, the choice is left to pickLoopRepo", async () => {
		dequeueNext.mockResolvedValue(entry({ repoId: null }));
		await tryDequeueAndStart(env, "i1", null, "owner-1");
		expect(start.mock.calls[0][0].repoId).toBeUndefined();
	});
});

describe("when the start is refused", () => {
	it("busy again is a RACE: the entry goes back to pending, keeping its place", async () => {
		dequeueNext.mockResolvedValue(entry());
		start.mockResolvedValue({ ok: false, status: 409, reason: "busy", error: "repo is already being worked on" });
		const out = await tryDequeueAndStart(env, "i1", "r1", "owner-1");
		expect(requeueEntry).toHaveBeenCalledWith(env, "objq-1");
		expect(finishQueueEntry).not.toHaveBeenCalled();
		expect(out).toMatchObject({ drained: true, started: false, requeued: true });
	});

	it("a structural refusal FAILS the entry with the driver's own sentence", async () => {
		// No runner, no repo, an unusable checkout — waiting fixes none of them, and an entry left
		// pending forever with nobody told why is the loss this issue is about wearing a new hat.
		dequeueNext.mockResolvedValue(entry());
		start.mockResolvedValue({ ok: false, status: 409, error: "No runner is connected — run `pags up`." });
		const out = await tryDequeueAndStart(env, "i1", "r1", "owner-1");
		expect(finishQueueEntry).toHaveBeenCalledWith(env, "objq-1", "failed", "No runner is connected — run `pags up`.");
		expect(requeueEntry).not.toHaveBeenCalled();
		expect(out).toMatchObject({ drained: true, started: false, requeued: false });
	});
});

describe("when the budget refuses", () => {
	it("fails the entry and never reaches the driver", async () => {
		dequeueNext.mockResolvedValue(entry());
		openBudget.mockRejectedValue(new Error("D1 write failed"));
		const out = await tryDequeueAndStart(env, "i1", "r1", "owner-1");
		expect(start).not.toHaveBeenCalled();
		expect(finishQueueEntry).toHaveBeenCalledWith(env, "objq-1", "failed", "budget refused: D1 write failed");
		expect(out).toMatchObject({ drained: true, started: false, requeued: false });
		expect(logError).toHaveBeenCalled();
	});
});

describe("it never throws", () => {
	it("swallows and records a dequeue that blows up", async () => {
		dequeueNext.mockRejectedValue(new Error("D1 unreachable"));
		await expect(tryDequeueAndStart(env, "i1", "r1", "owner-1")).resolves.toEqual({ drained: false });
		expect(logError).toHaveBeenCalled();
	});

	it("swallows and records a driver that blows up, naming the entry it stranded", async () => {
		dequeueNext.mockResolvedValue(entry());
		start.mockRejectedValue(new Error("workflow binding exploded"));
		const out = await tryDequeueAndStart(env, "i1", "r1", "owner-1");
		expect(out).toMatchObject({ drained: true, entryId: "objq-1", started: false });
		expect(logError.mock.calls[0][1].context).toMatchObject({ entryId: "objq-1" });
	});
});
