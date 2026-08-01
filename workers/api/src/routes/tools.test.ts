import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { signSession } from "../lib/session.js";
import { toolRoutes } from "./tools.js";

const SECRET = "test-secret";

function testApp(opts: { owned?: boolean; config?: string; create?: (arg: unknown) => Promise<{ id: string }> } = { owned: true }) {
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
							first: async () =>
								sql.includes("FROM agent_instances") && (opts.owned ?? true)
									? { id: "i1", agent_id: "a1", user_id: "u1", status: "active", config, created_at: "", updated_at: "" }
									: null,
							// logEvent (pipeline audit) does a .run() insert — must not throw.
							run: async () => ({}),
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
