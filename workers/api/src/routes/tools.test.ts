import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { signSession } from "../lib/session.js";
import { toolRoutes } from "./tools.js";

const SECRET = "test-secret";

/** The tool-policy gate (#tools) resolves the AGENT's declared capabilities, so a fixture
 *  must declare the tools its test invokes — a legacy agent that declares none is now
 *  correctly refused. Default: declare exactly the tools exercised in this file. */
const FIXTURE_AGENT_CONFIG = JSON.stringify({
	capabilities: { tools: ["github_workflow_runs", "github_list_issues", "github_read_issue", "github_create_issue", "http_request"] },
});

function testApp(opts: { owned?: boolean; config?: string; agentConfig?: string; create?: (arg: unknown) => Promise<{ id: string }>; runs?: unknown[]; loopCreate?: (arg: unknown) => Promise<{ id: string }> } = { owned: true }) {
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
								if (sql.includes("FROM agent_loop_runs")) {
									return { run_id: "r1", user_id: "u1", instance_id: "i1", objective: "ship it", status: "running", stop_reason: null, detail: null, iteration: 2, max_iterations: 10, cancel_requested: 0, budget_id: "b1", started_at: 1, finished_at: null };
								}
								if (sql.includes("FROM delegation_budgets")) {
									return { id: "b1", user_id: "u1", root_instance_id: "i1", cost_micros_limit: 5000000, cost_micros_reserved: 0, cost_micros_spent: 0, delegations_limit: 50, delegations_used: 0, max_depth: 4, status: "open", exhausted_reason: null, exhausted_at_depth: null, created_at: "", updated_at: "" };
								}
								if (sql.includes("FROM agent_supervision")) {
									return { id: "sup1", user_id: "u1", supervisor_instance_id: "i1", subordinate_instance_id: "i2", enabled: 1, config: "{}", created_at: "", updated_at: "" };
								}
								if (!sql.includes("FROM agent_instances") || !(opts.owned ?? true)) return null;
								// The tool-policy join (agent_instances ⨝ agents) needs the AGENT's config,
								// which is where capabilities.tools lives; the plain ownership read needs
								// the INSTANCE row. Same table, different shape.
								if (sql.includes("JOIN agents")) {
									return { slug: "fixture", category: "general", config: opts.agentConfig ?? FIXTURE_AGENT_CONFIG, instance_config: config };
								}
								return { id: "i1", agent_id: "a1", user_id: "u1", status: "active", config, created_at: "", updated_at: "" };
							},
							// logEvent (pipeline audit) does a .run() insert — must not throw.
							// meta.changes = 1 so routes that report "did a row match?" (cancel,
							// delete, replay) take their success path; the 404 cases in this file
							// are all ownership/unknown-name, not zero-changes.
							run: async () => ({ meta: { changes: 1 } }),
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
		// Durable agent loop (#158) — captures .create() so the start route is testable.
		AGENT_LOOP: { create: opts.loopCreate ?? (async () => ({ id: "wf-loop" })) },
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

describe("durable agent loop (#158)", () => {
	const tok = () => signSession({ uid: "u1", roles: ["user"] }, SECRET);

	it("starts a server-driven run and returns its id", async () => {
		let started: unknown = null;
		const { app, env } = testApp({ loopCreate: async (arg) => { started = arg; return { id: "wf-loop" }; } });
		const res = await app.request("/v1/instances/i1/loop", {
			method: "POST",
			headers: { Authorization: `Bearer ${await tok()}`, "Content-Type": "application/json" },
			body: JSON.stringify({ objective: "ship it", maxIterations: 5 }),
		}, env);
		expect(res.status).toBe(201);
		const body = (await res.json()) as { runId: string; budgetId: string; maxIterations: number };
		expect(body.runId).toBeTruthy();
		expect(body.maxIterations).toBe(5);
		// Every server-driven loop gets a budget — an autonomous run with no spend bound is the
		// failure #184 exists to prevent.
		expect(body.budgetId).toBeTruthy();
		expect((started as { params: { depth: number } }).params.depth).toBe(0);
	});

	it("clamps a runaway iteration request", async () => {
		const { app, env } = testApp();
		const res = await app.request("/v1/instances/i1/loop", {
			method: "POST",
			headers: { Authorization: `Bearer ${await tok()}`, "Content-Type": "application/json" },
			body: JSON.stringify({ objective: "go", maxIterations: 9999 }),
		}, env);
		expect(((await res.json()) as { maxIterations: number }).maxIterations).toBe(50);
	});

	it("requires an objective", async () => {
		const { app, env } = testApp();
		const res = await app.request("/v1/instances/i1/loop", {
			method: "POST",
			headers: { Authorization: `Bearer ${await tok()}`, "Content-Type": "application/json" },
			body: JSON.stringify({}),
		}, env);
		expect(res.status).toBe(400);
	});

	it("404s for an instance the caller does not own", async () => {
		const { app, env } = testApp({ owned: false });
		const res = await app.request("/v1/instances/i1/loop", {
			method: "POST",
			headers: { Authorization: `Bearer ${await tok()}`, "Content-Type": "application/json" },
			body: JSON.stringify({ objective: "go" }),
		}, env);
		expect(res.status).toBe(404);
	});

	it("reads back a run so a reopened console can resume watching", async () => {
		const { app, env } = testApp();
		const res = await app.request("/v1/instances/i1/loop/r1", { headers: { Authorization: `Bearer ${await tok()}` } }, env);
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ runId: "r1", iteration: 2, status: "running" });
	});

	it("cancels cooperatively", async () => {
		const { app, env } = testApp();
		const res = await app.request("/v1/instances/i1/loop/r1/cancel", {
			method: "POST",
			headers: { Authorization: `Bearer ${await tok()}` },
		}, env);
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ status: "cancelling" });
	});
});

// ── The capability gate on the generic invoker ───────────────────────────────
//
// Before this gate, owning an instance WAS authority to run any tool in the registry from
// this route (and from MCP's call_instance_tool, which proxies it). So `capabilities.tools`
// bounded the agent's chat while its instance could still be driven to read the owner's
// terminals or spreadsheets. These tests are the proof that "this agent is read-only" is now
// a property of the instance rather than of one surface.
describe("tool policy gate (undeclared tools are refused on every surface)", () => {
	const READ_ONLY_AGENT = JSON.stringify({ capabilities: { tools: ["github_workflow_runs"] } });

	it("403s a tool the agent does not declare, even a harmless read", async () => {
		const { app, env } = testApp({ agentConfig: READ_ONLY_AGENT });
		const res = await req(app, env, "/v1/instances/i1/tools/http_request", { method: "POST", body: JSON.stringify({ url: "https://x.test" }) }, await tok("u1"));
		expect(res.status).toBe(403);
		expect(((await res.json()) as any).error).toContain("not one of this agent's tools");
	});

	it("still runs a tool the agent does declare", async () => {
		const { app, env } = testApp({ agentConfig: READ_ONLY_AGENT });
		const res = await req(app, env, "/v1/instances/i1/tools/github_workflow_runs", { method: "POST", body: JSON.stringify({ repo: "o/n" }) }, await tok("u1"));
		expect(res.status).toBe(200);
	});

	it("reports a verdict for EVERY tool, so the UI can show what is blocked and why", async () => {
		const { app, env } = testApp({ agentConfig: READ_ONLY_AGENT });
		const body = (await (await req(app, env, "/v1/instances/i1/tools", {}, await tok("u1"))).json()) as any;
		const allowed = body.tools.filter((t: any) => t.allowed).map((t: any) => t.name);
		expect(allowed).toContain("github_workflow_runs");
		expect(allowed).not.toContain("http_request");
		expect(body.tools.find((t: any) => t.name === "http_request").reason).toBe("not_declared");
		// No write tool survives for a read-only agent — the assertion an auditor actually wants.
		expect(body.tools.filter((t: any) => t.allowed && t.scope === "write")).toEqual([]);
	});

	it("?allowed=true narrows to just the runnable set", async () => {
		const { app, env } = testApp({ agentConfig: READ_ONLY_AGENT });
		const body = (await (await req(app, env, "/v1/instances/i1/tools?allowed=true", {}, await tok("u1"))).json()) as any;
		expect(body.tools.every((t: any) => t.allowed)).toBe(true);
	});
});

describe("PUT /v1/instances/:id/tools/:name — the owner's off-switch", () => {
	const AGENT = JSON.stringify({ capabilities: { tools: ["github_workflow_runs", "http_request"] } });

	it("persists the off-switch onto the instance config", async () => {
		let written = "";
		const { app, env } = testApp({ agentConfig: AGENT });
		(env.DB as any).prepare = (sql: string) => ({
			bind: (...args: unknown[]) => ({
				first: async () =>
					sql.includes("JOIN agents")
						? { slug: "fixture", category: "general", config: AGENT, instance_config: "{}" }
						: sql.includes("FROM agent_instances")
							? { id: "i1", agent_id: "a1", user_id: "u1", status: "active", config: "{}" }
							: null,
				run: async () => {
					if (sql.includes("UPDATE agent_instances")) written = String(args[0]);
					return { meta: { changes: 1 } };
				},
				all: async () => ({ results: [] }),
			}),
		});
		const res = await req(app, env, "/v1/instances/i1/tools/http_request", { method: "PUT", body: JSON.stringify({ enabled: false }) }, await tok("u1"));
		expect(res.status).toBe(200);
		expect(JSON.parse(written).disabledTools).toEqual(["http_request"]);
	});

	it("refuses to record an off-switch for a tool the agent never had", async () => {
		const { app, env } = testApp({ agentConfig: JSON.stringify({ capabilities: { tools: ["github_workflow_runs"] } }) });
		const res = await req(app, env, "/v1/instances/i1/tools/http_request", { method: "PUT", body: JSON.stringify({ enabled: false }) }, await tok("u1"));
		expect(res.status).toBe(403);
	});

	it("rejects a non-boolean `enabled` rather than guessing", async () => {
		const { app, env } = testApp({ agentConfig: AGENT });
		const res = await req(app, env, "/v1/instances/i1/tools/http_request", { method: "PUT", body: JSON.stringify({ enabled: "yes" }) }, await tok("u1"));
		expect(res.status).toBe(400);
	});

	it("a switched-off tool is then refused by the invoker", async () => {
		const { app, env } = testApp({ agentConfig: AGENT, config: JSON.stringify({ disabledTools: ["http_request"] }) });
		const res = await req(app, env, "/v1/instances/i1/tools/http_request", { method: "POST", body: JSON.stringify({ url: "https://x.test" }) }, await tok("u1"));
		expect(res.status).toBe(403);
		expect(((await res.json()) as any).error).toContain("switched off");
	});
});

// ── #216: consent rows must describe something that can actually happen ──────
describe("PUT /v1/instances/:id/connectors/:connector/consent", () => {
	it("grants write consent for a write-capable connector", async () => {
		const { app, env } = testApp();
		const res = await req(app, env, "/v1/instances/i1/connectors/github/consent", { method: "PUT", body: JSON.stringify({ enabled: true }) }, await tok("u1"));
		expect(res.status).toBe(200);
	});

	it("404s an unknown connector instead of storing a row for it", async () => {
		const { app, env } = testApp();
		const res = await req(app, env, "/v1/instances/i1/connectors/not-a-connector/consent", { method: "PUT", body: JSON.stringify({ enabled: true }) }, await tok("u1"));
		expect(res.status).toBe(404);
	});

	// repo-local declares scopes.write:false, so runRegistryTool would refuse its writes anyway.
	// The problem was the record: consent that reads as granted but can never permit anything is
	// the raw material for a later bypass, because the next reader has to re-derive that
	// "granted" here does not mean granted.
	it("refuses write consent for a read-only connector", async () => {
		const { app, env } = testApp();
		const res = await req(app, env, "/v1/instances/i1/connectors/repo-local/consent", { method: "PUT", body: JSON.stringify({ enabled: true }) }, await tok("u1"));
		expect(res.status).toBe(400);
		expect(((await res.json()) as any).error).toMatch(/read-only/i);
	});

	// Revocation stays unvalidated on purpose: rows written before this check existed, or whose
	// connector has since gone read-only, must remain removable.
	it("allows revoking consent for a read-only or unknown connector", async () => {
		const { app, env } = testApp();
		for (const conn of ["repo-local", "not-a-connector"]) {
			const res = await req(app, env, `/v1/instances/i1/connectors/${conn}/consent`, { method: "PUT", body: JSON.stringify({ enabled: false }) }, await tok("u1"));
			expect(res.status).toBe(200);
		}
	});
});
