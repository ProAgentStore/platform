/**
 * #964 (from #960's findings), #1076 — the decision flow, end to end, over the real schema.
 *
 * The REAL `runCodingSessionWorkflow` reaches an `ask_owner` decision and PARKS on it at zero compute
 * (`step.waitForEvent`: no sleep loop, no runner poll). The owner answers — days later — through the
 * PUBLIC path, `POST /v1/instances/:id/input`, the route the console's answer box and
 * `answer_instance_input` both call. The answer is written to its question row (#1075), the parked
 * instance is woken, and the SAME run resumes with the answer read from the row: the park stopped the
 * engine, so the runner has nothing to report, which is also the runner-restart case.
 * Faked: the BYOK brain (scripted decisions), the machine (a small in-memory model of the runner's
 * coding takeover map) and the Workflows binding's `sendEvent`. Nothing in between is faked.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { callRunner, decideCodingAction } = vi.hoisted(() => ({ callRunner: vi.fn(), decideCodingAction: vi.fn() }));
vi.mock("../lib/runner-client.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/runner-client.js")>("../lib/runner-client.js");
	const conn = { kind: "relay", instanceId: "i1", runnerNode: "n1", relayName: "i1:node:n1" };
	return {
		...actual,
		callRunner: (...a: unknown[]) => callRunner(...a),
		getRunnerConn: async () => conn,
		getRunnerConnIgnoringLiveness: async () => conn,
		getBoundRunnerConn: async () => conn,
		relayConnected: async () => true,
	};
});
vi.mock("../lib/coding-loop.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/coding-loop.js")>("../lib/coding-loop.js");
	return { ...actual, decideCodingAction: (...a: unknown[]) => decideCodingAction(...a) };
});
vi.mock("../lib/auth.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/auth.js")>("../lib/auth.js");
	return { ...actual, requireUser: async () => ({ uid: "u1", roles: [] }) };
});

import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { HttpError } from "../lib/auth.js";
import { getLoopRun } from "../lib/agent-loop-store.js";
import { toDecision, type CodingDecision, type CodingGoal } from "../lib/coding-loop.js";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import { waitClause } from "../lib/work-report.js";
import { runCodingSessionWorkflow } from "../workflows/coding-session/workflow-run.js";
import { continueRefusal } from "./loop-continue-routes.js";
import type { CodingSessionParams } from "../workflows/coding-session-params.js";
import type { Env } from "../types.js";

const { instanceRoutes } = await import("./instances.js");

const IDLE = { pane: "$ ", runState: "idle", ready: true, alive: true };
const IN_SYNC = { checked: true, branch: "main", upstream: "origin/main", localHead: "aaaaaaaa1", remoteHead: "aaaaaaaa1", ahead: 0, behind: 0, fetched: true };

let d1: RealSchemaD1;
let env: Env;
/** Events sent to Workflow instances (#1076) — how an answer wakes a parked run. */
let woken: Array<{ instance: string; type: string }>;
/** What the Workflows binding reports for an instance's status (#1231). */
let workflowStatus: string;
/** The runner's coding takeover map, keyed by session — the thing an answer must reach. */
let pause: { open: boolean; resolved: boolean; value?: string };
let decisions: CodingDecision[];
let decided: CodingGoal[];
let acts: string[];

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["i1"] });
	d1.exec(`INSERT INTO coding_repos (id, instance_id, user_id, name, workdir, clone_status) VALUES ('r1', 'i1', 'u1', 'owner/repo', '/w/repo', 'ready')`);
	d1.exec(`INSERT INTO coding_sessions (id, instance_id, repo_id, user_id, status, client_type) VALUES ('s1', 'i1', 'r1', 'u1', 'active', 'claude')`);
	d1.exec(`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, max_iterations, started_at, session_id)
	  VALUES ('run-1', 'u1', 'i1', 'retire the v1 API', 'running', 10, ${Date.now()}, 's1')`);
	woken = [];
	workflowStatus = "waiting";
	const CODING_SESSION = { get: async (instance: string) => ({ status: async () => ({ status: workflowStatus }), sendEvent: async (e: { type: string }) => void woken.push({ instance, type: e.type }) }) };
	env = { DB: d1.DB, CODING_SESSION } as unknown as Env;
	pause = { open: false, resolved: false };
	acts = [];
	callRunner.mockReset();
	callRunner.mockImplementation(async (_conn: unknown, path: string, body: Record<string, unknown> = {}) => {
		if (path === "/coding/takeover") pause = { open: true, resolved: false };
		else if (path === "/coding/takeover/s1/resolve") {
			if (pause.open) pause = { open: true, resolved: true, value: String(body.value ?? "") };
		} else if (path === "/coding/takeover-status") return { resolved: pause.resolved, value: pause.value };
		else if (path === "/coding/takeover/s1/end") pause = { open: false, resolved: false };
		else if (path === "/coding/act") acts.push(String((body.action as { text?: string } | undefined)?.text ?? ""));
		else if (path === "/coding/git") return { output: "## main...origin/main\n" };
		else if (path === "/coding/sync") return IN_SYNC;
		else if (path === "/coding/start") return { ok: true, sessionId: "s1" };
		return IDLE;
	});
	decided = [];
	decideCodingAction.mockReset();
	decideCodingAction.mockImplementation(async (_e: unknown, _u: unknown, p: { goal: CodingGoal }) => {
		decided.push(structuredClone(p.goal));
		return decisions.length > 1 ? decisions.shift() : decisions[0];
	});
});
afterEach(() => d1.close());

/** The journal; `onWait` runs while the run waits on an event (#1076) — return `"timeout"` to time the wait out. */
function step(onSleep: (name: string) => Promise<void>, onWait: (name: string, type: string) => Promise<unknown> = async () => undefined): WorkflowStep {
	const done = new Map<string, unknown>();
	return {
		async do(name: string, a: unknown, b?: unknown) {
			const cb = (typeof a === "function" ? a : b) as () => Promise<unknown>;
			if (done.has(name)) return done.get(name);
			const v = await cb();
			done.set(name, v);
			return v;
		},
		async sleep(name: string) {
			await onSleep(name);
		},
		async waitForEvent(name: string, opts: { type: string }) {
			if ((await onWait(name, opts.type)) === "timeout") throw new Error("timed out");
			return { payload: {}, timestamp: new Date(), type: opts.type };
		},
	} as unknown as WorkflowStep;
}

const params = (): CodingSessionParams =>
	({ instanceId: "i1", userId: "u1", sessionId: "s1", repoId: "r1", runnerNode: "n1", loopRunId: "run-1", goal: { objective: "retire the v1 API", repo: "owner/repo", clientType: "claude" } }) as CodingSessionParams;

const question = () =>
	d1.sqlite.prepare("SELECT state, answered_via, decision, applied_at, applied_run_id FROM coder_questions WHERE task_id = 'csess-s1'").get() as { state: string; answered_via: string; decision: string; applied_at: number | null; applied_run_id: string | null };

async function post(taskId: string, value: string) {
	const app = new Hono<{ Bindings: Env }>();
	app.route("/v1/instances", instanceRoutes);
	app.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500)));
	const res = await app.request("/v1/instances/i1/input", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ taskId, value }) }, env);
	// biome-ignore lint/suspicious/noExplicitAny: a JSON response read field by field in assertions.
	return { status: res.status, body: (await res.json()) as Record<string, any> };
}

describe("a coding run asks, PARKS at zero compute, and resumes with the owner's answer (#964, #1076)", () => {
	it("through POST /v1/instances/:id/input — the console's and answer_instance_input's path — after any delay", async () => {
		// The issue link comes from the bound session, not the question's wording.
		d1.exec("UPDATE coding_repos SET github_repo = 'owner/repo' WHERE id = 'r1'");
		d1.exec("UPDATE coding_sessions SET issue_number = 1349 WHERE id = 's1'");
		decisions = [
			toDecision({ name: "ask_owner", arguments: { question: "Keep the v1 API or drop it?", options: ["keep it", "drop it"], why: "breaking change for two clients" } }),
			toDecision({ name: "send_message", arguments: { text: "Drop the v1 API as the owner chose." } }),
			{ finish: { status: "done", detail: "v1 removed" } },
		];
		let whileParked: Awaited<ReturnType<typeof getLoopRun>> = null;
		let answered: Awaited<ReturnType<typeof post>> | null = null;
		const sleeps: string[] = [];
		let statusPollsWhileParked = 0;
		const result = await runCodingSessionWorkflow(
			env,
			{ payload: params(), instanceId: "wf-run-1" } as unknown as WorkflowEvent<CodingSessionParams>,
			step(
				async (name) => void sleeps.push(name),
				async () => {
					// Parked: no wait loop has run, and nothing has polled the runner for an answer.
					statusPollsWhileParked = callRunner.mock.calls.filter((c) => c[1] === "/coding/takeover-status").length;
					whileParked = await getLoopRun(env, "u1", "run-1");
					// Three days later, the owner answers through the public path.
					vi.useFakeTimers({ now: Date.now() + 3 * 86_400_000, toFake: ["Date"] });
					answered = await post(whileParked?.waitingAsk?.taskId ?? "", "drop it");
				},
			),
		);
		vi.useRealTimers();

		// Parked on the decision, with the question on the run and its 30-day end published.
		expect(whileParked).toMatchObject({ status: "running", waitingReason: "decision", waitingAsk: { question: "Keep the v1 API or drop it?", taskId: "csess-s1" } });
		expect((whileParked as Awaited<ReturnType<typeof getLoopRun>>)?.waitingAsk?.issue).toMatchObject({ repo: "owner/repo", number: 1349, url: "https://github.com/owner/repo/issues/1349" });
		expect(waitClause(whileParked!, Date.now())).toContain('PARKED, waiting for YOUR ANSWER to a question: "Keep the v1 API or drop it?"');
		expect(sleeps.filter((n) => /^wait-/.test(n))).toEqual([]);
		expect(statusPollsWhileParked).toBe(0);
		expect(d1.sqlite.prepare("SELECT workflow_instance_id FROM agent_loop_runs WHERE run_id = 'run-1'").get()).toEqual({ workflow_instance_id: "wf-run-1" });
		const ev = d1.sqlite.prepare("SELECT payload FROM instance_runtime_task_events WHERE task_id = 'csess-s1' AND type = 'agent.needs_input'").get() as { payload: string };
		expect(JSON.parse(ev.payload).data.why).toBe("breaking change for two clients — from: keep it, drop it");
		expect(JSON.parse(ev.payload).data.issue).toMatchObject({ repo: "owner/repo", number: 1349, url: "https://github.com/owner/repo/issues/1349" });

		// The answer was written, then woke the parked instance — on the event named for its question.
		const qid = (d1.sqlite.prepare("SELECT id FROM coder_questions WHERE task_id = 'csess-s1'").get() as { id: string }).id;
		expect(woken).toEqual([{ instance: "wf-run-1", type: `answer-${qid}` }]);
		expect(answered).toMatchObject({ status: 200, body: { ok: true, kind: "coding", outcome: "delivered", runId: "run-1", sessionId: "s1", recorded: true } });
		// The SAME run resumed with the answer, read from the row (the engine had been stopped), acted on it, and finished.
		expect(decided[1].userHint).toBe('The owner answered your question "Keep the v1 API or drop it?": drop it');
		expect(acts.join("\n")).toContain("Drop the v1 API as the owner chose.");
		expect(result).toMatchObject({ outcome: "done" });
		expect(await getLoopRun(env, "u1", "run-1")).toMatchObject({ status: "completed", waitingReason: null, waitingAsk: null });
		expect(question()).toMatchObject({ state: "answered_human", answered_via: "console", decision: "drop it", applied_run_id: "run-1", applied_at: expect.any(Number) });
		// A second answer is recorded and reported "already applied" — never silently dropped.
		const again = await post("csess-s1", "keep it");
		expect(again).toMatchObject({ status: 202, body: { outcome: "already_applied", recorded: true, delivered: false, appliedRunId: "run-1" } });
		expect(question().decision).toBe("drop it");
	});

	it("a parked run whose Workflow died is never reported delivered: it is closed, the answer kept, and the queue moves (#1231)", async () => {
		// FGS Platform Coder, 2026-10-19: three answers each came back `delivered: true`, the question stayed
		// unapplied for 12 hours, and the queue behind the run never started.
		decisions = [toDecision({ name: "ask_owner", arguments: { question: "Close #350 now or after the deploy?", why: "the issue says after" } })];
		let answered: Awaited<ReturnType<typeof post>> | null = null;
		let queued: string | null = null;
		await runCodingSessionWorkflow(
			env,
			{ payload: params(), instanceId: "wf-run-1" } as unknown as WorkflowEvent<CodingSessionParams>,
			step(
				async () => undefined,
				async () => {
					const { enqueueObjective } = await import("../lib/objective-queue.js");
					queued = (await enqueueObjective(env, { instanceId: "i1", userId: "u1", repoId: "r1", objective: "the next objective" })).id;
					workflowStatus = "errored"; // evicted, or a deploy it could not replay through
					answered = await post("csess-s1", "after the deploy");
					return "timeout";
				},
			),
		);
		expect(answered).toMatchObject({ status: 409, body: { ok: false, outcome: "run_gone", delivered: false, recorded: true, runId: "run-1", next: "continue_run" } });
		expect(answered!.body.error).toMatch(/no longer running.*Continue the run/s);
		expect(woken).toEqual([]); // nothing was sent to a dead instance and called delivered
		expect(await getLoopRun(env, "u1", "run-1")).toMatchObject({ stopReason: "decision" });
		expect(question()).toMatchObject({ state: "answered_human", decision: "after the deploy", applied_at: null });
		const entry = d1.sqlite.prepare("SELECT status FROM instance_objective_queue WHERE id = ?").get(queued) as { status: string };
		expect(entry.status).not.toBe("pending"); // the closed run's repo drained
	});

	it("a long, multi-part question reaches the card whole: its uncut text and one option list per decision (#1129)", async () => {
		const asked = `${"Before I wire the alerts, three things are yours to decide. ".repeat(8)}Pick one per line.`;
		decisions = [
			toDecision({
				name: "ask_owner",
				arguments: { question: asked, parts: [{ question: "Notification channel?", options: ["Email", "Push"] }, { question: "Retry automatically?", options: ["Yes", "No"] }], why: "the alert config needs it" },
			}),
		];
		await runCodingSessionWorkflow(env, { payload: params() } as WorkflowEvent<CodingSessionParams>, step(async () => undefined, async () => "timeout"));
		const ev = d1.sqlite.prepare("SELECT payload FROM instance_runtime_task_events WHERE task_id = 'csess-s1' AND type = 'agent.needs_input'").get() as { payload: string };
		const data = JSON.parse(ev.payload).data;
		expect(data.field).toMatch(/\[cut: showing the first \d+ of \d+ characters\]$/);
		expect(data.fullQuestion).toBe(asked);
		expect(data.parts).toEqual([{ question: "Notification channel?", options: ["Email", "Push"] }, { question: "Retry automatically?", options: ["Yes", "No"] }]);
		// The question captured for the issue and the Coder Brain lists the decisions it holds.
		const captured = d1.sqlite.prepare("SELECT question FROM coder_questions WHERE task_id = 'csess-s1'").get() as { question: string };
		expect(captured.question).toContain("1. Notification channel? — Email / Push\n2. Retry automatically? — Yes / No");
	});

	it("an unanswered park times out after 30 days and stops `decision` — continuable, never `failed`", async () => {
		decisions = [toDecision({ name: "ask_owner", arguments: { question: "Which region?", options: ["eu", "us"] } })];
		const result = await runCodingSessionWorkflow(
			env,
			{ payload: params() } as WorkflowEvent<CodingSessionParams>,
			step(async () => undefined, async () => "timeout"),
		);
		expect(result).toMatchObject({ outcome: "needs_input" });
		expect(result.detail).toContain("Nobody answered within 30 days");
		const run = await getLoopRun(env, "u1", "run-1");
		expect(run).toMatchObject({ status: "needs_human", stopReason: "decision" });
		expect(continueRefusal(run!)).toBeNull();
	});
});

describe("a run at its iteration cap asks the owner instead of failing (#1236, #1261)", () => {
	const send = (text: string) => toDecision({ name: "send_message", arguments: { text } });
	// The ONE extra decision `runCodingLoop` asks once it has no steps left (#1261) — a real
	// `report_cap_status` tool call, not an action; the loop reads it and asks nothing further.
	const capReport = (overrides: Partial<CodingDecision["capSummary"] & object> = {}): CodingDecision => ({
		capSummary: {
			did: "Edited src/api.ts and ran the test suite.",
			blocker: 'The build fails with: "Cannot find module \'left-pad\'".',
			plan: "Add the missing dependency to package.json, reinstall, and re-run the suite.",
			steps: 4,
			reason: "One install and one retry should clear it, but CI here is flaky so it might take one more.",
			...overrides,
		},
	});
	const capped = (): CodingSessionParams => ({ ...params(), maxSteps: 2 }) as CodingSessionParams;
	const loopRow = () => d1.sqlite.prepare("SELECT status, stop_reason, max_iterations, checkout_released_at, waiting_reason FROM agent_loop_runs WHERE run_id = 'run-1'").get() as Record<string, unknown>;
	const cardQuestion = () => d1.sqlite.prepare("SELECT question, options, state, applied_run_id FROM coder_questions WHERE task_id = 'csess-s1'").get() as { question: string; options: string; state: string; applied_run_id: string | null };

	async function runToCap(answer: string | "timeout") {
		let whileParked: Record<string, unknown> | null = null;
		const seen: { parkedRun: Awaited<ReturnType<typeof getLoopRun>>; reply: Awaited<ReturnType<typeof post>> | null } = { parkedRun: null, reply: null };
		const result = await runCodingSessionWorkflow(
			env,
			{ payload: capped(), instanceId: "wf-run-1" } as unknown as WorkflowEvent<CodingSessionParams>,
			step(
				async () => undefined,
				async () => {
					whileParked = loopRow();
					seen.parkedRun = await getLoopRun(env, "u1", "run-1");
					if (answer === "timeout") return "timeout";
					seen.reply = await post("csess-s1", answer);
					return undefined;
				},
			),
		);
		return { result, whileParked: whileParked as Record<string, unknown> | null, ...seen };
	}

	it("parks as waiting on the owner — not failed — with the checkout and working tree left exactly as they are", async () => {
		decisions = [send("step one"), send("step two"), capReport()];
		const { whileParked, parkedRun } = await runToCap("timeout");
		expect(whileParked).toMatchObject({ status: "running", waiting_reason: "decision", checkout_released_at: null });
		expect(callRunner.mock.calls.some((c) => c[1] === "/coding/park-snapshot")).toBe(false); // nothing set aside, nothing reset
		// #1261: the brain's OWN step count (4), not the platform's fixed cap (2).
		expect(parkedRun?.waitingAsk?.question).toMatch(/reached its cap of 2 iterations without finishing\. Approve 4 more/);
		expect(parkedRun?.waitingAsk?.options).toEqual(["Approve 4 more iterations", "Deny — stop the run here"]);
		// The full report — what it did, the exact blocker, its plan, and why it asked for 4 — reaches
		// the uncut ask whole (#1129's mechanism), which is also what the linked GitHub issue comment quotes.
		expect(parkedRun?.waitingAsk?.fullQuestion).toContain("What it did: Edited src/api.ts and ran the test suite.");
		expect(parkedRun?.waitingAsk?.fullQuestion).toContain("Blocker: The build fails with: \"Cannot find module 'left-pad'\".");
		expect(parkedRun?.waitingAsk?.fullQuestion).toContain("Plan: Add the missing dependency to package.json, reinstall, and re-run the suite.");
		expect(parkedRun?.waitingAsk?.fullQuestion).toContain("Asking for 4 more steps — One install and one retry");
		// coding_loop_status and recent_instances both quote this note (#1236) — in full, never the old 600-char clip (#1261).
		const note = waitClause(parkedRun!, Date.now()) ?? "";
		expect(note).toMatch(/^WAITING on YOUR APPROVAL, not stalled and not working — it reached its iteration cap without finishing and asks for 4 more iterations\. What it did: Edited src\/api\.ts/);
		expect(note).toContain("Cannot find module 'left-pad'");
		expect(note).toContain('answer_instance_input (task_id csess-s1, value "approve" or a number of iterations)');
		expect(note).toContain('"deny" to stop it here');
	});

	it("no concrete plan: the brain says so plainly rather than inventing one (#1261)", async () => {
		decisions = [send("step one"), send("step two"), capReport({ plan: "", reason: "I don't know what's wrong yet." })];
		const { parkedRun } = await runToCap("timeout");
		expect(parkedRun?.waitingAsk?.fullQuestion).toContain("Plan: No concrete plan: it did not state one.");
	});

	it("approve with N: the SAME run resumes in the same session with N more iterations, and finishes", async () => {
		decisions = [send("step one"), send("step two"), capReport(), send("step three"), { finish: { status: "done", detail: "objective complete" } }];
		const { result, reply } = await runToCap("approve 5");
		expect(reply).toMatchObject({ status: 200, body: { outcome: "delivered", runId: "run-1" } });
		expect(result).toMatchObject({ outcome: "done" });
		expect(acts).toEqual(["step one", "step two", "step three"]);
		// The owner's own "approve 5" overrides the brain's requested 4 — their call, not the brain's.
		expect(decided[3].userHint).toMatch(/^The owner approved 5 more iterations after you reached your cap\. Continue the objective from exactly where you are/);
		expect(loopRow()).toMatchObject({ status: "completed", max_iterations: 15 });
		expect(cardQuestion()).toMatchObject({ state: "answered_human", applied_run_id: "run-1" });
	});

	it("deny: the run stops right there and takes no further step", async () => {
		decisions = [send("step one"), send("step two"), capReport(), send("NEVER SENT"), { finish: { status: "done", detail: "unused" } }];
		const { result } = await runToCap("Deny — stop the run here");
		expect(result).toMatchObject({ outcome: "cancelled", detail: expect.stringMatching(/Stopped by you at the iteration cap/) });
		// The cap-report decision counts as a decision too (#1261): 2 action rounds + the cap report.
		expect(decided).toHaveLength(3);
		expect(acts).toEqual(["step one", "step two"]);
		expect(loopRow()).toMatchObject({ status: "cancelled", stop_reason: "cancelled", max_iterations: 10 });
	});

	it("no answer: it gives up the way every human wait does — continuable, never failed / max_iterations", async () => {
		decisions = [send("step one"), send("step two"), capReport()];
		await runToCap("timeout");
		const row = loopRow();
		expect(row.stop_reason).toBe("decision");
		expect(row.status).not.toBe("failed");
		expect(continueRefusal((await getLoopRun(env, "u1", "run-1"))!)).toBeNull(); // the owner can continue it later
	});

	it("the brain never answered the cap decision: falls back to the previous fixed-cap behaviour (#1261)", async () => {
		// `decideCodingAction` is fully mocked in this file, so returning a plain action decision for
		// the cap round stands in for "the model did not call report_cap_status" in production.
		decisions = [send("step one"), send("step two"), send("ignored at the cap")];
		const { parkedRun } = await runToCap("timeout");
		// No capSummary on the result → the platform's fixed cap (2), and the old step-log tail.
		expect(parkedRun?.waitingAsk?.question).toMatch(/reached its cap of 2 iterations without finishing\. Approve 2 more/);
		expect(parkedRun?.waitingAsk?.fullQuestion).toContain("Its last steps:");
	});
});

describe("a parked coding question carries its trusted source end to end (#1363)", () => {
	const ASK = () => toDecision({ name: "ask_owner", arguments: { question: "Issue #1349 item 6: where should transient compare-read errors be handled?", options: ["retry in the step", "queue and read in the tick"], why: "the compare runs before any queue row exists" } });
	const cache = (over: Record<string, unknown> = {}) => JSON.stringify({ number: 1349, repo: "owner/repo", title: "Page GitHub workflow and commit-range evidence safely", state: "open", stateReason: null, labels: [], assignees: [], url: "https://github.com/owner/repo/issues/1349", updatedAt: "2026-01-01T00:00:00Z", closedAt: null, summary: "Read every page of the release evidence before posting.", ...over });

	/** Bind the run to issue 1349 through its session and ticket, with the issue sync's cache. */
	function bindIssue(over: Record<string, unknown> = {}) {
		d1.exec("UPDATE coding_repos SET github_repo = 'owner/repo' WHERE id = 'r1'");
		d1.exec("UPDATE coding_sessions SET issue_number = 1349 WHERE id = 's1'");
		d1.exec(`INSERT INTO tickets (id, instance_id, user_id, job_key, title, created_by, issue_number, repo_id, issue_cache) VALUES ('t1','i1','u1','issue:r1#1349','t','agent',1349,'r1','${cache(over).replace(/'/g, "''")}')`);
		d1.exec("UPDATE agent_loop_runs SET ticket_id = 't1' WHERE run_id = 'run-1'");
	}

	/** Run the real workflow to its park and read every surface an owner or a client sees, while it waits. */
	// biome-ignore lint/suspicious/noExplicitAny: the event payload is JSON read field by field in assertions.
	type Seen = { run: Awaited<ReturnType<typeof getLoopRun>>; data: Record<string, any>; notes: Array<{ title: string; body: string; url: string | null }>; answered: Awaited<ReturnType<typeof post>> | null };
	async function parked(opts: { answer?: string; env?: Env; decision?: CodingDecision } = {}): Promise<Seen> {
		decisions = [opts.decision ?? ASK()];
		const e = opts.env ?? env;
		const box: { seen?: Seen } = {};
		await runCodingSessionWorkflow(
			e,
			{ payload: params(), instanceId: "wf-run-1" } as unknown as WorkflowEvent<CodingSessionParams>,
			step(
				async () => undefined,
				async () => {
					const ev = d1.sqlite.prepare("SELECT payload FROM instance_runtime_task_events WHERE task_id = 'csess-s1' AND type = 'agent.needs_input'").get() as { payload: string };
					box.seen = {
						run: await getLoopRun(e, "u1", "run-1"),
						data: JSON.parse(ev.payload).data,
						notes: d1.sqlite.prepare("SELECT title, body, url FROM notifications WHERE user_id = 'u1' ORDER BY created_at, rowid").all() as Array<{ title: string; body: string; url: string | null }>,
						answered: opts.answer ? await post("csess-s1", opts.answer) : null,
					};
					return "timeout";
				},
			),
		);
		if (!box.seen) throw new Error("the run never parked on its question");
		return box.seen;
	}

	it("linked: the run, the card's event and the push all carry the exact issue, and the push still opens the same card", async () => {
		bindIssue();
		const { run, data, notes } = await parked();
		const issue = { repo: "owner/repo", number: 1349, title: "Page GitHub workflow and commit-range evidence safely", url: "https://github.com/owner/repo/issues/1349", summary: "Read every page of the release evidence before posting.", issueState: "open" };
		expect(run?.waitingAsk).toMatchObject({ issueStatus: "linked", issue, question: expect.stringContaining("transient compare-read errors") });
		expect(run?.waitingAsk?.issue?.stale).toBeUndefined();
		expect(data).toMatchObject({ issueStatus: "linked", issue, options: ["retry in the step", "queue and read in the tick"] });
		expect(data.why).toContain("the compare runs before any queue row exists");
		const push = notes.find((n) => /question/i.test(n.title));
		expect(push?.body).toContain("owner/repo#1349 — Page GitHub workflow and commit-range evidence safely. https://github.com/owner/repo/issues/1349");
		expect(push?.body).toContain("Context: Read every page of the release evidence before posting.");
		expect(push?.body).not.toContain("Needs refresh");
		expect(push?.url).toBe("/console/instances/i1/tasks/csess-s1");
	});

	it("stale (the issue is closed): flagged on the run, the event and the push, the question and options untouched, and still answerable", async () => {
		bindIssue({ state: "closed", closedAt: "2026-10-24T10:00:00Z" });
		const { run, data, notes, answered } = await parked({ answer: "queue and read in the tick" });
		expect(run?.waitingAsk?.issue).toMatchObject({ stale: true, staleReason: "issue_closed", issueState: "closed" });
		expect(data.issue).toMatchObject({ stale: true, staleReason: "issue_closed" });
		const push = notes.find((n) => /question/i.test(n.title));
		expect(push?.body).toContain("Needs refresh: the source issue is closed");
		expect(data.options).toEqual(["retry in the step", "queue and read in the tick"]); // never rewritten
		expect(answered).toMatchObject({ status: 200, body: { ok: true, outcome: "delivered" } }); // never answered for the owner, but answerable
	});

	it("stale (the issue changed after it was asked): flagged with its own reason", async () => {
		bindIssue({ updatedAt: new Date(Date.now() + 3_600_000).toISOString() });
		const { run, data } = await parked();
		expect(run?.waitingAsk?.issue).toMatchObject({ stale: true, staleReason: "issue_changed_since_asked" });
		expect(data.issue).toMatchObject({ stale: true, staleReason: "issue_changed_since_asked" });
	});

	it("the run view judges freshness again when read: an issue that closes while the question waits is flagged on the run, not just at ask time", async () => {
		bindIssue();
		const { data } = await parked();
		expect(data.issue.stale).toBeUndefined(); // fresh when asked
		d1.exec(`UPDATE tickets SET issue_cache = '${cache({ state: "closed", closedAt: "2026-10-25T01:00:00Z" })}' WHERE id = 't1'`);
		expect((await getLoopRun(env, "u1", "run-1"))?.waitingAsk?.issue).toMatchObject({ stale: true, staleReason: "issue_closed" });
	});

	it("a question parked before this shipped (no issue in its stored ask) gains the link and the verdict from the bound session", async () => {
		bindIssue({ state: "closed", closedAt: "2026-10-24T10:00:00Z" });
		const { run } = await parked();
		const stored = JSON.parse((d1.sqlite.prepare("SELECT waiting_ask FROM agent_loop_runs WHERE run_id = 'run-1'").get() as { waiting_ask: string }).waiting_ask);
		delete stored.issue;
		delete stored.issueStatus;
		d1.sqlite.prepare("UPDATE agent_loop_runs SET waiting_ask = ?1, waiting_reason = 'decision', status = 'running' WHERE run_id = 'run-1'").run(JSON.stringify(stored));
		expect(run?.waitingAsk?.issue?.url).toBe("https://github.com/owner/repo/issues/1349");
		expect((await getLoopRun(env, "u1", "run-1"))?.waitingAsk).toMatchObject({ issueStatus: "linked", issue: { url: "https://github.com/owner/repo/issues/1349", stale: true, staleReason: "issue_closed" } });
	});

	it("missing: no bound issue is 'none' everywhere, no link exists, the push says so, and the question is answerable", async () => {
		const { run, data, notes, answered } = await parked({ answer: "retry in the step" });
		expect(run?.waitingAsk?.issueStatus).toBe("none");
		expect(run?.waitingAsk?.issue).toBeUndefined();
		expect(data.issueStatus).toBe("none");
		expect(data.issue).toBeUndefined();
		const push = notes.find((n) => /question/i.test(n.title));
		expect(push?.body).toContain("No issue is linked to this run.");
		expect(JSON.stringify([run?.waitingAsk, data, notes])).not.toMatch(/github\.com\/[^"]*\/issues\//);
		expect(answered).toMatchObject({ status: 200, body: { ok: true } });
	});

	it("the lookup failing is 'unavailable' (not 'none'), the question is still delivered and answerable", async () => {
		bindIssue();
		const failing = Object.create(d1.DB) as Env["DB"];
		failing.prepare = (sql: string) => {
			if (sql.includes("t.issue_cache, t.updated_at AS synced")) throw new Error("D1 timeout"); // only the source lookup fails
			return d1.DB.prepare(sql);
		};
		const { run, data, notes, answered } = await parked({ env: { ...env, DB: failing } as Env, answer: "retry in the step" });
		expect(data.issueStatus).toBe("unavailable");
		expect(data.issue).toBeUndefined();
		expect(notes.find((n) => /question/i.test(n.title))?.body).toContain("The source issue could not be loaded");
		expect(notes.find((n) => /question/i.test(n.title))?.body).not.toContain("No issue is linked");
		expect(run?.waitingAsk?.question).toContain("transient compare-read errors");
		expect(answered).toMatchObject({ status: 200, body: { ok: true } });
	});

	it("unsafe: a repository that is not a plain owner/name builds no link, and issue-looking text in the question never does", async () => {
		d1.exec("UPDATE coding_repos SET github_repo = '../evil' WHERE id = 'r1'");
		d1.exec("UPDATE coding_sessions SET issue_number = 9 WHERE id = 's1'");
		const { run, data, notes } = await parked({ decision: toDecision({ name: "ask_owner", arguments: { question: "Issue #9 at https://evil.example/owner/repo/issues/9 — which?", options: ["A", "B"], why: "see https://evil.example/x" } }) });
		expect(run?.waitingAsk?.issue).toBeUndefined();
		expect(data.issue).toBeUndefined();
		expect(data.issueStatus).toBe("none");
		expect(JSON.stringify(notes)).not.toContain("https://github.com/");
		expect(run?.waitingAsk?.question).toContain("Issue #9"); // the words stay as the agent wrote them; they just are not a link
	});

	it("access control is unchanged: another account cannot read this run's question or its source", async () => {
		bindIssue();
		await parked();
		expect(await getLoopRun(env, "u2", "run-1")).toBeNull();
	});
});
