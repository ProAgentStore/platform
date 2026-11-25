/**
 * #1042: MCP's engine choice is marked as MCP on the wire, and never carries the console's API-coding
 * acknowledgement — so the API can refuse it any API-key coding the owner did not confirm in the console.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerCodingEngineTools } from "./coding-engine-tools.js";
import type { McpEnv } from "./http.js";
import type { SafetyContext } from "./safety.js";

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
const env: McpEnv = { API_BASE: "https://api.test" };

afterEach(() => vi.unstubAllGlobals());

describe("coding_engine_set (#1042)", () => {
	it("sends X-PAGS-Client: mcp and no acknowledgeApiCoding, whatever it is asked", async () => {
		const calls: Array<{ headers: Record<string, string>; body: Record<string, unknown> }> = [];
		vi.stubGlobal("fetch", async (_input: string | URL | Request, init?: RequestInit) => {
			calls.push({ headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body ? JSON.parse(String(init.body)) : {} });
			return new Response(JSON.stringify({ error: "API-key coding can only be turned on in the console" }), { status: 403, headers: { "content-type": "application/json" } });
		});
		const tools = new Map<string, Handler>();
		// biome-ignore lint/suspicious/noExplicitAny: minimal fake MCP server
		registerCodingEngineTools({ tool: (n: string, _d: string, _s: unknown, h: Handler) => tools.set(n, h) } as any, env, (t?: string) => t || "tok", (): SafetyContext => ({ env, subject: "u1", scopes: ["read", "write"] }));
		const out = await tools.get("coding_engine_set")?.({ instance_id: "i1", engine_id: "claude-api", model: "claude-opus-5", acknowledgeApiCoding: true });
		expect(calls).toHaveLength(1);
		expect(calls[0].headers["X-PAGS-Client"]).toBe("mcp");
		expect(calls[0].body).toEqual({ engineId: "claude-api", model: "claude-opus-5" });
		expect(out?.content[0].text).toMatch(/only be turned on in the console/);
	});
});

describe("coding_engine_set fallback (#1712)", () => {
	it("sends fallbackId, null for an empty string, and nothing when omitted", async () => {
		const bodies: Array<Record<string, unknown>> = [];
		vi.stubGlobal("fetch", async (_input: string | URL | Request, init?: RequestInit) => {
			bodies.push(init?.body ? JSON.parse(String(init.body)) : {});
			return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
		});
		const tools = new Map<string, Handler>();
		// biome-ignore lint/suspicious/noExplicitAny: minimal fake MCP server
		registerCodingEngineTools({ tool: (n: string, _d: string, _s: unknown, h: Handler) => tools.set(n, h) } as any, env, (t?: string) => t || "tok", (): SafetyContext => ({ env, subject: "u1", scopes: ["read", "write"] }));
		const set = tools.get("coding_engine_set");
		await set?.({ instance_id: "i1", engine_id: "codex", fallback_id: "claude" });
		await set?.({ instance_id: "i1", engine_id: "codex", fallback_id: "" });
		await set?.({ instance_id: "i1", engine_id: "codex" });
		expect(bodies).toEqual([{ engineId: "codex", fallbackId: "claude" }, { engineId: "codex", fallbackId: null }, { engineId: "codex" }]);
	});
});
