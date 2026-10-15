import { afterEach, describe, expect, it, vi } from "vitest";
import { registerObservabilityTools } from "./observability.js";
import type { McpEnv } from "../http.js";
import type { SafetyContext } from "../safety.js";
import { WIRE_LIMIT_BYTES, wireBytes } from "../wire-budget.js";
import type { InstanceToolsCtx } from "./shared.js";

/**
 * #1090 — the history readers over MCP: every reply fits the wire, a walk reaches every row exactly
 * once even when rows are large enough to force smaller pages, a refusal stays a refusal, and the
 * filters a caller passes actually reach the API.
 *
 * The fake API pages a keyset log the way the routes do (`history-page.ts`): newest first, strictly
 * older than the cursor, `nextCursor` = the last row RETURNED. The walk is asserted against the
 * fixture itself (G1: the fixture is several times the wire limit, so a passing walk had to page).
 */

const ROWS = Array.from({ length: 400 }, (_, i) => ({ id: `r-${String(i).padStart(4, "0")}`, message: `${"x".repeat(1500)}${i}` }));

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;

function setup(api: (url: URL) => { status?: number; body: unknown }) {
	const urls: URL[] = [];
	vi.stubGlobal("fetch", async (input: string | URL | Request) => {
		const url = new URL(typeof input === "string" ? input : input.toString());
		urls.push(url);
		const out = api(url);
		return new Response(JSON.stringify(out.body), { status: out.status ?? 200, headers: { "Content-Type": "application/json" } });
	});
	const env: McpEnv = { API_BASE: "https://api.test" };
	const tools = new Map<string, Handler>();
	const server = { tool: (name: string, _d: string, _s: unknown, handler: Handler) => tools.set(name, handler) };
	const ctx: InstanceToolsCtx = {
		env,
		tokenFor: (provided?: string) => provided || "session-token",
		safetyFor: (): SafetyContext => ({ env, subject: "user-1", scopes: ["read"] }),
		groups: new Set<string>(),
	};
	// biome-ignore lint/suspicious/noExplicitAny: minimal fake MCP server, same shape as instance-tools.test.ts
	registerObservabilityTools(server as any, ctx);
	return {
		urls,
		async call(name: string, args: Record<string, unknown>) {
			const tool = tools.get(name);
			if (!tool) throw new Error(`${name} is not registered`);
			const text = (await tool(args)).content[0].text;
			// biome-ignore lint/suspicious/noExplicitAny: test reads arbitrary JSON reply fields
			return { text, body: JSON.parse(text) as Record<string, any> };
		},
	};
}

/** A keyset page over `rows` under `key`, as the API routes serve it. */
function keysetApi(key: string, rows: Array<{ id: string }>) {
	return (url: URL) => {
		const limit = Number(url.searchParams.get("limit")) || 100;
		const cursor = url.searchParams.get("cursor");
		const start = !cursor || cursor === "newest" ? 0 : rows.findIndex((r) => r.id === cursor) + 1;
		const page = rows.slice(start, start + limit);
		const hasMore = start + limit < rows.length;
		return { body: { order: "newest_first", count: page.length, [key]: page, hasMore, nextCursor: hasMore ? page[page.length - 1].id : null, coverage: { retention: { days: 30 } } } };
	};
}

afterEach(() => vi.unstubAllGlobals());

describe("history pages fit the wire and walk completely (#1090)", () => {
	it("G1: the fixture is several times the wire limit", () => {
		expect(wireBytes(JSON.stringify(ROWS))).toBeGreaterThan(WIRE_LIMIT_BYTES * 8);
	});

	for (const [tool, key, args] of [
		["list_errors", "errors", {}],
		["agent_trace", "events", { instance_id: "iA" }],
		["admin_action_audit", "audit", {}],
		["admin_mcp_audit", "events", {}],
	] as const) {
		it(`${tool}: every page under the limit, every row exactly once, in order`, async () => {
			const h = setup(keysetApi(key, ROWS));
			const seen: string[] = [];
			let cursor: string | undefined = "newest";
			let pages = 0;
			while (cursor && pages < 100) {
				const { text, body } = await h.call(tool, { ...args, cursor, limit: 200 });
				expect(wireBytes(text)).toBeLessThanOrEqual(WIRE_LIMIT_BYTES);
				seen.push(...body[key].map((r: { id: string }) => r.id));
				cursor = body.nextCursor ?? undefined;
				pages++;
			}
			expect(pages).toBeGreaterThan(8);
			expect(seen).toEqual(ROWS.map((r) => r.id));
		});
	}

	it("one row over the budget on its own is delivered once, cut and marked, and the walk still advances", async () => {
		const huge = [{ id: "big", message: "y".repeat(200_000), context: "small" }, { id: "next", message: "ok" }];
		const h = setup(keysetApi("errors", huge));
		const first = await h.call("list_errors", { cursor: "newest" });
		expect(wireBytes(first.text)).toBeLessThanOrEqual(WIRE_LIMIT_BYTES);
		expect(first.body.errors.map((r: { id: string }) => r.id)).toEqual(["big"]);
		expect(first.body.errors[0].message).toContain("[cut: showing the first");
		expect(first.body.budgetNote).toContain("message");
		const second = await h.call("list_errors", { cursor: first.body.nextCursor });
		expect(second.body.errors.map((r: { id: string }) => r.id)).toEqual(["next"]);
	});

	it("a refusal passes through as a refusal — never reshaped into an empty page", async () => {
		const h = setup(() => ({ status: 403, body: { error: "Admin access required" } }));
		for (const tool of ["admin_mcp_audit", "admin_action_audit"]) {
			const { body } = await h.call(tool, {});
			expect(body.error).toBeTruthy();
			expect(body.audit ?? body.events).toBeUndefined();
		}
	});
});

describe("filters and modes reach the API (#1090)", () => {
	it("list_errors forwards level, build, time, instance and run; a cursor replaces offset", async () => {
		const h = setup(keysetApi("errors", ROWS.slice(0, 2)));
		await h.call("list_errors", { cursor: "newest", offset: 50, level: "warn", build: "abc123", since: "2026-10-01T00:00:00Z", until: "2026-10-02T00:00:00Z", instance_id: "iA", run_id: "run-1", scope: "all" });
		const q = h.urls[0].searchParams;
		expect(Object.fromEntries(q)).toMatchObject({ cursor: "newest", level: "warn", build: "abc123", since: "2026-10-01T00:00:00Z", until: "2026-10-02T00:00:00Z", instance_id: "iA", run_id: "run-1", scope: "all" });
		expect(q.has("offset")).toBe(false);
	});

	it("agent_trace keeps its legacy window unless asked for the walk; since or scope=all imply it", async () => {
		const h = setup((url) => (url.searchParams.has("cursor") ? keysetApi("events", ROWS.slice(0, 1))(url) : { body: { instanceId: "iA", count: 1, events: [ROWS[0]] } }));
		const legacy = await h.call("agent_trace", { instance_id: "iA", limit: 50 });
		expect(h.urls[0].searchParams.has("cursor")).toBe(false);
		expect(legacy.body.page).toBeDefined(); // the legacy offset page, unchanged
		await h.call("agent_trace", { instance_id: "iA", since: "2026-10-01T00:00:00Z" });
		expect(h.urls[1].searchParams.get("cursor")).toBe("newest");
		await h.call("agent_trace", { instance_id: "iZ", scope: "all" });
		expect(Object.fromEntries(h.urls[2].searchParams)).toMatchObject({ cursor: "newest", scope: "all" });
	});

	it("error_summary forwards scope and build, and pages signatures to fit the wire", async () => {
		const signatures = Array.from({ length: 300 }, (_, i) => ({ signature: `${"s".repeat(400)}${i}`, count: 1 }));
		const h = setup(() => ({ body: { scope: "all", total: 300, rows: 300, truncated: false, signatures } }));
		const { text, body } = await h.call("error_summary", { scope: "all", build: "abc123" });
		expect(Object.fromEntries(h.urls[0].searchParams)).toMatchObject({ scope: "all", build: "abc123" });
		expect(wireBytes(text)).toBeLessThanOrEqual(WIRE_LIMIT_BYTES);
		expect(body.total).toBe(300);
		expect(body.page).toMatchObject({ of: 300, hasMore: true });
	});
});
