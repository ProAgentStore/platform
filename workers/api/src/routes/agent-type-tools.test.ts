/**
 * An agent TYPE's tool contract (#771): the listing a `/mcp/t/<agentSlug>` session registers, and the
 * type check a call made on that session carries into the invoke route.
 */
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { HttpError } from "../lib/auth.js";
import { signSession } from "../lib/session.js";
import { agentTypeToolRoutes } from "./agent-type-tools.js";
import { toolRoutes } from "./tools.js";
import type { Env } from "../types.js";

const SECRET = "agent-type-tools-secret";
const CODER_CONFIG = JSON.stringify({ capabilities: { tools: ["github_read_issue", "github_create_issue"] } });

/** Agents by id: a published coder, a draft only its owner (and its subscribers) may read. */
const AGENTS = [
	{ id: "a-coder", slug: "coder", category: "code", config: CODER_CONFIG, visibility: "published", owner_id: "creator" },
	{ id: "a-draft", slug: "draft-x", category: "general", config: "{}", visibility: "draft", owner_id: "creator" },
	{ id: "a-chat", slug: "helper", category: "chat", config: "{}", visibility: "published", owner_id: "creator" },
];
/** Instances the caller `u1` owns: one coder, one helper. `u2` subscribes to the draft. */
const INSTANCES = [
	{ id: "inst-coder", agent_id: "a-coder", user_id: "u1" },
	{ id: "inst-helper", agent_id: "a-chat", user_id: "u1" },
	{ id: "inst-draft", agent_id: "a-draft", user_id: "u2" },
];

function buildApp() {
	const env = {
		SESSION_SIGNING_KEY: SECRET,
		DB: {
			prepare(sql: string) {
				return {
					bind(...args: unknown[]) {
						return {
							async first() {
								if (sql.includes("FROM agents a") && sql.includes("visibility = 'published'")) {
									const [key, uid] = args as [string, string];
									const a = AGENTS.find((x) => x.slug === key || x.id === key);
									if (!a) return null;
									const visible = a.visibility === "published" || a.owner_id === uid || INSTANCES.some((i) => i.agent_id === a.id && i.user_id === uid);
									return visible ? { id: a.id, slug: a.slug, category: a.category, config: a.config } : null;
								}
								if (sql.startsWith("SELECT slug FROM agents WHERE id")) return { slug: AGENTS.find((a) => a.id === args[0])?.slug ?? null };
								if (sql.includes("FROM agent_instances")) {
									const [id, uid] = args as [string, string];
									const inst = INSTANCES.find((i) => i.id === id && i.user_id === uid);
									if (!inst) return null;
									if (sql.includes("JOIN agents")) {
										const a = AGENTS.find((x) => x.id === inst.agent_id);
										return { slug: a?.slug, category: a?.category, config: a?.config, instance_config: "{}" };
									}
									return { ...inst, status: "active", config: "{}", created_at: "", updated_at: "" };
								}
								return null;
							},
							async all() {
								return { results: [] };
							},
							async run() {
								return { meta: { changes: 1 } };
							},
						};
					},
				};
			},
		},
	} as unknown as Env;
	const app = new Hono<{ Bindings: Env }>();
	app.route("/v1/agents", agentTypeToolRoutes);
	app.route("/v1/instances", toolRoutes);
	app.onError((err, c) => {
		if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
		throw err;
	});
	return { app, env };
}

const request = async (method: string, path: string, uid: string | null, body?: unknown) => {
	const { app, env } = buildApp();
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (uid) headers.Authorization = `Bearer ${await signSession(uid, SECRET, { roles: ["user"] })}`;
	const res = await app.request(path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, env);
	return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

type Row = { name: string; allowed?: boolean; jsonSchema?: unknown };

describe("GET /v1/agents/:slug/tools — an agent type's declared tools (#771)", () => {
	it("lists what the TYPE declares, in the instance listing's shape, schemas when asked — no instance involved", async () => {
		const { status, body } = await request("GET", "/v1/agents/coder/tools?allowed=true&schemas=true", "u9");
		expect(status).toBe(200);
		expect(body.agent).toEqual({ id: "a-coder", slug: "coder" });
		const rows = body.tools as Row[];
		const names = rows.map((r) => r.name);
		expect(names).toEqual(expect.arrayContaining(["github_read_issue", "github_create_issue"]));
		expect(rows.every((r) => r.allowed === true)).toBe(true);
		expect(rows.find((r) => r.name === "github_read_issue")?.jsonSchema).toMatchObject({ properties: { number: expect.anything() } });
		// An owner-permission tool is per instance, never part of the type's contract.
		expect(names).not.toContain("find_confirmation_link");
	});

	it("without ?allowed=true it says what the type does NOT declare too, like the instance listing", async () => {
		const rows = (await request("GET", "/v1/agents/coder/tools", "u9")).body.tools as Row[];
		expect(rows.some((r) => r.allowed === false)).toBe(true);
		expect(rows.some((r) => r.jsonSchema !== undefined)).toBe(false);
	});

	it("resolves the type by id as well as slug", async () => {
		expect((await request("GET", "/v1/agents/a-coder/tools", "u9")).status).toBe(200);
	});

	it("a draft is readable by its owner and its subscribers, and a 404 to everyone else", async () => {
		expect((await request("GET", "/v1/agents/draft-x/tools", "creator")).status).toBe(200);
		expect((await request("GET", "/v1/agents/draft-x/tools", "u2")).status).toBe(200);
		expect((await request("GET", "/v1/agents/draft-x/tools", "u9")).status).toBe(404);
		expect((await request("GET", "/v1/agents/nope/tools", "u9")).status).toBe(404);
	});

	it("requires a signed-in caller", async () => {
		expect((await request("GET", "/v1/agents/coder/tools", null)).status).toBe(401);
	});
});

describe("POST /v1/instances/:id/tools/:name?agent=<type> — a type session's call is held to its type (#771)", () => {
	it("an instance of ANOTHER type is refused, naming both types and the session that fits", async () => {
		const { status, body } = await request("POST", "/v1/instances/inst-helper/tools/github_read_issue?agent=coder", "u1", { repo: "a/b", number: 1 });
		expect(status).toBe(400);
		expect(body.error).toBe("This instance is helper, not coder — a /mcp/t/coder session runs only coder instances. Use /mcp/t/helper for it.");
	});

	it("an instance of the right type gets past the type check to the usual per-instance policy", async () => {
		// `http_request` is not declared by the coder type, so the POLICY refuses it (403) — the type check passed.
		const { status, body } = await request("POST", "/v1/instances/inst-coder/tools/http_request?agent=coder", "u1", {});
		expect(status).toBe(403);
		expect(String(body.error)).not.toMatch(/not coder/);
	});

	it("the check is opt-in: without ?agent the route behaves exactly as before", async () => {
		const { status, body } = await request("POST", "/v1/instances/inst-helper/tools/http_request", "u1", {});
		expect(status).toBe(403);
		expect(String(body.error)).not.toMatch(/not coder|\/mcp\/t\//);
	});

	it("ownership is still checked first — another owner's instance is a 404 whatever the type", async () => {
		expect((await request("POST", "/v1/instances/inst-draft/tools/github_read_issue?agent=coder", "u1", {})).status).toBe(404);
	});
});
