/**
 * #1335 through the real MCP tool schema: `coding_fleet_history` forwards every filter, the cursor and the page size to the owner-wide route
 * unchanged, asks for nothing it was not given, and is a read. The handler is driven for real against a stubbed `fetch`; what is asserted is
 * the request that goes on the wire.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpEnv } from "../http.js";
import type { SafetyContext } from "../safety.js";
import { registerCodingTools } from "./coding.js";
import type { InstanceToolsCtx } from "./shared.js";

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
const env: McpEnv = { API_BASE: "https://api.test" };

function setup(scopes: SafetyContext["scopes"] = ["read"]) {
	const calls: URL[] = [];
	vi.stubGlobal("fetch", async (input: string | URL | Request) => {
		const url = new URL(String(input));
		calls.push(url);
		return new Response(JSON.stringify({ items: [], complete: true, nextCursor: null, summary: { scope: "full_range", attempts: 100, runs: 2 }, coverage: { status: "partial", gaps: [] } }), { status: 200, headers: { "content-type": "application/json" } });
	});
	const tools = new Map<string, Handler>();
	const ctx: InstanceToolsCtx = { env, tokenFor: (t?: string) => t || "session-token", safetyFor: (): SafetyContext => ({ env, subject: "u1", scopes }), groups: new Set() };
	// biome-ignore lint/suspicious/noExplicitAny: minimal fake MCP server, same shape as objective-lifecycle-tools.test.ts
	registerCodingTools({ tool: (n: string, _d: string, _s: unknown, h: Handler) => tools.set(n, h) } as any, ctx);
	/** The history request itself — a slug lookup may have read the roster before it. */
	const history = () => calls.find((u) => u.pathname === "/v1/instances/my/coding-history") as URL;
	return { tools, calls, history };
}

afterEach(() => vi.unstubAllGlobals());

describe("coding_fleet_history (#1335)", () => {
	it("with no arguments reads every instance: the owner-wide route, no filter invented", async () => {
		const { tools, calls, history } = setup();
		await tools.get("coding_fleet_history")?.({});
		expect(calls).toHaveLength(1);
		expect(history().search).toBe("");
	});

	it("forwards each filter, the cursor exactly as given, the page size and the summary switch", async () => {
		const { tools, history } = setup();
		await tools.get("coding_fleet_history")?.({ instance_id: "i1", repo: "acme/app", issue: 3, since: "2026-10-01", until: "1793000000000", outcome: "admission_failed", kind: "attempt", cursor: "1793000000000:attempt.objq-1", limit: 50, summary: false });
		expect(Object.fromEntries(history().searchParams)).toEqual({
			instance_id: "i1",
			repo: "acme/app",
			issue: "3",
			since: "2026-10-01",
			until: "1793000000000",
			outcome: "admission_failed",
			kind: "attempt",
			cursor: "1793000000000:attempt.objq-1",
			limit: "50",
			summary: "false",
		});
	});

	it("hands the API's answer back whole, so the full-range summary and the coverage reach the caller", async () => {
		const { tools } = setup();
		const out = await tools.get("coding_fleet_history")?.({ repo: "acme/app" });
		expect(JSON.parse(out?.content[0].text ?? "{}")).toMatchObject({ summary: { scope: "full_range", attempts: 100, runs: 2 }, coverage: { status: "partial" } });
	});
});
