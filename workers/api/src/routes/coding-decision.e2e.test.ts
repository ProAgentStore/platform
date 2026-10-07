/**
 * #964 (from #960's findings) — the decision-wait flow, end to end, over the real schema.
 *
 * The REAL `runCodingSessionWorkflow` reaches an `ask_owner` decision; while it is parked, the
 * owner answers through the PUBLIC path — `POST /v1/instances/:id/input`, the route the console's
 * answer box and `answer_instance_input` both call — and the SAME run resumes with that answer.
 * Faked: the BYOK brain (scripted decisions) and the machine, which is a small in-memory model of
 * the runner's coding takeover map: `/coding/takeover` opens a pause, `/coding/takeover/:sid/resolve`
 * resolves it with a value, `/coding/takeover-status` reports it. Nothing in between is faked.
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
import { HANDOFF_GIVE_UP_MS, HANDOFF_WAIT_POLLS } from "../lib/coding-pause.js";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import { waitClause } from "../lib/work-report.js";
import { runCodingSessionWorkflow } from "../workflows/coding-session/workflow-run.js";
import type { CodingSessionParams } from "../workflows/coding-session-params.js";
import type { Env } from "../types.js";

const { instanceRoutes } = await import("./instances.js");

const IDLE = { pane: "$ ", runState: "idle", ready: true, alive: true };
const IN_SYNC = { checked: true, branch: "main", upstream: "origin/main", localHead: "aaaaaaaa1", remoteHead: "aaaaaaaa1", ahead: 0, behind: 0, fetched: true };

let d1: RealSchemaD1;
let env: Env;
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
	env = { DB: d1.DB } as unknown as Env;
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

function step(onSleep: (name: string) => Promise<void>): WorkflowStep {
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
	} as unknown as WorkflowStep;
}

const params = (): CodingSessionParams =>
	({ instanceId: "i1", userId: "u1", sessionId: "s1", repoId: "r1", runnerNode: "n1", loopRunId: "run-1", goal: { objective: "retire the v1 API", repo: "owner/repo", clientType: "claude" } }) as CodingSessionParams;

async function post(taskId: string, value: string) {
	const app = new Hono<{ Bindings: Env }>();
	app.route("/v1/instances", instanceRoutes);
	app.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500)));
	const res = await app.request("/v1/instances/i1/input", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ taskId, value }) }, env);
	// biome-ignore lint/suspicious/noExplicitAny: a JSON response read field by field in assertions.
	return { status: res.status, body: (await res.json()) as Record<string, any> };
}

describe("a coding run asks, waits on a decision, and resumes with the owner's answer (#964)", () => {
	it("through POST /v1/instances/:id/input — the console's and answer_instance_input's path", async () => {
		decisions = [
			toDecision({ name: "ask_owner", arguments: { question: "Keep the v1 API or drop it?", options: ["keep it", "drop it"], why: "breaking change for two clients" } }),
			toDecision({ name: "send_message", arguments: { text: "Drop the v1 API as the owner chose." } }),
			{ finish: { status: "done", detail: "v1 removed" } },
		];
		let whileParked: Awaited<ReturnType<typeof getLoopRun>> = null;
		let answered: Awaited<ReturnType<typeof post>> | null = null;
		const result = await runCodingSessionWorkflow(
			env,
			{ payload: params() } as WorkflowEvent<CodingSessionParams>,
			step(async (name) => {
				// The owner answers during the run's first handoff poll — exactly once.
				if (answered || !/^wait-\d+-\d+$/.test(name) || !pause.open) return;
				whileParked = await getLoopRun(env, "u1", "run-1");
				answered = await post(whileParked?.waitingAsk?.taskId ?? "", "drop it");
			}),
		);

		// The distinct wait state, with the question stored on the run.
		expect(whileParked).toMatchObject({
			status: "running",
			waitingReason: "decision",
			waitingAsk: { question: "Keep the v1 API or drop it?", options: ["keep it", "drop it"], why: "breaking change for two clients", taskId: "csess-s1" },
		});
		expect(waitClause(whileParked!, Date.now())).toContain('waiting for YOUR ANSWER to a question: "Keep the v1 API or drop it?"');
		// The board card is in "Needs you" and carries the event RunDetail's answer box reads.
		const ev = d1.sqlite.prepare("SELECT payload FROM instance_runtime_task_events WHERE task_id = 'csess-s1' AND type = 'agent.needs_input'").get() as { payload: string };
		expect(JSON.parse(ev.payload).data.why).toBe("breaking change for two clients — from: keep it, drop it");

		// The public path delivered it to the CODING pause, not the browser map, and said so.
		expect(answered).toEqual({ status: 200, body: { ok: true, kind: "coding", runId: "run-1", sessionId: "s1" } });
		// The SAME run resumed with the answer, acted on it, and finished.
		expect(decided[1].userHint).toBe('The owner answered your question "Keep the v1 API or drop it?": drop it');
		expect(acts.join("\n")).toContain("Drop the v1 API as the owner chose.");
		expect(result).toMatchObject({ outcome: "done" });
		const after = await getLoopRun(env, "u1", "run-1");
		expect(after).toMatchObject({ status: "completed", waitingReason: null, waitingAsk: null });
		// Answered once: a second answer finds nothing waiting, rather than a "session is gone".
		expect((await post("csess-s1", "keep it")).status).toBe(409);
	});

	it("an unanswered question gives up on the handoff clock and stops as escalated, saying nobody answered", async () => {
		decisions = [toDecision({ name: "ask_owner", arguments: { question: "Which region?", options: ["eu", "us"] } })];
		let polls = 0;
		const result = await runCodingSessionWorkflow(
			env,
			{ payload: params() } as WorkflowEvent<CodingSessionParams>,
			step(async (name) => {
				if (/^wait-\d+-\d+$/.test(name)) polls++;
			}),
		);
		expect(polls).toBe(HANDOFF_WAIT_POLLS);
		expect(result).toMatchObject({ outcome: "needs_input" });
		expect(result.detail).toContain(`Nobody answered within ${HANDOFF_GIVE_UP_MS / 60_000} minutes`);
		expect(await getLoopRun(env, "u1", "run-1")).toMatchObject({ status: "needs_human", stopReason: "escalated" });
	});
});
