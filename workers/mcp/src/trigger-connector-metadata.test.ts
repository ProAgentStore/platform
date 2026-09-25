import { afterEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import type { McpEnv } from "./http.js";
import { registerConnectorGrantTools } from "./instance-tools/connectors.js";
import { registerTriggerTools } from "./instance-tools/triggers.js";
import type { SafetyContext } from "./safety.js";

// ── #613, the trigger-and-connector-metadata group ────────────────────────────
//
// Four reads and one consent toggle, all thin proxies — so the tests pin what a proxy gets
// wrong: route and method, that the query parameter the route REQUIRES is actually sent and
// URL-encoded (`/v1/triggers/actions` 400s without `instanceId`), that the preview sends only
// the fields the caller named (a manufactured `type` or `count` would change what it reports),
// that the consent toggle sends `enabled` as a boolean either way, that `dry_run` never touches
// the network, and that a refused or failed call is not audited as completed.
//
// The reads are deliberately ungated ("none" in the contract table), matching every other
// owner-scoped read here; the route is owner-scoped server-side.
//
// Driven through the real safety layer and `authedCall`; only `fetch` and the audit KV are stubbed.

type ToolContent = { content: { type: string; text: string }[] };
type Handler = (args: Record<string, unknown>) => Promise<ToolContent>;
type Shape = Record<string, z.ZodTypeAny>;

function setup(opts: { scopes?: string[]; status?: number; body?: unknown } = {}) {
	const calls: Array<{ url: string; method: string; body: unknown }> = [];
	vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
		const raw = (init?.body as string | undefined) ?? null;
		calls.push({ url: String(input), method: (init?.method || "GET").toUpperCase(), body: raw === null ? null : JSON.parse(raw) });
		return new Response(JSON.stringify(opts.body ?? { ok: true }), { status: opts.status ?? 200, headers: { "Content-Type": "application/json" } });
	});
	const audit = new Map<string, string>();
	const kv = {
		get: async (k: string) => audit.get(k) ?? null,
		put: async (k: string, v: string) => void audit.set(k, v),
		delete: async (k: string) => void audit.delete(k),
		list: async () => ({ keys: [...audit.keys()].map((name) => ({ name })), list_complete: true }),
	} as unknown as KVNamespace;
	const env: McpEnv = { API_BASE: "https://api.test", OAUTH_KV: kv };
	const tools = new Map<string, Handler>();
	// biome-ignore lint/suspicious/noExplicitAny: minimal fake MCP server, as in contract.test.ts
	const server = { tool: (name: string, _d: string, _s: Shape, handler: Handler) => tools.set(name, handler) } as any;
	const tokenFor = (t?: string) => t || "session-token";
	const safetyFor = (): SafetyContext => ({ env, subject: "user-1", scopes: (opts.scopes ?? ["read", "write", "runtime"]) as SafetyContext["scopes"] });
	const ctx = { env, tokenFor, safetyFor, groups: new Set<string>() };
	registerConnectorGrantTools(server, ctx);
	registerTriggerTools(server, ctx);
	const run = (name: string, args: Record<string, unknown> = {}) => {
		const h = tools.get(name);
		if (!h) throw new Error(`"${name}" is not registered`);
		return h(args);
	};
	const completed = () => [...audit.values()].map((v) => JSON.parse(v) as { tool?: string; action?: string }).filter((e) => e.action === "completed");
	return { run, calls, completed };
}

afterEach(() => vi.unstubAllGlobals());

describe("list_connectors", () => {
	it("GETs the account-level catalogue and returns it unchanged", async () => {
		const body = { connectors: [{ id: "github", connected: true }, { id: "tmux", connected: null }] };
		const h = setup({ body });
		const res = await h.run("list_connectors", {});
		expect(h.calls).toEqual([{ url: "https://api.test/v1/connectors", method: "GET", body: null }]);
		expect(JSON.parse(res.content[0].text)).toEqual(body);
	});

	it("reads with only the read scope", async () => {
		const h = setup({ scopes: ["read"] });
		await h.run("list_connectors", {});
		expect(h.calls).toHaveLength(1);
	});
});

describe("list_instance_connectors", () => {
	it("GETs the per-instance verdicts", async () => {
		const h = setup({ body: { connectors: [{ id: "drive", offered: false, refusal: "this agent declares no drive tool" }] } });
		const res = await h.run("list_instance_connectors", { instance_id: "inst-1" });
		expect(h.calls).toEqual([{ url: "https://api.test/v1/instances/inst-1/connectors", method: "GET", body: null }]);
		expect(res.content[0].text).toContain("declares no drive tool");
	});
});

describe("list_instance_connector_consents", () => {
	it("GETs the stored rows and preserves ask versus always instead of inferring consent from connector availability", async () => {
		const body = { consents: [{ connector: "github", scope: "write", mode: "ask" }, { connector: "linear", scope: "write", mode: "always" }] };
		const h = setup({ body, scopes: ["read"] });
		const res = await h.run("list_instance_connector_consents", { instance_id: "inst / 1" });
		expect(h.calls).toEqual([{ url: "https://api.test/v1/instances/inst%20%2F%201/connectors/consent", method: "GET", body: null }]);
		expect(JSON.parse(res.content[0].text)).toEqual(body);
	});
});

describe("list_trigger_actions", () => {
	it("sends the instanceId the route requires, URL-encoded", async () => {
		const h = setup({ body: { actions: [{ action: "run_browse", available: false, reason: "this agent has no browser" }] } });
		const res = await h.run("list_trigger_actions", { instance_id: "inst 1" });
		expect(h.calls).toEqual([{ url: "https://api.test/v1/triggers/actions?instanceId=inst%201", method: "GET", body: null }]);
		expect(res.content[0].text).toContain("no browser");
	});
});

describe("preview_instance_trigger", () => {
	it("POSTs only the fields the caller named", async () => {
		const h = setup({ body: { schedule: "0 9 * * 1-5", runs: ["2026-09-21T09:00:00Z"], issues: [], error: null } });
		await h.run("preview_instance_trigger", { type: "cron", schedule: "0 9 * * 1-5" });
		expect(h.calls).toEqual([
			{ url: "https://api.test/v1/triggers/preview", method: "POST", body: { type: "cron", schedule: "0 9 * * 1-5" } },
		]);
	});

	it("sends nothing at all when nothing was named — no manufactured type or count", async () => {
		const h = setup();
		await h.run("preview_instance_trigger", {});
		expect(h.calls[0]?.body).toEqual({});
	});

	it("maps instance_id to the instanceId the route reads", async () => {
		const h = setup();
		await h.run("preview_instance_trigger", { instance_id: "inst-1", action: "run_browse" });
		expect(h.calls[0]?.body).toEqual({ instanceId: "inst-1", action: "run_browse" });
	});

	it("passes count through so a caller can ask for more run times", async () => {
		const h = setup();
		await h.run("preview_instance_trigger", { type: "cron", schedule: "* * * * *", count: 5 });
		expect(h.calls[0]?.body).toMatchObject({ count: 5 });
	});

	it("returns the route's issues rather than throwing on a bad draft", async () => {
		const h = setup({ body: { schedule: null, runs: [], issues: ["timezone is not a valid IANA zone"], error: "invalid schedule" } });
		const res = await h.run("preview_instance_trigger", { type: "cron", schedule: "nope" });
		const out = JSON.parse(res.content[0].text);
		expect(out.issues).toEqual(["timezone is not a valid IANA zone"]);
		expect(out.error).toBe("invalid schedule");
	});

	it("previews with only the read scope — it writes nothing", async () => {
		const h = setup({ scopes: ["read"] });
		await h.run("preview_instance_trigger", { type: "cron", schedule: "* * * * *" });
		expect(h.calls).toHaveLength(1);
	});
});

describe("set_instance_connector_consent", () => {
	it("PUTs the explicit mode, URL-encoding the instance and connector ids", async () => {
		const h = setup({ body: { ok: true, connector: "github", scope: "write", enabled: true, mode: "ask" } });
		await h.run("set_instance_connector_consent", { instance_id: "inst / 1", connector: "git hub", mode: "ask" });
		expect(h.calls).toEqual([
			{ url: "https://api.test/v1/instances/inst%20%2F%201/connectors/git%20hub/consent", method: "PUT", body: { mode: "ask" } },
		]);
		expect(h.completed().map((e) => e.tool)).toEqual(["set_instance_connector_consent"]);
	});

	it("revokes by sending enabled:false, not by omitting it", async () => {
		const h = setup();
		await h.run("set_instance_connector_consent", { instance_id: "inst-1", connector: "github", enabled: false });
		expect(h.calls[0]?.body).toEqual({ enabled: false });
	});

	it("refuses no mode and an ambiguous legacy-plus-mode request before either can change a consent", async () => {
		for (const args of [
			{ instance_id: "inst-1", connector: "github" },
			{ instance_id: "inst-1", connector: "github", enabled: true, mode: "ask" },
		]) {
			const h = setup();
			const res = await h.run("set_instance_connector_consent", args);
			expect(res.content[0].text).toMatch(/Provide/);
			expect(h.calls).toHaveLength(0);
		}
	});

	it("is refused without the write scope — a read-only session cannot widen an agent's reach", async () => {
		const h = setup({ scopes: ["read"] });
		const res = await h.run("set_instance_connector_consent", { instance_id: "inst-1", connector: "github", enabled: true });
		expect(res.content[0].text).toMatch(/write/);
		expect(h.calls).toHaveLength(0);
		expect(h.completed()).toHaveLength(0);
	});

	it("dry_run changes nothing and says which way it would go", async () => {
		const h = setup();
		const res = await h.run("set_instance_connector_consent", { instance_id: "inst-1", connector: "github", mode: "ask", dry_run: true });
		expect(h.calls).toHaveLength(0);
		expect(JSON.parse(res.content[0].text)).toMatchObject({ dryRun: true, wouldDo: { method: "PUT", body: { mode: "ask" } } });
		expect(res.content[0].text).toContain("approval");
	});

	it("surfaces the route's refusal for a read-only connector, unaudited", async () => {
		const h = setup({ status: 400, body: { error: "The web-search connector is read-only — write access cannot be granted to it." } });
		const res = await h.run("set_instance_connector_consent", { instance_id: "inst-1", connector: "web-search", enabled: true });
		expect(res.content[0].text).toContain("read-only");
		expect(h.completed()).toHaveLength(0);
	});

	it("surfaces a 404 for an unknown connector, unaudited", async () => {
		const h = setup({ status: 404, body: { error: "Unknown connector: nope" } });
		const res = await h.run("set_instance_connector_consent", { instance_id: "inst-1", connector: "nope", enabled: true });
		expect(res.content[0].text).toContain("Unknown connector");
		expect(h.completed()).toHaveLength(0);
	});
});
