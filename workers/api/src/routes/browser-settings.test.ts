/** Configuration inheritance, dispatch authority and truthful launch evidence (#1431). */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import { callRunner } from "../lib/runner-client.js";
import { agentCapabilities } from "../lib/agent-capabilities.js";
import { registerBrowserSettingsRoutes } from "./instances-browser-settings.js";
import { callRuntime, type RuntimeRow } from "./instances-runtime.js";
import type { Env } from "../types.js";

vi.mock("../lib/auth.js", async () => ({ ...(await vi.importActual<typeof import("../lib/auth.js")>("../lib/auth.js")), requireUser: async () => ({ uid: "u1", roles: [] }), requireCreator: async () => ({ uid: "u1", roles: ["creator"] }) }));
const { agentRoutes } = await import("./agents.js");
let d1: RealSchemaD1;
let app: Hono<{ Bindings: Env }>;
let sent: Array<Record<string, unknown>>;
let receipt: Record<string, unknown>;
let connected: boolean;
let env: Env;
beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["i1", "i2"] });
	seedTenant(d1, { userId: "u2", instanceIds: ["other"] });
	d1.exec(`INSERT INTO instance_runtimes (instance_id,user_id,placement,endpoint_url,runner_version) VALUES ('i1','u1','local','http://runner','0.4.198'),('i2','u1','local','http://runner','0.4.198')`);
	sent = []; receipt = { launch: null }; connected = true;
	env = { DB: d1.DB, RELAY: { idFromName: (id: string) => id, get: () => ({ fetch: async (req: Request) => {
		if (new URL(req.url).pathname === "/status") return Response.json({ connected });
		const wire = await req.json() as Record<string, unknown>; sent.push(wire);
		return Response.json(wire.path === "/browser/session" ? receipt : { ok: true });
	} }) } } as unknown as Env;
	app = new Hono<{ Bindings: Env }>();
	const instances = new Hono<{ Bindings: Env }>(); registerBrowserSettingsRoutes(instances);
	app.route("/instances", instances).route("/agents", agentRoutes);
	app.onError((e, c) => e instanceof HttpError ? c.json({ error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500));
});
afterEach(() => d1.close());
async function call(path: string, body?: unknown) {
	const res = await app.request(path, { method: body === undefined ? "GET" : "PUT", headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, env);
	return { status: res.status, body: await res.json() as Record<string, unknown> };
}
const conn = () => ({ env, instanceId: "i1", userId: "u1", endpointUrl: "", token: "", relayName: "i1" });

describe("browser settings", () => {
	it("inherits each field independently, clears only the named override, and never probes on settings reads", async () => {
		d1.exec(`UPDATE agent_instances SET config = '{"settings":{"language":"en"}}' WHERE id = 'i1'`);
		await call("/agents/agent-1/capabilities", { browserMode: "headed", browserEngine: "chrome", browserProfilePolicy: "persistent" });
		expect((await call("/instances/i1/browser-settings", { engine: "firefox", profile: "ephemeral" })).body).toMatchObject({ mode: null, engine: "firefox", profile: "ephemeral", effective: { mode: "headed", engine: "firefox", profile: "ephemeral" }, sources: { mode: "agent", engine: "instance", profile: "instance" } });
		expect((await call("/instances/i1/browser-settings", { engine: null })).body).toMatchObject({ engine: null, profile: "ephemeral", effective: { engine: "chrome", profile: "ephemeral" } });
		expect((await call("/instances/i2/browser-settings")).body).toMatchObject({ effective: { mode: "headed", engine: "chrome", profile: "persistent" } });
		expect(sent).toEqual([]);
		const stored = await d1.DB.prepare("SELECT config FROM agent_instances WHERE id = ?1").bind("i1").first<{ config: string }>();
		expect(JSON.parse(stored!.config).settings).toEqual({ language: "en" });
	});

	it("validates every browser choice and profile on template and instance doors", async () => {
		for (const engine of ["chrome", "msedge", "chromium", "firefox", "webkit"]) {
			expect((await call("/agents/agent-1/capabilities", { browserEngine: engine })).body.browserEngine).toBe(engine);
			expect((await call("/instances/i1/browser-settings", { engine })).body.engine).toBe(engine);
			for (const surfaces of [undefined, []]) expect(agentCapabilities({ config: JSON.stringify({ capabilities: { surfaces, browserEngine: engine, browserProfilePolicy: "ephemeral" } }) })).toMatchObject({ browserEngine: engine, browserProfilePolicy: "ephemeral" });
		}
		for (const body of [{ engine: "safari" }, { profile: "default" }, { profile: "isolated" }, { mode: true }, {}, { toString: "bad" }]) expect((await call("/instances/i1/browser-settings", body)).status).toBe(400);
		for (const capabilities of [{ browserEngine: "safari" }, { browserProfilePolicy: "isolated" }]) {
			expect((await call("/agents/agent-1/capabilities", capabilities)).status).toBe(400);
			expect((await call("/agents/agent-1", { capabilities })).status).toBe(400);
			const create = await app.request("/agents", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slug: "invalid-browser", name: "Invalid", capabilities }) }, env);
			expect(create.status).toBe(400);
		}
		for (const path of ["browser-settings", "browser-settings/session"]) expect((await call(`/instances/other/${path}`)).status).toBe(404);
		expect((await call("/instances/other/browser-settings", { engine: "chrome" })).status).toBe(404);
	});

	it("sends resolved choices through both dispatchers, preserving unset workflow policies", async () => {
		await call("/instances/i1/browser-settings", { engine: "chrome" });
		expect((await call("/instances/i1/browser-settings")).body).toMatchObject({ effective: { mode: null, engine: "chrome", profile: null }, sources: { profile: "runner" }, requiredCli: "0.4.198" });
		await callRunner(conn(), "/browser/act", { browserEngine: "firefox" });
		expect(sent.at(-1)).toMatchObject({ browserEngine: "chrome", body: { browserEngine: "firefox" } });
		expect(sent.at(-1)).not.toHaveProperty("browserProfilePolicy");
		await call("/instances/i1/browser-settings", { engine: null, profile: "ephemeral" });
		await callRuntime(env, { instance_id: "i1", user_id: "u1", runner_version: "0.4.198" } as RuntimeRow, "/local-apply/run", { method: "POST" });
		expect(sent.at(-1)).toMatchObject({ browserProfilePolicy: "ephemeral" });
		expect(sent.at(-1)).not.toHaveProperty("browserEngine");
		await call("/instances/i1/browser-settings", { profile: null });
		await callRunner(conn(), "/browser/act");
		expect(sent.at(-1)).not.toHaveProperty("browserEngine");
		expect(sent.at(-1)).not.toHaveProperty("browserProfilePolicy");
	});

	it("requires the new runner only for new explicit sessions, leaving old active runs accessible", async () => {
		d1.exec("UPDATE instance_runtimes SET runner_version = '0.4.197'");
		await call("/instances/i1/browser-settings", { mode: "headed" });
		await callRunner(conn(), "/browser/act"); // mode-only compatibility
		await call("/instances/i1/browser-settings", { engine: "firefox" });
		await expect(callRunner(conn(), "/browser/act")).rejects.toThrow("requires CLI 0.4.198");
		await expect(callRuntime(env, { instance_id: "i1", user_id: "u1", runner_version: "0.4.197" } as RuntimeRow, "/local-browser/run", { method: "POST" })).rejects.toThrow("requires CLI 0.4.198");
		for (const path of ["/browser/act", "/browser/complete", "/local-browser/shots", "/local-apply/cancel", "/local-browser/resume"]) await callRunner(conn(), path, { taskId: "existing" });
		await callRunner(conn(), "/tasks", { type: "echo" });
		expect(sent.at(-1)).not.toHaveProperty("browserEngine");
	});

	it("inherits website access independently and validates instance and creator policy", async () => {
		const browserWebsiteAccess = { mode: "ask_once", domains: ["JOBS.Example.COM.", "jobs.example.com"] };
		expect((await call("/agents/agent-1/capabilities", { browserWebsiteAccess })).status).toBe(200);
		expect((await call("/instances/i1/browser-settings")).body).toMatchObject({ effective: { websiteAccess: { mode: "ask_once", domains: ["jobs.example.com"] } }, sources: { websiteAccess: "agent" }, requiredCli: "0.4.209" });
		expect((await call("/instances/i1/browser-settings", { websiteAccess: { mode: "allow_all", domains: [] } })).body).toMatchObject({ effective: { websiteAccess: { mode: "allow_all", domains: [] } }, sources: { websiteAccess: "instance" } });
		expect((await call("/instances/i1/browser-settings", { websiteAccess: null })).body).toMatchObject({ effective: { websiteAccess: { mode: "ask_once", domains: ["jobs.example.com"] } } });
		for (const websiteAccess of [{ mode: "all", domains: [] }, { mode: "allowlist", domains: ["*.example.com"] }, { mode: "ask_once", domains: ["https://example.com"] }, { mode: "ask_once", domains: [], rememberedDomains: ["evil.example"] }, { mode: "allow_all" }, { mode: "allowlist", domains: Array(101).fill("example.com") }]) {
			expect((await call("/instances/i1/browser-settings", { websiteAccess })).status).toBe(400);
			expect((await call("/agents/agent-1/capabilities", { browserWebsiteAccess: websiteAccess })).status).toBe(400);
		}
		expect(sent).toEqual([]);
	});

	it("binds owner website policy on both dispatchers and refuses existing tasks on old runners", async () => {
		const access = { mode: "allowlist", domains: [] };
		await call("/instances/i1/browser-settings", { websiteAccess: access });
		for (const path of ["/browser/act", "/browser/snapshot", "/local-apply/resume", "/local-browser/resume", "/tasks/existing/website-access-resume"]) await expect(callRunner(conn(), path, { taskId: "existing", browserWebsiteAccess: { mode: "allow_all", domains: [] } })).rejects.toThrow("requires CLI 0.4.209");
		expect(sent).toEqual([]);
		await callRunner(conn(), "/local-apply/cancel", { taskId: "existing" });
		d1.exec("UPDATE instance_runtimes SET runner_version = '0.4.209'");
		await callRunner(conn(), "/browser/act", { taskId: "existing", browserWebsiteAccess: { mode: "allow_all", domains: [] } });
		expect(sent.at(-1)).toMatchObject({ browserWebsiteAccess: access });
		await callRunner(conn(), "/tasks/existing/website-access-resume", { pauseKey: "pause", websiteDecision: "allow" });
		expect(sent.at(-1)).toMatchObject({ browserWebsiteAccess: access });
		await callRuntime(env, { instance_id: "i1", user_id: "u1", runner_version: "0.4.209" } as RuntimeRow, "/local-apply/run", { method: "POST", body: JSON.stringify({ policy: { browserWebsiteAccess: { mode: "allow_all", domains: [] } } }) });
		expect(sent.at(-1)).toMatchObject({ browserWebsiteAccess: access });
		await call("/instances/i1/browser-settings", { websiteAccess: null });
		await callRunner(conn(), "/browser/act");
		expect(sent.at(-1)).not.toHaveProperty("browserWebsiteAccess");
	});

	it("sends remembered allow and deny decisions only for ask_once and only for this owner and instance", async () => {
		d1.exec("UPDATE instance_runtimes SET runner_version = '0.4.209'");
		for (const [id, uid, instance, hostname, decision] of [["r1", "u1", "i1", "jobs.example.com", "allow"], ["r2", "u1", "i1", "blocked.example.com", "deny"], ["r3", "u1", "i2", "other.example.com", "allow"], ["r4", "u2", "other", "private.example.com", "allow"]]) {
			await d1.DB.prepare("INSERT INTO website_access_requests (id,user_id,instance_id,subject_kind,subject_id,hostname,pause_key,created_at) VALUES (?1,?2,?3,'runtime_task','task',?4,'pause',1)").bind(id,uid,instance,hostname).run();
			await d1.DB.prepare("INSERT INTO website_access_grants (user_id,instance_id,hostname,decision,request_id,decided_at) VALUES (?1,?2,?3,?4,?5,1)").bind(uid,instance,hostname,decision,id).run();
		}
		await call("/instances/i1/browser-settings", { websiteAccess: { mode: "ask_once", domains: [] } });
		await callRunner(conn(), "/browser/act");
		expect(sent.at(-1)?.browserWebsiteAccess).toEqual({ mode: "ask_once", domains: [], rememberedDomains: ["jobs.example.com"], deniedDomains: ["blocked.example.com"] });
		for (const mode of ["allow_all", "allowlist"]) {
			await call("/instances/i1/browser-settings", { websiteAccess: { mode, domains: [] } });
			await callRunner(conn(), "/browser/act");
			expect(sent.at(-1)?.browserWebsiteAccess).toEqual({ mode, domains: [] });
		}
	});

	it("reports actual launch evidence separately from changed configuration, and never starts a browser", async () => {
		const launch = { engine: "chromium", version: "146.0", mode: "headless", profilePolicy: "ephemeral", profileId: "opaque", transport: "playwright", active: true };
		receipt = { launch, launches: [launch] };
		await call("/instances/i1/browser-settings", { engine: "firefox", mode: "headed" });
		expect((await call("/instances/i1/browser-settings/session")).body).toMatchObject({ status: "connected", launch, launches: [launch] });
		expect(sent.map((wire) => wire.path)).toEqual(["/browser/session"]);
		d1.exec("UPDATE instance_runtimes SET runner_version = '0.4.197'");
		expect((await call("/instances/i1/browser-settings/session")).body).toMatchObject({ status: "unsupported", launch: null });
		connected = false;
		expect((await call("/instances/i1/browser-settings/session")).body).toMatchObject({ status: "offline", launch: null });
		expect(sent).toHaveLength(1);
	});
});
