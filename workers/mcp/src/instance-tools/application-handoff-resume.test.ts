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
	const calls: Array<{ url: string; method: string; body: unknown }> = [];
	vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
		const body = init?.body ? JSON.parse(String(init.body)) : undefined;
		calls.push({ url: String(input), method: init?.method ?? "GET", body });
		if (options.refusal) return new Response(JSON.stringify({ error: options.refusal === 403 ? "Instance not owned" : "Application handoff not found or closed" }), { status: options.refusal });
		return new Response(JSON.stringify({ run: { id: "run /one", status: "running", submit: false } }), { headers: { "Content-Type": "application/json" } });
	});
	const env: McpEnv = { API_BASE: "https://api.test" };
	const server = new McpServer({ name: "handoff-resume-test", version: "1" });
	registerApplicationTools(server, {
		env,
		tokenFor: () => options.authenticated === false ? null : "test-session",
		safetyFor: () => ({ env, subject: "owner", scopes: options.scopes ?? ["read", "runtime"] }),
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

const target = { instance_id: "runner /one", run_id: "run /one", handoff_id: "continuity /?one" };
const endpoint = "https://api.test/v1/instances/runner%20%2Fone/application-runs/run%20%2Fone/handoff/resume?handoff_id=continuity%20%2F%3Fone";
const tool = "resume_application_handoff";

describe("exact application handoff resume through the published MCP schema", () => {
	it("dispatches once to the exact owner/run/handoff route without submission or fresh-run actions", async () => {
		const h = await harness();
		const out = await h.call(tool, { ...target, submit: true, answers: [{ question: "injected", answer: "ignored" }] });
		expect(JSON.parse(out.text)).toEqual({ run: { id: target.run_id, status: "running", submit: false } });
		expect(h.calls).toEqual([{ url: endpoint, method: "POST", body: {} }]);
		const listed = (await h.client.listTools()).tools.find(t => t.name === tool)!;
		expect(listed.inputSchema.required).toEqual(expect.arrayContaining(["instance_id", "run_id", "handoff_id"]));
		expect(listed.inputSchema.properties).not.toHaveProperty("submit");
		expect(listed.inputSchema.properties).not.toHaveProperty("answers");
	});

	it("previews the exact continuation without contacting the API or runner", async () => {
		const h = await harness();
		const out = JSON.parse((await h.call(tool, { ...target, dry_run: true })).text);
		expect(out.dryRun).toBe(true);
		expect(out.wouldDo).toMatchObject({ endpoint: endpoint.replace("https://api.test", ""), method: "POST", body: {} });
		expect(h.calls).toEqual([]);
	});

	it.each([403, 404, 409])("preserves upstream ownership/stale/closed refusal %i with no fallback or new run", async refusal => {
		const h = await harness({ refusal });
		expect((await h.call(tool, target)).text).toMatch(/^Error:/);
		expect(h.calls).toEqual([{ url: endpoint, method: "POST", body: {} }]);
	});

	it("pins identity and omits caller-controlled instance/token from its schema", async () => {
		const h = await harness({ pinned: "pinned-runner" });
		const listed = (await h.client.listTools()).tools.find(t => t.name === tool)!;
		expect(listed.inputSchema.properties).not.toHaveProperty("instance_id");
		expect(listed.inputSchema.properties).not.toHaveProperty("token");
		await h.call(tool, { ...target, token: "ignored" });
		expect(h.calls).toEqual([{ url: endpoint.replace("runner%20%2Fone", "pinned-runner"), method: "POST", body: {} }]);
	});

	it.each(["run_id", "handoff_id"])("requires exact nonempty %s before dispatch", async key => {
		const h = await harness();
		for (const value of [undefined, ""]) {
			const out = await h.call(tool, { ...target, [key]: value });
			expect(out.result.isError).toBe(true);
		}
		expect(h.calls).toEqual([]);
	});

	it("requires runtime scope including dry-run", async () => {
		const h = await harness({ scopes: ["read", "write"] });
		for (const dry_run of [false, true]) expect((await h.call(tool, { ...target, dry_run })).text).toContain('requires MCP scope "runtime"');
		expect(h.calls).toEqual([]);
	});

	it("requires authentication before dispatch", async () => {
		const h = await harness({ authenticated: false });
		expect((await h.call(tool, target)).text).toContain("authentication required");
		expect(h.calls).toEqual([]);
	});
});
