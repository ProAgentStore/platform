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
 * SIZED against production, deliberately. It was sized so its PRETTY form came out above
 * `HOST_LIMIT`, matching the real 66,042-byte response — an earlier fixture was ~2 KB smaller,
 * which put the pretty form under the limit and let the primary assertion pass with the fix
 * reverted (ADR 0002). #578 changed what that arm can prove; the block that measures the real
 * WORST case now lives at the bottom of this file, sized to the 66,189 B instance rather than to
 * this one, and it is where the red case is demonstrated.
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

/**
 * The route returns `jsonSchema` only on ALLOWED rows when `schemas=true` — a schema for a tool
 * the caller may not run describes inputs it could never send (#569). The stub honours the query
 * so the opt-in path measures the shape the route actually produces.
 *
 * THE SCHEMA WAS RESIZED AT #578, and the reason is worth the paragraph. It carried six properties
 * with long descriptions, serialising to 719 B — against the 326 B/row that all 36 schemas in the
 * measured 66,189 B production response actually average. That made the fixture's ALLOWED rows
 * 1,256 B each where production's are 720 B, i.e. 74% heavier, and the whole `schemas:true` shape
 * 22% larger than any of the 34 real instances. A fixture that heavy cannot be asserted against
 * the host limit without demanding headroom for a shape nobody has — and leaving it UNASSERTED at
 * 69,520 B is the precise defect #578 was filed about. Three properties is the measured size.
 */
function listingWithSchemas(): { tools: unknown[] } {
	const { tools } = listing();
	return {
		tools: tools.map((t) => {
			const row = t as { allowed: boolean };
			if (!row.allowed) return t;
			return {
				...row,
				jsonSchema: {
					type: "object",
					properties: Object.fromEntries(
						Array.from({ length: 3 }, (_, k) => [`parameter_${k}`, { type: "string", description: "What this parameter selects." }]),
					),
					required: ["parameter_0"],
				},
			};
		}),
	};
}

let tools: Map<string, { schema: Shape; handler: Handler }>;

beforeEach(() => {
	vi.stubGlobal("fetch", async (input: string | URL | Request) => {
		const url = typeof input === "string" ? input : input.toString();
		const body = url.includes("schemas=true") ? listingWithSchemas() : listing();
		return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
	});
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

		// THE PRETTY-PRINT ARM, AND WHY IT CHANGED DIRECTION AT #578.
		//
		// It used to assert `pretty > HOST_LIMIT`: re-introducing the two-space indentation put the
		// response back over, which proved that compact serialisation was what saved it. #578 then
		// cut the prose on rows the instance cannot run — 69 of these 104 — and this fixture's
		// pretty form fell to ~56 KB. So the old assertion can no longer fire, and the honest
		// reading is that it is no longer TRUE: compact is not the only thing holding this under.
		//
		// Restoring it would mean inflating the fixture until pretty-printing overflows again,
		// which is tuning a fixture to keep an arm alive — the shape ADR 0002 is about. Two
		// assertions replace it, and together they are stronger:
		//
		//   1. the reply IS the compact serialisation, byte for byte. Size-independent, so it
		//      catches a reverted `{compact:true}` however much headroom the payload has.
		//   2. even pretty-printed it fits, i.e. the payload no longer depends on serialisation
		//      style at all — which is the property #569's fix never had.
		expect(out.content[0].text).toBe(JSON.stringify(parsed));
		const pretty = new TextEncoder().encode(JSON.stringify(parsed, null, 2)).length;
		expect(pretty).toBeLessThan(HOST_LIMIT);

		console.log(
			`✓ list_instance_tools wire size: 104 rows, ${bytes} B compact vs ${pretty} B pretty ` +
				`(+${Math.round(((pretty - bytes) / bytes) * 100)}%), both under the ${HOST_LIMIT} B limit`,
		);
	});

	it("carries schemas for the runnable set only", async () => {
		// The allowed-only rule belongs to the ROUTE (`workers/api`, where
		// `tool-listing-budget.test.ts` owns it), and the stub below mirrors it. So this does NOT
		// re-prove that rule. It proves the MCP layer passes those rows through UNCHANGED — that
		// serialising compact neither drops a schema nor attaches one to a row the caller cannot
		// invoke. The SIZE of this path was recorded here and not asserted until #578; it is
		// asserted in the block below.
		const t = tools.get("list_instance_tools");
		if (!t) throw new Error("list_instance_tools not registered");
		const out = await t.handler({ instance_id: "inst-1", schemas: true });
		const parsed = JSON.parse(out.content[0].text) as { tools: { allowed: boolean; jsonSchema?: unknown }[] };
		const bytes = new TextEncoder().encode(out.content[0].text).length;

		// G1 — the denominator, before any claim about it.
		expect(parsed.tools).toHaveLength(104);
		const allowed = parsed.tools.filter((r) => r.allowed);
		expect(allowed).toHaveLength(35);

		expect(parsed.tools.filter((r) => r.jsonSchema !== undefined)).toHaveLength(allowed.length);
		expect(parsed.tools.filter((r) => !r.allowed && r.jsonSchema !== undefined)).toEqual([]);

		// ASSERTED since #578, where it was only recorded before. A number printed and not asserted
		// is how this path stayed over the limit through two fixes: #569 measured it at 65,969 B and
		// wrote the figure into a console line, and nothing went red for the four days it shipped.
		expect(bytes, `schemas:true is ${bytes} B, over the ${HOST_LIMIT} B host limit`).toBeLessThan(HOST_LIMIT);

		console.log(`✓ list_instance_tools schemas:true — ${bytes} B, schemas on ${allowed.length}/104 rows (allowed only), limit ${HOST_LIMIT} B.`);
	});
});

/**
 * The measured production worst case, and the arm that ASSERTS the limit instead of recording it
 * (#578).
 *
 * ── The denominator, per ADR 0002
 *
 * The population is the **34 instances on the operator account**, every one of them called on the
 * deployed API on 2026-08-15. `?schemas=true` spans 61,796–66,189 B and **20 of the 34 are over 64
 * KiB**. The worst is `933ebec5-…` (Small Business Website Lead Finder) at 66,189 B — 653 B over.
 *
 * That number is why this fixture is not the one above. #569's guard measures the coder-repo shape
 * (`bd43f4de-…`, 65,969 B, 433 B over), and a fix sized to 433 B of headroom still ships over on
 * the real worst case. A guard calibrated to one instance and called green is precisely how the
 * 433 figure came to be believed.
 *
 * ── What the fixture reproduces, and what it deliberately over-states
 *
 * The measured composition of the 66,189 B response: 104 rows, 36 allowed (25,913 B including
 * every schema), 68 `not_declared` (40,614 B, of which their `description` strings alone are
 * 25,074 B — 38% of the whole response, against 18% for every schema in it).
 *
 * The fixture is built to that shape and comes out somewhat HEAVIER, because its names and
 * envelope are not byte-identical to production's. That direction is the safe one: the guard then
 * demands more headroom than production needs, never less.
 */
describe("list_instance_tools worst case (#578)", () => {
	/** 369 characters — the measured mean description of a `not_declared` row (25,074 B / 68). */
	const NOT_DECLARED_DESCRIPTION =
		"An accurate description of what this tool does, including the caveat that matters and the constraint a caller has to know about before invoking it, plus the sentence naming the external system it reaches and what exactly it will change over there, and the note about which argument REPLACES rather than merges, which is the part a caller most reliably gets wrong in practice.".slice(
			0,
			369,
		);

	function worstCase(): { tools: unknown[] } {
		const tools = Array.from({ length: 104 }, (_, i) => {
			const allowed = i < 36;
			const row: Record<string, unknown> = {
				name: `connector_tool_with_a_realistic_name_${i}`,
				scope: "read",
				mutates: i % 2 === 0,
				description: allowed ? NOT_DECLARED_DESCRIPTION.slice(0, 200) : NOT_DECLARED_DESCRIPTION,
				allowed,
				disabled: false,
				reason: allowed ? "ok" : "not_declared",
				writeConsent: "n/a",
				tier: ["base", "standard", "runtime", "connector"][i % 4],
				invocableBy: ["chat", "call_instance_tool"],
			};
			if (i % 2) row.connector = "github";
			if (allowed) {
				row.jsonSchema = {
					type: "object",
					properties: Object.fromEntries(
						Array.from({ length: 4 }, (_, k) => [`parameter_${k}`, { type: "string", description: "What this parameter selects." }]),
					),
					required: ["parameter_0"],
				};
			}
			return row;
		});
		return { tools };
	}

	let worstTools: Map<string, { schema: Shape; handler: Handler }>;

	beforeEach(() => {
		// Deliberately ignores the query: BOTH paths are measured against the schema-bearing body,
		// so the default path is held to the heaviest thing the route could hand this layer rather
		// than to the lighter one it usually does.
		vi.stubGlobal("fetch", async () => new Response(JSON.stringify(worstCase()), { status: 200, headers: { "Content-Type": "application/json" } }));
		worstTools = new Map();
		const ctx: InstanceToolsCtx = {
			env,
			tokenFor: (provided?: string) => provided || "session-token",
			safetyFor: (): SafetyContext => ({ env, subject: "user-1", scopes: ["read", "write", "runtime", "destructive"] }),
		} as InstanceToolsCtx;
		registerBaseTools(
			// biome-ignore lint/suspicious/noExplicitAny: minimal fake MCP server
			{ tool: (name: string, _d: string, schema: Shape, handler: Handler) => void worstTools.set(name, { schema, handler }) } as any,
			ctx,
		);
	});

	it("is over the limit UNTRUNCATED — the red case this fix is measured against", () => {
		const { tools } = worstCase();
		const rows = tools as Array<{ allowed: boolean; description: string }>;

		// G1 — the fixture reproduces the measured composition before anything is claimed about it.
		expect(rows).toHaveLength(104);
		const notDeclared = rows.filter((r) => !r.allowed);
		expect(notDeclared).toHaveLength(68);
		const descriptionBytes = notDeclared.reduce((n, r) => n + new TextEncoder().encode(r.description).length, 0);
		expect(descriptionBytes).toBeGreaterThan(24_000); // measured 25,074 B

		// G4 — the guard is watched failing. This is exactly what the tool sent before #578: the
		// route's body, compact, with every description intact. If a later change makes this arm
		// pass, the fixture has stopped reproducing the defect and the arm below proves nothing.
		const untruncated = new TextEncoder().encode(JSON.stringify(worstCase())).length;
		expect(untruncated).toBeGreaterThan(HOST_LIMIT);

		console.log(
			`✓ #578 red case: 104 rows, 68 not-declared carrying ${descriptionBytes} B of description; ` +
				`untruncated wire size ${untruncated} B, ${untruncated - HOST_LIMIT} B over the ${HOST_LIMIT} B limit ` +
				"(production worst case: 66,189 B, 653 B over, 20 of 34 instances over)",
		);
	});

	it("fits once the not-runnable rows' prose is cut, on BOTH paths", async () => {
		const t = worstTools.get("list_instance_tools");
		if (!t) throw new Error("list_instance_tools not registered");

		for (const [label, args] of [
			["default", { instance_id: "inst-1" }],
			["schemas:true", { instance_id: "inst-1", schemas: true }],
		] as const) {
			const out = await t.handler(args);
			const bytes = new TextEncoder().encode(out.content[0].text).length;
			const parsed = JSON.parse(out.content[0].text) as { tools: Array<{ allowed: boolean; description: string }> };

			// G1 again — measured on what came back, not on what was sent in.
			expect(parsed.tools, label).toHaveLength(104);
			expect(parsed.tools.filter((r) => !r.allowed), label).toHaveLength(68);

			expect(bytes, `${label}: ${bytes} B, over the ${HOST_LIMIT} B host limit`).toBeLessThan(HOST_LIMIT);

			// The cut lands only where it was aimed: every not-runnable row is truncated, and no
			// runnable row is. A projection that trimmed everything would also fit, and would be a
			// different, worse change.
			expect(parsed.tools.filter((r) => !r.allowed && !r.description.endsWith("…")), label).toEqual([]);
			expect(parsed.tools.filter((r) => r.allowed && r.description.endsWith("…")), label).toEqual([]);
			expect(parsed.tools.find((r) => r.allowed)?.description, label).toBe(NOT_DECLARED_DESCRIPTION.slice(0, 200));

			console.log(`✓ #578 ${label}: ${bytes} B, ${Math.round((bytes / HOST_LIMIT) * 100)}% of the ${HOST_LIMIT} B limit`);
		}
	});

	it("keeps every verdict field on a truncated row — #525's contract is what must not be paid", async () => {
		const t = worstTools.get("list_instance_tools");
		if (!t) throw new Error("list_instance_tools not registered");
		const out = await t.handler({ instance_id: "inst-1" });
		const parsed = JSON.parse(out.content[0].text) as { tools: Array<Record<string, unknown>> };
		const cut = parsed.tools.find((r) => r.allowed === false);
		if (!cut) throw new Error("no not-declared row in the reply");
		// "What can this agent do" is only answerable if the answer says what it CANNOT and why.
		// Prose is what was traded; none of this is.
		for (const field of ["name", "scope", "mutates", "allowed", "disabled", "reason", "writeConsent", "tier", "invocableBy"]) {
			expect(cut, `the truncation dropped ${field}, which is the audit rather than the prose`).toHaveProperty(field);
		}
		expect(cut.reason).toBe("not_declared");
		// And the prose that survives is the first clause, not a mid-word stump.
		expect(String(cut.description).endsWith(" …")).toBe(false);
		expect(String(cut.description)).toContain("An accurate description of what this tool does");
	});
});
