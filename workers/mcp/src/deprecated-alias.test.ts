/**
 * #1243 — the four duplicate names are aliases of their survivors: the survivor's schema, its handler,
 * and a note naming it on every reply.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DEPRECATED_ALIAS_REMOVAL_DATE, deprecationNote, registerAliasTarget, registerDeprecatedAlias, withDeprecationNote } from "./deprecated-alias.js";

type Reg = { description: string; shape: Record<string, unknown>; handler: (args: unknown, extra: unknown) => Promise<unknown> };

function fakeServer() {
	const tools = new Map<string, Reg>();
	const server = {
		tool: (name: string, description: string, shape: Record<string, unknown>, handler: Reg["handler"]) => {
			if (tools.has(name)) throw new Error(`Tool ${name} is already registered`);
			tools.set(name, { description, shape, handler });
		},
	} as unknown as McpServer;
	return { server, tools };
}

describe("a deprecated alias (#1243)", () => {
	it("is registered with the survivor's own schema, and runs the survivor's handler", async () => {
		const { server, tools } = fakeServer();
		const seen: unknown[] = [];
		const shape = { instance_id: z.string(), run_id: z.string().optional() };
		const target = registerAliasTarget(server, "coding_loop_status", "Check a run.", shape, async (args) => {
			seen.push(args);
			return { content: [{ type: "text" as const, text: '{"runs":[]}' }] };
		});
		registerDeprecatedAlias(server, "check_instance_loop", target);

		const alias = tools.get("check_instance_loop");
		expect(alias?.shape).toBe(shape);
		expect(alias?.description).toMatch(/^Deprecated alias for coding_loop_status \(#1243\)/);
		expect(alias?.description).toContain(DEPRECATED_ALIAS_REMOVAL_DATE);

		const out = (await alias?.handler({ instance_id: "i1" }, {})) as { content: Array<{ text: string }> };
		expect(seen).toEqual([{ instance_id: "i1" }]);
		// The survivor's result first, untouched; the note after it.
		expect(out.content.map((c) => c.text)).toEqual(['{"runs":[]}', deprecationNote("coding_loop_status")]);
		expect(out.content[1].text).toMatch(/^⚠️ This tool name is deprecated — use `coding_loop_status` instead\./);
	});

	it("leaves a result with no content (a structured refusal) exactly as it is", () => {
		const refusal = { error: "not signed in" };
		expect(withDeprecationNote(refusal, "coding_loop_stop")).toBe(refusal);
	});
});
