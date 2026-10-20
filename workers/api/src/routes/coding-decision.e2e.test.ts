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
		expect(waitClause(whileParked!, Date.now())).toContain('PARKED, waiting for YOUR ANSWER to a question: "Keep the v1 API or drop it?"');
		expect(sleeps.filter((n) => /^wait-/.test(n))).toEqual([]);
		expect(statusPollsWhileParked).toBe(0);
		expect(d1.sqlite.prepare("SELECT workflow_instance_id FROM agent_loop_runs WHERE run_id = 'run-1'").get()).toEqual({ workflow_instance_id: "wf-run-1" });
		const ev = d1.sqlite.prepare("SELECT payload FROM instance_runtime_task_events WHERE task_id = 'csess-s1' AND type = 'agent.needs_input'").get() as { payload: string };
		expect(JSON.parse(ev.payload).data.why).toBe("breaking change for two clients — from: keep it, drop it");

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

describe("a run at its iteration cap asks the owner instead of failing (#1236)", () => {
	const send = (text: string) => toDecision({ name: "send_message", arguments: { text } });
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
		decisions = [send("step one"), send("step two"), { finish: { status: "done", detail: "unused" } }];
		const { whileParked, parkedRun } = await runToCap("timeout");
		expect(whileParked).toMatchObject({ status: "running", waiting_reason: "decision", checkout_released_at: null });
		expect(callRunner.mock.calls.some((c) => c[1] === "/coding/park-snapshot")).toBe(false); // nothing set aside, nothing reset
		expect(parkedRun?.waitingAsk?.question).toMatch(/reached its cap of 2 iterations without finishing\. Approve 2 more/);
		expect(parkedRun?.waitingAsk?.options).toEqual(["Approve 2 more iterations", "Deny — stop the run here"]);
		// coding_loop_status and recent_instances both quote this note (#1236).
		const note = waitClause(parkedRun!, Date.now()) ?? "";
		expect(note).toMatch(/^WAITING on YOUR APPROVAL, not stalled and not working — it reached its iteration cap without finishing and asks for 2 more iterations\. Its last steps: /);
		expect(note).toContain('answer_instance_input (task_id csess-s1, value "approve" or a number of iterations)');
		expect(note).toContain('"deny" to stop it here');
	});

	it("approve with N: the SAME run resumes in the same session with N more iterations, and finishes", async () => {
		decisions = [send("step one"), send("step two"), send("step three"), { finish: { status: "done", detail: "objective complete" } }];
		const { result, reply } = await runToCap("approve 5");
		expect(reply).toMatchObject({ status: 200, body: { outcome: "delivered", runId: "run-1" } });
		expect(result).toMatchObject({ outcome: "done" });
		expect(acts).toEqual(["step one", "step two", "step three"]);
		expect(decided[2].userHint).toMatch(/^The owner approved 5 more iterations after you reached your cap\. Continue the objective from exactly where you are/);
		expect(loopRow()).toMatchObject({ status: "completed", max_iterations: 15 });
		expect(cardQuestion()).toMatchObject({ state: "answered_human", applied_run_id: "run-1" });
	});

	it("deny: the run stops right there and takes no further step", async () => {
		decisions = [send("step one"), send("step two"), send("NEVER SENT"), { finish: { status: "done", detail: "unused" } }];
		const { result } = await runToCap("Deny — stop the run here");
		expect(result).toMatchObject({ outcome: "cancelled", detail: expect.stringMatching(/Stopped by you at the iteration cap/) });
		expect(decided).toHaveLength(2);
		expect(acts).toEqual(["step one", "step two"]);
		expect(loopRow()).toMatchObject({ status: "cancelled", stop_reason: "cancelled", max_iterations: 10 });
	});

	it("no answer: it gives up the way every human wait does — continuable, never failed / max_iterations", async () => {
		decisions = [send("step one"), send("step two"), { finish: { status: "done", detail: "unused" } }];
		await runToCap("timeout");
		const row = loopRow();
		expect(row.stop_reason).toBe("decision");
		expect(row.status).not.toBe("failed");
		expect(continueRefusal((await getLoopRun(env, "u1", "run-1"))!)).toBeNull(); // the owner can continue it later
	});
});
