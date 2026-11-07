import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpEnv } from "../http.js";
import { registerApplicationTools } from "./applications.js";

const sessions: Array<{ client: Client; server: McpServer }> = [];
afterEach(async () => {
	await Promise.all(sessions.splice(0).map(async ({ client, server }) => { await client.close(); await server.close(); }));
	vi.unstubAllGlobals();
});

async function harness(scopes: Array<"read" | "write" | "runtime" | "destructive"> = ["read", "write", "destructive"]) {
	const calls: Array<{ url: string; method: string; body: { dry_run?: boolean } }> = [];
	vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
		const body = init?.body ? JSON.parse(String(init.body)) : {};
		calls.push({ url: String(input), method: init?.method ?? "GET", body });
		const result = String(input).includes("repair-leads") ? { repair: { dryRun: body.dry_run, scanned: 4 } } : { rekey: { dryRun: body.dry_run, scanned: 2, collisions: [] } };
		return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
	});
	const env: McpEnv = { API_BASE: "https://api.test" };
	const server = new McpServer({ name: "job-repairs-test", version: "1" });
	registerApplicationTools(server, { env, tokenFor: () => "test-session", safetyFor: () => ({ env, subject: "owner", scopes }) });
	const client = new Client({ name: "test", version: "1" });
	const [a, b] = InMemoryTransport.createLinkedPair();
	await server.connect(b);
	await client.connect(a);
	sessions.push({ client, server });
	const call = async (name: string, args: Record<string, unknown>) => {
		const r = await client.callTool({ name, arguments: args });
		return (r.content as Array<{ type: string; text?: string }>).map((c) => c.text).join("\n");
	};
	return { calls, call };
}

describe.each([
	["repair_job_leads", "/v1/instances/scout/gmail-scout/repair-leads", "repair"],
	["rekey_job_applications", "/v1/instances/tailor/job-applications/rekey", "rekey"],
])("%s (#1610)", (tool, path, key) => {
	const id = tool === "repair_job_leads" ? "scout" : "tailor";
	it("defaults to a dry run: the route is asked for dry_run true and its result comes back as is", async () => {
		const { calls, call } = await harness();
		const out = JSON.parse(await call(tool, { instance_id: id }));
		expect(calls).toEqual([{ url: `https://api.test${path}`, method: "POST", body: { dry_run: true } }]);
		expect(out[key].dryRun).toBe(true);
	});
	it("a real run is refused without the destructive scope, and a dry run needs only write", async () => {
		const { calls, call } = await harness(["read", "write"]);
		expect(await call(tool, { instance_id: id, dry_run: false, confirm: tool })).toContain('requires MCP scope "destructive"');
		expect(calls).toHaveLength(0);
		expect(JSON.parse(await call(tool, { instance_id: id }))[key].dryRun).toBe(true);
	});
	it("a real run needs confirm equal to the tool name, and sends nothing without it", async () => {
		const { calls, call } = await harness();
		expect(await call(tool, { instance_id: id, dry_run: false })).toContain(`requires confirm="${tool}"`);
		expect(await call(tool, { instance_id: id, dry_run: false, confirm: "yes" })).toContain("requires confirm");
		expect(calls).toHaveLength(0);
		const out = JSON.parse(await call(tool, { instance_id: id, dry_run: false, confirm: tool }));
		expect(calls).toEqual([{ url: `https://api.test${path}`, method: "POST", body: { dry_run: false } }]);
		expect(out[key].dryRun).toBe(false);
	});
});

describe("repair_job_leads scope (#1611)", () => {
	it("passes the scope through to the route, and sends none when it is not given", async () => {
		const { calls, call } = await harness();
		await call("repair_job_leads", { instance_id: "scout", scope: "infrastructure_failures" });
		expect(calls).toEqual([{ url: "https://api.test/v1/instances/scout/gmail-scout/repair-leads", method: "POST", body: { dry_run: true, scope: "infrastructure_failures" } }]);
	});
});
