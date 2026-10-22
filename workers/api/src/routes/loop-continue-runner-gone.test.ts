/**
 * #1188: a run that stopped `runner_gone` after its 24h park is continuable once its machine is back — and not before.
 *
 * Same harness as loop-continue-routes.test.ts: the driver's start is mocked (single-flight and the checkout are the driver's
 * tests); what is pinned here is WHICH runs may be continued, when, and what the report/classifier now record.
 */
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { isResumableStopReason, RESUMABLE_STOP_REASONS } from "../lib/agent-loop-store.js";
import { statusFor } from "../lib/agent-loop.js";
import { codingCrashReport } from "../lib/coding-run-report.js";
import { RUNNER_PARK_MS, RUNNER_WAIT_MS } from "../lib/runner-availability.js";
import { RunnerGoneError } from "../lib/runner-unreachable.js";
import type { Env } from "../types.js";

const getLoopRun = vi.fn();
const getBoundRunnerConn = vi.fn();
const start = vi.fn();
vi.mock("../lib/auth.js", async () => ({ ...(await vi.importActual<typeof import("../lib/auth.js")>("../lib/auth.js")), requireUser: async () => ({ uid: "u1" }) }));
vi.mock("../lib/agent-loop-store.js", async () => ({ ...(await vi.importActual<typeof import("../lib/agent-loop-store.js")>("../lib/agent-loop-store.js")), getLoopRun: (...a: unknown[]) => getLoopRun(...a) }));
vi.mock("../lib/coding-store.js", () => ({ getSession: async () => ({ id: "csess_a", repoId: "repo-7" }), getRepo: async () => ({ id: "r1", workdir: "~/dev/x" }) }));
vi.mock("../lib/coding-ownership.js", () => ({ repoFreeForRun: async () => ({ free: true }), runnerEngineProbe: () => async () => "idle" }));
vi.mock("../lib/runner-client.js", () => ({
	relayConnected: async () => false,
	getRunnerConnIgnoringLiveness: async () => null,
	getBoundRunnerConn: (...a: unknown[]) => getBoundRunnerConn(...a),
	callRunner: async () => ({}),
}));
vi.mock("../lib/delegation-budget-store.js", () => ({ openBudget: async () => ({ id: "budget-new" }), resolveAccountCeilings: async () => ({ loopMaxIterations: 50 }) }));
vi.mock("../lib/agent-capabilities.js", () => ({ capabilitiesForInstance: async () => ({ workflow: "CODING_SESSION" }) }));
vi.mock("../lib/loop-drivers.js", () => ({ loopDriverFor: () => ({ id: "coding", label: "x", start }) }));
vi.mock("./instances-runtime.js", () => ({ requireOwnedInstance: async () => undefined }));
vi.mock("../lib/repo-state.js", () => ({ readRepoWorkingState: async () => null }));
vi.mock("../lib/coding-resume-note.js", () => ({ pendingCodingResumeCheckpoint: async () => null }));

const { registerLoopContinueRoutes } = await import("./loop-continue-routes.js");

const run = (over: Record<string, unknown> = {}) => ({
	runId: "run-1",
	instanceId: "i1",
	objective: "finish the migration",
	status: "needs_human",
	stopReason: "runner_gone",
	iteration: 3,
	maxIterations: 20,
	startedAt: 1_000,
	finishedAt: 2_000,
	sessionId: "csess_a",
	...over,
});
const call = (path: string, method = "POST") => {
	const r = new Hono<{ Bindings: Env }>();
	registerLoopContinueRoutes(r);
	r.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 409) : c.json({ error: String(e) }, 500)));
	return r.request(path, { method, body: method === "POST" ? "{}" : undefined, headers: { "content-type": "application/json" } }, { DB: { prepare: () => ({ bind: () => ({ run: async () => undefined, first: async () => null, all: async () => ({ results: [] }) }) }) } } as unknown as Env);
};

beforeEach(() => {
	vi.clearAllMocks();
	getLoopRun.mockResolvedValue(run());
	start.mockResolvedValue({ ok: true, runId: "run-2", driver: "coding" });
	getBoundRunnerConn.mockResolvedValue({ runnerNode: "mac" });
});

describe("what a runner_gone ending records (#1188)", () => {
	it("a waited-out runner is `runner_gone` — reported as itself, with no crash prefix", () => {
		const r = codingCrashReport(new RunnerGoneError("The runner did not come back: this run waited 24h for its machine."));
		expect(r).toEqual({ detail: "The runner did not come back: this run waited 24h for its machine.", stopReason: "runner_gone" });
		expect(r.detail).not.toMatch(/^run error:/);
	});

	it("it is on the resumable list and reads as needs-a-human, not failed", () => {
		expect(RESUMABLE_STOP_REASONS).toContain("runner_gone");
		expect(isResumableStopReason("runner_gone")).toBe(true);
		expect(statusFor("runner_gone")).toBe("needs_human");
	});

	it("the 24h park bound and the 10-minute poll are unchanged", () => {
		expect(RUNNER_PARK_MS).toBe(24 * 60 * 60_000);
		expect(RUNNER_WAIT_MS).toBe(10 * 60_000);
	});

	it("other endings are unaffected: an ordinary crash keeps its prefix and no stop reason; a verdict is not resumable", () => {
		expect(codingCrashReport(new Error("boom"))).toEqual({ detail: "run error: boom", stopReason: null });
		for (const reason of ["failed", "cancelled", "done", "escalated", "no_progress", "budget"]) expect(isResumableStopReason(reason)).toBe(false);
	});
});

describe("continuing a runner_gone run", () => {
	it("is REFUSED while its machine is still away — nothing started", async () => {
		getBoundRunnerConn.mockResolvedValue(null);
		const res = await call("/i1/loop/run-1/continue");
		expect(res.status).toBe(409);
		expect(((await res.json()) as { error: string }).error).toMatch(/machine is still away.*pags up/);
		expect(start).not.toHaveBeenCalled();
	});

	it("a failed look at the relay counts as away, never as back", async () => {
		getBoundRunnerConn.mockRejectedValue(new Error("relay down"));
		expect((await call("/i1/loop/run-1/continue")).status).toBe(409);
		expect(start).not.toHaveBeenCalled();
	});

	it("succeeds once the machine has reconnected, on the same objective and repo", async () => {
		getBoundRunnerConn.mockResolvedValue(null);
		expect((await call("/i1/loop/run-1/continue")).status).toBe(409);
		getBoundRunnerConn.mockResolvedValue({ runnerNode: "mac" }); // it re-registered
		const res = await call("/i1/loop/run-1/continue");
		expect(res.status).toBe(201);
		expect(await res.json()).toMatchObject({ runId: "run-2", continuedFromRunId: "run-1" });
		expect(start.mock.calls[0][0]).toMatchObject({ instanceId: "i1", objective: "finish the migration", repoId: "repo-7" });
	});

	it("a duplicate continue is refused by the driver's single-flight, not run twice", async () => {
		start.mockResolvedValueOnce({ ok: true, runId: "run-2", driver: "coding" });
		expect((await call("/i1/loop/run-1/continue")).status).toBe(201);
		start.mockResolvedValueOnce({ ok: false, status: 409, error: "repo-7 is already being worked on — wait for the current run to finish." });
		const second = await call("/i1/loop/run-1/continue");
		expect(second.status).toBe(409);
		expect(start).toHaveBeenCalledTimes(2);
	});

	it("the preview says the same thing: canContinue is false while away, true once back", async () => {
		getBoundRunnerConn.mockResolvedValue(null);
		const away = (await (await call("/i1/loop/run-1/continue-preview", "GET")).json()) as { canContinue: boolean; refusal: string | null };
		expect(away).toMatchObject({ canContinue: false });
		expect(away.refusal).toMatch(/still away/);
		getBoundRunnerConn.mockResolvedValue({ runnerNode: "mac" });
		expect(((await (await call("/i1/loop/run-1/continue-preview", "GET")).json()) as { canContinue: boolean }).canContinue).toBe(true);
	});

	it("never asks the relay for a run that did not end runner_gone: other endings keep their own rule", async () => {
		getBoundRunnerConn.mockResolvedValue(null); // away — irrelevant to these
		getLoopRun.mockResolvedValue(run({ stopReason: "max_iterations" }));
		expect((await call("/i1/loop/run-1/continue")).status).toBe(201);
		for (const [status, stopReason] of [["failed", "failed"], ["cancelled", "cancelled"], ["done", "done"]] as const) {
			getLoopRun.mockResolvedValue(run({ status, stopReason }));
			expect((await call("/i1/loop/run-1/continue")).status).toBe(409);
		}
		expect(getBoundRunnerConn).not.toHaveBeenCalled();
	});

	it("a run still going is refused first, whatever the machine is doing", async () => {
		getLoopRun.mockResolvedValue(run({ finishedAt: null, stopReason: null, status: "running" }));
		const res = await call("/i1/loop/run-1/continue");
		expect(res.status).toBe(409);
		expect(((await res.json()) as { error: string }).error).toMatch(/still going/);
	});
});
