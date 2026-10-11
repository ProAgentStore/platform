/**
 * #1017 through the real MCP tool schemas: every continuation the API advertises has an argument that
 * reaches it, and the lifecycle read forwards exactly the handles it was given.
 *
 * The handlers are driven for real against a stubbed `fetch`; what is asserted is the request that
 * goes on the wire. Invariant protected: API/MCP pagination parity — `startsNextOffset` was returned
 * by `coding_loop_status` with no argument to pass it back, so receipts past the first 20 were
 * unreachable through the tool.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpEnv } from "../http.js";
import type { SafetyContext } from "../safety.js";
import { registerCodingTools } from "./coding.js";
import type { InstanceToolsCtx } from "./shared.js";

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
const env: McpEnv = { API_BASE: "https://api.test" };

function setup(scopes: SafetyContext["scopes"] = ["read"]) {
	const calls: Array<{ url: URL; headers: Record<string, string> }> = [];
	vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input));
		calls.push({ url, headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)) });
		const body = url.pathname.endsWith("/loop") ? { runs: [], total: 0, offset: 0, nextOffset: null, starts: [], startsTotal: 45, startsOffset: 20, startsNextOffset: 40, startsComplete: false } : { events: [], nextCursor: null, complete: true };
		return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
	});
	const tools = new Map<string, Handler>();
	const ctx: InstanceToolsCtx = { env, tokenFor: (t?: string) => t || "session-token", safetyFor: (): SafetyContext => ({ env, subject: "u1", scopes }), groups: new Set() };
	// biome-ignore lint/suspicious/noExplicitAny: minimal fake MCP server, same shape as board-paging.test.ts
	registerCodingTools({ tool: (n: string, _d: string, _s: unknown, h: Handler) => tools.set(n, h) } as any, ctx);
	const api = () => calls.filter((c) => c.url.pathname.includes("/v1/instances/i1/"));
	return { tools, api };
}

afterEach(() => vi.unstubAllGlobals());

describe("pagination parity for the objective-queue surfaces (#1017)", () => {
	it("coding_loop_status forwards starts_offset, so every receipt page is reachable", async () => {
		const { tools, api } = setup();
		const out = await tools.get("coding_loop_status")?.({ instance_id: "i1", starts_offset: 20 });
		const call = api()[0];
		expect(call.url.pathname).toBe("/v1/instances/i1/loop");
		expect(call.url.searchParams.get("include_starts")).toBe("true");
		expect(call.url.searchParams.get("starts_offset")).toBe("20");
		// …and the continuation for the NEXT page reaches the caller.
		expect(JSON.parse(out?.content[0].text ?? "{}")).toMatchObject({ startsNextOffset: 40, startsComplete: false });
	});

	it("coding_loop_queue pages history with status all + offset, and keeps the pending default", async () => {
		const { tools, api } = setup();
		await tools.get("coding_loop_queue")?.({ instance_id: "i1", status: "all", offset: 50 });
		await tools.get("coding_loop_queue")?.({ instance_id: "i1" });
		const [all, pending] = api();
		expect(all.url.pathname).toBe("/v1/instances/i1/loop/queue");
		expect(Object.fromEntries(all.url.searchParams)).toEqual({ status: "all", offset: "50" });
		expect(pending.url.search).toBe("");
	});

	it("coding_loop_lifecycle forwards exactly the handle and cursor it was given, as a read", async () => {
		const { tools, api } = setup(["read"]);
		await tools.get("coding_loop_lifecycle")?.({ instance_id: "i1", request_id: "req-1", cursor: 7, limit: 25 });
		const call = api()[0];
		expect(call.url.pathname).toBe("/v1/instances/i1/loop/lifecycle");
		expect(Object.fromEntries(call.url.searchParams)).toEqual({ request_id: "req-1", cursor: "7", limit: "25" });
	});

	it("declares the client category on every API call — a claim the API records beside the verified uid", async () => {
		const { tools, api } = setup();
		await tools.get("coding_loop_lifecycle")?.({ instance_id: "i1", run_id: "run-1" });
		expect(api()[0].headers["X-PAGS-Client"]).toBe("mcp");
	});

	it("forwards the keyset cursors (#1017) — the stable continuation beside the legacy offsets", async () => {
		const { tools, api } = setup();
		await tools.get("coding_loop_status")?.({ instance_id: "i1", cursor: "1700:run-9", starts_cursor: "1600:req-4" });
		await tools.get("coding_loop_queue")?.({ instance_id: "i1", status: "all", cursor: "1500:objq-2" });
		const [status, queue] = api();
		expect(status.url.searchParams.get("cursor")).toBe("1700:run-9");
		expect(status.url.searchParams.get("starts_cursor")).toBe("1600:req-4");
		expect(Object.fromEntries(queue.url.searchParams)).toEqual({ status: "all", cursor: "1500:objq-2" });
	});
});
