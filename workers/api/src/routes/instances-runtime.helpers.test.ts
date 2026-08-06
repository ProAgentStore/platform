import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { HttpError } from "../lib/auth.js";
import { signSession } from "../lib/session.js";
import { defaultPipelinesFor, instanceRoutes } from "./instances.js";
import {
	getRuntime,
	getRuntimeNode,
	getRuntimeForNode,
	listRuntimeNodes,
	requireOwnedInstance,
	updateRuntimeStatus,
	runtimeResponse,
	runtimeNodeResponse,
	validateRuntimeEndpointUrl,
	safeCapabilities,
	safeParseArray,
	type RuntimeRow,
} from "./instances-runtime.js";
import type { Env } from "../types.js";

interface Write { sql: string; args: unknown[] }

function mockRow(overrides: Partial<RuntimeRow> = {}): RuntimeRow {
	return {
		instance_id: "inst-1",
		user_id: "u1",
		placement: "local",
		endpoint_url: "https://runner.example.com",
		token_ciphertext: null,
		token_dek_wrapped: null,
		token_iv: null,
		token_plaintext: "tok",
		capabilities: '["coding"]',
		runner_version: "0.3.3",
		runner_node: "",
		status: "registered",
		last_seen_at: null,
		created_at: "2026-08-01",
		updated_at: "2026-08-02",
		...overrides,
	};
}

/** D1 stub whose SELECTs are resolved by the test against the query text. */
function mockEnv(opts: {
	first?: (sql: string, args: unknown[]) => unknown;
	all?: (sql: string, args: unknown[]) => { results: unknown[] };
} = {}): { env: Env; writes: Write[] } {
	const writes: Write[] = [];
	const DB = {
		prepare(sql: string) {
			return {
				bind(...args: unknown[]) {
					return {
						async first() { return opts.first ? opts.first(sql, args) : null; },
						async all() { return opts.all ? opts.all(sql, args) : { results: [] }; },
						async run() { writes.push({ sql, args }); return { meta: { changes: 1 } }; },
					};
				},
			};
		},
	};
	return { env: { DB } as unknown as Env, writes };
}

// ————————————————————————————————————————————————————————————————
// Pure serializers + validators
// ————————————————————————————————————————————————————————————————

describe("validateRuntimeEndpointUrl", () => {
	it("accepts https and strips trailing slash + query + hash", () => {
		expect(validateRuntimeEndpointUrl("https://runner.example.com/path/?q=1#h")).toBe("https://runner.example.com/path");
	});

	it("allows http ONLY for localhost (dev), rejecting http elsewhere", () => {
		expect(validateRuntimeEndpointUrl("http://localhost:8787")).toBe("http://localhost:8787");
		expect(() => validateRuntimeEndpointUrl("http://runner.example.com")).toThrow(HttpError);
	});

	it("rejects a non-URL with a 400 HttpError", () => {
		try {
			validateRuntimeEndpointUrl("not a url");
			throw new Error("should have thrown");
		} catch (e) {
			expect(e).toBeInstanceOf(HttpError);
			expect((e as HttpError).status).toBe(400);
		}
	});
});

describe("safeCapabilities / safeParseArray", () => {
	it("keeps only strings and caps the list at 50", () => {
		const raw = [...Array(60).keys()].map(String).concat([1 as unknown as string, { x: 1 } as unknown as string]);
		const out = safeCapabilities(raw);
		expect(out).toHaveLength(50);
		expect(out.every((s) => typeof s === "string")).toBe(true);
	});

	it("returns [] for non-array input", () => {
		expect(safeCapabilities("nope")).toEqual([]);
		expect(safeCapabilities(undefined)).toEqual([]);
	});

	it("safeParseArray parses a JSON array and falls back to [] on garbage", () => {
		expect(safeParseArray('["a","b"]')).toEqual(["a", "b"]);
		expect(safeParseArray("{not json")).toEqual([]);
		expect(safeParseArray('{"a":1}')).toEqual([]); // object → not an array
	});
});

describe("runtimeResponse / runtimeNodeResponse", () => {
	it("exposes hasToken=true without ever leaking the token, and maps snake→camel", () => {
		const res = runtimeResponse(mockRow({ token_plaintext: "secret-token" }));
		expect(res.hasToken).toBe(true);
		expect(res.endpointUrl).toBe("https://runner.example.com");
		expect(res.capabilities).toEqual(["coding"]);
		expect(res.runnerVersion).toBe("0.3.3");
		// The plaintext token is NOT part of the serialized shape.
		expect(JSON.stringify(res)).not.toContain("secret-token");
	});

	it("hasToken=false when neither plaintext nor ciphertext is present", () => {
		const res = runtimeResponse(mockRow({ token_plaintext: null, token_ciphertext: null }));
		expect(res.hasToken).toBe(false);
	});

	it("runtimeNodeResponse adds the per-node relay name", () => {
		const res = runtimeNodeResponse(mockRow({ runner_node: "laptop-A" }));
		expect(res.relayName).toBe("inst-1:node:laptop-A");
		expect(res.runnerNode).toBe("laptop-A");
	});
});

// ————————————————————————————————————————————————————————————————
// D1 read helpers
// ————————————————————————————————————————————————————————————————

describe("requireOwnedInstance", () => {
	it("returns the row when the caller owns the instance", async () => {
		const row = { id: "inst-1", agent_id: "a1", user_id: "u1", status: "active", config: "{}", created_at: "", updated_at: "" };
		const { env } = mockEnv({ first: (sql, args) => (sql.includes("agent_instances") && args[0] === "inst-1" && args[1] === "u1") ? row : null });
		const got = await requireOwnedInstance(env, "inst-1", "u1");
		expect(got.id).toBe("inst-1");
		expect(got.user_id).toBe("u1");
	});

	it("throws 404 when the instance is not owned by the caller", async () => {
		const { env } = mockEnv({ first: () => null });
		await expect(requireOwnedInstance(env, "inst-1", "u2")).rejects.toMatchObject({ status: 404 });
	});
});

describe("getRuntime / getRuntimeNode / getRuntimeForNode / listRuntimeNodes", () => {
	it("getRuntime reads the default row scoped to (instance,user)", async () => {
		let seen: unknown[] = [];
		const { env } = mockEnv({ first: (sql, args) => { if (sql.includes("instance_runtimes")) { seen = args; return mockRow(); } return null; } });
		const row = await getRuntime(env, "inst-1", "u1");
		expect(row?.instance_id).toBe("inst-1");
		expect(seen).toEqual(["inst-1", "u1"]);
	});

	it("getRuntimeNode normalizes the node and scopes by it; empty node → null (no query)", async () => {
		let seen: unknown[] = [];
		const { env } = mockEnv({ first: (sql, args) => { if (sql.includes("instance_runtime_nodes")) { seen = args; return mockRow({ runner_node: "laptop-A" }); } return null; } });
		const row = await getRuntimeNode(env, "inst-1", "u1", "  laptop-A  ");
		expect(row?.runner_node).toBe("laptop-A");
		expect(seen).toEqual(["inst-1", "u1", "laptop-A"]); // trimmed by normalizeRunnerNode
		// Blank node short-circuits to null without hitting the DB.
		expect(await getRuntimeNode(env, "inst-1", "u1", "   ")).toBeNull();
	});

	it("getRuntimeForNode routes to the per-node row when a node is given, else the default", async () => {
		const { env } = mockEnv({
			first: (sql) => sql.includes("instance_runtime_nodes")
				? mockRow({ runner_node: "laptop-A" })
				: sql.includes("instance_runtimes") ? mockRow({ runner_node: "" }) : null,
		});
		expect((await getRuntimeForNode(env, "inst-1", "u1", "laptop-A"))?.runner_node).toBe("laptop-A");
		expect((await getRuntimeForNode(env, "inst-1", "u1", ""))?.runner_node).toBe(""); // fell through to default
	});

	it("listRuntimeNodes returns every registered machine for the instance (owner-scoped)", async () => {
		const rows = [mockRow({ runner_node: "laptop-A" }), mockRow({ runner_node: "desktop-B" })];
		let seen: unknown[] = [];
		const { env } = mockEnv({ all: (sql, args) => { if (sql.includes("instance_runtime_nodes")) { seen = args; return { results: rows }; } return { results: [] }; } });
		const got = await listRuntimeNodes(env, "inst-1", "u1");
		expect(got.map((r) => r.runner_node)).toEqual(["laptop-A", "desktop-B"]);
		expect(seen).toEqual(["inst-1", "u1"]);
	});
});

describe("updateRuntimeStatus", () => {
	it("updates BOTH the per-node row and the default row when a node is supplied", async () => {
		const { env, writes } = mockEnv();
		await updateRuntimeStatus(env, "inst-1", "u1", "online", "laptop-A");
		expect(writes).toHaveLength(2);
		expect(writes[0].sql).toContain("UPDATE instance_runtime_nodes");
		expect(writes[0].args).toEqual(["online", "inst-1", "u1", "laptop-A"]);
		expect(writes[1].sql).toContain("UPDATE instance_runtimes");
		expect(writes[1].args).toEqual(["online", "inst-1", "u1"]);
	});

	it("updates ONLY the default row when no node is supplied", async () => {
		const { env, writes } = mockEnv();
		await updateRuntimeStatus(env, "inst-1", "u1", "online");
		expect(writes).toHaveLength(1);
		expect(writes[0].sql).toContain("UPDATE instance_runtimes");
	});
});

// ————————————————————————————————————————————————————————————————
// INTEGRATION: the register / list / status / pin routes through the Hono app.
// Auth (verifySession) → ownership gate → the real route body → JSON. Only the
// D1 + RELAY boundaries are mocked. Paywall stays unenforced (PAYWALL_ENFORCE unset)
// so requirePro is a no-op — the register route must NOT 402 in soft-launch.
// ————————————————————————————————————————————————————————————————

const SECRET = "runtime-integration-secret";
// A valid 32-byte (AES-256) KEK, hex-encoded, so encodeRuntimeToken's crypto path works.
const KEK = "0".repeat(64);

function relayStub(connected: boolean) {
	return {
		idFromName: (name: string) => ({ name }),
		get: () => ({
			async fetch() { return Response.json({ connected }); },
		}),
	};
}

function buildApp(opts: {
	owns?: Array<[string, string]>;
	nodes?: unknown[];
	instanceConfig?: string;
	relayConnected?: boolean;
	noRuntime?: boolean;
	mirroredTask?: unknown;
	/** Records PIPELINE_RUN.create calls so ticket-approval tests can assert the dispatch. */
	pipelineRuns?: Array<Record<string, unknown>>;
} = {}) {
	const writes: Write[] = [];
	const owns = new Set((opts.owns ?? []).map(([i, u]) => `${i}::${u}`));
	const DB = {
		prepare(sql: string) {
			return {
				bind(...args: unknown[]) {
					return {
						async first() {
							if (sql.includes("FROM agent_instances")) {
								const [id, uid] = args as [string, string];
								if (sql.includes("SELECT config")) {
									if (!owns.has(`${id}::${uid}`)) return null;
									return { config: opts.instanceConfig ?? "{}" };
								}
								if (!owns.has(`${id}::${uid}`)) return null;
								return { id, agent_id: "a1", user_id: uid, status: "active", config: opts.instanceConfig ?? "{}", created_at: "", updated_at: "" };
							}
							if (sql.includes("FROM instance_runtimes")) {
								if (opts.noRuntime) return null; // runner-less agent (pipeline/config)
								const [id, uid] = args as [string, string];
								if (!owns.has(`${id}::${uid}`)) return null;
								return mockRow({ instance_id: id, user_id: uid });
							}
							if (sql.includes("FROM instance_runtime_tasks")) {
								return opts.mirroredTask ? { payload: JSON.stringify(opts.mirroredTask) } : null;
							}
							return null;
						},
						async all() {
							if (sql.includes("instance_runtime_nodes")) return { results: opts.nodes ?? [] };
							return { results: [] };
						},
						async run() { writes.push({ sql, args }); return { meta: { changes: 1 } }; },
					};
				},
			};
		},
	};
	const env = {
		SESSION_SIGNING_KEY: SECRET,
		KEY_ENCRYPTION_KEY: KEK,
		RELAY: relayStub(opts.relayConnected ?? false),
		PIPELINE_RUN: {
			async create(args: { params: Record<string, unknown> }) {
				opts.pipelineRuns?.push(args.params);
				return { id: "wf-1" };
			},
		},
		// executeTriggerAction resolves the instance DO up front (create_task/add_knowledge
		// dispatch into it), so the binding must exist even for a run_pipeline ticket.
		AGENT: {
			idFromName: (n: string) => n,
			get: () => ({ async fetch() { return new Response("{}", { status: 200 }); } }),
		},
		DB,
	} as unknown as Env;

	const app = new Hono<{ Bindings: Env }>();
	app.route("/v1/instances", instanceRoutes);
	app.onError((err, c) => {
		if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
		return c.json({ error: (err as Error).message }, 500);
	});
	return { app, env, writes };
}

const tokenFor = (uid: string) => signSession(uid, SECRET, { roles: ["user"] });

async function post(app: Hono, env: unknown, path: string, body: unknown, tok: string) {
	return app.request(path, { method: "POST", headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }, env);
}
async function put(app: Hono, env: unknown, path: string, body: unknown, tok: string) {
	return app.request(path, { method: "PUT", headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }, env);
}
async function get(app: Hono, env: unknown, path: string, tok?: string) {
	return app.request(path, { headers: tok ? { Authorization: `Bearer ${tok}` } : {} }, env);
}

describe("POST /v1/instances/:id/runtime (integration — register a node)", () => {
	it("401s without a bearer token (auth boundary)", async () => {
		const { app, env } = buildApp({ owns: [["inst-1", "u1"]] });
		const res = await post(app, env, "/v1/instances/inst-1/runtime", { endpointUrl: "https://runner.example.com" }, "");
		expect(res.status).toBe(401);
	});

	it("404s when the caller does not own the instance (ownership boundary, no writes)", async () => {
		const { app, env, writes } = buildApp({ owns: [] });
		const res = await post(app, env, "/v1/instances/inst-1/runtime", { endpointUrl: "https://runner.example.com", runnerNode: "laptop-A" }, await tokenFor("u1"));
		expect(res.status).toBe(404);
		expect(writes.some((w) => w.sql.includes("INSERT INTO instance_runtime"))).toBe(false);
	});

	it("registers a node and returns 201 (NO one-machine 409) with the node listed", async () => {
		const nodeRows = [mockRow({ runner_node: "laptop-A", instance_id: "inst-1", user_id: "u1" })];
		const { app, env, writes } = buildApp({ owns: [["inst-1", "u1"]], nodes: nodeRows });
		const res = await post(app, env, "/v1/instances/inst-1/runtime", {
			endpointUrl: "https://runner.example.com",
			runnerNode: "laptop-A",
			capabilities: ["coding", "browser"],
			runnerVersion: "0.3.3",
		}, await tokenFor("u1"));
		expect(res.status).toBe(201);
		const body = await res.json() as { runtime: { endpointUrl: string }; nodes: Array<{ runnerNode: string; relayName: string }> };
		expect(body.runtime.endpointUrl).toBe("https://runner.example.com");
		expect(body.nodes.map((n) => n.runnerNode)).toContain("laptop-A");
		expect(body.nodes[0].relayName).toBe("inst-1:node:laptop-A");
		// Both the per-node row and the legacy default row were upserted.
		expect(writes.some((w) => w.sql.includes("INSERT INTO instance_runtime_nodes"))).toBe(true);
		expect(writes.some((w) => w.sql.includes("INSERT INTO instance_runtimes"))).toBe(true);
	});

	it("a SECOND machine registering the same instance also gets 201 (machines coexist)", async () => {
		const { app, env } = buildApp({ owns: [["inst-1", "u1"]], nodes: [mockRow({ runner_node: "laptop-A" }), mockRow({ runner_node: "desktop-B" })] });
		const res = await post(app, env, "/v1/instances/inst-1/runtime", { endpointUrl: "https://runner2.example.com", runnerNode: "desktop-B" }, await tokenFor("u1"));
		expect(res.status).toBe(201);
		const body = await res.json() as { nodes: Array<{ runnerNode: string }> };
		expect(body.nodes.map((n) => n.runnerNode).sort()).toEqual(["desktop-B", "laptop-A"]);
	});

	it("400s on a non-https endpoint URL (validation before any write)", async () => {
		const { app, env, writes } = buildApp({ owns: [["inst-1", "u1"]] });
		const res = await post(app, env, "/v1/instances/inst-1/runtime", { endpointUrl: "http://runner.example.com" }, await tokenFor("u1"));
		expect(res.status).toBe(400);
		expect(writes.some((w) => w.sql.includes("INSERT INTO instance_runtime"))).toBe(false);
	});
});

describe("GET /v1/instances/:id/runtime (integration)", () => {
	it("returns the runtime + nodes for the owner", async () => {
		const { app, env } = buildApp({ owns: [["inst-1", "u1"]], nodes: [mockRow({ runner_node: "laptop-A" })] });
		const res = await get(app, env, "/v1/instances/inst-1/runtime", await tokenFor("u1"));
		expect(res.status).toBe(200);
		const body = await res.json() as { runtime: { hasToken: boolean } | null; nodes: unknown[] };
		expect(body.runtime).toBeTruthy();
		expect(body.runtime!.hasToken).toBe(true);
		expect(body.nodes).toHaveLength(1);
	});

	it("404s for a non-owner", async () => {
		const { app, env } = buildApp({ owns: [] });
		const res = await get(app, env, "/v1/instances/inst-1/runtime", await tokenFor("u2"));
		expect(res.status).toBe(404);
	});
});

describe("PUT/GET /v1/instances/:id/runner-node (integration — the 'runs on' pin)", () => {
	it("pins the instance to a node and persists runnerNode into the config", async () => {
		const { app, env, writes } = buildApp({ owns: [["inst-1", "u1"]] });
		const res = await put(app, env, "/v1/instances/inst-1/runner-node", { runnerNode: "laptop-A" }, await tokenFor("u1"));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ runnerNode: "laptop-A" });
		// Targeted json_set on $.runnerNode (#231): pinning a runner must not clobber a
		// settings or behaviour change saved from another tab between read and write.
		const update = writes.find((w) => w.sql.includes("json_set(") && w.sql.includes("'$.runnerNode'"));
		expect(update).toBeTruthy();
		expect(JSON.parse(update!.args[0] as string)).toBe("laptop-A");
	});

	it("clearing the pin (empty value) deletes runnerNode but keeps sibling config", async () => {
		const { app, env, writes } = buildApp({ owns: [["inst-1", "u1"]], instanceConfig: JSON.stringify({ runnerNode: "laptop-A", keepMe: 7 }) });
		const res = await put(app, env, "/v1/instances/inst-1/runner-node", { runnerNode: "" }, await tokenFor("u1"));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ runnerNode: null });
		// json_remove on just $.runnerNode. Siblings are now preserved BY CONSTRUCTION (#231) —
		// the UPDATE cannot touch another key — so the assertion is on the statement, not on a
		// merged blob the route no longer builds.
		const update = writes.find((w) => w.sql.includes("json_remove(") && w.sql.includes("'$.runnerNode'"));
		expect(update).toBeTruthy();
		expect(writes.some((w) => /SET config = \?1/.test(w.sql))).toBe(false);
	});

	it("GET reports the current pin and the available nodes to pin to", async () => {
		const { app, env } = buildApp({
			owns: [["inst-1", "u1"]],
			instanceConfig: JSON.stringify({ runnerNode: "laptop-A" }),
			nodes: [mockRow({ runner_node: "laptop-A", instance_id: "inst-1", user_id: "u1" })],
			relayConnected: true,
		});
		const res = await get(app, env, "/v1/instances/inst-1/runner-node", await tokenFor("u1"));
		expect(res.status).toBe(200);
		const body = await res.json() as { runnerNode: string | null; nodes: string[]; nodesDetail: Array<{ node: string; connected: boolean }> };
		expect(body.runnerNode).toBe("laptop-A");
		expect(body.nodes).toContain("laptop-A");
		expect(body.nodesDetail.find((n) => n.node === "laptop-A")?.connected).toBe(true);
	});

	it("404s when a non-owner tries to pin", async () => {
		const { app, env, writes } = buildApp({ owns: [] });
		const res = await put(app, env, "/v1/instances/inst-1/runner-node", { runnerNode: "laptop-A" }, await tokenFor("u2"));
		expect(res.status).toBe(404);
		expect(writes.some((w) => w.sql.includes("UPDATE agent_instances"))).toBe(false);
	});
});

describe("POST /v1/instances/:id/tasks/direct (runner-less board ticket, #150 P3)", () => {
	it("401s without a bearer token", async () => {
		const { app, env } = buildApp({ owns: [["inst-1", "u1"]] });
		expect((await post(app, env, "/v1/instances/inst-1/tasks/direct", { title: "x" }, "")).status).toBe(401);
	});

	it("404s + no write when the caller doesn't own the instance", async () => {
		const { app, env, writes } = buildApp({ owns: [] });
		const res = await post(app, env, "/v1/instances/inst-1/tasks/direct", { title: "x" }, await tokenFor("u1"));
		expect(res.status).toBe(404);
		expect(writes.some((w) => w.sql.includes("INSERT INTO instance_runtime_tasks"))).toBe(false);
	});

	it("400s without a title", async () => {
		const { app, env } = buildApp({ owns: [["inst-1", "u1"]] });
		expect((await post(app, env, "/v1/instances/inst-1/tasks/direct", { reasoning: "why" }, await tokenFor("u1"))).status).toBe(400);
	});

	it("creates a board ticket with reasoning — NO runner needed — and persists the reasoning in the payload", async () => {
		const { app, env, writes } = buildApp({ owns: [["inst-1", "u1"]] });
		const res = await post(
			app,
			env,
			"/v1/instances/inst-1/tasks/direct",
			{ title: "Palm Tree Kiosk", reasoning: "No website field → qualified lead", status: "completed" },
			await tokenFor("u1"),
		);
		expect(res.status).toBe(201);
		const body = (await res.json()) as { title: string; reasoning: string; status: string };
		expect(body).toMatchObject({ title: "Palm Tree Kiosk", reasoning: "No website field → qualified lead", status: "completed" });
		const insert = writes.find((w) => w.sql.includes("INSERT INTO instance_runtime_tasks"));
		expect(insert).toBeTruthy();
		// mirrorRuntimeTask binds the whole task JSON as the payload — reasoning must be in it.
		expect(insert?.args.some((a) => typeof a === "string" && a.includes("No website field → qualified lead"))).toBe(true);
	});
});

describe("Actionable tickets — the runner-less approval gate", () => {
	// A pipeline agent has no runner, so /approve's requireLiveRuntime could never serve it.
	// An actionable ticket carries its own work and is run straight from the cloud.
	const PIPELINE_CFG = JSON.stringify({ pipelines: { "site-builder": { name: "site-builder", steps: [{ tool: "map", inputs: {} }] } } });
	const actionable = (over: Record<string, unknown> = {}) => ({
		id: "t1",
		title: "Build a site for Palm Tree Kiosk",
		status: "needs_approval",
		action: { action: "run_pipeline", config: { pipeline: "site-builder" }, params: { place_id: "p1" } },
		...over,
	});

	it("creates an actionable ticket that defaults to needs_approval and persists its action", async () => {
		const { app, env, writes } = buildApp({ owns: [["inst-1", "u1"]] });
		const res = await post(
			app,
			env,
			"/v1/instances/inst-1/tasks/direct",
			{ title: "Build a site", action: "run_pipeline", config: { pipeline: "site-builder" }, params: { place_id: "p1" } },
			await tokenFor("u1"),
		);
		expect(res.status).toBe(201);
		const body = (await res.json()) as { status: string; action: { action: string; config: { pipeline: string } } };
		expect(body.status).toBe("needs_approval"); // it's waiting on a human, not a done record
		expect(body.action).toEqual({ action: "run_pipeline", config: { pipeline: "site-builder" }, params: { place_id: "p1" } });
		expect(writes.some((w) => w.sql.includes("INSERT INTO instance_runtime_tasks"))).toBe(true);
	});

	it("a plain ticket still defaults to completed (unchanged behaviour)", async () => {
		const { app, env } = buildApp({ owns: [["inst-1", "u1"]] });
		const res = await post(app, env, "/v1/instances/inst-1/tasks/direct", { title: "Found a lead" }, await tokenFor("u1"));
		expect(((await res.json()) as { status: string }).status).toBe("completed");
	});

	it("400s an invalid action at CREATE time rather than storing a ticket that can never run", async () => {
		const { app, env, writes } = buildApp({ owns: [["inst-1", "u1"]] });
		const res = await post(app, env, "/v1/instances/inst-1/tasks/direct", { title: "x", action: "run_pipeline" }, await tokenFor("u1"));
		expect(res.status).toBe(400);
		expect(writes.some((w) => w.sql.includes("INSERT INTO instance_runtime_tasks"))).toBe(false);
	});

	it("running an approved ticket dispatches its declared pipeline with its params", async () => {
		const pipelineRuns: Array<Record<string, unknown>> = [];
		const { app, env } = buildApp({ owns: [["inst-1", "u1"]], noRuntime: true, mirroredTask: actionable(), instanceConfig: PIPELINE_CFG, pipelineRuns });
		const res = await post(app, env, "/v1/instances/inst-1/tasks/t1/run", {}, await tokenFor("u1"));
		expect(res.status).toBe(200);
		expect((await res.json()) as { ok: boolean }).toMatchObject({ ok: true });
		expect(pipelineRuns).toHaveLength(1);
		expect(pipelineRuns[0]).toMatchObject({ instanceId: "inst-1", userId: "u1", params: { place_id: "p1" } });
	});

	it("/approve falls back to the same path — NO live runner required", async () => {
		const pipelineRuns: Array<Record<string, unknown>> = [];
		const { app, env } = buildApp({ owns: [["inst-1", "u1"]], noRuntime: true, mirroredTask: actionable(), instanceConfig: PIPELINE_CFG, pipelineRuns });
		const res = await post(app, env, "/v1/instances/inst-1/tasks/t1/approve", {}, await tokenFor("u1"));
		expect(res.status).toBe(200);
		expect(pipelineRuns).toHaveLength(1);
	});

	it("marks the ticket running before dispatch, then completed (the board shows progress)", async () => {
		const { app, env, writes } = buildApp({ owns: [["inst-1", "u1"]], noRuntime: true, mirroredTask: actionable(), instanceConfig: PIPELINE_CFG, pipelineRuns: [] });
		await post(app, env, "/v1/instances/inst-1/tasks/t1/run", {}, await tokenFor("u1"));
		const claim = writes.find((w) => w.sql.includes("UPDATE instance_runtime_tasks SET status = 'running'"));
		expect(claim).toBeTruthy(); // claimed atomically, so a double-click can't run it twice
		const mirrors = writes.filter((w) => w.sql.includes("INSERT INTO instance_runtime_tasks"));
		expect(mirrors.some((w) => w.args.some((a) => typeof a === "string" && a.includes('"status":"completed"')))).toBe(true);
	});

	it("409s a ticket that was already decided", async () => {
		const pipelineRuns: Array<Record<string, unknown>> = [];
		const { app, env } = buildApp({ owns: [["inst-1", "u1"]], noRuntime: true, mirroredTask: actionable({ status: "completed" }), instanceConfig: PIPELINE_CFG, pipelineRuns });
		const res = await post(app, env, "/v1/instances/inst-1/tasks/t1/run", {}, await tokenFor("u1"));
		expect(res.status).toBe(409);
		expect(pipelineRuns).toHaveLength(0);
	});

	it("400s a plain ticket — there is nothing to run", async () => {
		const { app, env } = buildApp({ owns: [["inst-1", "u1"]], noRuntime: true, mirroredTask: { id: "t1", title: "Found a lead", status: "completed" } });
		const res = await post(app, env, "/v1/instances/inst-1/tasks/t1/run", {}, await tokenFor("u1"));
		expect(res.status).toBe(400);
	});

	it("404s an unknown ticket", async () => {
		const { app, env } = buildApp({ owns: [["inst-1", "u1"]], noRuntime: true });
		expect((await post(app, env, "/v1/instances/inst-1/tasks/nope/run", {}, await tokenFor("u1"))).status).toBe(404);
	});

	it("404s + never dispatches for a non-owner", async () => {
		const pipelineRuns: Array<Record<string, unknown>> = [];
		const { app, env } = buildApp({ owns: [], mirroredTask: actionable(), instanceConfig: PIPELINE_CFG, pipelineRuns });
		const res = await post(app, env, "/v1/instances/inst-1/tasks/t1/run", {}, await tokenFor("u2"));
		expect(res.status).toBe(404);
		expect(pipelineRuns).toHaveLength(0);
	});

	it("ignores work supplied in the REQUEST — the stored action is the only work that runs", async () => {
		const pipelineRuns: Array<Record<string, unknown>> = [];
		const { app, env } = buildApp({ owns: [["inst-1", "u1"]], noRuntime: true, mirroredTask: actionable(), instanceConfig: PIPELINE_CFG, pipelineRuns });
		await post(
			app,
			env,
			"/v1/instances/inst-1/tasks/t1/run",
			{ action: "run_pipeline", config: { pipeline: "something-else" }, params: { place_id: "attacker" } },
			await tokenFor("u1"),
		);
		expect(pipelineRuns[0]).toMatchObject({ params: { place_id: "p1" } });
		expect((pipelineRuns[0].pipeline as { name: string }).name).toBe("site-builder");
	});

	it("records the failure on the ticket when the action can't run", async () => {
		// No such pipeline on the instance → startPipelineRun refuses; the ticket must say so.
		const { app, env, writes } = buildApp({ owns: [["inst-1", "u1"]], noRuntime: true, mirroredTask: actionable(), instanceConfig: "{}" });
		const res = await post(app, env, "/v1/instances/inst-1/tasks/t1/run", {}, await tokenFor("u1"));
		expect(res.status).toBe(502);
		const mirrors = writes.filter((w) => w.sql.includes("INSERT INTO instance_runtime_tasks"));
		expect(mirrors.some((w) => w.args.some((a) => typeof a === "string" && a.includes('"status":"failed"')))).toBe(true);
	});
});

describe("GET /v1/instances/:id/tasks/:taskId (runner-less fallback, #150)", () => {
	it("serves the mirrored ticket (with reasoning) when NO runtime is registered", async () => {
		const ticket = { id: "t1", title: "Palm Tree Kiosk", reasoning: "1. discovered via Places\n2. no website → lead", status: "completed" };
		const { app, env } = buildApp({ owns: [["inst-1", "u1"]], noRuntime: true, mirroredTask: ticket });
		const res = await get(app, env, "/v1/instances/inst-1/tasks/t1", await tokenFor("u1"));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { title: string; reasoning: string };
		expect(body.title).toBe("Palm Tree Kiosk");
		expect(body.reasoning).toContain("no website → lead"); // the WHY reaches the detail page
	});

	it("404s (not a thrown 'Runtime not registered') when there's no runner AND no mirror", async () => {
		const { app, env } = buildApp({ owns: [["inst-1", "u1"]], noRuntime: true });
		const res = await get(app, env, "/v1/instances/inst-1/tasks/missing", await tokenFor("u1"));
		expect(res.status).toBe(404);
	});
});

describe("defaultPipelinesFor — a pipeline agent arrives usable", () => {
	const VALID = { name: "site-builder", steps: [{ tool: "map", inputs: {} }] };

	it("copies the agent's declared pipelines", () => {
		const out = defaultPipelinesFor(JSON.stringify({ pipelines: { "site-builder": VALID } }));
		expect(out).toEqual({ "site-builder": VALID });
	});

	it("drops a definition the runner would reject, keeping the working ones", () => {
		// A broken template def must not poison the subscriber's config — the runner would
		// only fail later, at run time, with no clue where the bad def came from.
		const out = defaultPipelinesFor(JSON.stringify({ pipelines: { good: VALID, bad: { name: "bad", steps: [] } } }));
		expect(Object.keys(out)).toEqual(["good"]);
	});

	it("drops a definition naming a tool that doesn't exist", () => {
		const out = defaultPipelinesFor(JSON.stringify({ pipelines: { bad: { name: "bad", steps: [{ tool: "no_such_tool" }] } } }));
		expect(out).toEqual({});
	});

	it("returns {} for an agent with no pipelines, and for malformed config", () => {
		expect(defaultPipelinesFor(JSON.stringify({ capabilities: {} }))).toEqual({});
		expect(defaultPipelinesFor("{not json")).toEqual({});
		expect(defaultPipelinesFor(null)).toEqual({});
	});
});
