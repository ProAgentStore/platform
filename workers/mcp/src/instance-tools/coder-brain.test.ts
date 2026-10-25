import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpEnv } from "../http.js";
import { registerCoderBrainTools } from "./coder-brain.js";

function setup(scopes = ["read", "write"]) {
	const tools = new Map<string, (input: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>>();
	const env = { API_BASE: "https://api.test", OAUTH_KV: { put: async () => {} } } as unknown as McpEnv;
	const fetch = vi.fn(async () => Response.json({ pilot: { model: "claude-sonnet-4-6", fallbackModel: "claude-sonnet-4-6", options: [] } }));
	vi.stubGlobal("fetch", fetch);
	const server = { tool: (name: string, _description: string, _schema: unknown, handler: (input: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>) => tools.set(name, handler) };
	registerCoderBrainTools(server as unknown as McpServer, { env, groups: new Set(), tokenFor: () => "session-token", safetyFor: () => ({ env, subject: "u1", scopes }) });
	return { tools, fetch };
}
afterEach(() => vi.unstubAllGlobals());

describe("set_coder_brain Pilot policy (#1316)", () => {
	it("maps pilot_model alone to pilotModel and returns the API's actual selected/fallback policy", async () => {
		const h = setup();
		const reply = await h.tools.get("set_coder_brain")!({ instance_id: "i1", pilot_model: "claude-sonnet-4-6" });
		expect(h.fetch).toHaveBeenCalledTimes(1);
		const [url, init] = h.fetch.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe("https://api.test/v1/instances/i1/coder-brain");
		expect(init.method).toBe("PUT");
		expect(JSON.parse(init.body as string)).toEqual({ pilotModel: "claude-sonnet-4-6" });
		expect(JSON.parse(reply.content[0].text)).toMatchObject({ pilot: { model: "claude-sonnet-4-6", fallbackModel: "claude-sonnet-4-6" } });
	});
	it("previews without any network call, and requires write scope", async () => {
		const h = setup();
		await h.tools.get("set_coder_brain")!({ instance_id: "i1", pilot_model: "claude-sonnet-4-6", dry_run: true });
		expect(h.fetch).not.toHaveBeenCalled();
		const denied = setup(["read"]);
		expect((await denied.tools.get("set_coder_brain")!({ instance_id: "i1", pilot_model: "claude-sonnet-4-6" })).content[0].text).toContain('requires MCP scope "write"');
		expect(denied.fetch).not.toHaveBeenCalled();
	});
	it("keeps the Pilot available to the read-only reports reader", async () => {
		const h = setup(["read"]);
		const reply = await h.tools.get("po_triage_reports")!({ instance_id: "i1" });
		expect(JSON.parse(reply.content[0].text).pilot.model).toBe("claude-sonnet-4-6");
	});
});
