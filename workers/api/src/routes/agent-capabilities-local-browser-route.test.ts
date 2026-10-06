/**
 * The creator's capabilities routes serve the RESOLVED local browser block (#946), so the Agent
 * Builder edits what a run will actually get — and refuse an invalid one with the reason.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { realSchemaD1, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import type { Env } from "../types.js";

vi.mock("../lib/auth.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/auth.js")>("../lib/auth.js");
	return { ...actual, requireUser: async () => ({ uid: "u1", roles: [] }) };
});
const { agentRoutes } = await import("./agents.js");

let d1: RealSchemaD1;
beforeEach(() => {
	d1 = realSchemaD1();
	d1.exec(`INSERT INTO users (id, github_login) VALUES ('u1', 'u1')`);
	d1.exec(`INSERT INTO agents (id, owner_id, slug, name, config) VALUES ('scout', 'u1', 't946-scout', 'Scout', '{"capabilities":{"surfaces":[],"runtime":"local_browser","localBrowser":{"engines":["codex"]}}}'), ('chat', 'u1', 't946-chat', 'Chat', '{}')`);
});
afterEach(() => d1.close());

async function call(method: string, id: string, body?: unknown) {
	const app = new Hono<{ Bindings: Env }>();
	app.route("/v1/agents", agentRoutes);
	app.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500)));
	const res = await app.request(`/v1/agents/${id}/capabilities`, { method, headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }, { DB: d1.DB } as unknown as Env);
	return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("capabilities and the local browser block (#946)", () => {
	it("GET serves the resolved block, defaults filled in, and null for any other runtime", async () => {
		expect((await call("GET", "scout")).body.localBrowser).toMatchObject({ engines: ["codex"], mode: "research_only", subscriptionOnly: true, limits: { maxMinutes: 15, maxPages: 30 } });
		expect((await call("GET", "chat")).body.localBrowser).toBeNull();
	});

	it("PUT stores a valid block and serves it back resolved", async () => {
		const r = await call("PUT", "chat", { runtime: "local_browser", localBrowser: { allowDomains: ["Seek.com.au"], limits: { maxPages: 50 }, collection: { name: "job_leads", keyField: "url" } } });
		expect(r.status).toBe(200);
		expect(r.body).toMatchObject({ runtime: "local_browser", localBrowser: { allowDomains: ["seek.com.au"], limits: { maxPages: 50 }, collection: { name: "job_leads", keyField: "url" } } });
		expect((await call("GET", "chat")).body.localBrowser).toMatchObject({ allowDomains: ["seek.com.au"] });
	});

	it("PUT refuses an invalid block, and the block on another runtime, and stores nothing", async () => {
		expect((await call("PUT", "scout", { localBrowser: { limits: { maxMinutes: 999 } } })).body.error).toMatch(/maxMinutes/);
		expect((await call("PUT", "chat", { runtime: "coding", localBrowser: {} })).body.error).toMatch(/requires capabilities.runtime "local_browser"/);
		expect((await call("GET", "scout")).body.localBrowser).toMatchObject({ limits: { maxMinutes: 15 } });
	});
});
