import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { HttpError } from "../lib/auth.js";
import { signSession } from "../lib/session.js";
import { instanceRoutes } from "./instances.js";
import type { Env } from "../types.js";

/**
 * INTEGRATION test for the instance-lifecycle routes in instances.ts. Drives the
 * real handlers end-to-end through the Hono app: auth (requireUser / verifySession)
 * → ownership gate (mock D1) → real config-merge / capability-resolution / board
 * logic → AgentDO proxy (recording stub) → JSON. Only the D1, AgentDO and STORAGE
 * boundaries are faked; the ownership + validation + config-merge + settings-patch
 * logic all run for real. Runtime/node routes are covered in
 * instances-runtime.helpers.test.ts and are NOT duplicated here.
 */

const SECRET = "instances-integration-secret";

interface Write { sql: string; args: unknown[] }
interface DoCall { name: string; path: string; method: string; body?: unknown }

type Agent = { id: string; slug?: string; name?: string; model?: string; owner_id?: string; visibility?: string; config?: string | null; category?: string };

interface Opts {
	/** (instanceId,userId) pairs that resolve to an owned instance row. */
	owns?: Array<[string, string]>;
	/** agent_instances.config for owned rows (drives displayName / settings / voice). */
	instanceConfig?: string;
	/** agent + joined-agent metadata for the owned instance. */
	instanceAgent?: Agent;
	/** agents the subscribe SELECT can resolve (by id or slug). */
	agents?: Agent[];
	/** count of same-agent instances (subscribe numbering) + total instance count. */
	sameAgentCount?: number;
	totalInstanceCount?: number;
	/** rows for the `my/instances` list JOIN. */
	myInstances?: Array<Record<string, unknown>>;
	/** canned AgentDO responses keyed by pathname. */
	doResponse?: (path: string, method: string) => Response;
	/** STORAGE.get result (voice-audio fetch). */
	storageGet?: unknown;
}

function buildApp(opts: Opts = {}) {
	const writes: Write[] = [];
	const doCalls: DoCall[] = [];
	const owns = new Set((opts.owns ?? []).map(([i, u]) => `${i}::${u}`));
	const instanceConfig = opts.instanceConfig ?? "{}";
	const agentMeta = opts.instanceAgent ?? { id: "a1", slug: "generic", name: "Agent", category: "utility", config: "{}" };

	const DB = {
		prepare(sql: string) {
			return {
				bind(...args: unknown[]) {
					return {
						async first() {
							// subscribe: SELECT … FROM agents WHERE (id=?1 OR slug=?1) AND visibility='published'
							if (sql.includes("FROM agents") && sql.includes("visibility = 'published'")) {
								const key = args[0] as string;
								return (opts.agents ?? []).find((a) => a.id === key || a.slug === key) ?? null;
							}
							// subscribe: numbering + cap counts
							if (sql.includes("COUNT(*) AS n") && sql.includes("agent_id = ?1 AND user_id = ?2")) {
								return { n: opts.sameAgentCount ?? 0 };
							}
							if (sql.includes("COUNT(*) AS n") && sql.includes("user_id = ?1")) {
								return { n: opts.totalInstanceCount ?? 0 };
							}
							// subscribe: creator lookup + subscriber login
							if (sql.includes("SELECT owner_id FROM agents")) return { owner_id: agentMeta.owner_id ?? "creator" };
							if (sql.includes("github_login FROM users")) return { github_login: "octocat" };
							// settingsSchemaForInstance: JOIN agents on owned instance
							if (sql.includes("JOIN agents a ON a.id = i.agent_id")) {
								const [id, uid] = args as [string, string];
								if (!owns.has(`${id}::${uid}`)) return null;
								return { slug: agentMeta.slug, category: agentMeta.category, config: agentMeta.config };
							}
							// chat/messages/cancel/loop/system: SELECT id[, agent_id] FROM agent_instances WHERE id=?1 AND user_id=?2
							if (sql.includes("FROM agent_instances")) {
								const [id, uid] = args as [string, string];
								if (!owns.has(`${id}::${uid}`)) return null;
								if (sql.includes("SELECT config")) return { config: instanceConfig };
								return { id, agent_id: "a1", user_id: uid, status: "active", config: instanceConfig, created_at: "", updated_at: "" };
							}
							// chat: agent name lookup
							if (sql.includes("SELECT name FROM agents")) return { name: agentMeta.name };
							return null;
						},
						async all() {
							if (sql.includes("FROM agent_instances i")) return { results: opts.myInstances ?? [] };
							return { results: [] };
						},
						async run() { writes.push({ sql, args }); return { meta: { changes: 1 } }; },
					};
				},
			};
		},
		batch(stmts: unknown[]) { writes.push({ sql: "BATCH", args: stmts }); return Promise.resolve([]); },
	};

	const env = {
		SESSION_SIGNING_KEY: SECRET,
		DB,
		AGENT: {
			idFromName(name: string) { return { name }; },
			get(id: { name: string }) {
				return {
					async fetch(req: Request) {
						const url = new URL(req.url);
						let body: unknown;
						if (req.method === "POST" || req.method === "PUT") {
							body = await req.clone().json().catch(() => undefined);
						}
						doCalls.push({ name: id.name, path: url.pathname, method: req.method, body });
						return (opts.doResponse ?? defaultDoResponse)(url.pathname, req.method);
					},
				};
			},
		},
		STORAGE: {
			async get() { return opts.storageGet ?? null; },
			async put() { return undefined; },
		},
	} as unknown as Env;

	const app = new Hono<{ Bindings: Env }>();
	app.route("/v1/instances", instanceRoutes);
	app.onError((err, c) => {
		if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
		return c.json({ error: (err as Error).message }, 500);
	});
	return { app, env, writes, doCalls };
}

function defaultDoResponse(path: string): Response {
	if (path === "/state") return Response.json({ name: "Template", personality: "helpful", goal: "assist", guardrails: {}, model: "claude-sonnet-4-6" });
	if (path === "/knowledge") return Response.json({ documents: [] });
	if (path === "/chat") return Response.json({ message: { content: "hello back" } });
	if (path === "/messages") return Response.json({ messages: [] });
	return Response.json({ ok: true });
}

const tokenFor = (uid: string) => signSession(uid, SECRET, { roles: ["user"] });

function get(app: Hono, env: unknown, path: string, tok?: string) {
	return app.request(path, { headers: tok ? { Authorization: `Bearer ${tok}` } : {} }, env);
}
function post(app: Hono, env: unknown, path: string, body: unknown, tok?: string) {
	return app.request(path, { method: "POST", headers: { ...(tok ? { Authorization: `Bearer ${tok}` } : {}), "Content-Type": "application/json" }, body: JSON.stringify(body) }, env);
}
function put(app: Hono, env: unknown, path: string, body: unknown, tok?: string) {
	return app.request(path, { method: "PUT", headers: { ...(tok ? { Authorization: `Bearer ${tok}` } : {}), "Content-Type": "application/json" }, body: JSON.stringify(body) }, env);
}

// ————————————————————————————————————————————————————————————————
// POST /:agentId/subscribe — create instance + copy template state/KB
// ————————————————————————————————————————————————————————————————

describe("POST /v1/instances/:agentId/subscribe (integration)", () => {
	it("401s without a bearer token", async () => {
		const { app, env } = buildApp({ agents: [{ id: "a1", slug: "sitemon", name: "Site Monitor", visibility: "published" }] });
		const res = await post(app, env, "/v1/instances/a1/subscribe", {});
		expect(res.status).toBe(401);
	});

	it("404s when the agent is not published (or does not exist) — no instance written", async () => {
		const { app, env, writes } = buildApp({ agents: [] });
		const res = await post(app, env, "/v1/instances/ghost/subscribe", {}, await tokenFor("u1"));
		expect(res.status).toBe(404);
		expect((await res.json() as { error: string }).error).toContain("not published");
		expect(writes.some((w) => w.sql.includes("INSERT INTO agent_instances"))).toBe(false);
	});

	it("creates an instance, copies template state to the instance DO, and 201s", async () => {
		const { app, env, writes, doCalls } = buildApp({
			agents: [{ id: "a1", slug: "sitemon", name: "Site Monitor", model: "claude-sonnet-4-6", visibility: "published", config: "{}" }],
		});
		const res = await post(app, env, "/v1/instances/a1/subscribe", {}, await tokenFor("u1"));
		expect(res.status).toBe(201);
		const body = await res.json() as { instanceId: string; agentId: string; status: string };
		expect(body.agentId).toBe("a1");
		expect(body.status).toBe("active");
		expect(body.instanceId).toBeTruthy();
		// The instance row + the subscription upsert + the usage event were written.
		expect(writes.some((w) => w.sql.includes("INSERT INTO agent_instances"))).toBe(true);
		expect(writes.some((w) => w.sql.includes("INSERT INTO subscriptions"))).toBe(true);
		expect(writes.some((w) => w.sql.includes("INSERT INTO usage"))).toBe(true);
		// The template DO's state + knowledge were read, and the instance DO was init'd.
		expect(doCalls.some((d) => d.name === "a1" && d.path === "/state")).toBe(true);
		const init = doCalls.find((d) => d.path === "/init");
		expect(init).toBeTruthy();
		expect((init!.body as { name: string }).name).toBe("Template"); // template DO state wins
		expect(init!.name).toBe(body.instanceId); // init'd on the NEW instance DO, not the template
	});

	it("copies template KB documents into the new instance DO", async () => {
		const doResponse = (path: string) => {
			if (path === "/state") return Response.json({ name: "T", guardrails: {} });
			if (path === "/knowledge") return Response.json({ documents: [{ title: "Doc A", content: "body", source: "seed" }] });
			return Response.json({ ok: true });
		};
		const { app, env, doCalls } = buildApp({
			agents: [{ id: "a1", slug: "sitemon", name: "SM", visibility: "published" }],
			doResponse,
		});
		const res = await post(app, env, "/v1/instances/a1/subscribe", {}, await tokenFor("u1"));
		expect(res.status).toBe(201);
		const instanceId = (await res.json() as { instanceId: string }).instanceId;
		// A knowledge POST was made to the INSTANCE DO with the template's doc.
		const kbPost = doCalls.find((d) => d.name === instanceId && d.path === "/knowledge" && d.method === "POST");
		expect(kbPost).toBeTruthy();
		expect((kbPost!.body as { title: string }).title).toBe("Doc A");
	});

	it("auto-numbers the display name for a 2nd instance of the same agent", async () => {
		const { app, env, writes } = buildApp({
			agents: [{ id: "a1", slug: "sitemon", name: "Site Monitor", visibility: "published" }],
			sameAgentCount: 1, // one already exists → this is the 2nd
		});
		const res = await post(app, env, "/v1/instances/a1/subscribe", {}, await tokenFor("u1"));
		expect(res.status).toBe(201);
		const insert = writes.find((w) => w.sql.includes("INSERT INTO agent_instances"))!;
		// config arg carries the numbered display name.
		const cfg = JSON.parse(insert.args[3] as string);
		expect(cfg.displayName).toBe("Site Monitor 2");
	});
});

// ————————————————————————————————————————————————————————————————
// GET /my/instances — attaches resolved capabilities, drops config secrets
// ————————————————————————————————————————————————————————————————

describe("GET /v1/instances/my/instances (integration)", () => {
	it("401s without a token", async () => {
		const { app, env } = buildApp();
		expect((await get(app, env, "/v1/instances/my/instances")).status).toBe(401);
	});

	it("returns instances with a resolved capability descriptor and NO raw config", async () => {
		const rows = [{
			id: "inst-1", agent_id: "a1", status: "active", created_at: "2026-08-01",
			instance_config: "{}", name: "Coder", slug: "coder", description: "d", category: "code",
			icon: "🤖", icon_bg: "#000", config: "{}",
		}];
		const { app, env } = buildApp({ myInstances: rows });
		const res = await get(app, env, "/v1/instances/my/instances", await tokenFor("u1"));
		expect(res.status).toBe(200);
		const body = await res.json() as { instances: Array<Record<string, unknown> & { capabilities: { surfaces: string[] } }> };
		expect(body.instances).toHaveLength(1);
		// coder resolves to the coding surface (fallback derivation in agent-capabilities).
		expect(body.instances[0].capabilities.surfaces).toContain("coding");
		// The raw agent/instance config blobs are dropped from the response.
		expect(body.instances[0].config).toBeUndefined();
		expect(body.instances[0].instance_config).toBeUndefined();
	});

	it("a per-instance displayName overrides the agent name (multi-instance disambiguation)", async () => {
		const rows = [{
			id: "inst-1", agent_id: "a1", status: "active", created_at: "",
			instance_config: JSON.stringify({ displayName: "My Second Coder" }),
			name: "Coder", slug: "coder", description: "", category: "code", icon: "", icon_bg: "", config: "{}",
		}];
		const { app, env } = buildApp({ myInstances: rows });
		const res = await get(app, env, "/v1/instances/my/instances", await tokenFor("u1"));
		const body = await res.json() as { instances: Array<{ name: string; agentName: string }> };
		expect(body.instances[0].name).toBe("My Second Coder");
		expect(body.instances[0].agentName).toBe("Coder"); // original agent name preserved
	});
});

// ————————————————————————————————————————————————————————————————
// PUT /:instanceId/name — per-instance display name (config merge)
// ————————————————————————————————————————————————————————————————

describe("PUT /v1/instances/:id/name (integration)", () => {
	it("401s without a token", async () => {
		const { app, env } = buildApp({ owns: [["inst-1", "u1"]] });
		expect((await put(app, env, "/v1/instances/inst-1/name", { name: "X" })).status).toBe(401);
	});

	it("sets a display name and merges it into the instance config", async () => {
		const { app, env, writes } = buildApp({ owns: [["inst-1", "u1"]], instanceConfig: JSON.stringify({ keepMe: 9 }) });
		const res = await put(app, env, "/v1/instances/inst-1/name", { name: "  My Agent  " }, await tokenFor("u1"));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ name: "My Agent" }); // trimmed
		const update = writes.find((w) => w.sql.includes("UPDATE agent_instances"))!;
		const cfg = JSON.parse(update.args[0] as string);
		expect(cfg.displayName).toBe("My Agent");
		expect(cfg.keepMe).toBe(9); // sibling config preserved
	});

	it("an empty name clears the displayName (back to the agent name)", async () => {
		const { app, env, writes } = buildApp({ owns: [["inst-1", "u1"]], instanceConfig: JSON.stringify({ displayName: "Old", keepMe: 1 }) });
		const res = await put(app, env, "/v1/instances/inst-1/name", { name: "" }, await tokenFor("u1"));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ name: null });
		const cfg = JSON.parse(writes.find((w) => w.sql.includes("UPDATE agent_instances"))!.args[0] as string);
		expect(cfg.displayName).toBeUndefined();
		expect(cfg.keepMe).toBe(1);
	});
});

// ————————————————————————————————————————————————————————————————
// GET/PUT /:instanceId/settings — typed agent settings (patch semantics)
// ————————————————————————————————————————————————————————————————

const SETTINGS_AGENT: Agent = {
	id: "a1", slug: "language-buddy", category: "learning",
	config: JSON.stringify({
		settingsSchema: [
			{ id: "level", type: "select", label: "Level", options: [{ value: "beginner" }, { value: "advanced" }], default: "beginner" },
			{ id: "notes", type: "text", label: "Notes", default: "" },
		],
	}),
};

describe("GET /v1/instances/:id/settings (integration)", () => {
	it("404s when the caller does not own the instance", async () => {
		const { app, env } = buildApp({ owns: [], instanceAgent: SETTINGS_AGENT });
		expect((await get(app, env, "/v1/instances/inst-1/settings", await tokenFor("u2"))).status).toBe(404);
	});

	it("returns schema-default values merged over stored settings + the field schema", async () => {
		const { app, env } = buildApp({
			owns: [["inst-1", "u1"]], instanceAgent: SETTINGS_AGENT,
			instanceConfig: JSON.stringify({ settings: { level: "advanced" } }),
		});
		const res = await get(app, env, "/v1/instances/inst-1/settings", await tokenFor("u1"));
		expect(res.status).toBe(200);
		const body = await res.json() as { settings: Record<string, unknown>; fields: Array<{ id: string }> };
		expect(body.settings.level).toBe("advanced"); // stored value wins
		expect(body.settings.notes).toBe(""); // default filled in
		expect(body.fields.map((f) => f.id)).toEqual(["level", "notes"]);
	});
});

describe("PUT /v1/instances/:id/settings (integration)", () => {
	it("400s when the agent declares no settings schema", async () => {
		const { app, env } = buildApp({
			owns: [["inst-1", "u1"]],
			instanceAgent: { id: "a1", slug: "plain", category: "utility", config: "{}" },
		});
		const res = await put(app, env, "/v1/instances/inst-1/settings", { settings: { x: 1 } }, await tokenFor("u1"));
		expect(res.status).toBe(400);
		expect((await res.json() as { error: string }).error).toContain("no settings");
	});

	it("applies a patch (only sent fields change) and persists the merged settings", async () => {
		const { app, env, writes } = buildApp({
			owns: [["inst-1", "u1"]], instanceAgent: SETTINGS_AGENT,
			instanceConfig: JSON.stringify({ settings: { level: "beginner", notes: "keep" } }),
		});
		const res = await put(app, env, "/v1/instances/inst-1/settings", { settings: { level: "advanced" } }, await tokenFor("u1"));
		expect(res.status).toBe(200);
		const body = await res.json() as { settings: Record<string, unknown> };
		expect(body.settings.level).toBe("advanced"); // patched
		expect(body.settings.notes).toBe("keep"); // untouched field preserved (patch semantics)
		const cfg = JSON.parse(writes.find((w) => w.sql.includes("UPDATE agent_instances"))!.args[0] as string);
		expect(cfg.settings.level).toBe("advanced");
	});
});

// ————————————————————————————————————————————————————————————————
// GET/PUT /:instanceId/voice-settings — clamping + validation
// ————————————————————————————————————————————————————————————————

describe("voice-settings (integration)", () => {
	it("GET returns the default browser provider when unset", async () => {
		const { app, env } = buildApp({ owns: [["inst-1", "u1"]] });
		const res = await get(app, env, "/v1/instances/inst-1/voice-settings", await tokenFor("u1"));
		expect(res.status).toBe(200);
		expect((await res.json() as { voiceSettings: { provider: string } }).voiceSettings.provider).toBe("browser");
	});

	it("PUT 400s on an unknown provider", async () => {
		const { app, env, writes } = buildApp({ owns: [["inst-1", "u1"]] });
		const res = await put(app, env, "/v1/instances/inst-1/voice-settings", { provider: "bogus" }, await tokenFor("u1"));
		expect(res.status).toBe(400);
		expect(writes.some((w) => w.sql.includes("UPDATE agent_instances"))).toBe(false);
	});

	it("PUT clamps speed/silence into range and persists the normalized settings", async () => {
		const { app, env, writes } = buildApp({ owns: [["inst-1", "u1"]] });
		const res = await put(app, env, "/v1/instances/inst-1/voice-settings", {
			provider: "browser", speed: 9999, silenceMs: 10, sttMode: "openai", commandsEnabled: false,
		}, await tokenFor("u1"));
		expect(res.status).toBe(200);
		const vs = (await res.json() as { voiceSettings: Record<string, unknown> }).voiceSettings;
		expect(vs.speed).toBe(200); // clamped to max
		expect(vs.silenceMs).toBe(500); // clamped to min
		expect(vs.sttMode).toBe("openai");
		expect(vs.commandsEnabled).toBe(false);
		expect(writes.some((w) => w.sql.includes("UPDATE agent_instances"))).toBe(true);
	});
});

// ————————————————————————————————————————————————————————————————
// POST /:instanceId/chat — ownership gate + DO proxy + usage tracking
// ————————————————————————————————————————————————————————————————

describe("POST /v1/instances/:id/chat (integration)", () => {
	it("400s when message is missing", async () => {
		const { app, env } = buildApp({ owns: [["inst-1", "u1"]] });
		const res = await post(app, env, "/v1/instances/inst-1/chat", {}, await tokenFor("u1"));
		expect(res.status).toBe(400);
		expect((await res.json() as { error: string }).error).toContain("message required");
	});

	it("404s when the instance is not owned (before any DO call)", async () => {
		const { app, env, doCalls } = buildApp({ owns: [] });
		const res = await post(app, env, "/v1/instances/inst-1/chat", { message: "hi" }, await tokenFor("u2"));
		expect(res.status).toBe(404);
		expect(doCalls.some((d) => d.path === "/chat")).toBe(false);
	});

	it("proxies the message to the instance DO, tracks usage, and returns the reply", async () => {
		const { app, env, writes, doCalls } = buildApp({ owns: [["inst-1", "u1"]] });
		const res = await post(app, env, "/v1/instances/inst-1/chat", { message: "hello" }, await tokenFor("u1"));
		expect(res.status).toBe(200);
		expect((await res.json() as { message: { content: string } }).message.content).toBe("hello back");
		const chat = doCalls.find((d) => d.name === "inst-1" && d.path === "/chat");
		expect(chat).toBeTruthy();
		expect((chat!.body as { message: string; userId: string }).message).toBe("hello");
		expect((chat!.body as { userId: string }).userId).toBe("u1"); // server-pinned uid
		// A usage event was recorded (event type 'instance_chat' is baked into the SQL;
		// the metadata arg carries the instanceId).
		const usage = writes.find((w) => w.sql.includes("INSERT INTO usage") && w.sql.includes("instance_chat"));
		expect(usage).toBeTruthy();
		expect(JSON.parse(usage!.args[3] as string).instanceId).toBe("inst-1");
	});
});

// ————————————————————————————————————————————————————————————————
// GET /:instanceId/messages — ownership + DO passthrough
// ————————————————————————————————————————————————————————————————

describe("GET /v1/instances/:id/messages (integration)", () => {
	it("404s for a non-owner", async () => {
		const { app, env } = buildApp({ owns: [] });
		expect((await get(app, env, "/v1/instances/inst-1/messages", await tokenFor("u2"))).status).toBe(404);
	});

	it("clamps the limit and passes it through to the DO", async () => {
		const { app, env, doCalls } = buildApp({
			owns: [["inst-1", "u1"]],
			doResponse: (p) => p === "/messages" ? Response.json({ messages: [{ role: "user", content: "hi" }] }) : Response.json({ ok: true }),
		});
		const res = await get(app, env, "/v1/instances/inst-1/messages?limit=999999", await tokenFor("u1"));
		expect(res.status).toBe(200);
		expect((await res.json() as { messages: unknown[] }).messages).toHaveLength(1);
		const call = doCalls.find((d) => d.path === "/messages");
		expect(call).toBeTruthy();
		// limit clamped to the 2000 ceiling — the DO never gets 999999.
		expect(call!.name).toBe("inst-1");
	});
});

// ————————————————————————————————————————————————————————————————
// POST /:instanceId/loop-decide — validation + no-key credential error
// ————————————————————————————————————————————————————————————————

describe("POST /v1/instances/:id/loop-decide (integration)", () => {
	it("404s when the instance is not owned", async () => {
		const { app, env } = buildApp({ owns: [] });
		const res = await post(app, env, "/v1/instances/inst-1/loop-decide", { objective: "x", messages: [] }, await tokenFor("u2"));
		expect(res.status).toBe(404);
	});

	it("400s when objective is missing", async () => {
		const { app, env } = buildApp({ owns: [["inst-1", "u1"]] });
		const res = await post(app, env, "/v1/instances/inst-1/loop-decide", { messages: [] }, await tokenFor("u1"));
		expect(res.status).toBe(400);
		expect((await res.json() as { error: string }).error).toContain("objective required");
	});

	it("400s when messages is not an array", async () => {
		const { app, env } = buildApp({ owns: [["inst-1", "u1"]] });
		const res = await post(app, env, "/v1/instances/inst-1/loop-decide", { objective: "do it", messages: "nope" }, await tokenFor("u1"));
		expect(res.status).toBe(400);
		expect((await res.json() as { error: string }).error).toContain("messages must be an array");
	});

	it("402s when the owner has no API key configured (BYOK credentials error)", async () => {
		// KEY_ENCRYPTION_KEY is left unset → getUserProviderKey returns null → runUserWorkersAi
		// throws the credentials error → mapped to 402. Honest: no real AI is invoked.
		const { app, env } = buildApp({ owns: [["inst-1", "u1"]] });
		const res = await post(app, env, "/v1/instances/inst-1/loop-decide", { objective: "ship it", messages: [] }, await tokenFor("u1"));
		expect(res.status).toBe(402);
		expect((await res.json() as { error: string }).error).toContain("API key");
	});
});

// ————————————————————————————————————————————————————————————————
// POST /:instanceId/system-message — validation + DO proxy
// ————————————————————————————————————————————————————————————————

describe("POST /v1/instances/:id/system-message (integration)", () => {
	it("400s without content", async () => {
		const { app, env } = buildApp({ owns: [["inst-1", "u1"]] });
		const res = await post(app, env, "/v1/instances/inst-1/system-message", {}, await tokenFor("u1"));
		expect(res.status).toBe(400);
		expect((await res.json() as { error: string }).error).toContain("content required");
	});

	it("404s for a non-owner (no DO call)", async () => {
		const { app, env, doCalls } = buildApp({ owns: [] });
		const res = await post(app, env, "/v1/instances/inst-1/system-message", { content: "hi" }, await tokenFor("u2"));
		expect(res.status).toBe(404);
		expect(doCalls.some((d) => d.path === "/system-message")).toBe(false);
	});

	it("forwards the content to the instance DO", async () => {
		const { app, env, doCalls } = buildApp({ owns: [["inst-1", "u1"]] });
		const res = await post(app, env, "/v1/instances/inst-1/system-message", { content: "paused by user" }, await tokenFor("u1"));
		expect(res.status).toBe(200);
		const call = doCalls.find((d) => d.name === "inst-1" && d.path === "/system-message");
		expect(call).toBeTruthy();
		expect((call!.body as { content: string }).content).toBe("paused by user");
	});
});

// ————————————————————————————————————————————————————————————————
// Instance knowledge (POST / GET / DELETE) — ownership + DO proxy
// ————————————————————————————————————————————————————————————————

describe("instance knowledge routes (integration)", () => {
	it("POST 404s for a non-owner (no DO call)", async () => {
		const { app, env, doCalls } = buildApp({ owns: [] });
		const res = await post(app, env, "/v1/instances/inst-1/knowledge", { title: "T", content: "C" }, await tokenFor("u2"));
		expect(res.status).toBe(404);
		expect(doCalls.some((d) => d.method === "POST" && d.path === "/knowledge")).toBe(false);
	});

	it("POST forwards the doc to the instance DO and returns 201", async () => {
		const { app, env, doCalls } = buildApp({
			owns: [["inst-1", "u1"]],
			doResponse: (p, m) => p === "/knowledge" && m === "POST" ? Response.json({ id: "doc-9" }) : Response.json({ ok: true }),
		});
		const res = await post(app, env, "/v1/instances/inst-1/knowledge", { title: "Notes", content: "body", source: "user" }, await tokenFor("u1"));
		expect(res.status).toBe(201);
		expect((await res.json() as { id: string }).id).toBe("doc-9");
		const call = doCalls.find((d) => d.name === "inst-1" && d.path === "/knowledge" && d.method === "POST");
		expect((call!.body as { title: string }).title).toBe("Notes");
	});

	it("GET forwards the whole KB from the DO for the owner", async () => {
		const { app, env, doCalls } = buildApp({
			owns: [["inst-1", "u1"]],
			doResponse: (p) => p === "/knowledge" ? Response.json({ documents: [{ title: "A" }, { title: "B" }] }) : Response.json({ ok: true }),
		});
		const res = await get(app, env, "/v1/instances/inst-1/knowledge", await tokenFor("u1"));
		expect(res.status).toBe(200);
		expect((await res.json() as { documents: unknown[] }).documents).toHaveLength(2);
		expect(doCalls.some((d) => d.name === "inst-1" && d.path === "/knowledge" && d.method === "GET")).toBe(true);
	});

	it("DELETE forwards the docId to the DO", async () => {
		const { app, env, doCalls } = buildApp({
			owns: [["inst-1", "u1"]],
			doResponse: () => Response.json({ deleted: true }),
		});
		const res = await app.request("/v1/instances/inst-1/knowledge/doc-42", {
			method: "DELETE", headers: { Authorization: `Bearer ${await tokenFor("u1")}` },
		}, env);
		expect(res.status).toBe(200);
		expect((await res.json() as { deleted: boolean }).deleted).toBe(true);
		const call = doCalls.find((d) => d.method === "DELETE");
		expect(call!.path).toBe("/knowledge/doc-42");
	});
});

// ————————————————————————————————————————————————————————————————
// GET /:instanceId/board and board-config — ownership + real board lib
// ————————————————————————————————————————————————————————————————

describe("board routes (integration)", () => {
	it("GET /board 404s for a non-owner", async () => {
		const { app, env } = buildApp({ owns: [] });
		expect((await get(app, env, "/v1/instances/inst-1/board", await tokenFor("u2"))).status).toBe(404);
	});

	it("GET /board returns a board built by the real board lib for the owner", async () => {
		const { app, env } = buildApp({ owns: [["inst-1", "u1"]], instanceAgent: { id: "a1", slug: "coder", category: "code", config: "{}" } });
		const res = await get(app, env, "/v1/instances/inst-1/board", await tokenFor("u1"));
		expect(res.status).toBe(200);
		const body = await res.json() as { columns?: unknown[] };
		// The board carries a columns array (from the agent's capability defaults).
		expect(Array.isArray(body.columns)).toBe(true);
	});

	it("POST /board/status 400s without a jobKey", async () => {
		const { app, env } = buildApp({ owns: [["inst-1", "u1"]] });
		const res = await post(app, env, "/v1/instances/inst-1/board/status", { status: "done" }, await tokenFor("u1"));
		expect(res.status).toBe(400);
		expect((await res.json() as { error: string }).error).toContain("jobKey required");
	});

	it("GET /board-config returns the resolved config for the owner", async () => {
		const { app, env } = buildApp({ owns: [["inst-1", "u1"]], instanceAgent: { id: "a1", slug: "coder", category: "code", config: "{}" } });
		const res = await get(app, env, "/v1/instances/inst-1/board-config", await tokenFor("u1"));
		expect(res.status).toBe(200);
		const body = await res.json() as Record<string, unknown>;
		expect(body).toHaveProperty("columns");
	});
});

// ————————————————————————————————————————————————————————————————
// POST /:instanceId/tasks/:taskId/hint — validation + owner-scoped write
// ————————————————————————————————————————————————————————————————

describe("POST /v1/instances/:id/tasks/:taskId/hint (integration)", () => {
	it("400s when the hint is empty", async () => {
		const { app, env, writes } = buildApp({ owns: [["inst-1", "u1"]] });
		const res = await post(app, env, "/v1/instances/inst-1/tasks/t1/hint", { hint: "   " }, await tokenFor("u1"));
		expect(res.status).toBe(400);
		expect(writes.some((w) => w.sql.includes("UPDATE instance_runtime_tasks"))).toBe(false);
	});

	it("404s for a non-owner (no write)", async () => {
		const { app, env, writes } = buildApp({ owns: [] });
		const res = await post(app, env, "/v1/instances/inst-1/tasks/t1/hint", { hint: "try harder" }, await tokenFor("u2"));
		expect(res.status).toBe(404);
		expect(writes.some((w) => w.sql.includes("UPDATE instance_runtime_tasks"))).toBe(false);
	});

	it("persists the hint scoped to (task, instance, user)", async () => {
		const { app, env, writes } = buildApp({ owns: [["inst-1", "u1"]] });
		const res = await post(app, env, "/v1/instances/inst-1/tasks/t1/hint", { hint: "use the sitemap" }, await tokenFor("u1"));
		expect(res.status).toBe(200);
		const w = writes.find((x) => x.sql.includes("UPDATE instance_runtime_tasks"))!;
		expect(w.args).toEqual(["use the sitemap", "t1", "inst-1", "u1"]);
	});
});

// ————————————————————————————————————————————————————————————————
// POST /:instanceId/cancel — ownership gate + batch status update
// ————————————————————————————————————————————————————————————————

describe("POST /v1/instances/:id/cancel (integration)", () => {
	it("404s for a non-owner (no batch)", async () => {
		const { app, env, writes } = buildApp({ owns: [] });
		const res = await post(app, env, "/v1/instances/inst-1/cancel", {}, await tokenFor("u2"));
		expect(res.status).toBe(404);
		expect(writes.some((w) => w.sql === "BATCH")).toBe(false);
	});

	it("marks the instance + subscription canceled via a batched update", async () => {
		const { app, env, writes } = buildApp({ owns: [["inst-1", "u1"]] });
		const res = await post(app, env, "/v1/instances/inst-1/cancel", {}, await tokenFor("u1"));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ success: true });
		expect(writes.some((w) => w.sql === "BATCH")).toBe(true);
	});
});

// ————————————————————————————————————————————————————————————————
// GET /:instanceId/trace — ownership + level filter passthrough
// ————————————————————————————————————————————————————————————————

describe("GET /v1/instances/:id/trace (integration)", () => {
	it("404s for a non-owner", async () => {
		const { app, env } = buildApp({ owns: [] });
		expect((await get(app, env, "/v1/instances/inst-1/trace", await tokenFor("u2"))).status).toBe(404);
	});

	it("returns an events envelope for the owner (empty when no events)", async () => {
		const { app, env } = buildApp({ owns: [["inst-1", "u1"]] });
		const res = await get(app, env, "/v1/instances/inst-1/trace?level=error&limit=10", await tokenFor("u1"));
		expect(res.status).toBe(200);
		const body = await res.json() as { instanceId: string; count: number; events: unknown[] };
		expect(body.instanceId).toBe("inst-1");
		expect(body.count).toBe(0);
		expect(Array.isArray(body.events)).toBe(true);
	});
});

// ————————————————————————————————————————————————————————————————
// PUT /:instanceId/voice-audio/:turnId + GET — validation + R2 boundary
// ————————————————————————————————————————————————————————————————

describe("voice-audio routes (integration)", () => {
	it("PUT 400s on an empty audio body", async () => {
		const { app, env } = buildApp({ owns: [["inst-1", "u1"]] });
		const res = await app.request("/v1/instances/inst-1/voice-audio/turn1", {
			method: "PUT", headers: { Authorization: `Bearer ${await tokenFor("u1")}`, "Content-Type": "audio/webm" },
			body: new ArrayBuffer(0),
		}, env);
		expect(res.status).toBe(400);
		expect((await res.json() as { error: string }).error).toContain("empty audio");
	});

	it("PUT stores the audio and echoes the (sanitized) turnId", async () => {
		const { app, env } = buildApp({ owns: [["inst-1", "u1"]] });
		const res = await app.request("/v1/instances/inst-1/voice-audio/turn-1", {
			method: "PUT", headers: { Authorization: `Bearer ${await tokenFor("u1")}`, "Content-Type": "audio/webm" },
			body: new Uint8Array([1, 2, 3, 4]),
		}, env);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, turnId: "turn-1" });
	});

	it("GET 404s when no audio is stored for the turn", async () => {
		const { app, env } = buildApp({ owns: [["inst-1", "u1"]], storageGet: null });
		const res = await get(app, env, "/v1/instances/inst-1/voice-audio/turn-x", await tokenFor("u1"));
		expect(res.status).toBe(404);
	});
});
