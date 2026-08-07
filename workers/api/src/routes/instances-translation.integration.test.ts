import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { HttpError } from "../lib/auth.js";
import { signSession } from "../lib/session.js";
import { registerTranslationRoutes, translationConfigOf } from "./instances-translation.js";
import type { Env } from "../types.js";

/**
 * INTEGRATION test for the under-message translation routes. Drives the real
 * handlers through the Hono app: auth (requireUser) → ownership gate
 * (requireOwnedInstance, mock D1) → config read (readInstanceConfig, mock D1) →
 * the real translate flow with the platform AI boundary (env.AI.run) mocked and
 * the message_gloss cache backed by real in-memory state. Only D1 + AI are faked.
 */

const SECRET = "translation-integration-secret";

interface GlossRow { instance_id: string; content_hash: string; target: string; transliterate: number; translation: string; transliteration: string | null; pairs: string | null }

/**
 * @param owns  (instanceId,userId) pairs that resolve to an owned instance.
 * @param configs  per-instance stored config JSON (drives translationConfigOf).
 * @param ai  when set, a recording env.AI.run stub (+ PLATFORM_AI_ENABLED=true).
 */
function buildApp(opts: {
	owns?: Array<[string, string]>;
	configs?: Record<string, Record<string, unknown>>;
	ai?: (model: string, input: unknown) => { response?: string };
} = {}) {
	const owns = new Set((opts.owns ?? []).map(([i, u]) => `${i}::${u}`));
	const configs = opts.configs ?? {};
	const gloss: GlossRow[] = [];
	const writes: Array<{ sql: string; args: unknown[] }> = [];
	const aiCalls: Array<{ model: string; input: unknown }> = [];

	const env = {
		SESSION_SIGNING_KEY: SECRET,
		PLATFORM_AI_ENABLED: opts.ai ? "true" : undefined,
		AI: opts.ai
			? { run: async (model: string, input: unknown) => { aiCalls.push({ model, input }); return opts.ai!(model, input); } }
			: undefined,
		DB: {
			prepare(sql: string) {
				return {
					bind(...args: unknown[]) {
						return {
							async first() {
								if (sql.includes("FROM agent_instances") && sql.includes("id, agent_id")) {
									const [id, uid] = args as [string, string];
									if (!owns.has(`${id}::${uid}`)) return null;
									return { id, agent_id: "a1", user_id: uid, status: "active", config: "{}", created_at: "", updated_at: "" };
								}
								if (sql.startsWith("SELECT config FROM agent_instances")) {
									const [id, uid] = args as [string, string];
									if (!owns.has(`${id}::${uid}`)) return null;
									return { config: JSON.stringify(configs[id] ?? {}) };
								}
								if (sql.includes("FROM message_gloss") && sql.includes("content_hash = ?2")) {
									const [instanceId, contentHash, target, translit] = args as [string, string, string, number];
									const row = gloss.find((g) => g.instance_id === instanceId && g.content_hash === contentHash && g.target === target && g.transliterate === translit);
									return row ? { translation: row.translation, transliteration: row.transliteration, pairs: row.pairs } : null;
								}
								return null;
							},
							async all() {
								if (sql.includes("FROM message_gloss")) return { results: [] };
								return { results: [] };
							},
							async run() {
								writes.push({ sql, args });
								if (sql.includes("INTO message_gloss")) {
									const [instance_id, content_hash, target, transliterate, translation, transliteration, pairs] = args as [string, string, string, number, string, string | null, string | null];
									const i = gloss.findIndex((g) => g.instance_id === instance_id && g.content_hash === content_hash && g.target === target && g.transliterate === transliterate);
									const rec: GlossRow = { instance_id, content_hash, target, transliterate, translation, transliteration, pairs };
									if (i >= 0) gloss[i] = rec; else gloss.push(rec);
								}
								return { meta: { changes: 1 } };
							},
						};
					},
				};
			},
		},
	} as unknown as Env;

	const app = new Hono<{ Bindings: Env }>();
	const router = new Hono<{ Bindings: Env }>();
	registerTranslationRoutes(router);
	app.route("/v1/instances", router);
	app.onError((err, c) => {
		if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
		throw err;
	});
	return { app, env, gloss, writes, aiCalls };
}

const tokenFor = (uid: string) => signSession(uid, SECRET, { roles: ["user"] });

function req(app: Hono, env: unknown, method: string, path: string, body: unknown, tok?: string) {
	return app.request(path, {
		method,
		headers: { ...(tok ? { Authorization: `Bearer ${tok}` } : {}), "Content-Type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	}, env);
}

describe("translationConfigOf (pure normalization)", () => {
	it("defaults to disabled English with sane fallbacks", () => {
		const t = translationConfigOf({});
		expect(t).toEqual({ enabled: false, target: "English", targetTag: "en-US", transliterate: false, wordTap: true, fontSize: "medium" });
	});

	it("resolves a known target name to its BCP-47 tag and honors flags", () => {
		const t = translationConfigOf({ translation: { enabled: true, target: "Chinese (Simplified)", transliterate: true, wordTap: false, fontSize: "large" } });
		expect(t.enabled).toBe(true);
		expect(t.targetTag).toBe("zh-CN");
		expect(t.transliterate).toBe(true);
		expect(t.wordTap).toBe(false);
		expect(t.fontSize).toBe("large");
	});
});

describe("GET /v1/instances/:id/translation (integration)", () => {
	it("401s without a token", async () => {
		const { app, env } = buildApp({ owns: [["inst-1", "u1"]] });
		const res = await req(app, env, "GET", "/v1/instances/inst-1/translation", undefined);
		expect(res.status).toBe(401);
	});

	it("404s when the caller doesn't own the instance", async () => {
		const { app, env } = buildApp({ owns: [] });
		const res = await req(app, env, "GET", "/v1/instances/inst-1/translation", undefined, await tokenFor("u1"));
		expect(res.status).toBe(404);
		expect((await res.json() as { error: string }).error).toContain("Instance not found");
	});

	it("returns the resolved config + the language catalog for the owner", async () => {
		const { app, env } = buildApp({ owns: [["inst-1", "u1"]], configs: { "inst-1": { translation: { enabled: true, target: "Spanish" } } } });
		const res = await req(app, env, "GET", "/v1/instances/inst-1/translation", undefined, await tokenFor("u1"));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { translation: { enabled: boolean; target: string; targetTag: string }; languages: Array<{ name: string; tag: string }> };
		expect(body.translation.enabled).toBe(true);
		expect(body.translation.target).toBe("Spanish");
		expect(body.translation.targetTag).toBe("es-ES");
		expect(body.languages.some((l) => l.tag === "zh-CN")).toBe(true);
	});
});

describe("PUT /v1/instances/:id/translation (integration)", () => {
	it("404s on an unowned instance before any write", async () => {
		const { app, env, writes } = buildApp({ owns: [] });
		const res = await req(app, env, "PUT", "/v1/instances/inst-1/translation", { enabled: true, target: "French" }, await tokenFor("u1"));
		expect(res.status).toBe(404);
		expect(writes).toHaveLength(0);
	});

	it("persists the normalized config and echoes the resolved tag", async () => {
		const { app, env, writes } = buildApp({ owns: [["inst-1", "u1"]] });
		const res = await req(app, env, "PUT", "/v1/instances/inst-1/translation", { enabled: true, target: "French", transliterate: true, fontSize: "large" }, await tokenFor("u1"));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { translation: { enabled: boolean; target: string; targetTag: string; fontSize: string } };
		expect(body.translation.targetTag).toBe("fr-FR");
		expect(body.translation.fontSize).toBe("large");
		// A targeted json_set on $.translation, not a whole-blob rewrite (#231) — a whole-blob
		// write here would drop a settings or behaviour change saved from another tab.
		const upd = writes.find((w) => w.sql.includes("json_set(") && w.args[0] === "$.translation");
		expect(upd).toBeTruthy();
		expect(writes.some((w) => /SET config = \?1/.test(w.sql))).toBe(false);
		const stored = JSON.parse(upd!.args[1] as string) as { target: string; enabled: boolean };
		expect(stored.target).toBe("French");
		expect(stored.enabled).toBe(true);
	});

	it("falls back to English for an unknown target name", async () => {
		const { app, env } = buildApp({ owns: [["inst-1", "u1"]] });
		const res = await req(app, env, "PUT", "/v1/instances/inst-1/translation", { enabled: true, target: "Klingon" }, await tokenFor("u1"));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { translation: { target: string; targetTag: string } };
		expect(body.translation.target).toBe("English");
		expect(body.translation.targetTag).toBe("en-US");
	});
});

describe("POST /v1/instances/:id/translate (integration)", () => {
	it("400s when translation is not enabled", async () => {
		const { app, env } = buildApp({ owns: [["inst-1", "u1"]], configs: { "inst-1": {} } });
		const res = await req(app, env, "POST", "/v1/instances/inst-1/translate", { text: "hello" }, await tokenFor("u1"));
		expect(res.status).toBe(400);
		expect((await res.json() as { error: string }).error).toContain("not enabled");
	});

	it("400s when text is missing", async () => {
		const { app, env } = buildApp({ owns: [["inst-1", "u1"]], configs: { "inst-1": { translation: { enabled: true, target: "Spanish" } } } });
		const res = await req(app, env, "POST", "/v1/instances/inst-1/translate", {}, await tokenFor("u1"));
		expect(res.status).toBe(400);
		expect((await res.json() as { error: string }).error).toContain("text required");
	});

	it("404s an unowned instance", async () => {
		const { app, env } = buildApp({ owns: [] });
		const res = await req(app, env, "POST", "/v1/instances/inst-1/translate", { text: "hi" }, await tokenFor("u1"));
		expect(res.status).toBe(404);
	});

	it("translates via platform AI, returns + caches the result (plain mode)", async () => {
		const { app, env, gloss, aiCalls } = buildApp({
			owns: [["inst-1", "u1"]],
			configs: { "inst-1": { translation: { enabled: true, target: "Spanish" } } },
			ai: () => ({ response: "hola mundo" }),
		});
		const tok = await tokenFor("u1");
		const res = await req(app, env, "POST", "/v1/instances/inst-1/translate", { text: "hello world" }, tok);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ translation: "hola mundo" });
		expect(aiCalls).toHaveLength(1);
		expect(gloss).toHaveLength(1);
		expect(gloss[0].translation).toBe("hola mundo");

		// Second identical request is served from cache (no new AI call).
		const res2 = await req(app, env, "POST", "/v1/instances/inst-1/translate", { text: "hello world" }, tok);
		expect(res2.status).toBe(200);
		expect((await res2.json() as { translation: string }).translation).toBe("hola mundo");
		expect(aiCalls).toHaveLength(1);
	});

	it("parses interlinear word pairs in transliterate mode", async () => {
		const { app, env, gloss } = buildApp({
			owns: [["inst-1", "u1"]],
			configs: { "inst-1": { translation: { enabled: true, target: "Chinese (Simplified)", transliterate: true } } },
			ai: () => ({ response: JSON.stringify({ translation: "你好", pairs: [["你好", "nǐ hǎo"]] }) }),
		});
		const res = await req(app, env, "POST", "/v1/instances/inst-1/translate", { text: "hi" }, await tokenFor("u1"));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { translation: string; pairs: Array<[string, string]>; transliteration?: string };
		expect(body.translation).toBe("你好");
		expect(body.pairs).toEqual([["你好", "nǐ hǎo"]]);
		expect(gloss[0].transliterate).toBe(1);
	});

	it("502s when no AI provider responds (platform disabled + no BYOK key)", async () => {
		const { app, env } = buildApp({
			owns: [["inst-1", "u1"]],
			configs: { "inst-1": { translation: { enabled: true, target: "Spanish" } } },
			// no `ai` → PLATFORM_AI_ENABLED unset, and runUserWorkersAi has no key → throws → "".
		});
		const res = await req(app, env, "POST", "/v1/instances/inst-1/translate", { text: "hello" }, await tokenFor("u1"));
		expect(res.status).toBe(502);
		expect((await res.json() as { error: string }).error).toContain("Translation failed");
	});
});
