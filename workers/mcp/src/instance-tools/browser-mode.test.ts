import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { McpEnv } from "../http.js";
import type { SafetyContext } from "../safety.js";
import { registerBrowserModeTools } from "./browser-mode.js";
import { registerAgentAuthoringTools } from "./agent-authoring.js";

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
function fixture(scopes: SafetyContext["scopes"] = ["read", "write"], reply: unknown = { mode: "headed", agentDefault: "headless", effective: "headed", source: "instance" }, register = registerBrowserModeTools) {
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

describe("browser visibility MCP contract (#1429)", () => {
	it("reads the resolved mode and inheritance without altering the API response", async () => {
		const view = { mode: null, agentDefault: "headed", effective: "headed", source: "agent" };
		const { seen, call } = fixture(["read"], view);
		expect(JSON.parse(await call("get_instance_browser_mode", { instance_id: "i 1" }))).toEqual(view);
		expect(seen).toEqual([{ url: "https://api.test/v1/instances/i%201/browser-mode", method: "GET", body: undefined }]);
	});
	it.each(["headed", "headless", null])("sends exact override %s, preserving null as clear", async (mode) => {
		const { seen, call } = fixture();
		await call("set_instance_browser_mode", { instance_id: "i1", mode });
		expect(seen).toEqual([{ url: "https://api.test/v1/instances/i1/browser-mode", method: "PUT", body: { mode } }]);
	});
	it("previews the exact setting without touching the API", async () => {
		const { seen, call } = fixture();
		const result = JSON.parse(await call("set_instance_browser_mode", { instance_id: "i1", mode: null, dry_run: true }));
		expect(result.dryRun).toBe(true);
		expect(result.wouldDo).toMatchObject({ endpoint: "/v1/instances/i1/browser-mode", method: "PUT", body: { mode: null } });
		expect(seen).toEqual([]);
	});
	it("refuses writes from a read-only connection, including dry runs", async () => {
		const { seen, call } = fixture(["read"]);
		expect(await call("set_instance_browser_mode", { instance_id: "i1", mode: "headed", dry_run: true })).toContain("requires MCP scope");
		expect(seen).toEqual([]);
	});
	it("rejects an invalid or omitted mode before any request", async () => {
		const { seen, call } = fixture();
		await expect(call("set_instance_browser_mode", { instance_id: "i1", mode: "headfull" })).rejects.toThrow();
		await expect(call("set_instance_browser_mode", { instance_id: "i1" })).rejects.toThrow();
		expect(seen).toEqual([]);
	});
	it("returns structural API failures as Error without claiming a completed change", async () => {
		const { call } = fixture(["write"], { error: "owned instance not found" });
		expect(await call("set_instance_browser_mode", { instance_id: "other", mode: "headed" })).toBe("Error: owned instance not found");
	});
	it("maps the creator's default to capabilities.browserMode, including clearing inheritance", async () => {
		const { seen, call } = fixture(["destructive"], { browserMode: "headed" }, registerAgentAuthoringTools);
		for (const mode of ["headed", null]) await call("set_agent_capabilities", { agent_id: "a1", browser_mode: mode, confirm: "set_agent_capabilities" });
		expect(seen).toEqual([
			{ url: "https://api.test/v1/agents/a1/capabilities", method: "PUT", body: { browserMode: "headed" } },
			{ url: "https://api.test/v1/agents/a1/capabilities", method: "PUT", body: { browserMode: null } },
		]);
	});

});
