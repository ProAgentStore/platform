/** Real-schema research sync regressions: website permission never consumes profile consent
 * or rewinds an already-resumed run to the status of an older runner response. */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { realSchemaD1, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import type { Env } from "../types.js";

vi.mock("../lib/auth.js", async () => ({
	...await vi.importActual<typeof import("../lib/auth.js")>("../lib/auth.js"),
	requireUser: async () => ({ uid: "owner", roles: [] }),
}));
const { connection } = vi.hoisted(() => ({ connection: vi.fn() }));
vi.mock("../lib/runner-client.js", async (original) => ({
	...await original<typeof import("../lib/runner-client.js")>(), getBoundRunnerConn: connection,
}));
const { instanceRoutes } = await import("./instances.js");

let db: RealSchemaD1;
let status: Record<string, unknown>;
let sent: Array<{ path: string; body: Record<string, unknown>; browserWebsiteAccess?: unknown }>;
const at = "2026-11-04T01:00:00Z";
const hostname = "jobs.example.com";
const pause = { hostname, pauseKey: "website-pause-1", url: `https://${hostname}/jobs` };
const relay = {
	idFromName: (name: string) => name,
	get: () => ({ fetch: async (request: Request) => {
		const command = await request.json() as (typeof sent)[number];
		sent.push(command);
		if (command.path === "/capabilities") return Response.json({ taskTypes: ["local_browser.research"] });
		if (command.path === "/local-browser/run") return Response.json({ taskId: "native-research" }, { status: 202 });
		if (command.path === "/local-browser/status") return Response.json(status);
		if (command.path === "/local-browser/shots") return Response.json({ shots: [] });
		if (command.path === "/local-browser/resume") {
			status = { state: "running", lastSeq: 2, events: [{ seq: 2, type: "run.resumed", at }] };
			return Response.json(status);
		}
		return Response.json({});
	} }),
};

beforeEach(() => {
	db = realSchemaD1();
	db.exec(`INSERT INTO users (id, github_login) VALUES ('owner', 'owner');
		INSERT INTO agents (id, owner_id, slug, name, config) VALUES ('scout', 'owner', 'website-review-scout', 'Research agent', '{"capabilities":{"surfaces":[],"runtime":"local_browser","localBrowser":{"allowDomains":["example.com"]}}}');
		INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES ('agent', 'scout', 'owner', 'active', '{"runnerNode":"mac"}');
		INSERT INTO instance_runtime_nodes (instance_id,user_id,runner_node,endpoint_url,runner_version,status,last_seen_at) VALUES ('agent','owner','mac','relay://','0.4.209','online','2026-11-04 01:00:00');`);
	connection.mockReset();
	connection.mockResolvedValue({ runnerNode: "mac", instanceId: "agent", userId: "owner", relayName: "agent:node:mac", endpointUrl: "relay://", token: "", env: {} });
	status = { state: "running", lastSeq: 0, events: [] };
	sent = [];
});
afterEach(() => db.close());

async function call(method: string, path: string, body?: unknown) {
	const app = new Hono<{ Bindings: Env }>();
	app.route("/v1/instances", instanceRoutes);
	app.onError((error, context) => error instanceof HttpError ? context.json({ error: error.message }, error.status as 400) : context.json({ error: String(error) }, 500));
	const response = await app.request(`/v1/instances/agent${path}`, { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, { DB: db.DB, RELAY: relay } as unknown as Env);
	return { status: response.status, body: await response.json() as Record<string, unknown> };
}

async function start() {
	expect((await call("PUT", "/browser-settings", { websiteAccess: { mode: "ask_once", domains: [] } })).status).toBe(200);
	expect((await call("PUT", "/local-browser/settings", { browserProfile: "default" })).status).toBe(200);
	const started = await call("POST", "/local-browser/runs", { objective: "Read public job listings" });
	expect(started.status, JSON.stringify(started.body)).toBe(202);
	expect(started.body.status).toBe("running");
	return String(started.body.id);
}

describe("website permission research integration", () => {
	it("ask-once preserves the separate signed-in-profile consent handoff and notification", async () => {
		const runId = await start();
		status = { state: "paused", pauseReason: "consent_required", lastSeq: 1, events: [{ seq: 1, type: "run.paused", at, pauseReason: "consent_required", detail: { scope: "signed_in_profile" } }] };
		const current = await call("GET", `/local-browser/runs/${runId}`);
		expect(current.body).toMatchObject({ status: "paused", pauseReason: "consent_required" });
		expect(await db.DB.prepare("SELECT subject_kind,subject_id FROM browser_takeovers WHERE instance_id='agent' AND user_id='owner'").first()).toMatchObject({ subject_kind: "local_browser_run", subject_id: runId });
		expect(await db.DB.prepare("SELECT type FROM notifications WHERE user_id='owner'").first()).toMatchObject({ type: "local-browser" });
		expect((await db.DB.prepare("SELECT COUNT(*) AS n FROM website_access_requests").first<{ n: number }>())?.n).toBe(0);
		expect(sent.filter((command) => command.path === "/local-browser/resume")).toHaveLength(0);
	});

	it.each(["allow", "deny"] as const)("a remembered %s answers one exact pause once and leaves cloud state running", async (decision) => {
		const runId = await start();
		db.exec(`INSERT INTO website_access_requests (id,user_id,instance_id,subject_kind,subject_id,hostname,pause_key,status,created_at,decided_at) VALUES ('prior-question','owner','agent','local_browser_run','prior-run','jobs.example.com','prior-pause','${decision === "allow" ? "approved" : "denied"}',1,2);
			INSERT INTO website_access_grants (user_id,instance_id,hostname,decision,request_id,decided_at) VALUES ('owner','agent','jobs.example.com','${decision}','prior-question',2);`);
		status = { state: "paused", pauseReason: "consent_required", websitePause: pause, lastSeq: 1, events: [{ seq: 1, type: "run.paused", at, pauseReason: "consent_required", detail: { scope: "navigate", websitePause: pause } }] };
		const current = await call("GET", `/local-browser/runs/${runId}`);
		expect(current.body).toMatchObject({ id: runId, status: "running", pauseReason: null });
		const resumes = sent.filter((command) => command.path === "/local-browser/resume");
		expect(resumes).toHaveLength(1);
		expect(resumes[0].body).toMatchObject({ runId, expectedWebsitePauseKey: pause.pauseKey, websiteDecision: decision, profileConsented: false });
		expect(resumes[0].browserWebsiteAccess).toMatchObject({ mode: "ask_once", domains: [], ...(decision === "allow" ? { rememberedDomains: [hostname] } : { deniedDomains: [hostname] }) });
		expect(await db.DB.prepare("SELECT status,pause_reason FROM local_browser_runs WHERE id=?1").bind(runId).first()).toMatchObject({ status: "running", pause_reason: null });
		expect(sent.filter((command) => command.path === "/local-browser/run")).toHaveLength(1);
		expect((await db.DB.prepare("SELECT COUNT(*) AS n FROM website_access_requests").first<{ n: number }>())?.n).toBe(1);
	});
});
