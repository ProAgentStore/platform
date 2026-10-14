/**
 * #1062: the legacy JOB_APPLY workflow is a SUPPORTED browser-work path again, alongside
 * Scout → Tailor → Runner — no longer "retired". Over the real schema and the REAL seeded Job
 * Application Assistant (`agent_job_application_assistant`, `workflow: "JOB_APPLY"`), through the
 * real route and the real `startJobApply`. Faked: only what reaches a machine — whether a runner is
 * live, the runner's task creation (which writes the same task row the real one does) — and the
 * JobApplyWorkflow binding, whose `create` calls are captured.
 *
 * Every guard the start had before it was refused is asserted here: one application per instance
 * (sequential AND concurrent), a live runner, a résumé, the budget and run rows, the Profile as the
 * only source of candidate values — and the workflow check that only a JOB_APPLY agent can start one.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { realSchemaD1, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import { signSession } from "../lib/session.js";
import type { Env } from "../types.js";

const runner = vi.hoisted(() => ({ live: true }));
vi.mock("./instances-runtime.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./instances-runtime.js")>();
	return {
		...actual,
		requireLiveRuntime: async () => {
			if (!runner.live) throw new HttpError(503, "No runner connected. Start it with: pags up");
			return { endpoint: "relay", token: "t" };
		},
	};
});
vi.mock("./browser-workflows.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./browser-workflows.js")>();
	return {
		...actual,
		// The runner's task, as the real one leaves it: a `job.apply_agent` row that holds the slot.
		createBrowserRuntimeTask: async (env: Env, instanceId: string, userId: string, req: { type: string; input?: unknown }) => {
			const taskId = `task_${crypto.randomUUID()}`;
			// The mirror stores the runner's whole task, which echoes the input it was created with.
			await env.DB.prepare("INSERT INTO instance_runtime_tasks (id, instance_id, user_id, type, status, payload, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'running', ?5, datetime('now'), datetime('now'))")
				.bind(taskId, instanceId, userId, req.type, JSON.stringify({ input: req.input ?? {} }))
				.run();
			return { taskId };
		},
	};
});

const { registerApplyRoutes } = await import("./instances-apply.js");
const { instanceRoutes } = await import("./instances.js");
const { executeStorageTool } = await import("../lib/storage-tools.js");
const { agentCapabilities } = await import("../lib/agent-capabilities.js");
const { loopDriverFor } = await import("../lib/loop-drivers.js");
const { subjectScreenshotsOff } = await import("../lib/browser-artifacts.js");

const SECRET = "t1062-secret";
let d1: RealSchemaD1;
let created: Array<{ params: { instanceId: string; taskId: string; screenshots?: false; job: { url: string; dryRun: boolean; candidate: Record<string, unknown> } } }>;
let env: Env;

beforeEach(() => {
	runner.live = true;
	created = [];
	d1 = realSchemaD1();
	d1.exec(`INSERT INTO users (id, github_login) VALUES ('u1', 'u1')`);
	d1.exec(`INSERT INTO agents (id, owner_id, slug, name, config) VALUES ('scout-a', 'u1', 't1062-scout', 'Job Search Scout', '{"capabilities":{"surfaces":[],"runtime":"local_browser"}}')`);
	d1.exec(`INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES
	  ('apply-inst', 'agent_job_application_assistant', 'u1', 'active', '{}'),
	  ('scout-inst', 'scout-a', 'u1', 'active', '{}')`);
	d1.exec(`INSERT INTO user_profile (user_id, first_name, last_name, email) VALUES ('u1', 'Ada', 'Lovelace', 'ada@example.com')`);
	env = {
		DB: d1.DB,
		SESSION_SIGNING_KEY: SECRET,
		JOB_APPLY: { create: async (opts: (typeof created)[number]) => { created.push(opts); return { id: `wf_${created.length}` }; } },
	} as unknown as Env;
});
afterEach(() => d1.close());

async function app() {
	const router = new Hono<{ Bindings: Env }>();
	registerApplyRoutes(router);
	router.route("/", instanceRoutes);
	const a = new Hono<{ Bindings: Env }>();
	a.route("/v1/instances", router);
	a.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500)));
	return a;
}
async function apply(instanceId = "apply-inst", body: Record<string, unknown> = { url: "https://jobs.example/role/1", resumePath: "/home/ada/cv.pdf" }) {
	const token = await signSession("u1", SECRET, { roles: [] });
	const res = await (await app()).request(`/v1/instances/${instanceId}/apply`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }, env);
	// biome-ignore lint/suspicious/noExplicitAny: read field by field
	return { status: res.status, body: (await res.json()) as Record<string, any> };
}
const count = (sql: string) => (d1.sqlite.prepare(sql).get() as { n: number }).n;
const applyTasks = () => count("SELECT COUNT(*) AS n FROM instance_runtime_tasks WHERE type = 'job.apply_agent'");

describe("POST /:instanceId/apply starts the supported JOB_APPLY workflow (#1062)", () => {
	it("a JOB_APPLY instance with a live runner starts: one task, one run row, one spend pool, one workflow", async () => {
		const r = await apply();
		expect(r).toMatchObject({ status: 202, body: { workflowId: "wf_1", status: "running", url: "https://jobs.example/role/1" } });
		expect(created).toHaveLength(1);
		expect(created[0].params).toMatchObject({ instanceId: "apply-inst", taskId: r.body.taskId, job: { url: "https://jobs.example/role/1", dryRun: false } });
		expect(applyTasks()).toBe(1);
		expect(count("SELECT COUNT(*) AS n FROM agent_loop_runs WHERE instance_id = 'apply-inst'")).toBe(1);
		expect(count("SELECT COUNT(*) AS n FROM delegation_budgets WHERE root_instance_id = 'apply-inst'")).toBe(1);
		// The single-flight placeholder never outlives the start.
		expect(count("SELECT COUNT(*) AS n FROM instance_runtime_tasks WHERE id LIKE 'apply-claim_%'")).toBe(0);
	});

	it("candidate values come from the owner's Profile", async () => {
		await apply();
		expect(created[0].params.job.candidate).toMatchObject({ fullName: "Ada Lovelace", email: "ada@example.com" });
	});

	it("dryRun still fills without submitting — the flag reaches the workflow", async () => {
		await apply("apply-inst", { url: "https://jobs.example/role/1", resumePath: "/home/ada/cv.pdf", dryRun: true });
		expect(created[0].params.job.dryRun).toBe(true);
	});
});

describe("the owner's browser-screenshot switch reaches the workflow task (#1064)", () => {
	const put = async (enabled: boolean) => {
		const token = await signSession("u1", SECRET, { roles: [] });
		return (await app()).request("/v1/instances/apply-inst/browser-screenshots", { method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ enabled }) }, env);
	};

	it("ON (the default): the workflow and the task carry no flag", async () => {
		const r = await apply();
		expect(created[0].params).not.toHaveProperty("screenshots");
		expect(await subjectScreenshotsOff(env, "u1", "runtime_task", r.body.taskId)).toBe(false);
	});

	it("OFF: fixed on the workflow's params AND the task's own record, so the storage guard refuses its frames", async () => {
		expect((await put(false)).status).toBe(200);
		const r = await apply();
		expect(created[0].params.screenshots).toBe(false);
		expect(await subjectScreenshotsOff(env, "u1", "runtime_task", r.body.taskId)).toBe(true);
	});
});

describe("one application per instance — duplicates and races stay blocked (#1062)", () => {
	it("a second start while the first runs is refused 409, and starts nothing", async () => {
		expect((await apply()).status).toBe(202);
		const second = await apply("apply-inst", { url: "https://jobs.example/role/2", resumePath: "/home/ada/cv.pdf" });
		expect(second).toMatchObject({ status: 409, body: { error: expect.stringMatching(/already in progress/) } });
		expect(created).toHaveLength(1);
		expect(applyTasks()).toBe(1);
	});

	it("two CONCURRENT starts: exactly one wins, the other is 409", async () => {
		const [a, b] = await Promise.all([apply(), apply("apply-inst", { url: "https://jobs.example/role/2", resumePath: "/home/ada/cv.pdf" })]);
		expect([a.status, b.status].sort()).toEqual([202, 409]);
		expect(created).toHaveLength(1);
		expect(applyTasks()).toBe(1);
	});
});

describe("a start that cannot run says why, and leaves nothing behind (#1062)", () => {
	it("no live runner: refused, no task, no workflow, and the slot is free again", async () => {
		runner.live = false;
		const r = await apply();
		expect(r).toMatchObject({ status: 503, body: { error: expect.stringMatching(/No runner connected/) } });
		expect(created).toHaveLength(0);
		expect(count("SELECT COUNT(*) AS n FROM instance_runtime_tasks")).toBe(0);
		runner.live = true;
		expect((await apply()).status).toBe(202);
	});

	it("no résumé: refused before anything is claimed", async () => {
		const r = await apply("apply-inst", { url: "https://jobs.example/role/1" });
		expect(r).toMatchObject({ status: 400, body: { error: expect.stringMatching(/no résumé on file/) } });
		expect(count("SELECT COUNT(*) AS n FROM instance_runtime_tasks")).toBe(0);
	});

	it("an agent that does not run JOB_APPLY cannot start one — a concrete 409, nothing claimed", async () => {
		const r = await apply("scout-inst");
		expect(r).toMatchObject({ status: 409, body: { error: expect.stringMatching(/does not run the JOB_APPLY/) } });
		expect(created).toHaveLength(0);
		expect(count("SELECT COUNT(*) AS n FROM instance_runtime_tasks")).toBe(0);
	});
});

describe("the chat tool starts it too — with no candidate values from the model (#1062)", () => {
	const engine = {} as never;
	const ctx = () => ({ env, agentId: "apply-inst", userId: "u1" }) as never;

	it("submit_job_application starts the workflow, and ignores candidate fields the model sends", async () => {
		const out = await executeStorageTool({ name: "submit_job_application", input: { url: "https://jobs.example/role/9", resume_path: "/home/ada/cv.pdf", full_name: "Invented Person", email: "invented@example.com", work_authorization: "Citizen" } }, engine, ctx());
		expect(out).toMatchObject({ success: true, content: expect.stringMatching(/started — .*workflow wf_1, task task_/) });
		expect(created[0]?.params.job.candidate).toMatchObject({ fullName: "Ada Lovelace", email: "ada@example.com" });
		expect(JSON.stringify(created[0]?.params.job.candidate)).not.toMatch(/Invented|invented@|Citizen/);
	});

	it("a second chat start is refused with the exact error, never reported as started", async () => {
		await executeStorageTool({ name: "submit_job_application", input: { url: "https://jobs.example/role/9", resume_path: "/home/ada/cv.pdf" } }, engine, ctx());
		const again = await executeStorageTool({ name: "submit_job_application", input: { url: "https://jobs.example/role/10", resume_path: "/home/ada/cv.pdf" } }, engine, ctx());
		expect(again).toMatchObject({ success: false, content: expect.stringMatching(/already in progress/) });
		expect(created).toHaveLength(1);
	});
});

describe("every surface reads the same fact: JOB_APPLY is supported, not retired (#1062)", () => {
	it("my_instances carries no retirement for the JOB_APPLY instance, and its capabilities say JOB_APPLY", async () => {
		const token = await signSession("u1", SECRET, { roles: [] });
		const res = await (await app()).request("/v1/instances/my/instances", { headers: { Authorization: `Bearer ${token}` } }, env);
		// biome-ignore lint/suspicious/noExplicitAny: a JSON response read field by field
		const { instances } = (await res.json()) as { instances: Array<Record<string, any>> };
		const inst = instances.find((i) => i.id === "apply-inst")!;
		expect(Object.hasOwn(inst, "retirement")).toBe(false);
		expect(Object.hasOwn(inst.capabilities, "retired")).toBe(false);
		expect(inst.capabilities).toMatchObject({ surfaces: ["apply"], runtime: "browser", workflow: "JOB_APPLY" });
	});

	it("the Loop door no longer refuses it with a 410", async () => {
		const caps = agentCapabilities({ slug: "job-application-assistant", category: "productivity", config: null });
		expect(caps.retired).toBeUndefined();
		const started = { create: vi.fn(async () => ({ id: "wf" })) };
		const out = await loopDriverFor(caps).start({ env: { ...env, AGENT_LOOP: started } as unknown as Env, instanceId: "apply-inst", userId: "u1", objective: "x", budgetId: "b1", depth: 0 });
		expect(out.ok === false ? out.status : 200).not.toBe(410);
	});

	it("the catalogue row is published again — new owners can subscribe to it", () => {
		expect(d1.sqlite.prepare("SELECT visibility FROM agents WHERE slug = 'job-application-assistant'").get()).toEqual({ visibility: "published" });
	});
});
