import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { McpEnv } from "../http.js";
import type { SafetyContext } from "../safety.js";
import { registerBrowserVerificationTools } from "./browser-verification.js";

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
function fixture(scopes: SafetyContext["scopes"] = ["read", "write"], reply: unknown = { mode: "headed", agentDefault: "headless", effective: "headed", source: "instance" }, register = registerBrowserVerificationTools) {
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

describe("independent screenshot capture and form blur (#1433)", () => {
	it("reads both settings without losing false values", async () => {
		const view = { enabled: true, blurFormFields: false, explained: "future runs" };
		const { seen, call } = fixture(["read"], view);
		expect(JSON.parse(await call("get_browser_screenshots", { instance_id: "i1" }))).toEqual(view);
		expect(seen).toEqual([{ url: "https://api.test/v1/instances/i1/browser-screenshots", method: "GET", body: undefined }]);
	});
	it("sends blur-only and capture-only patches without changing the omitted sibling", async () => {
		const { seen, call } = fixture();
		await call("set_browser_screenshots", { instance_id: "i1", blur_form_fields: false });
		await call("set_browser_screenshots", { instance_id: "i1", enabled: false });
		await call("set_browser_screenshots", { instance_id: "i1", enabled: true, blur_form_fields: true });
		expect(seen.map(({ body }) => body)).toEqual([{ blurFormFields: false }, { enabled: false }, { enabled: true, blurFormFields: true }]);
		expect(seen.every(({ method, url }) => method === "PUT" && url.endsWith("/browser-screenshots"))).toBe(true);
	});
	it("dry run names the exact patch and touches no API", async () => {
		const { seen, call } = fixture();
		const out = JSON.parse(await call("set_browser_screenshots", { instance_id: "i1", blur_form_fields: false, dry_run: true }));
		expect(out.wouldDo).toEqual({ endpoint: "/v1/instances/i1/browser-screenshots", method: "PUT", body: { blurFormFields: false } });
		expect(seen).toEqual([]);
	});
	it("rejects no-op patches and non-booleans before dispatch", async () => {
		const { seen, call } = fixture();
		expect(await call("set_browser_screenshots", { instance_id: "i1" })).toContain("Error: pass enabled and/or blur_form_fields");
		for (const value of [null, "false", 0]) await expect(call("set_browser_screenshots", { instance_id: "i1", blur_form_fields: value })).rejects.toThrow();
		expect(seen).toEqual([]);
	});
	it("enforces write permission even for blur-only previews", async () => {
		const { seen, call } = fixture(["read"]);
		expect(await call("set_browser_screenshots", { instance_id: "i1", blur_form_fields: false, dry_run: true })).toContain("requires MCP scope");
		expect(seen).toEqual([]);
	});
	it("returns structural API failure without a success response", async () => {
		const { call } = fixture(["write"], { error: "Not your instance" });
		expect(await call("set_browser_screenshots", { instance_id: "i1", blur_form_fields: false })).toBe("Error: Not your instance");
	});
});
