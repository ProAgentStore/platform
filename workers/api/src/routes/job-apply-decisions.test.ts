/**
 * #1079 — a JOB_APPLY question is a durable decision, over the real schema, the real `/input` route
 * and the real `startJobApply`. Faked: only what reaches a machine (whether a runner is live and what
 * its `/browser/input` answers, the runner's task creation) and the JobApplyWorkflow binding.
 *
 * Before: an answer given after the 15-minute window got 409 "That takeover session is gone" and
 * nothing was recorded. Now it is stored on the question, saved to the Profile, and the next
 * application to that posting uses it.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { realSchemaD1, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import { signSession } from "../lib/session.js";
import type { Env } from "../types.js";

const runner = vi.hoisted(() => ({ live: true, reply: { ok: true } as Record<string, unknown>, inputs: [] as Array<Record<string, unknown>> }));
vi.mock("./instances-runtime.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./instances-runtime.js")>();
	const row = { endpoint: "relay", token: "t" };
	return {
		...actual,
		requireLiveRuntime: async () => {
			if (!runner.live) throw new HttpError(503, "No runner connected. Start it with: pags up");
			return row;
		},
		getLiveRuntime: async () => (runner.live ? row : null),
		callRuntime: async (_env: unknown, _rt: unknown, path: string, init?: { body?: string }) => {
			if (path === "/browser/input") runner.inputs.push(JSON.parse(init?.body ?? "{}"));
			return Response.json(runner.reply);
		},
	};
});
vi.mock("./browser-workflows.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./browser-workflows.js")>();
	return {
		...actual,
		createBrowserRuntimeTask: async (env: Env, instanceId: string, userId: string, req: { type: string; input?: unknown }) => {
			const taskId = `task_${crypto.randomUUID()}`;
			await env.DB.prepare("INSERT INTO instance_runtime_tasks (id, instance_id, user_id, type, status, payload, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'running', ?5, datetime('now'), datetime('now'))")
				.bind(taskId, instanceId, userId, req.type, JSON.stringify({ input: req.input ?? {} }))
				.run();
			return { taskId };
		},
	};
});

const { registerApplyRoutes } = await import("./instances-apply.js");
const { instanceRoutes } = await import("./instances.js");
const { recordPauseDecision, getDecision } = await import("../lib/owner-decisions.js");
const { expireStaleTakeovers } = await import("../lib/browser-takeovers.js");
const { getProfile } = await import("../lib/profile.js");

const SECRET = "t1079-secret";
const URL1 = "https://jobs.example/role/1";
let d1: RealSchemaD1;
let env: Env;
let created: Array<{ params: { taskId: string; job: { url: string; providedAnswers?: Record<string, string> } } }>;

beforeEach(() => {
	runner.live = true;
	runner.reply = { ok: true };
	runner.inputs = [];
	created = [];
	d1 = realSchemaD1();
	d1.exec(`INSERT INTO users (id, github_login) VALUES ('u1', 'u1')`);
	d1.exec(`INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES ('apply-inst', 'agent_job_application_assistant', 'u1', 'active', '{}')`);
	d1.exec(`INSERT INTO user_profile (user_id, first_name, last_name, email) VALUES ('u1', 'Ada', 'Lovelace', 'ada@example.com')`);
	env = {
		DB: d1.DB,
		SESSION_SIGNING_KEY: SECRET,
		JOB_APPLY: { create: async (opts: (typeof created)[number]) => { created.push(opts); return { id: `wf_${created.length}` }; } },
	} as unknown as Env;
});
afterEach(() => d1.close());

async function request(path: string, body: Record<string, unknown>, headers: Record<string, string> = {}) {
	const router = new Hono<{ Bindings: Env }>();
	registerApplyRoutes(router);
	router.route("/", instanceRoutes);
	const a = new Hono<{ Bindings: Env }>();
	a.route("/v1/instances", router);
	a.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500)));
	const token = await signSession("u1", SECRET, { roles: [] });
	const res = await a.request(`/v1/instances/apply-inst${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) }, env);
	// biome-ignore lint/suspicious/noExplicitAny: read field by field
	return { status: res.status, body: (await res.json()) as Record<string, any> };
}
const answer = (taskId: string, value: string, headers?: Record<string, string>) => request("/input", { taskId, value }, headers);
/** The question an application paused on, as the workflow records it at the handoff. */
const asked = (taskId = "task_old", url = URL1) => recordPauseDecision(env, { instanceId: "apply-inst", userId: "u1", kind: "job_apply", subjectId: taskId, taskId, scope: url, field: "Australian working rights", question: "Australian working rights" });

describe("a JOB_APPLY answer is stored first, and never refused for want of a live run (#1079)", () => {
	it("after the run stopped waiting, with no runner connected: stored on the question and in the Profile — not refused", async () => {
		const q = await asked();
		runner.live = false;
		const r = await answer("task_old", "Australian citizen");
		expect(r.status).toBe(202);
		expect(r.body).toMatchObject({ ok: true, kind: "job_apply_late", outcome: "recorded", delivered: false, recorded: true, decisionId: q.id });
		expect(await getDecision(env, q.id)).toMatchObject({ answer: "Australian citizen", answeredVia: "console", appliedAt: null });
		expect(Object.values(await getProfile(env, "u1"))).toContain("Australian citizen");
	});

	it("with a runner whose handoff is gone (it restarted): stored, 202 — the old 409 'session is gone' with nothing recorded is gone", async () => {
		const q = await asked();
		runner.reply = { ok: false };
		const r = await answer("task_old", "Australian citizen", { "X-PAGS-Client": "mcp" });
		expect(r.status).toBe(202);
		expect(r.body.error).toBeUndefined();
		expect(await getDecision(env, q.id)).toMatchObject({ answer: "Australian citizen", answeredVia: "mcp" });
	});

	it("inside the window: stored first, then delivered to the live run exactly as before", async () => {
		const q = await asked();
		const r = await answer("task_old", "Australian citizen");
		expect(r.status).toBe(200);
		expect(runner.inputs).toEqual([{ taskId: "task_old", value: "Australian citizen" }]);
		expect((await getDecision(env, q.id))?.answer).toBe("Australian citizen");
	});

	it("a card with no question on record behaves as before: a gone session is still reported", async () => {
		runner.reply = { ok: false };
		const r = await answer("task_never_asked", "x");
		expect(r.status).toBe(409);
		expect(r.body.error).toMatch(/takeover session is gone/);
	});

	it("the next application to that posting is given the answer, and records that it used it", async () => {
		const q = await asked();
		runner.live = false;
		await answer("task_old", "Australian citizen");
		runner.live = true;
		expect((await request("/apply", { url: URL1, resumePath: "/home/ada/cv.pdf" })).status).toBe(202);
		const next = created[0].params;
		expect(next.job.providedAnswers?.["Australian working rights"]).toBe("Australian citizen");
		expect(await getDecision(env, q.id)).toMatchObject({ appliedRef: next.taskId });
		// Used once: a later application to another posting is not handed it as a pending answer.
		d1.exec(`UPDATE instance_runtime_tasks SET status = 'completed'`);
		await request("/apply", { url: "https://jobs.example/role/2", resumePath: "/home/ada/cv.pdf" });
		expect((await getDecision(env, q.id))?.appliedRef).toBe(next.taskId);
	});

	it("a second answer to a question a run already used is recorded, reported as already applied, never applied twice", async () => {
		const q = await asked();
		d1.exec(`UPDATE owner_decisions SET answer = 'citizen', answered_at = 1, applied_at = 2, applied_ref = 'task_new' WHERE id = '${q.id}'`);
		const r = await answer("task_old", "permanent resident");
		expect(r.status).toBe(202);
		expect(r.body).toMatchObject({ outcome: "already_applied", recorded: true });
		expect(await getDecision(env, q.id)).toMatchObject({ answer: "citizen", appliedRef: "task_new" });
		expect(runner.inputs).toEqual([]);
	});

	it("a browser takeover expiring ends the takeover, never the decision behind it", async () => {
		const q = await asked();
		d1.exec(`INSERT INTO browser_takeovers (id, instance_id, agent_id, user_id, subject_kind, subject_id, state, reason, mobile_allowed, expires_at, created_at, updated_at)
		  VALUES ('tko1', 'apply-inst', 'agent_job_application_assistant', 'u1', 'runtime_task', 'task_old', 'requested', 'manual', 0, 1, 1, 1)`);
		expect(await expireStaleTakeovers(env)).toBe(1);
		expect((d1.sqlite.prepare("SELECT state FROM browser_takeovers WHERE id = 'tko1'").get() as { state: string }).state).toBe("expired");
		runner.live = false;
		const r = await answer("task_old", "Australian citizen");
		expect(r.status).toBe(202);
		expect((await getDecision(env, q.id))?.answer).toBe("Australian citizen");
	});
});
