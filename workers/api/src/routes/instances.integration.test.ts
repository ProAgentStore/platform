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
interface DoCall { name: string; path: string; search: string; method: string; body?: unknown }

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
	/** users.preferences blob — the owner's account-level voice/translation defaults (#211). */
	accountPreferences?: string;
}

function buildApp(opts: Opts = {}) {
	const writes: Write[] = [];
	/** Every SELECT the handlers prepare — lets a test assert on the generated SQL. */
	const reads: string[] = [];
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
							// account preferences (#211) — the base every instance resolves against.
							if (sql.includes("SELECT preferences FROM users")) return { preferences: opts.accountPreferences ?? "" };
							// chat: agent name lookup
							if (sql.includes("SELECT name FROM agents")) return { name: agentMeta.name };
							return null;
						},
						async all() {
							reads.push(sql);
							if (sql.includes("FROM agent_instances i")) return { results: opts.myInstances ?? [] };
							// The per-USER ATS tips cache. Non-empty so an ALLOWED read is
							// distinguishable from a refusal — both return `{tips: […]}`, so a test
							// asserting only the shape passes even when the gate refuses everything.
							if (sql.includes("FROM ats_apply_cache")) {
								return { results: [{ host: "jobs.dayforcehcm.com", outcome: "submitted", steps: 12, notes: "n", updated_at: "2026-08-01" }] };
							}
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
						doCalls.push({ name: id.name, path: url.pathname, search: url.search, method: req.method, body });
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
	return { app, env, writes, reads, doCalls };
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
function del(app: Hono, env: unknown, path: string, tok?: string) {
	return app.request(path, { method: "DELETE", headers: tok ? { Authorization: `Bearer ${tok}` } : {} }, env);
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

	it("stores the display name the subscriber chose, instead of numbering it (#450)", async () => {
		// The console asks for a name on the second subscription precisely so the auto-numbered one
		// is never created: "Site Monitor 2" cannot be reached by saying it out loud.
		const { app, env, writes } = buildApp({
			agents: [{ id: "a1", slug: "sitemon", name: "Site Monitor", visibility: "published" }],
			sameAgentCount: 1,
		});
		const res = await post(app, env, "/v1/instances/a1/subscribe", { displayName: "  Shop site  " }, await tokenFor("u1"));
		expect(res.status).toBe(201);
		const cfg = JSON.parse(writes.find((w) => w.sql.includes("INSERT INTO agent_instances"))!.args[3] as string);
		expect(cfg.displayName).toBe("Shop site");
	});

	it("names a FIRST instance too when one was chosen, and leaves it unnamed otherwise", async () => {
		const build = () => buildApp({ agents: [{ id: "a1", slug: "sitemon", name: "Site Monitor", visibility: "published" }] });
		const named = build();
		await post(named.app, named.env, "/v1/instances/a1/subscribe", { displayName: "Shop site" }, await tokenFor("u1"));
		const namedCfg = JSON.parse(named.writes.find((w) => w.sql.includes("INSERT INTO agent_instances"))!.args[3] as string);
		expect(namedCfg.displayName).toBe("Shop site");
		// No name and no sibling: the agent's own name is already sayable, so nothing is stored.
		const plain = build();
		await post(plain.app, plain.env, "/v1/instances/a1/subscribe", {}, await tokenFor("u1"));
		const plainCfg = JSON.parse(plain.writes.find((w) => w.sql.includes("INSERT INTO agent_instances"))!.args[3] as string);
		expect(plainCfg.displayName).toBeUndefined();
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

	// #67: cancelling was the only non-destructive way to retire a duplicate instance, but this
	// list returned canceled rows anyway — so the console nav, MCP's instance resolution and
	// `pags up` all kept offering an instance the user had already retired.
	it("excludes canceled instances by default", async () => {
		const { app, env, reads } = buildApp({ myInstances: [] });
		await get(app, env, "/v1/instances/my/instances", await tokenFor("u1"));
		const listSql = reads.find((s) => s.includes("FROM agent_instances i"));
		expect(listSql).toContain("i.status != 'canceled'");
	});

	it("?includeCanceled=1 returns them, so a retired instance is never stranded", async () => {
		const { app, env, reads } = buildApp({ myInstances: [] });
		await get(app, env, "/v1/instances/my/instances?includeCanceled=1", await tokenFor("u1"));
		const listSql = reads.find((s) => s.includes("FROM agent_instances i"));
		expect(listSql).not.toContain("canceled");
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
		// Targeted json_set on $.displayName (#231). Siblings are preserved BY CONSTRUCTION now —
		// the UPDATE cannot reach another key — so the assertion is on the statement issued.
		const update = writes.find((w) => w.sql.includes("json_set(") && w.args[0] === "$.displayName")!;
		expect(JSON.parse(update.args[1] as string)).toBe("My Agent");
		expect(writes.some((w) => /SET config = \?1/.test(w.sql))).toBe(false);
	});

	it("an empty name clears the displayName (back to the agent name)", async () => {
		const { app, env, writes } = buildApp({ owns: [["inst-1", "u1"]], instanceConfig: JSON.stringify({ displayName: "Old", keepMe: 1 }) });
		const res = await put(app, env, "/v1/instances/inst-1/name", { name: "" }, await tokenFor("u1"));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ name: null });
		expect(writes.some((w) => w.sql.includes("json_remove(") && w.args[0] === "$.displayName")).toBe(true);
		expect(writes.some((w) => /SET config = \?1/.test(w.sql))).toBe(false);
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
		const cfg = JSON.parse(writes.find((w) => w.sql.includes("json_set("))!.args[1] as string);
		expect(cfg.level).toBe("advanced");
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
		expect(call!.search).toBe("?limit=2000");
	});

	it("forwards the `before` cursor to the DO — it used to be dropped, so paging re-served page 1 (#428)", async () => {
		const { app, env, doCalls } = buildApp({
			owns: [["inst-1", "u1"]],
			doResponse: (p) => p === "/messages" ? Response.json({ messages: [], nextCursor: null, hasMore: false }) : Response.json({ ok: true }),
		});
		const cursor = "msg:2026-08-08T06:46:33.000Z:ffb4c8f8-4247-4da1-8f5f-d20c20e4acda";
		const res = await get(app, env, `/v1/instances/inst-1/messages?limit=10&before=${encodeURIComponent(cursor)}`, await tokenFor("u1"));
		expect(res.status).toBe(200);
		const call = doCalls.find((d) => d.path === "/messages");
		expect(new URLSearchParams(call!.search).get("before")).toBe(cursor);
		expect(new URLSearchParams(call!.search).get("limit")).toBe("10");
	});

	it("returns the DO's paging fields, so the console stops guessing hasMore from a page length (#428)", async () => {
		const { app, env } = buildApp({
			owns: [["inst-1", "u1"]],
			doResponse: (p) => p === "/messages"
				? Response.json({ messages: [{ role: "user", content: "hi" }], nextCursor: "msg:2026-08-08T06:00:00.000Z:m1", hasMore: true })
				: Response.json({ ok: true }),
		});
		const body = await (await get(app, env, "/v1/instances/inst-1/messages", await tokenFor("u1"))).json() as { nextCursor?: string; hasMore?: boolean };
		expect(body.nextCursor).toBe("msg:2026-08-08T06:00:00.000Z:m1");
		expect(body.hasMore).toBe(true);
	});

	it("a cursor the DO refuses stays a 4xx — swallowing it into an empty 200 is how #428 hid", async () => {
		const { app, env } = buildApp({
			owns: [["inst-1", "u1"]],
			doResponse: (p) => p === "/messages"
				? Response.json({ error: "Unrecognised `before` cursor." }, { status: 400 })
				: Response.json({ ok: true }),
		});
		const res = await get(app, env, "/v1/instances/inst-1/messages?before=not-a-cursor", await tokenFor("u1"));
		expect(res.status).toBe(400);
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

// ————————————————————————————————————————————————————————————————
// Account preferences vs per-agent override (#211)
// ————————————————————————————————————————————————————————————————

describe("voice-settings resolve against the owner's account defaults (#211)", () => {
	const ACCOUNT = JSON.stringify({ voice: { speed: 130, sttMode: "openai", provider: "openai-realtime" } });

	it("an agent with NO override reports the ACCOUNT default, and says so", async () => {
		// The point of the whole change: configure once, and every agent follows. Before this a new
		// subscription seeded nothing and silently ran on platform defaults.
		const { app, env } = buildApp({ owns: [["inst-1", "u1"]], accountPreferences: ACCOUNT });
		const res = await get(app, env, "/v1/instances/inst-1/voice-settings", await tokenFor("u1"));
		const body = await res.json() as { voiceSettings: { speed: number; sttMode: string }; hasOverride: boolean };
		expect(body.voiceSettings.speed).toBe(130);
		expect(body.voiceSettings.sttMode).toBe("openai");
		expect(body.hasOverride).toBe(false);
	});

	it("an override wins, and inherits the fields it does not mention from the ACCOUNT", async () => {
		// Not from platform defaults — otherwise "customise the speed on this one agent" would
		// silently drop the user back to browser dictation.
		const { app, env } = buildApp({
			owns: [["inst-1", "u1"]],
			accountPreferences: ACCOUNT,
			instanceConfig: JSON.stringify({ voiceSettings: { speed: 90 } }),
		});
		const res = await get(app, env, "/v1/instances/inst-1/voice-settings", await tokenFor("u1"));
		const body = await res.json() as { voiceSettings: { speed: number; sttMode: string }; hasOverride: boolean };
		expect(body.voiceSettings.speed).toBe(90);
		expect(body.voiceSettings.sttMode).toBe("openai");
		expect(body.hasOverride).toBe(true);
	});

	it("keeps returning the effective object under `voiceSettings` — the SDK reads that exact key", async () => {
		// packages/sdk/src/voice/config.ts getVoiceConfig() does `d.voiceSettings`. Renaming it, or
		// returning the raw override instead of the resolved object, breaks voice in the console AND
		// coder-web with nothing in this repo failing.
		const { app, env } = buildApp({ owns: [["inst-1", "u1"]], accountPreferences: ACCOUNT });
		const body = await (await get(app, env, "/v1/instances/inst-1/voice-settings", await tokenFor("u1"))).json() as Record<string, unknown>;
		expect(body).toHaveProperty("voiceSettings");
		expect((body.voiceSettings as Record<string, unknown>).language).toBeDefined();
	});

	// #373. The one field that unions, end to end through the real route — the pure resolver is
	// tested in lib/preferences.test.ts; this is about what the SDK and the panel actually receive.
	it("resolves the vocabulary as a UNION and labels the inherited half", async () => {
		const { app, env } = buildApp({
			owns: [["inst-1", "u1"]],
			accountPreferences: JSON.stringify({ voice: { vocabulary: ["HeartFull"] } }),
			instanceConfig: JSON.stringify({ voiceSettings: { vocabulary: ["tmux"] } }),
		});
		const res = await get(app, env, "/v1/instances/inst-1/voice-settings", await tokenFor("u1"));
		const vs = (await res.json() as { voiceSettings: Record<string, unknown> }).voiceSettings;
		expect(vs.vocabulary).toEqual(["HeartFull", "tmux"]);
		// Without this the console cannot tell which words this agent OWNS, and the box that edits
		// them would save the account's words into the agent — freezing a copy nobody can see.
		expect(vs.inheritedVocabulary).toEqual(["HeartFull"]);
		expect(Array.isArray(vs.derivedVocabulary)).toBe(true);
	});

	it("a vocabulary write never absorbs the account list into the agent", async () => {
		const { app, env, writes } = buildApp({
			owns: [["inst-1", "u1"]],
			accountPreferences: JSON.stringify({ voice: { speed: 130, vocabulary: ["HeartFull"] } }),
		});
		await put(app, env, "/v1/instances/inst-1/voice-settings", { vocabulary: ["tmux"] }, await tokenFor("u1"));
		const saved = JSON.parse(String((writes.find((w) => w.sql.includes("json_set("))?.args ?? [])[1]));
		expect(saved.speed).toBe(130); // every OTHER field still seeds from the account
		expect(saved.vocabulary).toEqual(["tmux"]); // this one does not
	});

	it("PUT stores an override sanitized against the account, not the platform", async () => {
		const { app, env, writes } = buildApp({ owns: [["inst-1", "u1"]], accountPreferences: ACCOUNT });
		const res = await put(app, env, "/v1/instances/inst-1/voice-settings", { speed: 80 }, await tokenFor("u1"));
		expect(res.status).toBe(200);
		const saved = JSON.parse(String((writes.find((w) => w.sql.includes("json_set("))?.args ?? [])[1]));
		expect(saved.speed).toBe(80);
		expect(saved.sttMode).toBe("openai"); // inherited, not reset to "browser"
		expect((await res.json() as { hasOverride: boolean }).hasOverride).toBe(true);
	});

	it("DELETE removes the override entirely — absence is what 'use my defaults' means", async () => {
		const { app, env, writes } = buildApp({
			owns: [["inst-1", "u1"]],
			accountPreferences: ACCOUNT,
			instanceConfig: JSON.stringify({ displayName: "keep me", voiceSettings: { speed: 90 } }),
		});
		const res = await del(app, env, "/v1/instances/inst-1/voice-settings", await tokenFor("u1"));
		// json_remove on $.voiceSettings alone (#231). "Only the override goes" is now guaranteed
		// by the statement rather than by re-serialising a blob that could have gone stale.
		expect(writes.some((w) => w.sql.includes("json_remove(") && w.args[0] === "$.voiceSettings")).toBe(true);
		expect(writes.some((w) => /SET config = \?1/.test(w.sql))).toBe(false);
		const body = await res.json() as { voiceSettings: { speed: number }; hasOverride: boolean };
		expect(body.hasOverride).toBe(false);
		expect(body.voiceSettings.speed).toBe(130); // back to the account default
	});

	it("a declared voiceLanguage still wins — and is NOT written into storage", async () => {
		// Language Buddy's target_language. Previously the settings route COPIED it into
		// voiceSettings, which both went stale and — now that presence means "customised" — would
		// have flipped the agent off the owner's defaults just by picking a language.
		const { app, env, writes } = buildApp({
			owns: [["inst-1", "u1"]],
			accountPreferences: ACCOUNT,
			instanceAgent: {
				id: "a1", slug: "language-buddy", category: "education",
				// TOP-LEVEL settingsSchema, a sibling of `capabilities` — that is where
				// agentCapabilities reads it from (agent-capabilities.ts:379).
				config: JSON.stringify({ settingsSchema: [
					{ id: "target_language", label: "Target language", type: "select", voiceLanguage: true,
					  options: [{ value: "zh-CN", label: "Chinese" }], default: "zh-CN" },
				] }),
			},
			instanceConfig: JSON.stringify({ settings: { target_language: "zh-CN" } }),
		});
		const body = await (await get(app, env, "/v1/instances/inst-1/voice-settings", await tokenFor("u1"))).json() as {
			voiceSettings: { language: string; speed: number }; hasOverride: boolean;
		};
		expect(body.voiceSettings.language).toBe("zh-CN");
		expect(body.voiceSettings.speed).toBe(130); // the rest still comes from the account
		expect(body.hasOverride).toBe(false); // a declared language is not a customisation
		expect(writes).toHaveLength(0); // reading resolves; it never writes
	});

	it("saving a declared voiceLanguage does not create an override", async () => {
		const { app, env, writes } = buildApp({
			owns: [["inst-1", "u1"]],
			accountPreferences: ACCOUNT,
			instanceAgent: {
				id: "a1", slug: "language-buddy", category: "education",
				config: JSON.stringify({ settingsSchema: [
					{ id: "target_language", label: "Target language", type: "select", voiceLanguage: true,
					  options: [{ value: "ja-JP", label: "Japanese" }], default: "ja-JP" },
				] }),
			},
		});
		await put(app, env, "/v1/instances/inst-1/settings", { settings: { target_language: "ja-JP" } }, await tokenFor("u1"));
		const saved = JSON.parse(String((writes.find((w) => w.args[0] === "$.settings")?.args ?? [])[1]));
		expect(saved.target_language).toBe("ja-JP");
		// The point of #211: a declared voiceLanguage must not create a voiceSettings override.
		// With per-key writes that is now visible as the absence of any $.voiceSettings statement.
		expect(writes.some((w) => w.args[0] === "$.voiceSettings")).toBe(false);
	});
});

describe("apply-tips is gated on the DECLARED surface, not on an agent slug", () => {
	// It read `slug === "job-application-assistant"`. Any OTHER agent that declares `apply` — the
	// whole point of declarative capabilities — got an empty list with no error, so its Rules &
	// Tips tab was permanently blank and nothing said why. Capability, not identity.
	const applyAgent = (slug: string) => ({
		id: "a1", slug, category: "productivity",
		config: JSON.stringify({ capabilities: { surfaces: ["apply"], runtime: "browser", workflow: "JOB_APPLY" } }),
	});

	it("serves tips to a DIFFERENT agent that declares the apply surface", async () => {
		const { app, env } = buildApp({ owns: [["inst-1", "u1"]], instanceAgent: applyAgent("my-own-apply-agent") });
		const res = await get(app, env, "/v1/instances/inst-1/apply-tips", await tokenFor("u1"));
		expect(res.status).toBe(200);
		// A REAL tip, not just the right shape: a refusal also returns `{tips: []}`, so asserting
		// the key alone would pass with the gate permanently closed.
		expect((await res.json() as { tips: unknown[] }).tips).toHaveLength(1);
	});

	it("still refuses an agent that does NOT declare apply", async () => {
		// The protection this gate exists for: a user's application history must not surface inside an
		// unrelated agent such as the Coder.
		const { app, env } = buildApp({
			owns: [["inst-1", "u1"]],
			instanceAgent: {
				id: "a1", slug: "coder-repo", category: "code",
				config: JSON.stringify({ capabilities: { surfaces: ["coding"], runtime: "coding", workflow: "CODING_SESSION" } }),
			},
		});
		const res = await get(app, env, "/v1/instances/inst-1/apply-tips", await tokenFor("u1"));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ tips: [] });
	});
});

