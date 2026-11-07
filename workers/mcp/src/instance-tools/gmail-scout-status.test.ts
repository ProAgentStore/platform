import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { McpEnv } from "../http.js";
import { registerGmailScoutTools } from "./gmail-scout.js";

afterEach(() => vi.unstubAllGlobals());

describe("gmail_scout_status (#1597)", () => {
	it("returns the API's ISO scan times unchanged", async () => {
		const reply = { state: { lastScanAt: "2026-11-07T05:42:00.000Z", lastFailureAt: null }, receipts: [] };
		vi.stubGlobal("fetch", async () => new Response(JSON.stringify(reply), { headers: { "Content-Type": "application/json" } }));
		const handlers = new Map<string, { handler: (a: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>; schema: z.ZodObject<z.ZodRawShape> }>();
		const env: McpEnv = { API_BASE: "https://api.test" };
		registerGmailScoutTools({ tool: (name: string, _d: string, schema: z.ZodRawShape, handler: never) => handlers.set(name, { handler, schema: z.object(schema) }) } as never, {
			env, tokenFor: () => "session", safetyFor: () => ({ env, subject: "u1", scopes: ["read"] }), groups: new Set(),
		} as never);
		const tool = handlers.get("gmail_scout_status")!;
		const out = await tool.handler(tool.schema.parse({ instance_id: "i1" }));
		expect(JSON.parse(out.content[0].text)).toEqual(reply);
	});
});
