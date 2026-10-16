/**
 * #1109 — `get_instance_operator_manual` stays inside the wire budget. The generated `context` of an
 * agent declaring the whole catalogue (~41k) beside a full owner manual (16k) would not, so the tool
 * pages `context` (never `manual`) and says where it stands.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpEnv } from "../http.js";
import type { SafetyContext } from "../safety.js";
import { WIRE_BUDGET_BYTES, wireBytes } from "../wire-budget.js";
import { registerSettingsTools } from "./settings.js";

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;

function manualTool(body: unknown) {
	const urls: string[] = [];
	vi.stubGlobal("fetch", async (input: string | URL | Request) => {
		urls.push(String(input));
		return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
	});
	const handlers = new Map<string, Handler>();
	const env: McpEnv = { API_BASE: "https://api.test" };
	registerSettingsTools({ tool: (name: string, _d: string, _s: unknown, h: Handler) => handlers.set(name, h) } as never, {
		env,
		tokenFor: (p?: string) => p || "session-token",
		safetyFor: (): SafetyContext => ({ env, subject: "user-1", scopes: ["read"] }),
		groups: new Set<string>(),
	} as never);
	return { urls, call: (args: Record<string, unknown>) => (handlers.get("get_instance_operator_manual") as Handler)(args).then((r) => r.content[0].text) };
}

afterEach(() => vi.unstubAllGlobals());

describe("get_instance_operator_manual pages the generated context (#1109)", () => {
	it("returns a small manual whole, unpaged", async () => {
		const body = { manual: "notes", rules: "", context: "## Operating this instance (generated)\n- `x` — y" };
		const { call, urls } = manualTool(body);
		expect(JSON.parse(await call({ instance_id: "i1" }))).toEqual(body);
		expect(urls).toEqual(["https://api.test/v1/instances/i1/operator-manual"]);
	});

	it("pages an oversized context by offset: every page fits, the manual is whole on each, and the pages rebuild the context exactly", async () => {
		const manual = "M".repeat(16_000);
		const context = Array.from({ length: 900 }, (_, i) => `- \`tool_${i}\` — does thing ${i}. Args: \`a\` string (required). read-only. Reach: chat.`).join("\n");
		const { call } = manualTool({ manual, rules: "", context });
		let rebuilt = "";
		let offset: number | undefined;
		for (let guard = 0; guard < 20; guard++) {
			const text = await call({ instance_id: "i1", ...(offset === undefined ? {} : { context_offset: offset }) });
			expect(wireBytes(text)).toBeLessThanOrEqual(WIRE_BUDGET_BYTES);
			const page = JSON.parse(text) as { manual: string; context: string; contextPage: { nextOffset: number | null; of: number } };
			expect(page.manual).toBe(manual);
			expect(page.contextPage.of).toBe(context.length);
			rebuilt += page.context;
			if (page.contextPage.nextOffset === null) break;
			offset = page.contextPage.nextOffset;
		}
		expect(rebuilt).toBe(context);
	});
});
