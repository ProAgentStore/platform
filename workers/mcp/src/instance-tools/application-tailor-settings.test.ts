import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpEnv } from "../http.js";
import type { SafetyContext } from "../safety.js";
import { registerApplicationTools } from "./applications.js";

const sessions: Array<{ client: Client; server: McpServer }> = [];
afterEach(async () => {
	await Promise.all(sessions.splice(0).map(async ({ client, server }) => { await client.close(); await server.close(); }));
	vi.unstubAllGlobals();
});

async function harness(options: { pinned?: string; scopes?: SafetyContext["scopes"]; authenticated?: boolean; refusal?: number } = {}) {
	const settings: Record<string, unknown> = { engine: "claude", authMode: "machine", workspace: "~/jobs", sources: { resume: "resume.md", profile: "profile.md" }, retainDays: 0, maxMinutes: 10, stallMinutes: null };
	const calls: Array<{ url: string; method: string; body: unknown }> = [];
	vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
		const body = init?.body ? JSON.parse(String(init.body)) : undefined;
		calls.push({ url: String(input), method: init?.method ?? "GET", body });
		if (options.refusal) return new Response(JSON.stringify({ error: "Instance not owned" }), { status: options.refusal });
		if (init?.method === "PUT") Object.assign(settings, body);
		return new Response(JSON.stringify({ settings }), { headers: { "Content-Type": "application/json" } });
	});
	const env: McpEnv = { API_BASE: "https://api.test" };
	const server = new McpServer({ name: "tailor-settings-test", version: "1" });
	registerApplicationTools(server, {
		env,
		tokenFor: () => options.authenticated === false ? null : "test-session",
		safetyFor: () => ({ env, subject: "owner", scopes: options.scopes ?? ["read", "write"] }),
	}, { pinnedInstanceId: options.pinned });
	const client = new Client({ name: "test", version: "1" });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await server.connect(serverTransport);
	await client.connect(clientTransport);
	sessions.push({ client, server });
	const call = async (name: string, args: Record<string, unknown>) => {
		const result = await client.callTool({ name, arguments: args });
		const content = result.content as Array<{ type: string; text?: string }>;
		return { result, text: content.filter(b => b.type === "text").map(b => b.text).join("\n") };
	};
	return { client, call, calls };
}

describe("Application Tailor settings through the published MCP schema", () => {
	it("patches only the requested engine on the exact Tailor and reads all effective settings back", async () => {
		const h = await harness();
		const target = { instance_id: "tailor /one" };
		await h.call("set_application_tailor_settings", { ...target, settings: { engine: "codex" } });
		const read = JSON.parse((await h.call("get_application_tailor_settings", target)).text);
		expect(read.settings).toMatchObject({ engine: "codex", authMode: "machine", workspace: "~/jobs", maxMinutes: 10, sources: { profile: "profile.md", resume: "resume.md" } });
		expect(h.calls).toEqual([
			{ url: "https://api.test/v1/instances/tailor%20%2Fone/application-tailor/settings", method: "PUT", body: { engine: "codex" } },
			{ url: "https://api.test/v1/instances/tailor%20%2Fone/application-tailor/settings", method: "GET", body: undefined },
		]);
	});

	it("previews the exact patch without any API call or runtime dispatch", async () => {
		const h = await harness();
		const out = JSON.parse((await h.call("set_application_tailor_settings", { instance_id: "tailor", settings: { engine: "codex", retainDays: 30, stallMinutes: null }, dry_run: true })).text);
		expect(out.dryRun).toBe(true);
		expect(out.wouldDo).toMatchObject({ endpoint: "/v1/instances/tailor/application-tailor/settings", method: "PUT", body: { engine: "codex", retainDays: 30, stallMinutes: null } });
		expect(h.calls).toEqual([]);
	});

	it("pins the target and omits caller-controlled identity from the pinned schema", async () => {
		const h = await harness({ pinned: "pinned-tailor" });
		const listed = (await h.client.listTools()).tools.filter(t => t.name.endsWith("application_tailor_settings"));
		for (const tool of listed) { expect(tool.inputSchema.properties).not.toHaveProperty("instance_id"); expect(tool.inputSchema.properties).not.toHaveProperty("token"); }
		await h.call("set_application_tailor_settings", { instance_id: "wrong-runner", settings: { engine: "codex" } });
		expect(h.calls[0]?.url).toBe("https://api.test/v1/instances/pinned-tailor/application-tailor/settings");
	});

	it.each([{ engine: "grok" }, { authMode: "api-key" }, { maxMinutes: 0 }, { retainDays: 3651 }, { stallMinutes: 0 }, { sources: { resume: null } }, { providerKey: "not-a-secret" }])("refuses unsupported settings before contacting the API: %j", async settings => {
		const h = await harness();
		const out = await h.call("set_application_tailor_settings", { instance_id: "tailor", settings });
		expect(out.result.isError).toBe(true);
		expect(h.calls).toEqual([]);
	});

	it("requires write scope even for a preview, while reads remain available", async () => {
		const h = await harness({ scopes: ["read"] });
		expect((await h.call("set_application_tailor_settings", { instance_id: "tailor", settings: { engine: "codex" }, dry_run: true })).text).toContain('requires MCP scope "write"');
		expect(h.calls).toEqual([]);
		expect(JSON.parse((await h.call("get_application_tailor_settings", { instance_id: "tailor" })).text).settings.engine).toBe("claude");
	});

	it("preserves an ownership refusal from the existing route and performs no fallback", async () => {
		const h = await harness({ refusal: 403 });
		const result = await h.call("set_application_tailor_settings", { instance_id: "foreign", settings: { engine: "codex" } });
		expect(result.text).toMatch(/^Error:/);
		expect(h.calls).toHaveLength(1);
	});

	it("requires authentication before reading or patching", async () => {
		const h = await harness({ authenticated: false });
		for (const name of ["get_application_tailor_settings", "set_application_tailor_settings"]) expect((await h.call(name, { instance_id: "tailor", settings: { engine: "codex" } })).text).toContain("authentication required");
		expect(h.calls).toEqual([]);
	});
});
