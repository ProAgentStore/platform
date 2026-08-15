/**
 * What `coding_timeline` puts ON THE WIRE fits a calling host (#581 AC4).
 *
 * ── Why this is a second measurement and not a duplicate
 *
 * `workers/api/src/routes/coding-feed.test.ts` proves the ROUTE budgets its page, at ~40,000 B.
 * That is the number the API returns. It is not the number a host applies its limit to.
 *
 * #569 is the standing evidence for the difference: the API-side budget test asserted ~54,000 B
 * for `list_instance_tools`, production served **66,042 B**, and both were right — the MCP worker
 * pretty-printed the body on the way out with two-space indentation, adding ~22%. Every assertion
 * in the suite stopped one layer above the one that serialises, so the tool still did not fit the
 * limit that produced the issue and nothing could see it. #578 is the same tool still 653 B over
 * on its opt-in path.
 *
 * So this file measures the bytes the MCP TOOL returns, on a page the route would really produce.
 * A timeline reader is unbounded by nature — the record it reads holds 12,000-character terminal
 * snapshots — which is exactly the shape that has overflowed here before.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import type { McpEnv } from "../http.js";
import type { SafetyContext } from "../safety.js";
import { registerCodingTools } from "./coding.js";
import type { InstanceToolsCtx } from "./shared.js";

type ToolContent = { content: { type: string; text: string }[] };
type Handler = (args: Record<string, unknown>) => Promise<ToolContent>;
type Shape = Record<string, z.ZodTypeAny>;

const env: McpEnv = { API_BASE: "https://api.test" };

/** 64 KiB — the limit the calling host in #569 applied. */
const HOST_LIMIT = 64 * 1024;

/**
 * A page shaped like what the route emits at its byte budget, taken from the API-side measurement
 * on the real schema: 79 `terminal` rows, each cut to the 400-character tail, each carrying the
 * `chars` field that records its true 12,000-character length.
 *
 * SIZED against that measurement deliberately. A fixture of five short rows would pass any limit
 * assertion and certify ground it never walked (ADR 0002) — which is how #569's guard passed at
 * 54 KB against a production response of 66,042 B. What keeps this one honest is the `inline`
 * assertion below: the same 79 rows at their TRUE lengths are ten times the host limit, so the
 * per-row cap is demonstrably doing the work rather than the fixture being small.
 */
function feedPage(): Record<string, unknown> {
	const tail = "claude working on the thing\n".repeat(15).slice(0, 400);
	return {
		sessionId: "csess_88a4de4b-045b-4814-b978-b55626f62375",
		sessionStatus: "active",
		repoId: "crepo_2f1c9f0a-11d4-4f2e-9f0c-2a7b0d5e6f31",
		engineLabel: "claude:csess_88a4de4b-045b-4814-b978-b55626f62375",
		runState: "thinking",
		runnerConnected: true,
		events: Array.from({ length: 79 }, (_, i) => ({
			seq: 8900 + i,
			type: "terminal",
			content: tail,
			createdAt: "2026-08-15 14:20:57",
			chars: 12_000,
		})),
		nextSeq: 8978,
		hasMore: true,
		truncated: { events: 79, chars: 916_400 },
	};
}

let tools: Map<string, { schema: Shape; handler: Handler }>;

beforeEach(() => {
	vi.stubGlobal("fetch", async (input: string | URL | Request) => {
		const url = typeof input === "string" ? input : input.toString();
		// The tool resolves a slug through `my_instances` before it calls the route.
		const body = url.includes("/coding/timeline") ? feedPage() : { instances: [{ id: "inst-1", agentSlug: "coder" }] };
		return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
	});
	tools = new Map();
	const ctx: InstanceToolsCtx = {
		env,
		tokenFor: (provided?: string) => provided || "session-token",
		safetyFor: (): SafetyContext => ({ env, subject: "user-1", scopes: ["read", "write", "runtime", "destructive"] }),
		groups: new Set(["coding"]),
	} as InstanceToolsCtx;
	registerCodingTools(
		// biome-ignore lint/suspicious/noExplicitAny: minimal fake MCP server
		{ tool: (name: string, _d: string, schema: Shape, handler: Handler) => void tools.set(name, { schema, handler }) } as any,
		ctx,
	);
});

describe("coding_timeline wire size (#581 AC4)", () => {
	it("returns a budget-sized page under the host limit that produced #569", async () => {
		const t = tools.get("coding_timeline");
		if (!t) throw new Error("coding_timeline not registered");
		const out = await t.handler({ instance_id: "inst-1" });
		const bytes = new TextEncoder().encode(out.content[0].text).length;

		// G1 — the denominator, before any claim about it. A page that came back empty, or with
		// its `chars` fields dropped, would satisfy the size assertion by measuring nothing.
		const parsed = JSON.parse(out.content[0].text) as { events: { chars?: number }[] };
		expect(parsed.events).toHaveLength(79);
		expect(parsed.events.every((e) => e.chars === 12_000)).toBe(true);

		expect(bytes).toBeLessThan(HOST_LIMIT);

		// The tool serialises COMPACT. `jsonText` indented by default until #586 — the ~22% that
		// turned #569's asserted 54 KB into a served 66,042 B, and 44,313 B into 40,304 here.
		// Asserted directly rather than trusted to the helper, because "it happens to fit" is not
		// the same claim as "it is sent the way the fix sends it"; #586's own sweep in
		// `conformance.test.ts` makes the same assertion across all 136 tools.
		expect(out.content[0].text).toBe(JSON.stringify(parsed));

		// TWO bounds, and the second is the one #569's fix did not have. Re-introducing the
		// indentation would cost ~22% — and this page would STILL fit, because the route's
		// 40,000-byte budget leaves 1.5x of headroom under 64 KiB. So the payload does not depend
		// on how it happens to be serialised, which is the property that makes this a fix rather
		// than a coincidence. If a later change raises the budget until this arm fails, that is the
		// design decision being caught, not a broken test.
		const pretty = new TextEncoder().encode(JSON.stringify(parsed, null, 2)).length;
		expect(pretty).toBeLessThan(HOST_LIMIT);

		// And the ground this walks: the same 79 rows served at their true lengths — the shape
		// this tool would have had without the per-row cap — are an order of magnitude over.
		const inline = parsed.events.reduce((n, e) => n + (e.chars ?? 0), 0);
		expect(inline).toBeGreaterThan(HOST_LIMIT * 10);

		console.log(
			`✓ coding_timeline wire size: 79 rows, ${bytes} B compact vs ${pretty} B pretty ` +
				`(+${Math.round(((pretty - bytes) / bytes) * 100)}%, both under the ${HOST_LIMIT} B limit); ` +
				`the same rows uncut would be ${inline} chars`,
		);
	});
});
