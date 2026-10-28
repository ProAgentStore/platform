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
 *   recovery_required     → back to `pending` with the reason on the row (#984): the repo is
 *                           mid-handover, which a person resolves
 *   runner_offline        → back to `pending` (#1161): the machine is away; its relay reconnecting
 *                           drains the queue — for at most a day (#1189), then `failed`
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

vi.mock("./provider-account-hold.js", () => ({ automaticProviderHold: async () => null }));

vi.mock("./objective-queue.js", () => ({
	dequeueNext: (...a: unknown[]) => dequeueNext(...a),
	finishQueueEntry: (...a: unknown[]) => finishQueueEntry(...a),
	requeueEntry: (...a: unknown[]) => requeueEntry(...a),
}));
vi.mock("./loop-drivers.js", async (orig) => ({
	loopDriverFor: () => ({ id: "coding", label: "the engine", start: (...a: unknown[]) => start(...a) }),
	// The REAL predicate, not a stub: which refusals are waited for is the decision this file is
	// about, and a mock that answered it would assert the mock (#984). It was a hand copy until
	// #1161, which is how a new waitable reason could have gone unseen here.
	startRefusalIsWaitable: (await orig<typeof import("./loop-drivers.js")>()).startRefusalIsWaitable,
}));
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
	requeueEntry.mockResolvedValue({ requeued: true, deferralSeq: 1 });
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
		// A queued entry carries no verified origin: whoever enqueued it, the engine is told "unverified" (#1019).
		expect(start.mock.calls[0][0].objectiveOrigin).toBeUndefined();
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
		expect(requeueEntry).toHaveBeenCalledWith(env, "objq-1", "repo is already being worked on", { reason: "busy" });
		expect(finishQueueEntry).not.toHaveBeenCalled();
		expect(out).toMatchObject({ drained: true, started: false, requeued: true });
	});

	it("recovery_required is WAITED FOR too, with the reason recorded on the row (#984)", async () => {
		// The repo holds work a closed run owns, or an engine still executing a dead run's
		// instruction. Failing the entry would drop a queued issue on the floor; starting it is the
		// incident. It keeps its place and says why — the queue's own answer to "nothing is moving".
		dequeueNext.mockResolvedValue(entry());
		start.mockResolvedValue({ ok: false, status: 409, reason: "recovery_required", error: "This checkout holds 8 uncommitted files belonging to run run-978 (issue #978)." });
		const out = await tryDequeueAndStart(env, "i1", "r1", "owner-1");
		expect(requeueEntry).toHaveBeenCalledWith(env, "objq-1", "This checkout holds 8 uncommitted files belonging to run run-978 (issue #978).", { reason: "recovery_required" });
		expect(finishQueueEntry).not.toHaveBeenCalled();
		expect(out).toMatchObject({ drained: true, started: false, requeued: true });
	});

	it("runner_offline is WAITED FOR: a machine asleep keeps the entry, and the rest of the queue, in place (#1161)", async () => {
		// Before: the refusal carried no reason, so the queue failed the entry as structural and nothing
		// was left to drain the entries behind it. The relay reconnecting drains it (routes/relay.ts).
		dequeueNext.mockResolvedValue(entry());
		start.mockResolvedValue({ ok: false, status: 409, reason: "runner_offline", error: "No coding runner connected for owner/repo — run `pags up`." });
		const out = await tryDequeueAndStart(env, "i1", "r1", "owner-1");
		expect(requeueEntry).toHaveBeenCalledWith(env, "objq-1", "No coding runner connected for owner/repo — run `pags up`.", { reason: "runner_offline" });
		expect(finishQueueEntry).not.toHaveBeenCalled();
		expect(out).toMatchObject({ drained: true, started: false, requeued: true });
	});

	it("runner_offline has an end (#1189): past the whole bound a drain that finds the machine still away FAILS the entry, naming the bound", async () => {
		const longAgo = Date.now() - 25 * 3600_000;
		dequeueNext.mockResolvedValue(entry({ offlineSince: longAgo }));
		start.mockResolvedValue({ ok: false, status: 409, reason: "runner_offline", error: "No coding runner connected for owner/repo — run `pags up`." });
		const out = await tryDequeueAndStart(env, "i1", "r1", "owner-1");
		expect(requeueEntry).not.toHaveBeenCalled();
		expect(finishQueueEntry).toHaveBeenCalledWith(env, "objq-1", "failed", expect.stringContaining("the longest a queued objective waits"));
		expect(out).toMatchObject({ drained: true, started: false, requeued: false, error: expect.stringContaining("queue it again") });
	});

	it("runner_offline inside the bound still waits, and an entry with no clock (queued before 0296) waits too", async () => {
		for (const offlineSince of [Date.now() - 3600_000, null, undefined]) {
			requeueEntry.mockClear();
			finishQueueEntry.mockClear();
			dequeueNext.mockResolvedValue(entry({ offlineSince }));
			start.mockResolvedValue({ ok: false, status: 409, reason: "runner_offline", error: "No coding runner connected." });
			const out = await tryDequeueAndStart(env, "i1", "r1", "owner-1");
			expect(requeueEntry).toHaveBeenCalledTimes(1);
			expect(finishQueueEntry).not.toHaveBeenCalled();
			expect(out).toMatchObject({ requeued: true });
		}
	});

	it("only an offline runner is bounded: another waitable reason is requeued however old the entry's offline clock", async () => {
		dequeueNext.mockResolvedValue(entry({ offlineSince: Date.now() - 100 * 3600_000 }));
		start.mockResolvedValue({ ok: false, status: 409, reason: "recovery_required", error: "The checkout holds uncommitted work." });
		await tryDequeueAndStart(env, "i1", "r1", "owner-1");
		expect(requeueEntry).toHaveBeenCalledTimes(1);
		expect(finishQueueEntry).not.toHaveBeenCalled();
	});

	it("runner_overloaded is WAITED FOR, with the reason passed through for the timed backoff (#1264)", async () => {
		// Unlike `runner_offline`, nothing EVENT-SHAPED resolves this — the machine recovers on its own
		// clock, which only `requeueEntry`'s own timed `next_retry_at` (via this reason) catches.
		dequeueNext.mockResolvedValue(entry());
		start.mockResolvedValue({ ok: false, status: 409, reason: "runner_overloaded", error: "Mac.modem is overloaded (memory: 99.6% used (threshold 92%))." });
		const out = await tryDequeueAndStart(env, "i1", "r1", "owner-1");
		expect(requeueEntry).toHaveBeenCalledWith(env, "objq-1", "Mac.modem is overloaded (memory: 99.6% used (threshold 92%)).", { reason: "runner_overloaded" });
		expect(finishQueueEntry).not.toHaveBeenCalled();
		expect(out).toMatchObject({ drained: true, started: false, requeued: true });
	});

	it("runner_unresponsive is WAITED FOR the same way: a runner that missed a ping heals on its own, so the entry is requeued with the reason, never failed (#1388)", async () => {
		dequeueNext.mockResolvedValue(entry());
		const error = "tiny-laptop could not start: Runner relay is connected but not responding [runner-unreachable:UNRESPONSIVE@/coding/start]";
		start.mockResolvedValue({ ok: false, status: 409, reason: "runner_unresponsive", error });
		const out = await tryDequeueAndStart(env, "i1", "r1", "owner-1");
		expect(requeueEntry).toHaveBeenCalledWith(env, "objq-1", error, { reason: "runner_unresponsive" });
		expect(finishQueueEntry).not.toHaveBeenCalled();
		expect(out).toMatchObject({ drained: true, started: false, requeued: true });
	});

	it("a structural refusal FAILS the entry with the driver's own sentence", async () => {
		// No repo, an unusable checkout — waiting fixes neither, and an entry left pending forever
		// with nobody told why is the loss this issue is about wearing a new hat.
		dequeueNext.mockResolvedValue(entry());
		start.mockResolvedValue({ ok: false, status: 409, error: "This checkout is not a git working tree." });
		const out = await tryDequeueAndStart(env, "i1", "r1", "owner-1");
		expect(finishQueueEntry).toHaveBeenCalledWith(env, "objq-1", "failed", "This checkout is not a git working tree.");
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

describe("a paused instance keeps its queue (#1015)", () => {
	/** An instance row the drain reads before it claims anything. */
	const envWithStatus = (status: string) =>
		({ DB: { prepare: () => ({ bind: () => ({ first: async () => ({ status }) }) }) } }) as unknown as Env;

	it("claims NOTHING while paused — no dequeue, no budget, the entry stays pending and untouched", async () => {
		dequeueNext.mockResolvedValue(entry());
		expect(await tryDequeueAndStart(envWithStatus("paused"), "i1", "r1", "owner-1")).toEqual({ drained: false });
		expect(dequeueNext).not.toHaveBeenCalled();
		expect(openBudget).not.toHaveBeenCalled();
		expect(finishQueueEntry).not.toHaveBeenCalled();
	});

	it("drains as usual once active", async () => {
		dequeueNext.mockResolvedValue(entry());
		expect(await tryDequeueAndStart(envWithStatus("active"), "i1", "r1", "owner-1")).toMatchObject({ drained: true, started: true });
	});

	it("a pause that lands between the claim and the start REQUEUES the entry — it is never failed", async () => {
		// The driver's own pause gate now refuses with `reason: "paused"`, which is waitable.
		dequeueNext.mockResolvedValue(entry());
		start.mockResolvedValue({ ok: false, status: 409, reason: "paused", error: "This agent is paused." });
		const out = await tryDequeueAndStart(envWithStatus("active"), "i1", "r1", "owner-1");
		expect(out).toMatchObject({ drained: true, started: false, requeued: true });
		expect(requeueEntry).toHaveBeenCalledWith(expect.anything(), "objq-1", "This agent is paused.", { reason: "paused" });
		expect(finishQueueEntry).not.toHaveBeenCalled();
	});
});
