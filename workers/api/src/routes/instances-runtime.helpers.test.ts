import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { HttpError } from "../lib/auth.js";
import { signSession } from "../lib/session.js";
import { instanceRoutes } from "./instances.js";
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
								const [id, uid] = args as [string, string];
								if (!owns.has(`${id}::${uid}`)) return null;
								return mockRow({ instance_id: id, user_id: uid });
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
		const update = writes.find((w) => w.sql.includes("UPDATE agent_instances"));
		expect(update).toBeTruthy();
		expect(JSON.parse(update!.args[0] as string).runnerNode).toBe("laptop-A");
	});

	it("clearing the pin (empty value) deletes runnerNode but keeps sibling config", async () => {
		const { app, env, writes } = buildApp({ owns: [["inst-1", "u1"]], instanceConfig: JSON.stringify({ runnerNode: "laptop-A", keepMe: 7 }) });
		const res = await put(app, env, "/v1/instances/inst-1/runner-node", { runnerNode: "" }, await tokenFor("u1"));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ runnerNode: null });
		const update = writes.find((w) => w.sql.includes("UPDATE agent_instances"))!;
		const cfg = JSON.parse(update.args[0] as string);
		expect(cfg.runnerNode).toBeUndefined();
		expect(cfg.keepMe).toBe(7);
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
