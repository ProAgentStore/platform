/**
 * `GET /:id/loop/:runId/continue-preview` (#806 item 2) — the review surface behind the Continue
 * button.
 *
 * ── What only this route decides
 *
 * The composition is `loop-continue-preview.ts`'s and is tested there. What is asserted here is
 * the wiring, and every item on that list is something that would silently produce a CONFIDENT
 * WRONG ANSWER rather than an error:
 *
 *   · the continue lookback is passed — without it the preview reports "nothing carries forward"
 *     for every run older than six hours, while the button it describes would have found one;
 *   · the uncommitted count reaches the checkpoint, so the previewed note is the note;
 *   · an unreachable runner is reported as unknown, not as a clean tree;
 *   · the refusal is the POST's refusal, from the same function;
 *   · a refused run still answers 200 — the refusal IS the answer to "what would happen".
 *
 * `pendingCodingResumeCheckpoint` is mocked: which run it picks is `coding-resume-note-repo.test.ts`'s
 * subject, against the real schema. What matters here is what this route ASKS it.
 */
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { CONTINUE_RESUME_LOOKBACK_MS } from "../lib/agent-loop-store.js";
import { CONTINUE_PREVIEW_TREE_UNAVAILABLE } from "../lib/loop-continue-preview.js";
import type { Env } from "../types.js";

const getLoopRun = vi.fn();
const requireOwnedInstance = vi.fn();
const getSession = vi.fn();
const getRepo = vi.fn();
const resolveAccountCeilings = vi.fn();
const readLoopLimits = vi.fn();
const pendingCodingResumeCheckpoint = vi.fn();
const readRepoWorkingState = vi.fn();
const getBoundRunnerConn = vi.fn();

vi.mock("../lib/auth.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/auth.js")>("../lib/auth.js");
	return { ...actual, requireUser: async () => ({ uid: "u1" }) };
});
vi.mock("../lib/agent-loop-store.js", async () => {
	// The real predicate and the real constant, for the same reason the POST's tests keep them:
	// which endings are continuable, and how far back a continue looks, are what these assert.
	const actual = await vi.importActual<typeof import("../lib/agent-loop-store.js")>("../lib/agent-loop-store.js");
	return { ...actual, getLoopRun: (...a: unknown[]) => getLoopRun(...a) };
});
vi.mock("../lib/coding-store.js", () => ({
	getSession: (...a: unknown[]) => getSession(...a),
	getRepo: (...a: unknown[]) => getRepo(...a),
}));
vi.mock("../lib/delegation-budget-store.js", () => ({
	openBudget: vi.fn(),
	resolveAccountCeilings: (...a: unknown[]) => resolveAccountCeilings(...a),
}));
vi.mock("../lib/loop-limits-store.js", () => ({ readLoopLimits: (...a: unknown[]) => readLoopLimits(...a) }));
vi.mock("../lib/coding-resume-note.js", () => ({ pendingCodingResumeCheckpoint: (...a: unknown[]) => pendingCodingResumeCheckpoint(...a) }));
vi.mock("../lib/repo-state.js", () => ({ readRepoWorkingState: (...a: unknown[]) => readRepoWorkingState(...a) }));
vi.mock("../lib/runner-client.js", () => ({ getBoundRunnerConn: (...a: unknown[]) => getBoundRunnerConn(...a) }));
vi.mock("../lib/agent-capabilities.js", () => ({ capabilitiesForInstance: vi.fn() }));
vi.mock("../lib/loop-drivers.js", () => ({ loopDriverFor: () => ({ id: "coding", label: "x", start: vi.fn() }) }));
vi.mock("./instances-runtime.js", () => ({ requireOwnedInstance: (...a: unknown[]) => requireOwnedInstance(...a) }));

const { registerLoopContinueRoutes } = await import("./loop-continue-routes.js");

function app() {
	const router = new Hono<{ Bindings: Env }>();
	registerLoopContinueRoutes(router);
	router.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 404) : c.json({ error: String(e) }, 500)));
	return router;
}

/** #806's own case: a run that spent its step budget mid-work. */
const stoppedRun = {
	runId: "run-1",
	instanceId: "i1",
	objective: "finish the migration",
	status: "failed",
	stopReason: "max_iterations",
	detail: "ran out of steps at 20/20",
	iteration: 20,
	maxIterations: 20,
	startedAt: 1_000,
	finishedAt: 2_000,
	sessionId: "csess_a",
};

const checkpoint = {
	predecessorRunId: "run-1",
	predecessorSessionId: "csess_a",
	endedBy: "max_iterations",
	landed: [{ instanceId: "i1", kind: "push.trunk", summary: "pushed 3 commits to main", ok: true }],
	unobserved: [],
	uncommittedFiles: 0,
	learned: [] as string[],
	note: "PLATFORM NOTE (not from the human): a previous run …",
};

const get = (path: string) => app().request(path, { method: "GET" }, {} as Env);

beforeEach(() => {
	vi.clearAllMocks();
	requireOwnedInstance.mockResolvedValue(undefined);
	getLoopRun.mockResolvedValue({ ...stoppedRun });
	getSession.mockResolvedValue({ id: "csess_a", repoId: "repo-7" });
	getRepo.mockResolvedValue({ id: "repo-7", name: "platform", workdir: "/w" });
	resolveAccountCeilings.mockResolvedValue({ loopMaxIterations: 50 });
	readLoopLimits.mockResolvedValue({});
	getBoundRunnerConn.mockResolvedValue({ runnerNode: "laptop" });
	readRepoWorkingState.mockResolvedValue({ changedFiles: 3 });
	pendingCodingResumeCheckpoint.mockResolvedValue({ ...checkpoint });
});

describe("the happy path", () => {
	it("answers what a continue would carry forward, without starting anything", async () => {
		const res = await get("/i1/loop/run-1/continue-preview");
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.canContinue).toBe(true);
		expect(body.refusal).toBeNull();
		expect(body.objective).toBe("finish the migration");
		expect(body.stopReason).toBe("max_iterations");
		expect(body.briefing).toMatchObject({ kind: "this-run", predecessorRunId: "run-1", landed: ["pushed 3 commits to main"] });
		expect(body.summary).toContain("what this run left behind");
	});

	it("reports the ceiling a continue would grant, through the same clamps the POST uses", async () => {
		// #820: the instance floor applies to the empty-body default, so a 20-step run whose
		// instance floor is 40 is continued with 40. Showing 20 here would be the page promising
		// the stall the floor exists to prevent.
		readLoopLimits.mockResolvedValue({ minIterations: 40 });
		const body = (await (await get("/i1/loop/run-1/continue-preview")).json()) as { maxIterations: number };
		expect(body.maxIterations).toBe(40);
	});
});

describe("the two reads that make the preview the truth rather than an estimate", () => {
	it("asks for the predecessor with the CONTINUE lookback, not the six-hour default", async () => {
		// The entire difference between a continue and a restart (#806 item 4). Without it this
		// page tells an owner checking back the next morning that nothing carries forward, while
		// the button beside it would have found the run.
		await get("/i1/loop/run-1/continue-preview");
		expect(pendingCodingResumeCheckpoint).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ sessionId: "csess_a", lookbackMs: CONTINUE_RESUME_LOOKBACK_MS }),
		);
	});

	it("shows the stopped Pilot's own notes from the SAME checkpoint the run is briefed from (#822, #806)", async () => {
		pendingCodingResumeCheckpoint.mockResolvedValue({ ...checkpoint, learned: ["Fix written, tests green. Next: rebase and push."] });
		const body = (await (await get("/i1/loop/run-1/continue-preview")).json()) as { summary: string; briefing: { learned: string[] } };
		expect(body.briefing.learned).toEqual(["Fix written, tests green. Next: rebase and push."]);
		expect(body.summary).toContain("the note its Pilot wrote to itself as it worked");
	});

	it("threads the uncommitted count INTO the checkpoint, so the previewed note is the real note", async () => {
		// Slice (iii) made the note depend on the dirty tree. A preview that passed 0 here would
		// render a note missing the clause the run will actually be given.
		await get("/i1/loop/run-1/continue-preview");
		expect(pendingCodingResumeCheckpoint).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ uncommittedFiles: 3 }));
	});

	it("quotes the checkpoint's note verbatim rather than composing its own", async () => {
		const body = (await (await get("/i1/loop/run-1/continue-preview")).json()) as { briefing: { note: string } };
		expect(body.briefing.note).toBe(checkpoint.note);
	});

	it("probes the machine the continue would run on, resolved through the 'Runs on' pin", async () => {
		await get("/i1/loop/run-1/continue-preview");
		expect(getBoundRunnerConn).toHaveBeenCalled();
		expect(readRepoWorkingState).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ sessionId: "csess_a" }));
	});
});

describe("an unreachable runner is reported, never guessed at", () => {
	it("says the tree is unknown when no runner is connected", async () => {
		// The EXPECTED case here: item 4 is an owner checking back hours later.
		getBoundRunnerConn.mockResolvedValue(null);
		const body = (await (await get("/i1/loop/run-1/continue-preview")).json()) as {
			briefing: { uncommittedFiles: number | null; workingTree: string; caveat: string };
		};
		expect(body.briefing.uncommittedFiles).toBeNull();
		expect(body.briefing.workingTree).toBe("unavailable");
		expect(body.briefing.caveat).toBe(CONTINUE_PREVIEW_TREE_UNAVAILABLE);
	});

	it("survives a runner that answers with an error, and still reports the rest", async () => {
		readRepoWorkingState.mockRejectedValue(new Error("relay timeout"));
		const res = await get("/i1/loop/run-1/continue-preview");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { briefing: { workingTree: string }; canContinue: boolean };
		expect(body.briefing.workingTree).toBe("unavailable");
		expect(body.canContinue).toBe(true);
	});

	it("passes 0 to the checkpoint when the tree could not be read — the same value the workflow passes", async () => {
		// `coding-session.ts` uses `repoState?.changedFiles ?? 0` on its own failed read, so an
		// unreadable tree must produce the SAME note in both places rather than two different ones.
		getBoundRunnerConn.mockResolvedValue(null);
		await get("/i1/loop/run-1/continue-preview");
		expect(pendingCodingResumeCheckpoint).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ uncommittedFiles: 0 }));
	});
});

describe("a run that cannot be continued still gets an answer", () => {
	it("answers 200 with the POST's own refusal, not an error", async () => {
		// The refusal IS the answer to "what would happen if I pressed this". An owner reading why
		// the button is absent is exactly who this surface is for, so it must not 4xx at them.
		getLoopRun.mockResolvedValue({ ...stoppedRun, status: "completed", stopReason: "done" });
		const res = await get("/i1/loop/run-1/continue-preview");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { canContinue: boolean; refusal: string };
		expect(body.canContinue).toBe(false);
		expect(body.refusal).toContain("start a new one rather than continuing it");
	});

	it("names the still-running case separately — that one sends you to Stop, not to a new objective", async () => {
		getLoopRun.mockResolvedValue({ ...stoppedRun, status: "running", finishedAt: null });
		const body = (await (await get("/i1/loop/run-1/continue-preview")).json()) as { canContinue: boolean; refusal: string };
		expect(body.canContinue).toBe(false);
		expect(body.refusal).toContain("still going");
	});

	it("uses the SAME sentence the POST refuses with", async () => {
		// Two copies of these sentences is how a page comes to explain a refusal the server does
		// not make. Asserted by driving both surfaces on one run.
		getLoopRun.mockResolvedValue({ ...stoppedRun, status: "failed", stopReason: "failed" });
		const preview = (await (await get("/i1/loop/run-1/continue-preview")).json()) as { refusal: string };
		const posted = await app().request(
			"/i1/loop/run-1/continue",
			{ method: "POST", body: "{}", headers: { "content-type": "application/json" } },
			{} as Env,
		);
		expect(posted.status).toBe(409);
		expect(((await posted.json()) as { error: string }).error).toBe(preview.refusal);
	});
});

describe("tenancy and shape", () => {
	it("404s a run that belongs to another instance of the same owner", async () => {
		getLoopRun.mockResolvedValue({ ...stoppedRun, instanceId: "i2" });
		expect((await get("/i1/loop/run-1/continue-preview")).status).toBe(404);
	});

	it("404s a run that does not exist", async () => {
		getLoopRun.mockResolvedValue(null);
		expect((await get("/i1/loop/run-1/continue-preview")).status).toBe(404);
	});

	it("asks for no checkpoint and probes no runner for a CHAT run, which has no repo", async () => {
		getLoopRun.mockResolvedValue({ ...stoppedRun, sessionId: null });
		const body = (await (await get("/i1/loop/run-1/continue-preview")).json()) as {
			repoId: string | null;
			briefing: { kind: string };
		};
		expect(pendingCodingResumeCheckpoint).not.toHaveBeenCalled();
		expect(readRepoWorkingState).not.toHaveBeenCalled();
		expect(body.repoId).toBeNull();
		expect(body.briefing.kind).toBe("none");
	});

	it("reports `other-run` when the immediate predecessor is a different run", async () => {
		pendingCodingResumeCheckpoint.mockResolvedValue({ ...checkpoint, predecessorRunId: "run-9" });
		const body = (await (await get("/i1/loop/run-1/continue-preview")).json()) as {
			briefing: { kind: string; predecessorRunId: string };
			summary: string;
		};
		expect(body.briefing.kind).toBe("other-run");
		expect(body.briefing.predecessorRunId).toBe("run-9");
		expect(body.summary).toContain("a more recent stopped run");
	});

	it("reports `none` when the checkpoint read found nothing", async () => {
		pendingCodingResumeCheckpoint.mockResolvedValue(null);
		const body = (await (await get("/i1/loop/run-1/continue-preview")).json()) as { briefing: { kind: string }; summary: string };
		expect(body.briefing.kind).toBe("none");
		expect(body.summary).toMatch(/^Nothing carries forward/);
	});
});
