import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import type { SafetyContext } from "../safety.js";
import { registerWebsiteAccessTools } from "./website-access.js";

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
function fixture(scopes: SafetyContext["scopes"] = ["read", "write", "runtime"]) {
	const requests: Array<{ url: string; method: string; body?: unknown }> = [];
	vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
		requests.push({ url: String(url), method: init?.method ?? "GET", ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
		return Response.json({ request: { id: "question", hostname: "jobs.example.com", status: "approved" }, recorded: true, resumed: false });
	});
	const handlers = new Map<string, { schema: z.ZodObject<z.ZodRawShape>; handler: Handler }>();
	const env = { API_BASE: "https://api.test" };
	registerWebsiteAccessTools({ tool: (name: string, _description: string, schema: z.ZodRawShape, handler: Handler) => handlers.set(name, { schema: z.object(schema), handler }) } as never, { env, tokenFor: () => "session", safetyFor: () => ({ env, subject: "u1", scopes }), groups: new Set() });
	return { requests, call: async (name: string, input: Record<string, unknown>) => {
		const tool = handlers.get(name)!;
		return (await tool.handler(tool.schema.parse(input))).content[0].text;
	} };
}
afterEach(() => vi.unstubAllGlobals());
it("uses distinct read endpoints without turning reads into approval", async () => {
	const f = fixture(["read"]);
	await f.call("list_instance_website_requests", { instance_id: "i/1", cursor: "older id" });
	await f.call("get_instance_website_request", { instance_id: "i/1", request_id: "q/1" });
	await f.call("list_instance_website_decisions", { instance_id: "i/1" });
	expect(f.requests.map((r) => r.url)).toEqual(["https://api.test/v1/instances/i%2F1/website-requests?cursor=older%20id", "https://api.test/v1/instances/i%2F1/website-requests/q%2F1", "https://api.test/v1/instances/i%2F1/website-grants"]);
	expect(f.requests.every((r) => r.method === "GET")).toBe(true);
});
it("previews answer/revoke without writes, preserves saved-versus-resumed truth, and cannot supply another hostname", async () => {
	const f = fixture();
	const input = { instance_id: "i1", request_id: "q1", decision: "approve" };
	const preview = JSON.parse(await f.call("answer_instance_website_request", { ...input, dry_run: true }));
	expect(preview.wouldDo).toMatchObject({ method: "POST", body: { decision: "approve" } });
	await f.call("revoke_instance_website_decision", { instance_id: "i1", hostname: "jobs.example.com", dry_run: true });
	expect(f.requests).toEqual([]);
	expect(JSON.parse(await f.call("answer_instance_website_request", { ...input, hostname: "other.example" }))).toMatchObject({ recorded: true, resumed: false });
	expect(f.requests[0].body).toEqual({ decision: "approve" });
	await f.call("revoke_instance_website_decision", { instance_id: "i1", hostname: "jobs.example.com" });
	expect(f.requests.at(-1)).toMatchObject({ method: "DELETE", url: "https://api.test/v1/instances/i1/website-grants/jobs.example.com" });
});
it.each(["read", "runtime", "write"] as const)("requires both write and runtime authority for an answer (%s)", async (scope) => {
	const f = fixture([scope]);
	expect(await f.call("answer_instance_website_request", { instance_id: "i1", request_id: "q1", decision: "deny" })).toContain("requires MCP scope");
	expect(f.requests).toEqual([]);
});
