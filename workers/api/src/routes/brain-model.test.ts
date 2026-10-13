/**
 * #1043 — a coder's Brain model, through the real routes and schema: the Brain card's `PUT /state` and
 * MCP set_coder_brain's `PUT /coder-brain`. The proof the issue asks for: changing the Brain cannot
 * change the coding engine or how it signs in — the stored engine config is byte-identical and
 * `resolveEngineEnv` answers exactly as before — and nothing on the engine path reads the Brain at all.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { realSchemaD1, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import { signSession } from "../lib/session.js";
import type { Env } from "../types.js";

const keys = vi.hoisted(() => new Map<string, string>());
vi.mock("../lib/user-ai.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../lib/user-ai.js")>()),
	getUserProviderKey: async (_env: unknown, _uid: string, provider: string) => keys.get(provider) ?? null,
}));
// Cloudflare is not asked from a test: stored credentials count as working.
vi.mock("../lib/cloudflare-ai-check.js", () => ({ cloudflareAiCredentialProblem: async () => null }));

const { instanceStorageRoutes } = await import("./storage.js");
const { registerCoderBrainRoutes } = await import("./instances-coder-brain.js");
const { resolveEngineEnv } = await import("../lib/coding-engines.js");
const { BRAIN_MODELS, activeBrainLabel } = await import("../lib/brain-models.js");
const { DEFAULT_BRAIN_MODEL, advisoryBrain, brainModelRefusal, readInstanceBrain } = await import("../lib/instance-brain.js");
const { readCoderBrain } = await import("../lib/coder-brain.js");

const SECRET = "t1043-secret";
const SCOUT = "@cf/meta/llama-4-scout-17b-16e-instruct";
const ENGINE_CONFIG = {
	codingEngines: [
		{ id: "claude", label: "Claude Code", command: "claude --dangerously-skip-permissions" },
		{ id: "claude-api", label: "Claude (API)", command: "claude --model claude-sonnet-4-6", auth: "api-key" },
	],
	defaultEngineId: "claude",
	apiCodingOptIns: { "claude-api": { command: "claude --model claude-sonnet-4-6", provider: "anthropic", model: "claude-sonnet-4-6", acknowledgedAt: "2026-10-13T00:00:00Z" } },
	coderBrain: { enabled: true, poEnabled: false, model: "claude-sonnet-4-6" },
};

let d1: RealSchemaD1;
let token: string;
let doState: Map<string, Record<string, unknown>>;
let env: Env;

/** The instance DO's `/state`, as agent-do.ts answers it: a model write records `modelChosen` only as the route says. */
function fakeAgent() {
	return {
		idFromName: (n: string) => n,
		get: (id: string) => ({
			fetch: async (req: Request) => {
				const s = doState.get(id) ?? {};
				if (req.method === "PUT") {
					const u = (await req.json()) as Record<string, unknown>;
					const next = { ...s, ...u };
					if (u.model !== undefined) next.modelChosen = u.modelChosen === true;
					doState.set(id, next);
					return Response.json(next);
				}
				return Response.json(s);
			},
		}),
	};
}

beforeEach(async () => {
	keys.clear();
	keys.set("anthropic", "sk-ant-x");
	doState = new Map();
	d1 = realSchemaD1();
	d1.exec(`INSERT INTO users (id, github_login) VALUES ('u1', 'u1')`);
	d1.exec(`INSERT INTO agents (id, owner_id, slug, name, config) VALUES ('coder', 'u1', 't1043-coder', 'Coder', '{"capabilities":{"surfaces":["coding"],"runtime":"coding","workflow":"CODING_SESSION"}}')`);
	d1.exec(`INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES ('i1', 'coder', 'u1', 'active', '${JSON.stringify(ENGINE_CONFIG)}')`);
	token = await signSession("u1", SECRET, { roles: [] });
	env = { DB: d1.DB, AGENT: fakeAgent(), SESSION_SIGNING_KEY: SECRET } as unknown as Env;
});
afterEach(() => d1.close());

async function call(method: string, path: string, body?: unknown, mcp = false) {
	const routes = new Hono<{ Bindings: Env }>();
	routes.route("/", instanceStorageRoutes);
	registerCoderBrainRoutes(routes);
	const app = new Hono<{ Bindings: Env }>();
	app.route("/v1/instances", routes);
	app.onError((e, c) => c.json({ error: e.message }, e instanceof HttpError ? (e.status as 400) : 500));
	const res = await app.request(
		`/v1/instances/i1${path}`,
		{ method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(mcp ? { "X-PAGS-Client": "mcp" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) },
		env,
	);
	// biome-ignore lint/suspicious/noExplicitAny: read field by field
	return { status: res.status, body: (await res.json()) as Record<string, any> };
}
const config = () => JSON.parse((d1.sqlite.prepare("SELECT config FROM agent_instances WHERE id = 'i1'").get() as { config: string }).config);
const engineSide = () => {
	const { codingEngines, defaultEngineId, apiCodingOptIns } = config();
	return JSON.stringify({ codingEngines, defaultEngineId, apiCodingOptIns });
};
const engineEnvs = async () => ({
	sub: await resolveEngineEnv(env, "i1", "u1", { id: "s1", clientType: "claude", launchCommand: "claude --dangerously-skip-permissions" } as never),
	api: await resolveEngineEnv(env, "i1", "u1", { id: "s2", clientType: "claude", launchCommand: "claude --model claude-sonnet-4-6" } as never),
});

describe("changing the Brain model cannot change the coding engine or its sign-in (#1043)", () => {
	it("through the Brain card (PUT /state): the Brain changes; engine config and engine env are identical", async () => {
		d1.exec(`INSERT INTO user_api_keys (user_id, provider, account_id, key_ciphertext, dek_wrapped, iv) VALUES ('u1', 'cloudflare', 'acct', X'00', X'00', X'00')`);
		const engineBefore = engineSide();
		const envBefore = await engineEnvs();
		const r = await call("PUT", "/state", { model: SCOUT });
		expect(r.status).toBe(200);
		expect(await readInstanceBrain(env, "i1")).toEqual({ model: SCOUT, modelChosen: true });
		expect(engineSide()).toBe(engineBefore);
		expect(await engineEnvs()).toEqual(envBefore);
		expect(envBefore).toEqual({ sub: { ANTHROPIC_API_KEY: "", CLAUDE_CODE_OAUTH_TOKEN: "" }, api: { ANTHROPIC_API_KEY: "sk-ant-x" } });
	});

	it("through MCP set_coder_brain (PUT /coder-brain model): the coder's Brain changes, the engine does not", async () => {
		d1.exec(`INSERT INTO user_api_keys (user_id, provider, account_id, key_ciphertext, dek_wrapped, iv) VALUES ('u1', 'cloudflare', 'acct', X'00', X'00', X'00')`);
		const engineBefore = engineSide();
		const envBefore = await engineEnvs();
		const r = await call("PUT", "/coder-brain", { model: SCOUT }, true);
		expect(r.status).toBe(200);
		expect(r.body.settings).toMatchObject({ model: SCOUT, modelChosen: true });
		expect(await readInstanceBrain(env, "i1")).toEqual({ model: SCOUT, modelChosen: true });
		// One setting: the picked Brain is not copied into the coder-brain config.
		expect(config().coderBrain.model).toBeUndefined();
		expect(engineSide()).toBe(engineBefore);
		expect(await engineEnvs()).toEqual(envBefore);
	});

	it("a Cloudflare pick without Cloudflare credentials is refused — and changes nothing at all", async () => {
		const before = JSON.stringify(config());
		for (const [path, body] of [["/state", { model: SCOUT }], ["/coder-brain", { model: SCOUT }]] as const) {
			const r = await call("PUT", path, body);
			expect(r.status).toBe(400);
			expect(r.body.error).toMatch(/no Cloudflare credentials are stored/);
		}
		expect(JSON.stringify(config())).toBe(before);
		expect(doState.get("i1")).toBeUndefined();
	});

	it("nothing on the engine path reads the Brain: an unreachable Brain still resolves the engine exactly", async () => {
		const envBefore = await engineEnvs();
		env = { DB: d1.DB } as unknown as Env; // no AGENT binding at all — a Brain read would throw
		expect(await engineEnvs()).toEqual(envBefore);
		const src = (f: string) => readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../lib", f), "utf8");
		for (const f of ["coding-engines.ts", "coding-api-policy.ts", "coding-session-open.ts"]) expect(src(f)).not.toMatch(/instance-brain|advisoryBrain|readInstanceBrain/);
		// …and the Pilot that drives the engine stays on Sonnet, outside the Brain selector.
		expect(src("coding-loop.ts")).not.toMatch(/instance-brain|advisoryBrain/);
		expect(src("coding-loop.ts")).toMatch(/runUserWorkersAi\(env, userId, "claude-sonnet-4-6"/);
	});
});

describe("the Brain reaches the advisory surfaces (#1043)", () => {
	it("advisory calls run the picked Brain on its own provider; until one is picked they run the default as before", async () => {
		expect(await advisoryBrain(env, "i1")).toEqual({ model: DEFAULT_BRAIN_MODEL, modelChosen: false });
		doState.set("i1", { model: SCOUT, modelChosen: false }); // set by a template, not picked: not honoured
		expect(await advisoryBrain(env, "i1")).toEqual({ model: DEFAULT_BRAIN_MODEL, modelChosen: false });
		doState.set("i1", { model: SCOUT, modelChosen: true });
		expect(await advisoryBrain(env, "i1")).toEqual({ model: SCOUT, modelChosen: true });
		expect(await advisoryBrain({ AGENT: undefined } as unknown as Env, "i1")).toEqual({ model: DEFAULT_BRAIN_MODEL, modelChosen: false });
	});

	it("coder-brain decisions use the coder's Brain once picked, and keep a pre-#1043 model until then", async () => {
		d1.exec(`UPDATE agent_instances SET config = json_set(config, '$.coderBrain.model', '@cf/qwen/qwen2.5-coder-32b-instruct') WHERE id = 'i1'`);
		expect(await readCoderBrain(env, "i1", "u1")).toMatchObject({ model: "@cf/qwen/qwen2.5-coder-32b-instruct", modelChosen: false });
		doState.set("i1", { model: SCOUT, modelChosen: true });
		expect(await readCoderBrain(env, "i1", "u1")).toMatchObject({ model: SCOUT, modelChosen: true });
	});

	it("the Co-pilot, Loop and repo-agent calls are routed through the Brain (not hard-wired)", () => {
		const src = (f: string) => readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", f), "utf8");
		for (const f of ["lib/coding-copilot.ts", "lib/loop-orchestrator.ts", "routes/coding-brains.ts"]) {
			expect(src(f), f).toMatch(/advisoryBrain\(/);
			expect(src(f), f).toMatch(/honorModel: brain\.modelChosen/);
		}
	});

	it("shows the active Brain in words, always as advisory", () => {
		expect(activeBrainLabel({ model: SCOUT, modelChosen: true })).toBe("Brain: Llama 4 Scout 17B (Cloudflare Workers AI) · advisory only");
		expect(activeBrainLabel({})).toBe("Brain: Claude Sonnet 4.6 (Anthropic) — default · advisory only");
	});
});

describe("DeepSeek is absent (#1043)", () => {
	it("is not a brain model, and a DeepSeek pick is refused", async () => {
		expect(JSON.stringify(BRAIN_MODELS)).not.toMatch(/deepseek/i);
		expect(await brainModelRefusal(env, "u1", "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b")).toMatchObject({ status: 400 });
	});
});

describe("PUT /coder-brain: turning PO triage on creates a LIVE trigger unless a dry run is asked for (#1061)", () => {
	const triage = () => (d1.sqlite.prepare("SELECT config FROM agent_triggers WHERE instance_id = 'i1' AND action = 'run_po_triage'").all() as Array<{ config: string }>).map((r) => JSON.parse(r.config).dryRun);

	it("by default the created trigger queues for real", async () => {
		expect((await call("PUT", "/coder-brain", { enabled: true, poEnabled: true }, true)).status).toBe(200);
		expect(triage()).toEqual([false]);
	});

	it("poDryRun: true creates it as a dry run", async () => {
		expect((await call("PUT", "/coder-brain", { enabled: true, poEnabled: true, poDryRun: true }, true)).status).toBe(200);
		expect(triage()).toEqual([true]);
	});

	it("a poDryRun that is not a boolean is refused, and nothing is created", async () => {
		const r = await call("PUT", "/coder-brain", { enabled: true, poEnabled: true, poDryRun: "yes" }, true);
		expect(r).toMatchObject({ status: 400, body: { error: "poDryRun must be true or false" } });
		expect(triage()).toEqual([]);
	});
});
