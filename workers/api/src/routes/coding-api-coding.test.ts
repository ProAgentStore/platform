/**
 * #1042 through the real routes and the real schema: what the console and MCP may write about
 * API-key coding, and what the engines panel is told. An MCP request is the one the MCP worker sends —
 * `X-PAGS-Client: mcp` on every call (`workers/mcp/src/http.ts`).
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HttpError } from "../lib/auth.js";
import { realSchemaD1, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import { signSession } from "../lib/session.js";
import type { Env } from "../types.js";
import { registerSessionOpenRoutes } from "./coding-sessions-open.js";

const SECRET = "t1042-secret";
const KEY_PRESET = { id: "claude-api", label: "Claude (API)", command: "claude --dangerously-skip-permissions", auth: "api-key" };
const SUB = { id: "claude", label: "Claude Code", command: "claude --dangerously-skip-permissions --model sonnet" };

let d1: RealSchemaD1;
let token: string;

beforeEach(async () => {
	d1 = realSchemaD1();
	d1.exec(`INSERT INTO users (id, github_login) VALUES ('u1', 'u1')`);
	d1.exec(`INSERT INTO agents (id, owner_id, slug, name, config) VALUES ('coder', 'u1', 't1042-coder', 'Coder', '{}')`);
	d1.exec(`INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES ('i1', 'coder', 'u1', 'active', '{}')`);
	token = await signSession("u1", SECRET, { roles: [] });
});
afterEach(() => d1.close());

async function call(method: string, path: string, body?: unknown, mcp = false) {
	const routes = new Hono<{ Bindings: Env }>();
	registerSessionOpenRoutes(routes);
	const app = new Hono<{ Bindings: Env }>();
	app.route("/v1/instances", routes);
	app.onError((e, c) => c.json({ error: e.message }, e instanceof HttpError ? (e.status as 400) : 500));
	const res = await app.request(
		`/v1/instances/i1${path}`,
		{ method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(mcp ? { "X-PAGS-Client": "mcp" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) },
		{ DB: d1.DB, SESSION_SIGNING_KEY: SECRET } as unknown as Env,
	);
	// biome-ignore lint/suspicious/noExplicitAny: read field by field
	return { status: res.status, body: (await res.json()) as Record<string, any> };
}
const stored = () => JSON.parse((d1.sqlite.prepare("SELECT config FROM agent_instances WHERE id = 'i1'").get() as { config: string }).config);

describe("PUT /coding/engines — the console's confirmed opt-in (#1042)", () => {
	it("refuses an api-key preset without the acknowledgement, with the billing warning, and stores nothing", async () => {
		const r = await call("PUT", "/coding/engines", { engines: [SUB, KEY_PRESET], defaultEngineId: "claude-api" });
		expect(r.status).toBe(409);
		expect(r.body.error).toMatch(/Anthropic.*billed|bills every token.*separately from any subscription/s);
		expect(stored().codingEngines).toBeUndefined();
	});

	it("refuses it from MCP even with the acknowledgement", async () => {
		const r = await call("PUT", "/coding/engines", { engines: [SUB, KEY_PRESET], acknowledgeApiCoding: ["claude-api"] }, true);
		expect(r.status).toBe(403);
		expect(stored().codingEngines).toBeUndefined();
	});

	it("saves it from the console with the acknowledgement, recording provider, model and time", async () => {
		const r = await call("PUT", "/coding/engines", { engines: [SUB, KEY_PRESET], defaultEngineId: "claude-api", acknowledgeApiCoding: ["claude-api"] });
		expect(r.status).toBe(200);
		expect(stored().apiCodingOptIns).toEqual({ "claude-api": { command: KEY_PRESET.command, provider: "anthropic", model: null, acknowledgedAt: expect.any(String) } });
	});
});

describe("PUT /coding/engine-choice — what MCP's coding_engine_set may choose (#1042)", () => {
	beforeEach(() => {
		d1.exec(`UPDATE agent_instances SET config = '${JSON.stringify({ codingEngines: [SUB, KEY_PRESET], defaultEngineId: "claude" })}' WHERE id = 'i1'`);
	});

	it("MCP cannot select an unconfirmed API-key engine; nothing changes", async () => {
		const r = await call("PUT", "/coding/engine-choice", { engineId: "claude-api" }, true);
		expect(r.status).toBe(403);
		expect(stored().defaultEngineId).toBe("claude");
	});

	it("the console is asked to confirm it first", async () => {
		const r = await call("PUT", "/coding/engine-choice", { engineId: "claude-api" });
		expect(r.status).toBe(409);
		expect(r.body.error).toMatch(/Confirm it in the console/);
	});

	it("MCP may still choose subscription engines, and one the owner already confirmed", async () => {
		expect((await call("PUT", "/coding/engine-choice", { engineId: "claude", model: "opus" }, true)).status).toBe(200);
		await call("PUT", "/coding/engine-choice", { engineId: "claude-api", acknowledgeApiCoding: true });
		expect((await call("PUT", "/coding/engine-choice", { engineId: "claude" }, true)).status).toBe(200);
		expect((await call("PUT", "/coding/engine-choice", { engineId: "claude-api" }, true)).status).toBe(200);
		// …but not change its MODEL: another model is another bill, confirmed in the console.
		expect((await call("PUT", "/coding/engine-choice", { engineId: "claude-api", model: "claude-opus-5" }, true)).status).toBe(403);
	});

	it("each engine says how it bills", async () => {
		const r = await call("GET", "/coding/engine-choice");
		expect(Object.fromEntries(r.body.engines.map((e: { id: string; billing: string }) => [e.id, e.billing]))).toEqual({ claude: "subscription", "claude-api": "api-key" });
	});
});

describe("GET /coding/engines — what the panel is offered (#1042)", () => {
	it("defaults are subscription; API options are credential-gated; Cloudflare only with its credentials; no DeepSeek", async () => {
		const bare = await call("GET", "/coding/engines");
		expect(bare.body.engines.every((e: { auth?: string }) => e.auth !== "api-key")).toBe(true);
		expect(bare.body.apiCoding.options.every((o: { keyStored: boolean }) => !o.keyStored)).toBe(true);
		expect(bare.body.apiCoding.cloudflare).toBeNull();

		d1.exec(`INSERT INTO user_api_keys (user_id, provider, account_id, key_ciphertext, dek_wrapped, iv) VALUES ('u1', 'anthropic', '', X'00', X'00', X'00'), ('u1', 'cloudflare', 'acct', X'00', X'00', X'00')`);
		const withKeys = await call("GET", "/coding/engines");
		expect(withKeys.body.apiCoding.options.find((o: { clientType: string }) => o.clientType === "claude").keyStored).toBe(true);
		expect(withKeys.body.apiCoding.cloudflare).toMatchObject({ comingSoon: true });
		expect(JSON.stringify(withKeys.body)).not.toMatch(/deepseek/i);
		// Names only — no key material reaches the panel.
		expect(JSON.stringify(withKeys.body)).not.toMatch(/key_ciphertext|dek_wrapped/);
	});
});
