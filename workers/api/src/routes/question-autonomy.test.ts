/**
 * #1385: the `questions: "ask" | "decide"` setting, through the real routes on the real migrated schema. The driver is the only fake (what it does
 * with the value is pinned in `lib/loop-drivers.test.ts` and `lib/coding-pause-decide.test.ts`); this file pins the setting's journey — accepted
 * and refused at the door, kept through the queue, stored on the instance, and read back on the run.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import type { Env } from "../types.js";

vi.mock("../lib/auth.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/auth.js")>("../lib/auth.js");
	return { ...actual, requireUser: async () => ({ uid: "u1", roles: [] }) };
});
vi.mock("../lib/billing.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/billing.js")>("../lib/billing.js");
	return { ...actual, requirePro: async () => undefined };
});
const driverStart = vi.fn();
vi.mock("../lib/loop-drivers.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/loop-drivers.js")>("../lib/loop-drivers.js");
	return { ...actual, loopDriverFor: () => ({ id: "coding", label: "coding", start: (...a: unknown[]) => driverStart(...a) }) };
});

const { toolRoutes } = await import("./tools.js");
const { tryDequeueAndStart } = await import("../lib/objective-queue-start.js");
const { createLoopRun } = await import("../lib/agent-loop-store.js");
const { applyQuestionsPolicy } = await import("../lib/question-policy.js");

let d1: RealSchemaD1;
let env: Env;

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["i1"] });
	seedTenant(d1, { userId: "u2", instanceIds: ["x1"] });
	d1.exec("UPDATE agent_instances SET agent_id = 'agent_local_coder' WHERE user_id = 'u1'");
	d1.exec(`INSERT INTO coding_repos (id, instance_id, user_id, name, github_repo) VALUES ('r1', 'i1', 'u1', 'app', 'acme/app')`);
	env = { DB: d1.DB, SESSION_SIGNING_KEY: "k" } as unknown as Env;
	driverStart.mockReset();
	driverStart.mockResolvedValue({ ok: true, runId: "run-1", driver: "coding" });
});
afterEach(() => d1.close());

// biome-ignore lint/suspicious/noExplicitAny: a JSON response read field by field in assertions.
type Json = Record<string, any>;
const app = () => {
	const router = new Hono<{ Bindings: Env }>();
	router.route("/v1/instances", toolRoutes);
	router.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500)));
	return router;
};
async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }> {
	const res = await app().request(path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }, env, { waitUntil: () => undefined, passThroughOnException: () => undefined, props: {} } as never);
	return { status: res.status, body: (await res.json()) as Json };
}
const startLoop = (body: Json = {}) => call("POST", "/v1/instances/i1/loop", { objective: "Work issue #9 on app", repoId: "r1", ...body });
const startInput = () => driverStart.mock.calls[0][0] as { questions?: string };

describe("starting a run (#1385)", () => {
	it("`questions: decide` reaches the driver", async () => {
		const r = await startLoop({ questions: "decide" });
		expect(r.status).toBe(201);
		expect(startInput().questions).toBe("decide");
	});

	it("an explicit `ask` reaches the driver too, so a run can opt out of an instance default of `decide`", async () => {
		await startLoop({ questions: "ask" });
		expect(startInput().questions).toBe("ask");
	});

	it("absent means the instance default decides: the route passes nothing", async () => {
		await startLoop();
		expect(startInput().questions).toBeUndefined();
	});

	it("anything else is refused at the door, before a budget is opened or the driver is asked — it must not silently become `ask`", async () => {
		for (const bad of ["always", "yes", true, 1, ["decide"]]) {
			const r = await startLoop({ questions: bad });
			expect(r.status, String(bad)).toBe(400);
			expect(r.body).toMatchObject({ error: 'questions must be "ask" or "decide"', startState: "not_started" });
		}
		expect(driverStart).not.toHaveBeenCalled();
	});

	it("a start that has to wait keeps the setting through the queue and hands it to the run the drain starts", async () => {
		driverStart.mockResolvedValueOnce({ ok: false, status: 409, reason: "busy", error: "the repo is busy" });
		const queued = await startLoop({ questions: "decide", queueIfBusy: true });
		expect(queued.status).toBe(202);
		expect(queued.body.queued).toBe(true);
		const stored = d1.sqlite.prepare("SELECT metadata FROM instance_objective_queue WHERE id = ?").get(queued.body.entry.id) as { metadata: string };
		expect(JSON.parse(stored.metadata)).toEqual({ questions: "decide" });

		driverStart.mockClear();
		driverStart.mockResolvedValue({ ok: true, runId: "run-2", driver: "coding" });
		const drained = await tryDequeueAndStart(env, "i1", "r1", "u1");
		expect(drained.drained).toBe(true);
		expect(startInput().questions).toBe("decide");
	});

	it("a queued start that named nothing inherits the instance default when the drain starts it (nothing is stored on the entry)", async () => {
		driverStart.mockResolvedValueOnce({ ok: false, status: 409, reason: "busy", error: "the repo is busy" });
		const queued = await startLoop({ queueIfBusy: true });
		const stored = d1.sqlite.prepare("SELECT metadata FROM instance_objective_queue WHERE id = ?").get(queued.body.entry.id) as { metadata: string | null };
		expect(stored.metadata).toBeNull();
		driverStart.mockClear();
		await tryDequeueAndStart(env, "i1", "r1", "u1");
		expect(startInput().questions).toBeUndefined();
	});
});

describe("the instance default — loop limits (#1385)", () => {
	const get = () => call("GET", "/v1/instances/i1/loop-limits");
	const put = (body: Json) => call("PUT", "/v1/instances/i1/loop-limits", body);

	it("is `ask` until set", async () => {
		const r = await get();
		expect(r.status).toBe(200);
		expect(r.body.effectiveQuestions).toBe("ask");
		expect(r.body.limits.questions).toBeUndefined();
	});

	it("round-trips: set to `decide`, read back as the limit and as the effective policy", async () => {
		const saved = await put({ questions: "decide" });
		expect(saved.status).toBe(200);
		expect(saved.body).toMatchObject({ limits: { questions: "decide" }, effectiveQuestions: "decide" });
		expect((await get()).body).toMatchObject({ limits: { questions: "decide" }, effectiveQuestions: "decide" });
	});

	it("is a patch: changing another limit keeps it, and `null` clears it back to `ask`", async () => {
		await put({ questions: "decide" });
		const other = await put({ maxIterations: 12 });
		expect(other.body).toMatchObject({ limits: { maxIterations: 12, questions: "decide" }, effectiveQuestions: "decide" });
		const cleared = await put({ questions: null });
		expect(cleared.body.effectiveQuestions).toBe("ask");
		expect(cleared.body.limits.questions).toBeUndefined();
		expect(cleared.body.limits.maxIterations).toBe(12);
	});

	it("an unrecognised value is a 400 that names the two words, and changes nothing", async () => {
		await put({ questions: "decide" });
		for (const bad of ["always", "Never", 7, true]) {
			const r = await put({ questions: bad });
			expect(r.status, String(bad)).toBe(400);
			expect(r.body.error).toBe('questions must be "ask" or "decide"');
		}
		expect((await get()).body.effectiveQuestions).toBe("decide");
	});

	it("is the owner's alone", async () => {
		expect((await call("PUT", "/v1/instances/x1/loop-limits", { questions: "decide" })).status).toBe(404);
		expect((d1.sqlite.prepare("SELECT config FROM agent_instances WHERE id = 'x1'").get() as { config: string }).config).not.toContain("decide");
	});
});

describe("reading a run back (#1385)", () => {
	const startRun = (runId: string, questionsPolicy: "ask" | "decide" | null) => createLoopRun(env, { runId, userId: "u1", instanceId: "i1", objective: "x", maxIterations: 10, startedAt: Date.now(), questionsPolicy });

	it("a `decide` run says so and lists what it decided — the question, the choice, the alternatives, why, and where it was posted", async () => {
		await startRun("run-d", "decide");
		await applyQuestionsPolicy(
			env,
			{ runId: "run-d", instanceId: "i1", userId: "u1", round: 0, issue: { repo: "acme/app", number: 394 }, postComment: async () => true },
			{ question: "Push now or wait?", options: ["Yes — commit and push now", "No — wait and run tests again first"] },
		);
		const r = await call("GET", "/v1/instances/i1/loop/run-d");
		expect(r.status).toBe(200);
		expect(r.body.questions).toBe("decide");
		expect(r.body.decisions).toHaveLength(1);
		expect(r.body.decisions[0]).toMatchObject({ outcome: "decided", question: "Push now or wait?", decision: "No — wait and run tests again first", alternatives: ["Yes — commit and push now"], issue: { repo: "acme/app", number: 394 }, posted: true });
	});

	it("a question it kept for the owner is listed too, with the reason, so 'why did it stop?' has an answer", async () => {
		await startRun("run-d", "decide");
		await applyQuestionsPolicy(env, { runId: "run-d", instanceId: "i1", userId: "u1", round: 1, issue: null, postComment: async () => true }, { question: "Should I delete the staging database?", options: ["Yes", "No"] });
		const r = await call("GET", "/v1/instances/i1/loop/run-d");
		expect(r.body.decisions[0]).toMatchObject({ outcome: "parked", guardrail: "destructive", decision: null });
	});

	it("a default run reads `ask` with no decisions — and so does one from before the setting existed", async () => {
		await startRun("run-a", null);
		await startRun("run-b", "ask");
		for (const id of ["run-a", "run-b"]) {
			const r = await call("GET", `/v1/instances/i1/loop/${id}`);
			expect(r.body.questions, id).toBe("ask");
			expect(r.body.decisions, id).toEqual([]);
		}
	});
});
