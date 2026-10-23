import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HttpError } from "../lib/auth.js";
import { realSchemaD1, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import { signSession } from "../lib/session.js";
import type { Env } from "../types.js";
import { registerCoderBrainRoutes } from "./instances-coder-brain.js";

const SECRET = "pilot-route-test";
const SONNET = "claude-sonnet-4-6";
const HAIKU = "claude-haiku-5-5";
let db: RealSchemaD1;
let env: Env;
let token: string;
let stateWrites: number;
const config = () => JSON.parse((db.sqlite.prepare("SELECT config FROM agent_instances WHERE id = 'i1'").get() as { config: string }).config);
const triggers = () => db.sqlite.prepare("SELECT * FROM agent_triggers WHERE instance_id = 'i1'").all();

beforeEach(async () => {
	db = realSchemaD1(); stateWrites = 0;
	db.exec("INSERT INTO users (id, github_login) VALUES ('u1', 'u1'), ('u2', 'u2')");
	db.exec(`INSERT INTO agents (id, owner_id, slug, name, config) VALUES ('a1', 'u1', 'pilot-coder', 'Coder', '{"capabilities":{"workflow":"CODING_SESSION","surfaces":["coding"],"runtime":"coding"}}')`);
	db.exec(`INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES ('i1', 'a1', 'u1', 'active', '{"coderBrain":{"enabled":false,"poEnabled":true,"model":"claude-sonnet-4-6"},"codingEngines":[{"id":"claude","command":"claude --model opus"}],"defaultEngineId":"claude","sentinel":42}')`);
	db.exec("INSERT INTO agent_triggers (id, user_id, agent_id, instance_id, name, type, action, enabled, schedule) VALUES ('t1', 'u1', 'a1', 'i1', 'Existing schedule', 'cron', 'run_po_triage', 1, '@daily')");
	token = await signSession("u1", SECRET, { roles: [] });
	env = { DB: db.DB, SESSION_SIGNING_KEY: SECRET, AGENT: { idFromName: (id: string) => id, get: () => ({ fetch: async (req: Request) => {
		if (req.method === "PUT") stateWrites++;
		return Response.json({ model: "@cf/meta/llama-4-scout-17b-16e-instruct", modelChosen: true });
	} }) } } as unknown as Env;
});
afterEach(() => db.close());

async function call(method: string, body?: unknown, path = "coder-brain") {
	const app = new Hono<{ Bindings: Env }>();
	registerCoderBrainRoutes(app);
	app.onError((e, c) => c.json({ error: e.message }, e instanceof HttpError ? e.status as 400 : 500));
	const res = await app.request(`/i1/${path}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, env);
	return { status: res.status, body: await res.json() as { pilot?: { model: string; fallbackModel: string; options: Array<{ id: string }> }; error?: string } };
}

describe("Pilot configuration is an owner-scoped policy, separate from Brain and CLI (#1316)", () => {
	it("reads Sonnet by default and the exact two-model catalogue, including through the MCP reader", async () => {
		for (const path of ["coder-brain", "po-triage/reports"]) {
			const r = await call("GET", undefined, path);
			expect(r.status).toBe(200);
			expect(r.body.pilot).toMatchObject({ model: SONNET, fallbackModel: SONNET });
			expect(r.body.pilot?.options.map((o) => o.id)).toEqual([SONNET, HAIKU]);
		}
	});

	it("writes only pilot.model, preserving raw brain flags, existing schedules, advisory state and CLI config", async () => {
		const before = config(); const schedules = triggers();
		const r = await call("PUT", { pilotModel: HAIKU });
		expect(r).toMatchObject({ status: 200, body: { pilot: { model: HAIKU, fallbackModel: SONNET } } });
		expect(config()).toEqual({ ...before, pilot: { model: HAIKU } });
		expect(triggers()).toEqual(schedules);
		expect(stateWrites).toBe(0);
		expect((await call("GET")).body.pilot?.model).toBe(HAIKU);
	});

	it.each(["claude-haiku-4-5", "haiku", "", null, 42])("refuses unsupported Pilot %j before any requested brain mutation", async (pilotModel) => {
		const before = config(); const schedules = triggers();
		expect((await call("PUT", { pilotModel, enabled: true })).status).toBe(400);
		expect(config()).toEqual(before);
		expect(triggers()).toEqual(schedules);
		expect(stateWrites).toBe(0);
	});

	it("requires a CODING_SESSION instance even when selecting the default", async () => {
		db.exec(`UPDATE agents SET config = '{"capabilities":{"surfaces":["repo"]}}' WHERE id = 'a1'`);
		expect((await call("PUT", { pilotModel: SONNET })).status).toBe(409);
		expect(config().pilot).toBeUndefined();
	});

	it("refuses a different owner and unauthenticated writes", async () => {
		token = await signSession("u2", SECRET, { roles: [] });
		expect((await call("PUT", { pilotModel: HAIKU })).status).toBe(404);
		token = "";
		expect((await call("PUT", { pilotModel: HAIKU })).status).toBe(401);
		expect(config().pilot).toBeUndefined();
	});
});
