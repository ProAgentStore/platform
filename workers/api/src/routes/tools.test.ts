import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { signSession } from "../lib/session.js";
import { resetEraCache } from "../lib/connectors/mcp.js";
import { toolRoutes } from "./tools.js";
import { unfenceUntrusted } from "../lib/untrusted-fence.js";

/**
 * Knowingly-partial test doubles, and the only `any` left in this file.
 *
 * A `RegistryToolCtx` carries a whole `Env` of bindings and a four-method `ConnectorClient`;
 * the tool under test touches one or two of them. Declaring an interface for that subset would
 * put a second, unmaintained shape in front of the compiler and have it vouch for that, and
 * `as unknown as X` is the same claim with the lint rule switched off. So the cast is kept on
 * purpose and kept HERE — one place that says "fake", instead of call sites that imply otherwise.
 */
// biome-ignore lint/suspicious/noExplicitAny: deliberate partial double — see the block above.
const fake = <T,>(v: T): any => v;

/**
 * Readers for JSON that came back from a route, for use in assertions.
 *
 * Every field is `unknown`, not `any`. These response shapes are not declared types anywhere in
 * the worker, so an interface written here would be a second source of truth that nothing keeps
 * in step — and the compiler would then vouch for it. `unknown` leaves the `expect` below as the
 * only thing making a claim about the shape, which is what a test is for.
 */
const jsonBody = async (res: Response): Promise<Record<string, unknown>> => (await res.json()) as Record<string, unknown>;
const rec = (v: unknown): Record<string, unknown> => (v ?? {}) as Record<string, unknown>;
const rows = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v : []);

const SECRET = "test-secret";

/** The tool-policy gate (#tools) resolves the AGENT's declared capabilities, so a fixture
 *  must declare the tools its test invokes — a legacy agent that declares none is now
 *  correctly refused. Default: declare exactly the tools exercised in this file. */
const FIXTURE_AGENT_CONFIG = JSON.stringify({
	capabilities: { tools: ["github_workflow_runs", "github_list_issues", "github_read_issue", "github_create_issue", "http_request"] },
});

function testApp(
	opts: {
		owned?: boolean;
		config?: string;
		agentConfig?: string;
		create?: (arg: unknown) => Promise<{ id: string }>;
		runs?: unknown[];
		loopCreate?: (arg: unknown) => Promise<{ id: string }>;
		/** Rows in instance_mcp_consent for this instance (#262). */
		mcpGrants?: Array<{ instance_id: string; user_id: string; endpoint: string; tool: string; created_at: string }>;
		/** Connectors with write consent granted (#90). */
		writeConsents?: string[];
	} = { owned: true },
) {
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
					bind(...binds: unknown[]) {
						return {
							first: async () => {
								// Connector write-consent (#90): a row means granted. The connector name is
								// the 2nd bind (instance, connector, scope).
								if (sql.includes("instance_connector_consent")) {
									return (opts.writeConsents ?? []).includes(String(binds[1])) ? { ok: 1 } : null;
								}
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
							all: async () => {
								if (sql.includes("FROM pipeline_runs")) return { results: opts.runs ?? [] };
								if (sql.includes("instance_mcp_consent")) return { results: opts.mcpGrants ?? [] };
								return { results: [] };
							},
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
		const body = await jsonBody(res);
		expect(rows(body.tools).map((t) => t.name)).toContain("github_workflow_runs");
	});
	it("emits each tool's jsonSchema verbatim (draft-07 object schema)", async () => {
		const { app, env } = testApp();
		const res = await req(app, env, "/v1/instances/i1/tools", {}, await tok("u1"));
		const body = await jsonBody(res);
		const tool = rows(body.tools).find((t) => t.name === "github_workflow_runs");
		expect(tool.jsonSchema.type).toBe("object");
		expect(tool.jsonSchema.properties.repo.type).toBe("string");
		expect(tool.jsonSchema.required).toContain("repo");
		// The old ad-hoc `parameters` map is gone from the wire shape.
		expect(tool.parameters).toBeUndefined();
	});
});

describe("GET /v1/instances/:id/connectors (#352)", () => {
	const TERMINAL_OPERATOR = JSON.stringify({ capabilities: { tools: ["tmux_capture_pane", "tmux_send_keys"] } });
	const DOC_READER = JSON.stringify({ capabilities: { tools: ["search_knowledge", "list_knowledge", "read_knowledge"] } });
	const verdict = (body: Record<string, unknown>, id: string) => rec(rows(body.connectors).find((p) => p.id === id));

	it("404s when the instance isn't owned", async () => {
		const { app, env } = testApp({ owned: false });
		const res = await req(app, env, "/v1/instances/i1/connectors", {}, await tok("u1"));
		expect(res.status).toBe(404);
	});

	// The whole point of the issue: the ACCOUNT state is identical for both of these agents — one
	// Drive connection, shared by every instance — and the verdict still differs, because the
	// AGENT differs. Before this route there was nothing to ask.
	it("withholds Drive from an agent that cannot read a knowledge base, and offers it to one that can", async () => {
		const operator = testApp({ agentConfig: TERMINAL_OPERATOR });
		const opBody = await jsonBody(await req(operator.app, operator.env, "/v1/instances/i1/connectors", {}, await tok("u1")));
		expect(verdict(opBody, "google_drive")).toMatchObject({ allowed: false, reason: "no_knowledge" });
		expect(verdict(opBody, "zoho_workdrive")).toMatchObject({ allowed: false, reason: "no_knowledge" });

		const reader = testApp({ agentConfig: DOC_READER });
		const readBody = await jsonBody(await req(reader.app, reader.env, "/v1/instances/i1/connectors", {}, await tok("u1")));
		expect(verdict(readBody, "google_drive")).toMatchObject({ allowed: true, reason: "knowledge" });
	});

	// The subscriber's veto outranks the creator's declaration everywhere else (buildAgentToolDefinitions
	// applies it last), so a connector must not be offered on the strength of a tool this instance
	// would refuse to run.
	it("honours the owner's per-tool off-switches", async () => {
		const { app, env } = testApp({
			agentConfig: DOC_READER,
			config: JSON.stringify({ disabledTools: ["search_knowledge", "list_knowledge", "read_knowledge"] }),
		});
		const body = await jsonBody(await req(app, env, "/v1/instances/i1/connectors", {}, await tok("u1")));
		expect(verdict(body, "google_drive")).toMatchObject({ allowed: false, reason: "no_knowledge" });
	});

	it("reports Gmail as reachable regardless — its gate is the per-agent permissions.email flag", async () => {
		const { app, env } = testApp({ agentConfig: TERMINAL_OPERATOR });
		const body = await jsonBody(await req(app, env, "/v1/instances/i1/connectors", {}, await tok("u1")));
		expect(verdict(body, "gmail")).toMatchObject({ allowed: true, reason: "permission" });
	});

	it("returns the whole catalog, so 'what can this agent reach' also says what it cannot", async () => {
		const { app, env } = testApp({ agentConfig: TERMINAL_OPERATOR });
		const body = await jsonBody(await req(app, env, "/v1/instances/i1/connectors", {}, await tok("u1")));
		expect(verdict(body, "tmux")).toMatchObject({ allowed: true, reason: "tools" });
		expect(verdict(body, "github")).toMatchObject({ allowed: false, reason: "no_tools" });
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
		const body = await jsonBody(res);
		expect(body.name).toBe("github_workflow_runs");
		expect(body.success).toBe(false);
		expect(body.content).toMatch(/not connected|not configured/i);
	});
	it("400s when a required field is missing (validated against jsonSchema before dispatch)", async () => {
		const { app, env } = testApp();
		// github_workflow_runs requires `repo`; omit it.
		const res = await req(app, env, "/v1/instances/i1/tools/github_workflow_runs", { method: "POST", body: "{}" }, await tok("u1"));
		expect(res.status).toBe(400);
		const body = await jsonBody(res);
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
		const body = await jsonBody(res);
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
		const body = await jsonBody(res);
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
		const body = await jsonBody(res);
		expect(body.name).toBe("http_request");
		expect(body.success).toBe(true);
		// #308: the envelope is fenced as untrusted remote text at the connector, so this surface
		// gets it fenced too — which is the point (fencing at the chat surface would leave this
		// route, the pipeline step and MCP bare). Unwrapped the way the pipeline binder does.
		expect(JSON.parse(unfenceUntrusted(body.content)).data).toEqual([{ id: "p1", name: "Cafe" }]);
		fetchSpy.mockRestore();
	});
});

describe("GET /v1/instances/:id/pipelines (issue #97)", () => {
	it("lists pipelines declared in the instance config", async () => {
		const { app, env } = testApp({ config: JSON.stringify(STORED_PIPELINE) });
		const res = await req(app, env, "/v1/instances/i1/pipelines", {}, await tok("u1"));
		expect(res.status).toBe(200);
		const body = await jsonBody(res);
		expect(body.pipelines).toHaveLength(1);
		expect(body.pipelines[0]).toMatchObject({ name: "sweep", steps: 1, sink: "results", valid: true });
	});

	it("404s when the instance isn't owned", async () => {
		const { app, env } = testApp({ owned: false });
		const res = await req(app, env, "/v1/instances/i1/pipelines", {}, await tok("u1"));
		expect(res.status).toBe(404);
	});
});

describe("GET /v1/instances/:id/pipelines/:name (issue #464)", () => {
	it("404s when the instance isn't owned", async () => {
		const { app, env } = testApp({ owned: false, config: JSON.stringify(STORED_PIPELINE) });
		const res = await req(app, env, "/v1/instances/i1/pipelines/sweep", {}, await tok("u1"));
		expect(res.status).toBe(404);
	});

	it("404s when the pipeline name does not exist on the instance", async () => {
		const { app, env } = testApp({ config: JSON.stringify(STORED_PIPELINE) });
		const res = await req(app, env, "/v1/instances/i1/pipelines/no_such_pipeline", {}, await tok("u1"));
		expect(res.status).toBe(404);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.error).toMatch(/not found/i);
	});

	it("returns the full definition for a valid pipeline", async () => {
		const { app, env } = testApp({ config: JSON.stringify(STORED_PIPELINE) });
		const res = await req(app, env, "/v1/instances/i1/pipelines/sweep", {}, await tok("u1"));
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.name).toBe("sweep");
		expect(body.valid).toBe(true);
		expect(body.error).toBeNull();
		expect(body.definition).toMatchObject({ steps: [{ tool: "github_workflow_runs" }], sink: { collection: "results" } });
	});

	it("returns valid:false and the validator error for a malformed stored definition", async () => {
		const bad = { pipelines: { broken: { steps: [] } } }; // empty steps → invalid
		const { app, env } = testApp({ config: JSON.stringify(bad) });
		const res = await req(app, env, "/v1/instances/i1/pipelines/broken", {}, await tok("u1"));
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.valid).toBe(false);
		expect(body.error).toBeTruthy();
		expect(body.definition).toMatchObject({ steps: [] });
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
		const body = await jsonBody(res);
		expect(body.ok).toBe(true);
		expect(body.workflowId).toBe("wf-99");
		expect(body.runId).toBeTruthy();
		expect(create).toHaveBeenCalledTimes(1);
		const arg = rec(create.mock.calls[0][0]);
		expect(rec(rec(arg.params).pipeline).name).toBe("sweep");
		expect(rec(arg.params).params).toEqual({ repo: "owner/name" });
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
				first: async () => {
					// The capability join (#381) — the attach route now refuses a definition naming a
					// tool the agent does not declare, so this stub has to answer as the real one does.
					if (sql.includes("JOIN agents")) return { slug: "fixture", category: "general", config: FIXTURE_AGENT_CONFIG, instance_config: "{}" };
					return sql.includes("FROM agent_instances") ? { id: "i1", agent_id: "a1", user_id: "u1", status: "active", config: "{}" } : null;
				},
				run: async () => { if (sql.includes("UPDATE agent_instances")) written = String(args[1]); return {}; }, // ?1 is the bound JSON path (#327)
				all: async () => ({ results: [] }),
			}),
		});
		const res = await req(app, env, "/v1/instances/i1/pipelines/lead_finder", { method: "PUT", body: JSON.stringify(DEF) }, await tok("u1"));
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ ok: true, name: "lead_finder" });
		// The def landed under config.pipelines.lead_finder — where loadPipeline reads it — and its
		// own `name` was normalised to that key (#173). It said "sweep" on the way in: leaving it
		// meant the runs table recorded `lead_finder` while every workflow log line said "sweep",
		// so one run appeared under two names and neither could find the other.
		// `written` is now just the `pipelines` subtree: the route patches that ONE config key
		// via json_set instead of rewriting the whole blob, so a concurrent write to an unrelated
		// key is no longer silently discarded (#231).
		expect(JSON.parse(written).lead_finder.name).toBe("lead_finder");
	});

	it("400s a definition naming a tool the agent does not declare (#381)", async () => {
		// Before this the definition was stored happily and the refusal — if it came at all — came
		// at run time, several steps and one spend later. `validatePipeline` cannot catch it: it is
		// pure and knows only the registry, so it cannot ask WHOSE agent this is.
		const { app, env } = testApp({ agentConfig: JSON.stringify({ capabilities: { tools: ["http_request"] } }) });
		const res = await req(app, env, "/v1/instances/i1/pipelines/lead_finder", { method: "PUT", body: JSON.stringify(DEF) }, await tok("u1"));
		expect(res.status).toBe(400);
		expect((await jsonBody(res)).error).toMatch(/github_workflow_runs/);
	});

	it("400s a geocode-only definition, naming the step that needs http_request (#396)", async () => {
		// Every step here is step-library and connector-less, so this definition passed attach AND
		// kick and was refused mid-run — the outcome the pre-flight exists to prevent, reached
		// through a door it could not see. The message must name `geocode`: the author's definition
		// does not contain the word `http_request` anywhere.
		const def = { name: "sweep", steps: [{ tool: "geocode", inputs: { address: "Sydney, NSW" }, bind: "geo" }] };
		const { app, env } = testApp({ agentConfig: JSON.stringify({ capabilities: { tools: [] } }) });
		const res = await req(app, env, "/v1/instances/i1/pipelines/lead_finder", { method: "PUT", body: JSON.stringify(def) }, await tok("u1"));
		expect(res.status).toBe(400);
		expect((await jsonBody(res)).error).toMatch(/step 0 \("geocode"\) needs "http_request"/);
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
		const body = await jsonBody(res);
		expect(body.runs).toHaveLength(1);
		expect(body.runs[0].pipeline).toBe("leads");
		expect(body.runs[0].seen).toBe(3);
		expect(body.runs[0].params).toEqual({ city: "Sydney" });
	});
});

describe("supervision edges (#183)", () => {
	const tok = () => signSession({ uid: "u1", roles: ["user"] }, SECRET);

	// A supervisor's AGENT has to declare a supervision tool, or the edge it wires can never be
	// used (#354) — so the fixture for the graph rules declares one, and the tests below that are
	// about the graph keep testing the graph.
	const DELEGATES = JSON.stringify({ capabilities: { tools: ["delegate_goal", "list_subordinates"] } });

	const post = async (body: unknown, owned = true, agentConfig = DELEGATES) => {
		const { app, env } = testApp({ owned, agentConfig });
		return app.request("/v1/instances/i1/supervision", {
			method: "POST",
			headers: { Authorization: `Bearer ${await tok()}`, "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}, env);
	};

	// The half that was missing. The graph is instance-level and the ability is agent-level, and
	// the route only ever checked the graph: it answered 201, the row appeared under "Agents this
	// one supervises", and the impossibility surfaced only when a delegation was asked for and the
	// agent had no tool to do it with — which reads as the agent being broken.
	it("refuses a supervisor whose agent declares no supervision tool", async () => {
		const res = await post({ subordinateInstanceId: "i2" }, true, JSON.stringify({ capabilities: { tools: ["search_knowledge"] } }));
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toContain("cannot delegate");
	});

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
		expect((await jsonBody(res)).error).toContain("not one of this agent's tools");
	});

	it("still runs a tool the agent does declare", async () => {
		const { app, env } = testApp({ agentConfig: READ_ONLY_AGENT });
		const res = await req(app, env, "/v1/instances/i1/tools/github_workflow_runs", { method: "POST", body: JSON.stringify({ repo: "o/n" }) }, await tok("u1"));
		expect(res.status).toBe(200);
	});

	it("reports a verdict for EVERY tool, so the UI can show what is blocked and why", async () => {
		const { app, env } = testApp({ agentConfig: READ_ONLY_AGENT });
		const body = await jsonBody(await req(app, env, "/v1/instances/i1/tools", {}, await tok("u1")));
		const allowed = rows(body.tools).filter((t) => t.allowed).map((t) => t.name);
		expect(allowed).toContain("github_workflow_runs");
		expect(allowed).not.toContain("http_request");
		expect(rows(body.tools).find((t) => t.name === "http_request")?.reason).toBe("not_declared");
		// No write tool survives for a read-only agent — the assertion an auditor actually wants.
		expect(rows(body.tools).filter((t) => t.allowed && t.scope === "write")).toEqual([]);
	});

	it("?allowed=true narrows to just the runnable set", async () => {
		const { app, env } = testApp({ agentConfig: READ_ONLY_AGENT });
		const body = await jsonBody(await req(app, env, "/v1/instances/i1/tools?allowed=true", {}, await tok("u1")));
		expect(rows(body.tools).every((t) => t.allowed)).toBe(true);
	});
});

describe("PUT /v1/instances/:id/tools/:name — the owner's off-switch", () => {
	const AGENT = JSON.stringify({ capabilities: { tools: ["github_workflow_runs", "http_request"] } });

	it("persists the off-switch onto the instance config", async () => {
		let written = "";
		const { app, env } = testApp({ agentConfig: AGENT });
		fake(env.DB).prepare = (sql: string) => ({
			bind: (...args: unknown[]) => ({
				first: async () =>
					sql.includes("JOIN agents")
						? { slug: "fixture", category: "general", config: AGENT, instance_config: "{}" }
						: sql.includes("FROM agent_instances")
							? { id: "i1", agent_id: "a1", user_id: "u1", status: "active", config: "{}" }
							: null,
				run: async () => {
					if (sql.includes("json_set(") && args[0] === "$.disabledTools") written = String(args[1]);
					return { meta: { changes: 1 } };
				},
				all: async () => ({ results: [] }),
			}),
		});
		const res = await req(app, env, "/v1/instances/i1/tools/http_request", { method: "PUT", body: JSON.stringify({ enabled: false }) }, await tok("u1"));
		expect(res.status).toBe(200);
		// Targeted json_set on $.disabledTools, not a whole-blob rewrite (#231) — a whole-blob
		// write here would drop a Settings change saved from another tab between read and write.
		expect(written).toEqual(JSON.stringify(["http_request"]));
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
		expect((await jsonBody(res)).error).toContain("switched off");
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
		expect((await jsonBody(res)).error).toMatch(/read-only/i);
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

/**
 * POST /v1/instances/:id/mcp/test — the connection setup diagnostics (#266 / #265).
 *
 * The agent fixture declares the outbound MCP tools so the tool-policy gate is satisfied;
 * `writeConsents`/`mcpGrants` move the other two gates independently, which is the whole point
 * of the surface: each gate must be reportable on its own.
 */
const MCP_AGENT_CONFIG = JSON.stringify({ capabilities: { tools: ["mcp_list_tools", "mcp_call_tool"] } });
const CATALOG = { jsonrpc: "2.0", id: 1, result: { tools: [{ name: "create_site", description: "Make a site" }, { name: "delete_site" }] } };

/** Answer any MCP POST with one canned body — the era probe takes the modern path and stops. */
function mockMcpServer(body: unknown, status = 200) {
	const calls: string[] = [];
	vi.spyOn(globalThis, "fetch").mockImplementation(async (url: unknown) => {
		calls.push(String(url));
		return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
	});
	return calls;
}

describe("POST /v1/instances/:id/mcp/test (connection diagnostics)", () => {
	afterEach(() => vi.restoreAllMocks());
	beforeEach(() => resetEraCache());

	it("refuses a non-https endpoint before any network call is attempted", async () => {
		// The endpoint is user-supplied config, so this route is an authenticated "make the
		// Worker fetch this URL" button. Everything downstream also goes through safeFetch, but
		// the cheapest refusal is the one that never opens a socket.
		const calls = mockMcpServer(CATALOG);
		const { app, env } = testApp({ agentConfig: MCP_AGENT_CONFIG });
		const res = await req(app, env, "/v1/instances/i1/mcp/test", { method: "POST", body: JSON.stringify({ url: "http://internal.local/mcp" }) }, await tok("u1"));
		expect(res.status).toBe(400);
		expect(calls).toHaveLength(0);
	});

	it("echoes the NORMALIZED endpoint, so the panel shows the URL consent actually keys on", async () => {
		// A test that reported success for `https://Host/mcp/` while grants are stored under
		// `https://host/mcp` would be a subtler lie than an outright wrong verdict.
		mockMcpServer(CATALOG);
		const { app, env } = testApp({ agentConfig: MCP_AGENT_CONFIG });
		const res = await req(app, env, "/v1/instances/i1/mcp/test", { method: "POST", body: JSON.stringify({ url: "https://EXAMPLE.com/mcp/?k=secret", auth: "none" }) }, await tok("u1"));
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.endpoint).toBe("https://example.com/mcp");
		expect(JSON.stringify(body)).not.toContain("secret");
	});

	it("does NOT call a reachable server ready when consent would refuse every tool", async () => {
		// THE lie this route exists to prevent. Reachability and permission are different
		// questions, and answering only the first is what makes an agent look broken later.
		mockMcpServer(CATALOG);
		const { app, env } = testApp({ agentConfig: MCP_AGENT_CONFIG });
		const res = await req(app, env, "/v1/instances/i1/mcp/test", { method: "POST", body: JSON.stringify({ url: "https://example.com/mcp", auth: "none" }) }, await tok("u1"));
		const body = (await res.json()) as { status: string; toolCount: number; callableCount: number; detail: string; tools: Array<{ name: string; blockedBy?: string }> };
		expect(body.status).toBe("connected");
		expect(body.toolCount).toBe(2);
		expect(body.callableCount).toBe(0);
		expect(body.detail).toMatch(/may call none/i);
		expect(body.tools.find((t) => t.name === "create_site")?.blockedBy).toBe("no_write_consent");
	});

	it("reports each gate separately, so the user fixes the one that is actually blocking", async () => {
		mockMcpServer(CATALOG);
		const { app, env } = testApp({
			agentConfig: MCP_AGENT_CONFIG,
			writeConsents: ["mcp"],
			mcpGrants: [{ instance_id: "i1", user_id: "u1", endpoint: "https://example.com/mcp", tool: "*", created_at: "" }],
		});
		const res = await req(app, env, "/v1/instances/i1/mcp/test", { method: "POST", body: JSON.stringify({ url: "https://example.com/mcp", auth: "none" }) }, await tok("u1"));
		const body = (await res.json()) as { gates: unknown; callableCount: number; tools: Array<{ name: string }> };
		expect(body.gates).toEqual({ callToolEnabled: true, writeConsent: true });
		expect(body.callableCount).toBe(1);
		// The wildcard covers create_site but deliberately not delete_site — judged on the name
		// we would put on the wire, never on anything the server said about its own tools.
		expect(body.tools.find((t) => t.name === "delete_site")).toMatchObject({ destructive: true, callable: false, blockedBy: "wildcard_excludes_destructive" });
	});

	it("classifies a rejected credential as auth_required rather than unreachable", async () => {
		// 401 means the token is wrong/expired/revoked — indistinguishable on the wire, but
		// definitely not a network problem. Telling the user to check the host would be wrong.
		mockMcpServer({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "unauthorized" } }, 401);
		const { app, env } = testApp({ agentConfig: MCP_AGENT_CONFIG });
		const res = await req(app, env, "/v1/instances/i1/mcp/test", { method: "POST", body: JSON.stringify({ url: "https://example.com/mcp", auth: "none" }) }, await tok("u1"));
		const body = (await res.json()) as { status: string; toolCount: number };
		expect(body.status).toBe("auth_required");
		expect(body.toolCount).toBe(0);
	});

	it("never puts the bearer token in the report", async () => {
		// The report is rendered in a browser and may be pasted into a bug ticket. The
		// connector's own guarantee is that the credential stays on the wire; this pins it at
		// the surface a human actually copies.
		mockMcpServer(CATALOG);
		const { app, env } = testApp({ agentConfig: MCP_AGENT_CONFIG });
		const res = await req(app, env, "/v1/instances/i1/mcp/test", { method: "POST", body: JSON.stringify({ url: "https://example.com/mcp", auth: "none" }) }, await tok("u1"));
		expect(JSON.stringify(await res.json())).not.toMatch(/authorization|bearer/i);
	});

	it("404s when the caller does not own the instance", async () => {
		const calls = mockMcpServer(CATALOG);
		const { app, env } = testApp({ owned: false, agentConfig: MCP_AGENT_CONFIG });
		const res = await req(app, env, "/v1/instances/i1/mcp/test", { method: "POST", body: JSON.stringify({ url: "https://example.com/mcp" }) }, await tok("u1"));
		expect(res.status).toBe(404);
		expect(calls).toHaveLength(0);
	});

	/**
	 * The read surfaces (#263). Before this the probe asked `tools/list` and nothing else, so the
	 * report had nothing to say about resources or prompts and the Settings panel could not show
	 * their availability. The rule carried over from #266 is that availability must be reported
	 * together with REACH: the probe runs on the owner's authority, so a count on its own says
	 * nothing about what the agent will manage to do.
	 */
	describe("resources and prompts", () => {
		/** Answer per JSON-RPC method, so tools/resources/prompts can differ in one connection test. */
		function mockByMethod(byMethod: Record<string, unknown>) {
			const methods: string[] = [];
			vi.spyOn(globalThis, "fetch").mockImplementation(async (_url: unknown, init?: RequestInit) => {
				const method = String((JSON.parse(String(init?.body ?? "{}")) as { method?: string }).method ?? "");
				methods.push(method);
				const body = byMethod[method] ?? { jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Method not found" } };
				return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
			});
			return methods;
		}

		it("probes both read surfaces and reports what each server actually publishes", async () => {
			const methods = mockByMethod({
				"tools/list": CATALOG,
				"resources/list": { jsonrpc: "2.0", id: 1, result: { resources: [{ uri: "file:///a" }, { uri: "file:///b" }] } },
				// prompts/list falls through to -32601 — the ordinary answer from a server that has none.
			});
			const { app, env } = testApp({ agentConfig: JSON.stringify({ capabilities: { tools: ["mcp_list_tools", "mcp_call_tool", "mcp_list_resources", "mcp_read_resource"] } }) });
			const res = await req(app, env, "/v1/instances/i1/mcp/test", { method: "POST", body: JSON.stringify({ url: "https://example.com/mcp", auth: "none" }) }, await tok("u1"));
			const body = (await res.json()) as { resources: { state: string; count: number; detail: string }; prompts: { state: string; detail: string } };
			expect(methods).toContain("resources/list");
			expect(methods).toContain("prompts/list");
			expect(body.resources).toMatchObject({ state: "available", count: 2, listEnabled: true, readEnabled: true });
			// A server with no prompts is answering correctly, not failing. Reported as a fault, the
			// owner goes and debugs a connection that works.
			expect(body.prompts.state).toBe("unsupported");
			expect(body.prompts.detail).toMatch(/publishes no prompts/);
		});

		it("does not report resources as reachable when the agent cannot run the read tools", async () => {
			// THE #266 lie, in its second home: the probe enumerated them on the owner's authority,
			// but this agent declares neither read tool, so it will see none of it.
			mockByMethod({ "tools/list": CATALOG, "resources/list": { jsonrpc: "2.0", id: 1, result: { resources: [{ uri: "file:///a" }] } } });
			const { app, env } = testApp({ agentConfig: MCP_AGENT_CONFIG });
			const res = await req(app, env, "/v1/instances/i1/mcp/test", { method: "POST", body: JSON.stringify({ url: "https://example.com/mcp", auth: "none" }) }, await tok("u1"));
			const body = (await res.json()) as { resources: { count: number; listEnabled: boolean; readEnabled: boolean; detail: string } };
			expect(body.resources).toMatchObject({ count: 1, listEnabled: false, readEnabled: false });
			expect(body.resources.detail).toMatch(/can't run `mcp_list_resources`/);
		});

		it("says nothing about either surface when the connection itself failed", async () => {
			// An unreachable server taught us nothing about what it publishes, and a confident
			// "no resources" for a host that was briefly down is worse than silence.
			const methods = mockByMethod({});
			vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
				methods.push("tools/list");
				return new Response(JSON.stringify({ error: "nope" }), { status: 401, headers: { "Content-Type": "application/json" } });
			});
			const { app, env } = testApp({ agentConfig: MCP_AGENT_CONFIG });
			const res = await req(app, env, "/v1/instances/i1/mcp/test", { method: "POST", body: JSON.stringify({ url: "https://example.com/mcp", auth: "none" }) }, await tok("u1"));
			const body = (await res.json()) as { status: string; resources?: unknown; prompts?: unknown };
			expect(body.status).toBe("auth_required");
			expect(body.resources).toBeUndefined();
			expect(body.prompts).toBeUndefined();
		});

		it("keeps the read surfaces out of the write gates, because no write gate applies to them", async () => {
			// `gates` describes what blocks `mcp_call_tool`. Resources and prompts are read-scoped:
			// the connector write switch and the per-tool grant are simply not involved, and listing
			// them there would send an owner to flip something that changes nothing.
			mockByMethod({ "tools/list": CATALOG, "resources/list": { jsonrpc: "2.0", id: 1, result: { resources: [{ uri: "file:///a" }] } } });
			const { app, env } = testApp({ agentConfig: JSON.stringify({ capabilities: { tools: ["mcp_list_tools", "mcp_call_tool", "mcp_list_resources", "mcp_read_resource"] } }) });
			const res = await req(app, env, "/v1/instances/i1/mcp/test", { method: "POST", body: JSON.stringify({ url: "https://example.com/mcp", auth: "none" }) }, await tok("u1"));
			const body = (await res.json()) as { gates: unknown; resources: { readEnabled: boolean; detail: string } };
			expect(body.gates).toEqual({ callToolEnabled: true, writeConsent: false });
			// No write consent, no grants — and the resources are still fully reachable.
			expect(body.resources.readEnabled).toBe(true);
			expect(body.resources.detail).toMatch(/no per-item approval/);
		});
	});
});
