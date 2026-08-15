/**
 * What `list_instance_tools` puts ON THE WIRE fits a calling host (#569).
 *
 * ── Why this exists next to the API-side budget test ────────────────────────────────────
 *
 * #569 was filed because a host refused the response. The fix budgeted the payload down —
 * schemas became opt-in — and `workers/api/src/lib/tool-listing-budget.test.ts` proved it, at
 * ~54,000 bytes for a 104-row instance.
 *
 * Production then measured **66,042 bytes** for the same call. Both numbers were right: the API
 * test asserted the route's COMPACT body, and the MCP worker pretty-printed it with two-space
 * indentation on the way out, adding ~22%. So the tool still did not fit the limit that produced
 * the issue, and nothing in the suite could see it — every existing assertion stopped at the
 * layer above the one that serialises.
 *
 * This file measures the bytes the MCP tool RETURNS. That is the number a host applies its limit
 * to, and it is the only one that closes the issue.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import type { McpEnv } from "../http.js";
import type { SafetyContext } from "../safety.js";
import { registerBaseTools } from "./base.js";
import type { InstanceToolsCtx } from "./shared.js";

type ToolContent = { content: { type: string; text: string }[] };
type Handler = (args: Record<string, unknown>) => Promise<ToolContent>;
type Shape = Record<string, z.ZodTypeAny>;

const env: McpEnv = { API_BASE: "https://api.test" };

/** 64 KiB — the limit the calling host in #569 applied. */
const HOST_LIMIT = 64 * 1024;

/**
 * A listing shaped like the audited instance: 104 rows, 35 of them allowed. Field lengths are
 * taken from the real response — the descriptions are what make this payload big, and #569
 * explicitly rejected truncating them ("`github_update_issue`'s description is where the
 * 'labels REPLACE' warning lives").
 *
 * SIZED against production, deliberately: pretty-printed this must come out ABOVE `HOST_LIMIT`,
 * because that is what the real 66,042-byte response did. An earlier version of this fixture was
 * ~2 KB smaller, which put its pretty-printed form UNDER the limit — so the primary assertion
 * passed with the fix reverted and the guard certified ground it never walked (ADR 0002). The
 * `pretty > HOST_LIMIT` assertion below is what keeps that from happening again: it fails if
 * anyone shrinks this fixture to the point where the test stops testing anything.
 */
function listing(): { tools: unknown[] } {
	const tools = Array.from({ length: 104 }, (_, i) => ({
		name: `connector_tool_with_a_realistic_name_${i}`,
		connector: i % 2 ? "github" : undefined,
		scope: "read",
		mutates: i % 2 === 0,
		description: `${"An accurate description of what this tool does, including the caveat that matters. ".repeat(3)}Labels REPLACE rather than merge. (${i})`,
		allowed: i < 35,
		disabled: false,
		reason: i < 35 ? "ok" : "not_declared",
		writeConsent: "n/a",
		tier: ["base", "standard", "runtime", "connector"][i % 4],
		invocableBy: ["chat", "call_instance_tool"],
	}));
	return { tools };
}

let tools: Map<string, { schema: Shape; handler: Handler }>;

beforeEach(() => {
	vi.stubGlobal("fetch", async () =>
		new Response(JSON.stringify(listing()), { status: 200, headers: { "Content-Type": "application/json" } }),
	);
	tools = new Map();
	const ctx: InstanceToolsCtx = {
		env,
		tokenFor: (provided?: string) => provided || "session-token",
		safetyFor: (): SafetyContext => ({ env, subject: "user-1", scopes: ["read", "write", "runtime", "destructive"] }),
	} as InstanceToolsCtx;
	registerBaseTools(
		// biome-ignore lint/suspicious/noExplicitAny: minimal fake MCP server
		{ tool: (name: string, _d: string, schema: Shape, handler: Handler) => void tools.set(name, { schema, handler }) } as any,
		ctx,
	);
});

describe("list_instance_tools wire size (#569)", () => {
	it("returns a 104-row listing under the host limit that produced the issue", async () => {
		const t = tools.get("list_instance_tools");
		if (!t) throw new Error("list_instance_tools not registered");
		const out = await t.handler({ instance_id: "inst-1" });
		const bytes = new TextEncoder().encode(out.content[0].text).length;

		// G1 — assert the fixture is the size it claims to be, or the byte count below measures
		// nothing. A listing that silently came back empty would pass any size assertion.
		const parsed = JSON.parse(out.content[0].text) as { tools: unknown[] };
		expect(parsed.tools).toHaveLength(104);

		expect(bytes).toBeLessThan(HOST_LIMIT);

		// The specific regression: re-introducing the indentation puts it back OVER the limit.
		// Asserted against `HOST_LIMIT` and not merely against `bytes` — "pretty is bigger than
		// compact" is true of any JSON at all and would have let a too-small fixture pass while
		// the reverted fix still fit.
		const pretty = new TextEncoder().encode(JSON.stringify(parsed, null, 2)).length;
		expect(pretty).toBeGreaterThan(HOST_LIMIT);

		console.log(
			`✓ list_instance_tools wire size: 104 rows, ${bytes} B compact vs ${pretty} B pretty ` +
				`(+${Math.round(((pretty - bytes) / bytes) * 100)}%), limit ${HOST_LIMIT} B`,
		);
	});
});
