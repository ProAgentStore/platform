import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { signSession } from "../lib/session.js";
import { resetEraCache } from "../lib/connectors/mcp.js";
import { toolRoutes } from "./tools.js";
import { unfenceUntrusted } from "../lib/untrusted-fence.js";
// Imported so the health expectations are COMPUTED by the shared function, never hand-written.
import { runHealth, STALLED_AFTER_MS, waitClause } from "../lib/work-report.js";

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
		/** Columns to overlay on the `agent_loop_runs` fixture row (#580's liveness/park fields). */
		loopRun?: Record<string, unknown>;
		/** Rows in instance_mcp_consent for this instance (#262). */
		mcpGrants?: Array<{ instance_id: string; user_id: string; endpoint: string; tool: string; created_at: string }>;
		/** Connectors with write consent granted (#90). */
		writeConsents?: string[];
		/**
		 * What the instance DO reports for `permissions.email` (#721) — the flag the tool listing
		 * now resolves so `find_confirmation_link` is reported as this agent's when it is on.
		 *
		 * Omit it and NO `AGENT` binding is provided at all, which is deliberately the default: that
		 * is the unreadable-state path, and every test in this file that does not care about the
		 * mailbox exercises it. `"unreadable"` is the same failure with the binding present.
		 */
		emailPermission?: boolean | "unreadable";
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
									return {
										run_id: "r1", user_id: "u1", instance_id: "i1", objective: "ship it", status: "running", stop_reason: null,
										detail: null, iteration: 2, max_iterations: 10, cancel_requested: 0, budget_id: "b1", started_at: 1, finished_at: null,
										// The 0127 columns (#580). Overridable so a test can drive the three health
										// states; absent from the default row, exactly as a pre-0127 run reads.
										...(opts.loopRun ?? {}),
									};
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
								// The loop LIST route (#580) — same fixture row the `.first()` branch above
								// returns, so the list and the detail read cannot describe different runs.
								if (sql.includes("FROM agent_loop_runs")) {
									return {
										results: opts.loopRun
											? [{ run_id: "r1", user_id: "u1", instance_id: "i1", objective: "ship it", status: "running", stop_reason: null, detail: null, iteration: 2, max_iterations: 10, cancel_requested: 0, budget_id: "b1", started_at: 1, finished_at: null, ...opts.loopRun }]
											: [],
									};
								}
								if (sql.includes("instance_mcp_consent")) return { results: opts.mcpGrants ?? [] };
								return { results: [] };
							},
						};
					},
				};
			},
		},
		// The instance DO, present only when a test says what `permissions.email` should read
		// (#721). `emailPermitted` swallows a throw into "not permitted", so its absence is the
		// fail-closed path rather than a crash.
		...(opts.emailPermission === undefined
			? {}
			: {
					AGENT: {
						idFromName: (n: string) => n,
						get: () => ({
							fetch: async () =>
								opts.emailPermission === "unreadable"
									? new Response("nope", { status: 500 })
									: new Response(JSON.stringify({ permissions: { email: opts.emailPermission === true } })),
						}),
					},
				}),
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
	it("emits each tool's jsonSchema verbatim under ?schemas=true (draft-07 object schema)", async () => {
		// `?schemas=true` since #569: the schemas were 41% of an 89 KB default response that a
		// calling host refused outright. Verbatim is still the contract when they ARE sent — see
		// tool-listing-budget.test.ts for the budget and for the rows that never carry one.
		const { app, env } = testApp();
		const res = await req(app, env, "/v1/instances/i1/tools?schemas=true", {}, await tok("u1"));
		const body = await jsonBody(res);
		const tool = rec(rows(body.tools).find((t) => t.name === "github_workflow_runs"));
		expect(rec(tool.jsonSchema).type).toBe("object");
		expect(rec(rec(rec(tool.jsonSchema).properties).repo).type).toBe("string");
		expect(rec(tool.jsonSchema).required).toContain("repo");
		// The old ad-hoc `parameters` map is gone from the wire shape.
		expect(tool.parameters).toBeUndefined();
	});

	it("omits schemas by default (#569)", async () => {
		const { app, env } = testApp();
		const res = await req(app, env, "/v1/instances/i1/tools", {}, await tok("u1"));
		const body = await jsonBody(res);
		const tool = rec(rows(body.tools).find((t) => t.name === "github_workflow_runs"));
		expect(tool.jsonSchema).toBeUndefined();
		// …and the row is still a full audit row.
		expect(tool.name).toBe("github_workflow_runs");
		expect(typeof tool.description).toBe("string");
		expect(tool.mutates).toBe(false);
	});
});

// ── The tool an OWNER PERMISSION grants (#721) ──────────────────────────────────────────────
//
// Measured live before the fix, on the one instance of 43 with `permissions.email === true`:
// `{"name":"find_confirmation_link","allowed":false,"disabled":false,"reason":"not_declared"}`.
// The chat runtime was running it on that same instance. These pin the wire shape in both flag
// states, because the wire shape is what the console reads and what an auditor calls.
describe("GET /v1/instances/:id/tools — find_confirmation_link (#721)", () => {
	const findLink = async (opts: Parameters<typeof testApp>[0]) => {
		const { app, env } = testApp(opts);
		const res = await req(app, env, "/v1/instances/i1/tools", {}, await tok("u1"));
		expect(res.status).toBe(200);
		return { status: res.status, row: rec(rows((await jsonBody(res)).tools).find((t) => t.name === "find_confirmation_link")) };
	};

	it("reports the mailbox reader as this agent's when the owner has granted the permission", async () => {
		const { row } = await findLink({ emailPermission: true });
		expect(row.allowed).toBe(true);
		expect(row.reason).toBe("ok");
		// The fixture agent declares five github/http tools and no gmail tool at all — which is the
		// point: the chat runtime offers this one on the flag alone, so the listing must too.
		expect(row.reach).toBe("internet");
	});

	it("says needs_permission — not not_declared — when the flag is off", async () => {
		const { row } = await findLink({ emailPermission: false });
		expect(row.allowed).toBe(false);
		expect(row.reason).toBe("needs_permission");
		expect(row.reason).not.toBe("not_declared");
	});

	// The regression this read introduces if it is written carelessly: a DO state read now sits in
	// the /tools path, and this panel is the worst place for a failure to be loud OR to be
	// permissive. It must degrade to "not permitted" and still serve the listing.
	it("degrades to not-permitted on an unreadable DO state, and still returns the listing", async () => {
		const { status, row } = await findLink({ emailPermission: "unreadable" });
		expect(status).toBe(200);
		expect(row.allowed).toBe(false);
		expect(row.reason).toBe("needs_permission");
	});

	// `allowed:true` un-gates the generic invoker for a REGISTRY tool. This one is a BUILT-IN, so
	// `getRegistryTool` misses it and the route answers before the policy is ever consulted — the
	// reach does not widen with the grant. Asserted rather than assumed, because "allowed now means
	// callable from anywhere" is exactly the side effect a reader would accept without checking.
	it("stays chat-only over REST even when granted — invocableBy is not widened by a permission", async () => {
		const { app, env } = testApp({ emailPermission: true });
		const res = await req(app, env, "/v1/instances/i1/tools/find_confirmation_link", { method: "POST", body: "{}" }, await tok("u1"));
		expect(res.status).toBe(404);
		expect(String((await jsonBody(res)).error)).toContain("runs in the agent's own chat loop and nowhere else");

		const listed = await req(app, env, "/v1/instances/i1/tools", {}, await tok("u1"));
		const row = rec(rows((await jsonBody(listed)).tools).find((t) => t.name === "find_confirmation_link"));
		expect(row.invocableBy).toEqual(["chat"]);
	});

	// The owner's off-switch is a real switch once the row is theirs, and refuses to become a
	// parking space for a tool they have not granted.
	it("PUT switches it off when granted, and 403s toward the permission when not", async () => {
		const on = testApp({ emailPermission: true });
		const okRes = await req(on.app, on.env, "/v1/instances/i1/tools/find_confirmation_link", { method: "PUT", body: JSON.stringify({ enabled: false }) }, await tok("u1"));
		expect(okRes.status).toBe(200);

		const off = testApp({ emailPermission: false });
		const denied = await req(off.app, off.env, "/v1/instances/i1/tools/find_confirmation_link", { method: "PUT", body: JSON.stringify({ enabled: false }) }, await tok("u1"));
		expect(denied.status).toBe(403);
		expect(String((await jsonBody(denied)).error)).toContain("Permissions & Connections");
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

	// Until #711 Gmail reported `permission` here, because it had no tools to judge. It has three
	// now, so a terminal operator that declares none of them reports no Gmail reach — the same
	// verdict any other tool-bearing connector would get.
	it("judges Gmail on its declared tools (#711)", async () => {
		const { app, env } = testApp({ agentConfig: TERMINAL_OPERATOR });
		const body = await jsonBody(await req(app, env, "/v1/instances/i1/connectors", {}, await tok("u1")));
		expect(verdict(body, "gmail")).toMatchObject({ allowed: false, reason: "no_tools" });
	});

	// #720. The console's consent checkbox reads its label AND its sentence from here, so both have
	// to be on the wire. A connector that cannot be write-granted sends no sentence — a meaning that
	// renders nowhere is one that rots unread.
	it("carries each connector's label and what granting its write scope permits (#720)", async () => {
		const { app, env } = testApp({ agentConfig: TERMINAL_OPERATOR });
		const body = await jsonBody(await req(app, env, "/v1/instances/i1/connectors", {}, await tok("u1")));
		expect(verdict(body, "github").label).toBe("GitHub");
		expect(String(verdict(body, "github").writeMeaning)).toMatch(/^Open issues/);
		// The load-bearing one: the only checkbox that grants no reach by itself (#262).
		expect(String(verdict(body, "mcp").writeMeaning)).toMatch(/kill switch, not a permission/);
		// Read-only connector → nothing to say.
		expect(verdict(body, "repo-local").writeMeaning).toBeUndefined();
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
	/**
	 * Draft-07's LIST form of `type`, which every `set_behaviour` field uses (#608).
	 *
	 * `matchesType` switched on `type` as a string, so an array fell through to `default: return
	 * true` and the property was accepted whatever was passed. `JsonSchema` declared `type` as a
	 * bare `string`, so no compiler could say so — the validator was inert for exactly the tool a
	 * model is most likely to call with free text it invented, and it looked like it was working.
	 */
	it("400s a wrongly-typed field whose schema declares the draft-07 type LIST", async () => {
		const { app, env } = testApp({
			owned: true,
			agentConfig: JSON.stringify({ capabilities: { tools: ["set_behaviour"] } }),
		});
		// behaviourToolSchema emits `type: ["number","null"]` for technicality, so null can reset it.
		const res = await req(
			app,
			env,
			"/v1/instances/i1/tools/set_behaviour",
			{ method: "POST", body: JSON.stringify({ technicality: "banana" }) },
			await tok("u1"),
		);
		expect(res.status).toBe(400);
		const body = await jsonBody(res);
		expect(body.error).toMatch(/"technicality" must be a number or null/i);
	});

	it("still accepts the null member of that list, so a setting can be reset", async () => {
		const { app, env } = testApp({
			owned: true,
			agentConfig: JSON.stringify({ capabilities: { tools: ["set_behaviour"] } }),
		});
		const res = await req(
			app,
			env,
			"/v1/instances/i1/tools/set_behaviour",
			{ method: "POST", body: JSON.stringify({ technicality: null }) },
			await tok("u1"),
		);
		// Whatever the handler then does, the VALIDATOR must not be what refused it.
		expect(res.status).not.toBe(400);
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
		expect(JSON.parse(unfenceUntrusted(String(body.content))).data).toEqual([{ id: "p1", name: "Cafe" }]);
		fetchSpy.mockRestore();
	});
});

describe("GET /v1/instances/:id/pipelines (issue #97)", () => {
	it("lists pipelines declared in the instance config", async () => {
		const { app, env } = testApp({ config: JSON.stringify(STORED_PIPELINE) });
		const res = await req(app, env, "/v1/instances/i1/pipelines", {}, await tok("u1"));
		expect(res.status).toBe(200);
		const body = await jsonBody(res);
		expect(rows(body.pipelines)).toHaveLength(1);
		expect(rows(body.pipelines)[0]).toMatchObject({ name: "sweep", steps: 1, sink: "results", valid: true });
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
		const create = vi.fn(async (_arg: unknown) => ({ id: "wf-99" }));
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
		expect(rec(arg.params).trigger).toBe("api");
		expect(rec(arg.params).userId).toBe("u1");
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
		expect(rows(body.runs)).toHaveLength(1);
		expect(rows(body.runs)[0].pipeline).toBe("leads");
		expect(rows(body.runs)[0].seen).toBe(3);
		expect(rows(body.runs)[0].params).toEqual({ city: "Sydney" });
	});
});

describe("supervision edges (#183)", () => {
	const tok = () => signSession("u1", SECRET, { roles: ["user"] });

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
	const tok = () => signSession("u1", SECRET, { roles: ["user"] });

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
		// No write that leaves the PLATFORM survives for a read-only agent — the assertion an
		// auditor actually wants, and the one this line used to make without the qualifier.
		expect(rows(body.tools).filter((t) => t.allowed && t.scope === "write" && t.connector)).toEqual([]);
	});

	// #525. The assertion above used to read `t.allowed && t.scope === "write"` with no connector
	// clause, and it passed — because the listing enumerated the registry only. The same instance
	// wrote to its own memory while `list_instance_tools` was telling an operator that a tool absent
	// from the allowed set cannot be invoked "by chat or by call_instance_tool". The built-in rows
	// are what make that sentence true, so a read-only agent now honestly reports the writes it has.
	it("lists the built-in tools every agent runs, and says which surface can reach them", async () => {
		const { app, env } = testApp({ agentConfig: READ_ONLY_AGENT });
		const body = await jsonBody(await req(app, env, "/v1/instances/i1/tools", {}, await tok("u1")));
		const byName = new Map(rows(body.tools).map((t) => [t.name as string, t]));
		for (const name of ["read_memory", "write_memory", "delete_memory", "get_tasks", "create_task", "update_task", "fetch_url", "get_activity", "get_user_context", "set_user_preference", "configure_board"]) {
			expect(byName.get(name), `${name} absent from the listing`).toBeDefined();
			expect(byName.get(name)?.allowed, `${name} runs in chat but reads as not runnable`).toBe(true);
		}
		expect(byName.get("write_memory")?.scope).toBe("write");
		// `invocableBy` is the distinction the old sentence flattened: chat runs it, this route can't.
		expect(byName.get("write_memory")?.invocableBy).toEqual(["chat"]);
		expect(byName.get("write_memory")?.tier).toBe("base");
		expect(byName.get("github_workflow_runs")?.invocableBy).toEqual(["chat", "call_instance_tool"]);
	});

	it("refuses a built-in tool on the invoker, and says it is a surface limit rather than an unknown name", async () => {
		const { app, env } = testApp({ agentConfig: READ_ONLY_AGENT });
		const res = await req(app, env, "/v1/instances/i1/tools/write_memory", { method: "POST", body: JSON.stringify({ key: "k", type: "knowledge", content: "c" }) }, await tok("u1"));
		expect(res.status).toBe(404);
		const err = String((await jsonBody(res)).error);
		expect(err).toContain("built-in");
		expect(err).not.toContain("Unknown tool");
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

	// #525: the switch used to gate on `getRegistryTool`, so the owner's veto — the one control a
	// creator's declaration must not outrank — could not reach the tools every agent has. The chat
	// runtime has always honoured `config.disabledTools` for them; only the route that sets it did not.
	it("switches off a built-in tool the agent never declared but always runs", async () => {
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
		const res = await req(app, env, "/v1/instances/i1/tools/write_memory", { method: "PUT", body: JSON.stringify({ enabled: false }) }, await tok("u1"));
		expect(res.status).toBe(200);
		expect(written).toEqual(JSON.stringify(["write_memory"]));
	});

	it("still 404s a name no listing contains", async () => {
		const { app, env } = testApp({ agentConfig: AGENT });
		const res = await req(app, env, "/v1/instances/i1/tools/not_a_tool", { method: "PUT", body: JSON.stringify({ enabled: false }) }, await tok("u1"));
		expect(res.status).toBe(404);
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

/**
 * The run record ships the platform's OWN verdict, not just the counters (#580 AC3).
 *
 * `fd1c323` split liveness, progress and a park into three fields. This is the half that gets the
 * READING of them off the agent-facing work report and onto the surface an MCP client calls: a
 * client used to receive `status:"running"`, two timestamps and an iteration counter, and had to
 * decide for itself whether that was alright.
 *
 * That derivation is the defect. `work-report.ts:136-141` records a model reading "step 3/50 after
 * 9 minutes" as a stall and telling the owner there was "nothing I can do", while the engine was
 * mid-edit — and the intervention that invites destroys work that was progressing normally.
 *
 * Every expectation below is computed by calling the SHARED `runHealth`/`waitClause`, never by
 * writing the expected string out by hand. That is the assertion: the route quotes the platform's
 * verdict rather than growing a second one that can drift from it.
 */
describe("a loop run carries its health verdict (#580)", () => {
	const tok = () => signSession("u1", SECRET, { roles: ["user"] });
	const NOW = 1_800_000_000_000;

	// The route calls `Date.now()` and so does the expectation, so the clock is frozen: otherwise
	// `waitClause`'s "expected to resume in …" is computed against two different instants and the
	// equality below would be testing the scheduler rather than the route.
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	/** The shape `runHealth`/`waitClause` read, matching what `getLoopRun` maps a row into. */
	const view = (over: Record<string, unknown>) =>
		fake({ status: "running", startedAt: NOW, lastProgressAt: null, lastAliveAt: null, waitingUntil: null, waitingReason: null, ...over });

	async function readRun(loopRun: Record<string, unknown>) {
		const { app, env } = testApp({ loopRun });
		const res = await app.request("/v1/instances/i1/loop/r1", { headers: { Authorization: `Bearer ${await tok()}` } }, env);
		expect(res.status).toBe(200);
		return jsonBody(res);
	}

	it("reports `working` for a run whose orchestrator is ticking", async () => {
		const body = await readRun({ started_at: NOW - 60_000, last_alive_at: NOW - 30_000, last_progress_at: NOW - 30_000 });
		// G1 — the fixture reached the route intact, or the verdict below describes a row that is
		// not the one under test.
		expect(body.runId).toBe("r1");
		expect(body.lastAliveAt).toBe(NOW - 30_000);
		expect(body.health).toBe(runHealth(view({ startedAt: NOW - 60_000, lastAliveAt: NOW - 30_000, lastProgressAt: NOW - 30_000 }), NOW));
		expect(body.health).toBe("working");
		expect(body.waitNote).toBeNull();
	});

	it("reports `working`, NOT stalled, when the heartbeat is fresh and progress is old", async () => {
		// The inference this surface must never make. A fresh heartbeat beside a stale advance is
		// equally a long engine turn, a park, and a genuine stall — reading it as the third is what
		// told an owner a mid-edit run was stuck. Progress is a fact here; it is not a diagnosis.
		const row = { started_at: NOW - 3_600_000, last_alive_at: NOW - 20_000, last_progress_at: NOW - 3_000_000 };
		const body = await readRun(row);
		expect(body.lastProgressAt).toBe(NOW - 3_000_000); // reported, plainly
		expect(body.health).toBe("working");
	});

	it("reports `waiting` with the reason for a deliberately parked run", async () => {
		const row = { started_at: NOW - 3_600_000, last_alive_at: NOW - 3_600_000, waiting_reason: "engine_limit", waiting_until: NOW + 600_000 };
		const body = await readRun(row);
		const expected = view({ startedAt: NOW - 3_600_000, lastAliveAt: NOW - 3_600_000, waitingReason: "engine_limit", waitingUntil: NOW + 600_000 });
		// A park OUTRANKS the heartbeat test: this run has not ticked for an hour and that is
		// correct, so "stalled" would be as wrong as a bare "running".
		expect(body.health).toBe(runHealth(expected, NOW));
		expect(body.health).toBe("waiting");
		expect(body.waitNote).toBe(waitClause(expected, NOW));
		expect(String(body.waitNote)).toContain("WAITING, not stalled and not working");
	});

	it("reports `stalled` when nothing has ticked at all", async () => {
		const row = { started_at: NOW - 3_600_000, last_alive_at: NOW - STALLED_AFTER_MS - 60_000 };
		const body = await readRun(row);
		expect(body.health).toBe(runHealth(view({ startedAt: NOW - 3_600_000, lastAliveAt: NOW - STALLED_AFTER_MS - 60_000 }), NOW));
		expect(body.health).toBe("stalled");
		expect(body.waitNote).toBeNull();
	});

	it("carries the verdict on the LIST route too, so the two cannot disagree", async () => {
		// #580's original AC3 is that two surfaces must not disagree about one run. A verdict on
		// the detail route alone would leave the list — which is what a caller with no run id
		// reads — still shipping bare counters.
		const { app, env } = testApp({ loopRun: { started_at: NOW - 3_600_000, last_alive_at: NOW - 3_600_000, waiting_reason: "human" } });
		const res = await app.request("/v1/instances/i1/loop", { headers: { Authorization: `Bearer ${await tok()}` } }, env);
		const listed = rows((await jsonBody(res)).runs);
		expect(listed.length).toBeGreaterThan(0);
		for (const run of listed) expect(run).toHaveProperty("health");
	});
});
