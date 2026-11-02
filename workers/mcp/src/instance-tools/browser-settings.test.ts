import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { McpEnv } from "../http.js";
import type { SafetyContext } from "../safety.js";
import { registerBrowserSettingsTools } from "./browser-settings.js";
import { registerAgentAuthoringTools } from "./agent-authoring.js";

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
function fixture(scopes: SafetyContext["scopes"] = ["read", "write"], reply: unknown = { mode: "headed", agentDefault: "headless", effective: "headed", source: "instance" }, register = registerBrowserSettingsTools) {
	const seen: Array<{ url: string; method: string; body: unknown }> = [];
	vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
		seen.push({ url: String(input), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
		return new Response(JSON.stringify(reply), { headers: { "Content-Type": "application/json" } });
	});
	const handlers = new Map<string, { handler: Handler; schema: z.ZodObject<z.ZodRawShape> }>();
	const env: McpEnv = { API_BASE: "https://api.test" };
	register({ tool: (name: string, _d: string, schema: z.ZodRawShape, handler: Handler) => handlers.set(name, { handler, schema: z.object(schema) }) } as never, {
		env, tokenFor: () => "session", safetyFor: () => ({ env, subject: "u1", scopes }), groups: new Set(),
	});
	return { seen, call: async (name: string, args: Record<string, unknown>) => {
		const tool = handlers.get(name)!;
		return (await tool.handler(tool.schema.parse(args))).content[0].text;
	} };
}
afterEach(() => vi.unstubAllGlobals());

describe("browser settings MCP contract (#1431)", () => {
	it("keeps configured defaults and actual runtime evidence separate", async () => {
		const reply = { effective: { mode: null, engine: "firefox", profile: null }, sources: { engine: "agent" } };
		const { seen, call } = fixture(["read"], reply);
		expect(JSON.parse(await call("get_instance_browser_settings", { instance_id: "i 1" }))).toEqual(reply);
		await call("get_instance_browser_session", { instance_id: "i 1" });
		expect(seen.map(({ url, method }) => ({ url, method }))).toEqual([
			{ url: "https://api.test/v1/instances/i%201/browser-settings", method: "GET" },
			{ url: "https://api.test/v1/instances/i%201/browser-settings/session", method: "GET" },
		]);
	});
	it("patches only supplied fields and preserves independent null clears", async () => {
		const { seen, call } = fixture();
		await call("set_instance_browser_settings", { instance_id: "i1", engine: "firefox", profile_policy: null });
		await call("set_instance_browser_settings", { instance_id: "i1", mode: null, profile_policy: "ephemeral" });
		expect(seen.map(({ body }) => body)).toEqual([{ engine: "firefox", profile: null }, { mode: null, profile: "ephemeral" }]);
		expect(seen.every(({ method }) => method === "PUT")).toBe(true);
	});
	it("previews exact API payload without requesting a browser or saving settings", async () => {
		const { seen, call } = fixture();
		const out = JSON.parse(await call("set_instance_browser_settings", { instance_id: "i1", engine: "webkit", profile_policy: "persistent", mode: "headed", dry_run: true }));
		expect(out.wouldDo).toMatchObject({ method: "PUT", body: { engine: "webkit", profile: "persistent", mode: "headed" } });
		expect(seen).toEqual([]);
	});
	it("refuses an empty patch and invalid choices before dispatch", async () => {
		const { seen, call } = fixture();
		expect(await call("set_instance_browser_settings", { instance_id: "i1" })).toContain("Error: pass at least one");
		for (const args of [{ engine: "safari" }, { profile_policy: "shared" }, { mode: "headfull" }]) {
			await expect(call("set_instance_browser_settings", { instance_id: "i1", ...args })).rejects.toThrow();
		}
		expect(seen).toEqual([]);
	});
	it("refuses writes without write permission and preserves structural API errors", async () => {
		const denied = fixture(["read"]);
		expect(await denied.call("set_instance_browser_settings", { instance_id: "i1", engine: "firefox", dry_run: true })).toContain("requires MCP scope");
		expect(denied.seen).toEqual([]);
		const failed = fixture(["write"], { error: "not your instance" });
		expect(await failed.call("set_instance_browser_settings", { instance_id: "i1", engine: "firefox" })).toBe("Error: not your instance");
	});
	it("sends creator defaults under canonical capability keys, preserving omitted siblings", async () => {
		const { seen, call } = fixture(["destructive"], { ok: true }, registerAgentAuthoringTools);
		await call("set_agent_capabilities", { agent_id: "a1", browser_engine: "firefox", browser_profile_policy: "ephemeral", confirm: "set_agent_capabilities" });
		await call("set_agent_capabilities", { agent_id: "a1", browser_engine: null, confirm: "set_agent_capabilities" });
		expect(seen.map(({ body }) => body)).toEqual([{ browserEngine: "firefox", browserProfilePolicy: "ephemeral" }, { browserEngine: null }]);
	});
});
