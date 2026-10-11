/**
 * `coding_session_capture` paging (#1018), through the real registered handler with a stubbed API.
 *
 * Fixtures are SYNTHETIC: generated `line NNNNN` text, no real terminal output, path or identifier.
 *
 * Invariants protected: the default reply ends at the NEWEST output (the reported failure was a
 * first page that began with the oldest kept output); every advertised continuation (`olderBefore`
 * backwards, `nextOffset` forwards) is executable and the pages tile the pane exactly, with no gap or
 * overlap; every page fits the host budget; growing output is visible on the next call; the counts
 * are explained; and the capture only ever asks for the caller's session under the caller's token.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerCodingSessionTools } from "./coding-tools.js";
import type { McpEnv } from "./http.js";
import type { SafetyContext } from "./safety.js";
import { WIRE_BUDGET_BYTES, wireBytes } from "./wire-budget.js";

const env: McpEnv = { API_BASE: "https://api.test" };
type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
/** Synthetic pane: `n` numbered lines, each with some filler and a JSON-escaping character. */
const pane = (n: number) => Array.from({ length: n }, (_, i) => `line ${String(i + 1).padStart(5, "0")} "synthetic output" ${"x".repeat(40)}`).join("\n");

function setup(state: { pane: string; paneChars?: number }) {
	const calls: Array<{ path: string; auth: string | undefined }> = [];
	vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input));
		calls.push({ path: url.pathname, auth: (init?.headers as Record<string, string> | undefined)?.Authorization });
		const body = url.pathname.endsWith("/capture")
			? { pane: state.pane, paneChars: state.paneChars ?? state.pane.length, runState: "thinking", alive: true, ready: false, runnerConnected: true }
			: { sessions: [{ id: "s1", status: "active" }] };
		return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
	});
	const tools = new Map<string, Handler>();
	registerCodingSessionTools(
		// biome-ignore lint/suspicious/noExplicitAny: minimal fake MCP server, same shape as coding-repo-remove.test.ts
		{ tool: (n: string, _d: string, _s: unknown, h: Handler) => tools.set(n, h) } as any,
		env,
		(t?: string) => t || "caller-token",
		(): SafetyContext => ({ env, subject: "u1", scopes: ["read"] }),
	);
	const capture = async (args: Record<string, unknown> = {}) => {
		const out = await tools.get("coding_session_capture")?.({ instance_id: "i1", ...args });
		const text = out?.content[0].text ?? "";
		return { text, body: JSON.parse(text) as { pane: string; paneChars: number; panePage?: { offset: number; count: number; of: number; nextOffset: number | null; olderBefore: number | null; newest: boolean }; paneRepresentation?: string; capturedAt: string; source: string } };
	};
	return { capture, calls };
}

afterEach(() => vi.unstubAllGlobals());

describe("coding_session_capture pages a long pane newest-first (#1018)", () => {
	it("a pane that fits comes back whole, unpaged, dated as a live reading", async () => {
		const { capture } = setup({ pane: pane(20) });
		const { body } = await capture();
		expect(body.pane).toBe(pane(20));
		expect(body.panePage).toBeUndefined();
		expect(body).toMatchObject({ source: "live" });
		expect(Number.isNaN(Date.parse(body.capturedAt))).toBe(false);
	});

	it("the default reply ends at the newest output, within the budget", async () => {
		const text = pane(1500);
		const { capture } = setup({ pane: text, paneChars: text.length + 30_000 });
		const { text: wire, body } = await capture();
		expect(wireBytes(wire)).toBeLessThanOrEqual(WIRE_BUDGET_BYTES);
		expect(body.pane.endsWith("line 01500 \"synthetic output\" " + "x".repeat(40))).toBe(true);
		expect(body.panePage).toMatchObject({ newest: true, nextOffset: null, of: text.length });
		expect(body.panePage?.olderBefore).toBeGreaterThan(0);
		// The two counts measure different things, and the reply says which.
		expect(body.paneChars).toBe(text.length + 30_000);
		expect(body.paneRepresentation).toContain("paneChars");
	});

	it("walking back with olderBefore reconstructs the whole pane exactly — no gap, no overlap", async () => {
		const text = pane(1500);
		const { capture } = setup({ pane: text });
		const pages: string[] = [];
		let before: number | null | undefined;
		for (let guard = 0; guard < 20; guard++) {
			const { text: wire, body } = await capture(before === undefined ? {} : { before });
			expect(wireBytes(wire)).toBeLessThanOrEqual(WIRE_BUDGET_BYTES);
			pages.unshift(body.pane);
			before = body.panePage?.olderBefore ?? null;
			if (before === null) break;
		}
		expect(pages.length).toBeGreaterThan(1);
		expect(pages.join("")).toBe(text);
	});

	it("walking forward from offset 0 with nextOffset reconstructs it too", async () => {
		const text = pane(1500);
		const { capture } = setup({ pane: text });
		let offset: number | null = 0;
		let out = "";
		for (let guard = 0; offset !== null && guard < 20; guard++) {
			const { body } = await capture({ offset });
			out += body.pane;
			offset = body.panePage?.nextOffset ?? null;
		}
		expect(out).toBe(text);
	});

	it("output that grows between calls is visible as the new newest page", async () => {
		const state = { pane: pane(1500) };
		const { capture } = setup(state);
		expect((await capture()).body.pane).toContain("line 01500");
		state.pane = pane(1600);
		const { body } = await capture();
		expect(body.pane).toContain("line 01600");
		expect(body.panePage?.newest).toBe(true);
	});

	it("asks only for the caller's own session, under the caller's own token", async () => {
		const { capture, calls } = setup({ pane: pane(5) });
		await capture({ session_id: "s1", token: "caller-token" });
		expect(calls.map((c) => c.path)).toEqual(["/v1/instances/i1/coding/sessions", "/v1/instances/i1/coding/sessions/s1/capture"]);
		expect(new Set(calls.map((c) => c.auth))).toEqual(new Set(["Bearer caller-token"]));
	});
});
