import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { signSession } from "../lib/session.js";
import { toolRoutes } from "./tools.js";

const SECRET = "test-secret";

function testApp(opts: { owned?: boolean; config?: string; create?: (arg: unknown) => Promise<{ id: string }>; runs?: unknown[] } = { owned: true }) {
	const app = new Hono();
	app.route("/v1/instances", toolRoutes);
	app.onError((err, c) => {
		if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
		throw err;
	});
	const config = opts.config ?? "{}";
	const env = {
		SESSION_SIGNING_KEY: SECRET,
		// githubAppConfigured() → false (no GITHUB_APP_ID), so github tools return a
		// clean "not connected" result instead of hitting the network.
		DB: {
			prepare(sql: string) {
				return {
					bind() {
						return {
							first: async () => {
								// Supervision (#183): the read-back after INSERT.
								if (sql.includes("FROM agent_supervision")) {
									return { id: "sup1", user_id: "u1", supervisor_instance_id: "i1", subordinate_instance_id: "i2", enabled: 1, config: "{}", created_at: "", updated_at: "" };
								}
								return sql.includes("FROM agent_instances") && (opts.owned ?? true)
									? { id: "i1", agent_id: "a1", user_id: "u1", status: "active", config, created_at: "", updated_at: "" }
									: null;
							},
							// logEvent (pipeline audit) does a .run() insert — must not throw.
							run: async () => ({}),
							// listRuns (#98) reads via .all(); return the seeded runs for the
							// pipeline_runs query, empty otherwise.
							all: async () => ({ results: sql.includes("FROM pipeline_runs") ? opts.runs ?? [] : [] }),
						};
					},
				};
			},
		},
		// Durable pipeline runner (issue #97) — stubbed to capture .create() calls.
		PIPELINE_RUN: { create: opts.create ?? (async () => ({ id: "wf-test" })) },
	};
	return { app, env };
}

// A valid stored pipeline whose step uses a real registry tool (so validatePipeline passes).
const STORED_PIPELINE = { pipelines: { sweep: { name: "sweep", steps: [{ tool: "github_workflow_runs", inputs: { repo: { $param: "repo" } }, bind: "runs" }], sink: { collection: "results" } } } };

const tok = (uid: string) => signSession(uid, SECRET, { roles: ["user"] });
const req = (app: Hono, env: unknown, path: string, init: RequestInit, t: string) =>
	app.request(path, { ...init, headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json", ...(init.headers || {}) } }, env);

describe("GET /v1/instances/:id/tools", () => {
	it("404s when the instance isn't owned", async () => {
		const { app, env } = testApp({ owned: false });
		const res = await req(app, env, "/v1/instances/i1/tools", {}, await tok("u1"));
		expect(res.status).toBe(404);
	});
	it("lists the connector tools for the owner", async () => {
		const { app, env } = testApp();
		const res = await req(app, env, "/v1/instances/i1/tools", {}, await tok("u1"));
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.tools.map((t: any) => t.name)).toContain("github_workflow_runs");
	});
	it("emits each tool's jsonSchema verbatim (draft-07 object schema)", async () => {
		const { app, env } = testApp();
		const res = await req(app, env, "/v1/instances/i1/tools", {}, await tok("u1"));
		const body = (await res.json()) as any;
		const tool = body.tools.find((t: any) => t.name === "github_workflow_runs");
		expect(tool.jsonSchema.type).toBe("object");
		expect(tool.jsonSchema.properties.repo.type).toBe("string");
		expect(tool.jsonSchema.required).toContain("repo");
		// The old ad-hoc `parameters` map is gone from the wire shape.
		expect(tool.parameters).toBeUndefined();
	});
});

describe("POST /v1/instances/:id/tools/:name", () => {
	it("404s an unknown tool", async () => {
		const { app, env } = testApp();
		const res = await req(app, env, "/v1/instances/i1/tools/nope", { method: "POST", body: "{}" }, await tok("u1"));
		expect(res.status).toBe(404);
	});
	it("invokes a github tool and returns its result (not connected → success:false)", async () => {
		const { app, env } = testApp();
		const res = await req(app, env, "/v1/instances/i1/tools/github_workflow_runs", { method: "POST", body: JSON.stringify({ repo: "owner/name" }) }, await tok("u1"));
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.name).toBe("github_workflow_runs");
		expect(body.success).toBe(false);
		expect(body.content).toMatch(/not connected|not configured/i);
	});
	it("400s when a required field is missing (validated against jsonSchema before dispatch)", async () => {
		const { app, env } = testApp();
		// github_workflow_runs requires `repo`; omit it.
		const res = await req(app, env, "/v1/instances/i1/tools/github_workflow_runs", { method: "POST", body: "{}" }, await tok("u1"));
		expect(res.status).toBe(400);
		const body = (await res.json()) as any;
		expect(body.error).toMatch(/required field: repo/i);
	});
	it("400s when a field has the wrong basic type", async () => {
		const { app, env } = testApp();
		// github_read_issue: `number` must be a number.
		const res = await req(
			app,
			env,
			"/v1/instances/i1/tools/github_read_issue",
			{ method: "POST", body: JSON.stringify({ repo: "owner/name", number: "not-a-number" }) },
			await tok("u1"),
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as any;
		expect(body.error).toMatch(/"number" must be a number/i);
	});
	it("passes validation when required fields are present + well-typed (reaches the handler)", async () => {
		const { app, env } = testApp();
		const res = await req(
			app,
			env,
			"/v1/instances/i1/tools/github_read_issue",
			{ method: "POST", body: JSON.stringify({ repo: "owner/name", number: 7 }) },
			await tok("u1"),
		);
		// Validation passed → handler ran → GitHub not configured → 200 with success:false.
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.content).toMatch(/not connected|not configured/i);
	});
	it("invokes the generic http_request tool through the SAME route — no bespoke route (issue #95)", async () => {
		const { app, env } = testApp();
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ places: [{ id: "p1", displayName: { text: "Cafe" } }] }), { status: 200, headers: { "Content-Type": "application/json" } }),
		);
		const res = await req(
			app,
			env,
			"/v1/instances/i1/tools/http_request",
			{ method: "POST", body: JSON.stringify({ url: "https://places.googleapis.com/v1/x", responseMap: "places[].{id,name:displayName.text}" }) },
			await tok("u1"),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.name).toBe("http_request");
		expect(body.success).toBe(true);
		expect(JSON.parse(body.content).data).toEqual([{ id: "p1", name: "Cafe" }]);
		fetchSpy.mockRestore();
	});
});

describe("GET /v1/instances/:id/pipelines (issue #97)", () => {
	it("lists pipelines declared in the instance config", async () => {
		const { app, env } = testApp({ config: JSON.stringify(STORED_PIPELINE) });
		const res = await req(app, env, "/v1/instances/i1/pipelines", {}, await tok("u1"));
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.pipelines).toHaveLength(1);
		expect(body.pipelines[0]).toMatchObject({ name: "sweep", steps: 1, sink: "results", valid: true });
	});

	it("404s when the instance isn't owned", async () => {
		const { app, env } = testApp({ owned: false });
		const res = await req(app, env, "/v1/instances/i1/pipelines", {}, await tok("u1"));
		expect(res.status).toBe(404);
	});
});

describe("POST /v1/instances/:id/pipelines/:name/run (issue #97)", () => {
	it("owner-gated: 404s when the instance isn't owned (never kicks the workflow)", async () => {
		const create = vi.fn(async () => ({ id: "wf" }));
		const { app, env } = testApp({ owned: false, config: JSON.stringify(STORED_PIPELINE), create });
		const res = await req(app, env, "/v1/instances/i1/pipelines/sweep/run", { method: "POST", body: "{}" }, await tok("u1"));
		expect(res.status).toBe(404);
		expect(create).not.toHaveBeenCalled();
	});

	it("404s an unknown pipeline name", async () => {
		const { app, env } = testApp({ config: JSON.stringify(STORED_PIPELINE) });
		const res = await req(app, env, "/v1/instances/i1/pipelines/nope/run", { method: "POST", body: "{}" }, await tok("u1"));
		expect(res.status).toBe(404);
	});

	it("kicks the durable workflow with the def + params and returns run ids", async () => {
		const create = vi.fn(async () => ({ id: "wf-99" }));
		const { app, env } = testApp({ config: JSON.stringify(STORED_PIPELINE), create });
		const res = await req(app, env, "/v1/instances/i1/pipelines/sweep/run", { method: "POST", body: JSON.stringify({ params: { repo: "owner/name" } }) }, await tok("u1"));
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.ok).toBe(true);
		expect(body.workflowId).toBe("wf-99");
		expect(body.runId).toBeTruthy();
		expect(create).toHaveBeenCalledTimes(1);
		const arg = create.mock.calls[0][0] as any;
		expect(arg.params.pipeline.name).toBe("sweep");
		expect(arg.params.params).toEqual({ repo: "owner/name" });
		expect(arg.params.trigger).toBe("api");
		expect(arg.params.userId).toBe("u1");
	});
});

describe("PUT /v1/instances/:id/pipelines/:name (attach a pipeline — the missing write path)", () => {
	const DEF = STORED_PIPELINE.pipelines.sweep;

	it("owner-gated: 404s when the instance isn't owned", async () => {
		const { app, env } = testApp({ owned: false });
		const res = await req(app, env, "/v1/instances/i1/pipelines/lead_finder", { method: "PUT", body: JSON.stringify(DEF) }, await tok("u1"));
		expect(res.status).toBe(404);
	});

	it("400s an invalid pipeline definition", async () => {
		const { app, env } = testApp();
		const res = await req(app, env, "/v1/instances/i1/pipelines/lead_finder", { method: "PUT", body: JSON.stringify({ not: "a pipeline" }) }, await tok("u1"));
		expect(res.status).toBe(400);
	});

	it("attaches a valid pipeline under the requested name → 200 (it can then be run)", async () => {
		let written = "";
		const create = async () => ({ id: "x" });
		const { app, env } = testApp({ config: "{}", create });
		// capture the config UPDATE the route performs
		(env.DB as { prepare: (s: string) => unknown }).prepare = (sql: string) => ({
			bind: (...args: unknown[]) => ({
				first: async () => (sql.includes("FROM agent_instances") ? { id: "i1", agent_id: "a1", user_id: "u1", status: "active", config: "{}" } : null),
				run: async () => { if (sql.includes("UPDATE agent_instances")) written = String(args[0]); return {}; },
				all: async () => ({ results: [] }),
			}),
		});
		const res = await req(app, env, "/v1/instances/i1/pipelines/lead_finder", { method: "PUT", body: JSON.stringify(DEF) }, await tok("u1"));
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ ok: true, name: "lead_finder" });
		// the def landed under config.pipelines.lead_finder — where loadPipeline reads it
		expect(JSON.parse(written).pipelines.lead_finder.name).toBe("sweep");
	});
});

describe("GET /v1/instances/:id/pipeline-runs (issue #98)", () => {
	it("404s when the instance isn't owned", async () => {
		const { app, env } = testApp({ owned: false });
		const res = await req(app, env, "/v1/instances/i1/pipeline-runs", {}, await tok("u1"));
		expect(res.status).toBe(404);
	});

	it("lists the owner's runs with counts + parsed params", async () => {
		const runs = [{ run_id: "r1", user_id: "u1", instance_id: "i1", pipeline: "leads", trigger: "api", status: "completed", params: '{"city":"Sydney"}', started_at: 5, finished_at: 9, seen: 3, added: 2, skipped: 1, errors: 0, detail: null }];
		const { app, env } = testApp({ owned: true, runs });
		const res = await req(app, env, "/v1/instances/i1/pipeline-runs", {}, await tok("u1"));
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.runs).toHaveLength(1);
		expect(body.runs[0].pipeline).toBe("leads");
		expect(body.runs[0].seen).toBe(3);
		expect(body.runs[0].params).toEqual({ city: "Sydney" });
	});
});

describe("supervision edges (#183)", () => {
	const tok = () => signSession({ uid: "u1", roles: ["user"] }, SECRET);

	const post = async (body: unknown, owned = true) => {
		const { app, env } = testApp({ owned });
		return app.request("/v1/instances/i1/supervision", {
			method: "POST",
			headers: { Authorization: `Bearer ${await tok()}`, "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}, env);
	};

	it("wires a supervisor over a subordinate", async () => {
		const res = await post({ subordinateInstanceId: "i2" });
		expect(res.status).toBe(201);
		expect(await res.json()).toMatchObject({ supervisorInstanceId: "i1", subordinateInstanceId: "i2" });
	});

	it("refuses self-supervision at wiring time", async () => {
		// The rule is enforced when the human is present, not discovered at 3am as an
		// unbounded delegation loop that spends real money.
		const res = await post({ subordinateInstanceId: "i1" });
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toContain("cannot supervise itself");
	});

	it("requires a subordinate", async () => {
		expect((await post({})).status).toBe(400);
	});

	it("404s when the caller does not own the supervisor instance", async () => {
		expect((await post({ subordinateInstanceId: "i2" }, false)).status).toBe(404);
	});

	it("lists a supervisor's edges", async () => {
		const { app, env } = testApp();
		const res = await app.request("/v1/instances/i1/supervision", {
			headers: { Authorization: `Bearer ${await tok()}` },
		}, env);
		expect(res.status).toBe(200);
		expect(await res.json()).toHaveProperty("supervision");
	});
});
