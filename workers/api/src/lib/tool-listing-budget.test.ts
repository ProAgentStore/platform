import { describe, expect, it } from "vitest";
import { allToolPolicyInputs, projectToolListing, resolveToolPolicy, type ToolPolicyEntry } from "./instance-tool-policy.js";
import { TOOL_TIERS, type ToolTier } from "./builtin-tool-policy.js";
import type { AgentCapabilities } from "./agent-capabilities.js";
import type { ToolDef } from "./connectors/types.js";

/**
 * How big `GET /v1/instances/:id/tools` is allowed to be, measured rather than assumed (#569).
 *
 * The default response for production instance bd43f4de-… was 89,281 bytes over the wire for 104
 * rows, and it EXCEEDED the calling host's response limit — so the mode the resolver deliberately
 * defends ("return every tool, including the ones it cannot run") was the one that did not arrive.
 * `jsonSchema` was 41% of it.
 *
 * The budget is asserted against the WORST case this listing can produce, not against the one
 * instance that was measured: an agent that declares every tool. A ceiling that only holds for the
 * shape someone happened to audit is not a ceiling.
 */

const caps = (over: Partial<AgentCapabilities>): AgentCapabilities =>
	({ surfaces: [], runtime: null, workflow: null, ...over }) as AgentCapabilities;

/** 64 KiB — the acceptance criterion in #569, and a number hosts actually enforce. */
const BUDGET = 64 * 1024;

const wireBytes = (rows: readonly ToolPolicyEntry[]) => new TextEncoder().encode(JSON.stringify({ tools: rows })).length;

/** Every capability shape the listing can be resolved for that MAXIMISES the payload. */
function shapes(): Array<[string, AgentCapabilities]> {
	const everyName = allToolPolicyInputs().map((t) => t.name);
	return [
		["declares nothing (the permissive default)", caps({})],
		["declares EVERY tool — the worst case", caps({ tools: everyName })],
		["coding surface", caps({ surfaces: ["coding"] })],
		["repo surface", caps({ surfaces: ["repo"] })],
	];
}

describe("the tool listing fits in a response (#569)", () => {
	it("keeps the DEFAULT response under 64 KiB for every capability shape", () => {
		const all = allToolPolicyInputs();
		// G1 — the denominator. 104 rows were measured in production; under 90 means a connector or
		// the built-in catalog failed to load and this budget is being met by measuring less.
		expect(all.length, "the tool listing collapsed — a budget over a fraction of it proves nothing").toBeGreaterThan(90);
		for (const [label, c] of shapes()) {
			const rows = projectToolListing(resolveToolPolicy(c, [], all, []));
			const size = wireBytes(rows);
			expect(rows.length, label).toBe(all.length);
			expect(size, `${label}: the default listing is ${size} bytes, over the ${BUDGET}-byte budget`).toBeLessThan(BUDGET);
			console.log(`✓ #569: ${label} — ${rows.length} rows, ${size} bytes`);
		}
	});

	it("never sends a schema for a row the instance cannot run", () => {
		const rows = projectToolListing(resolveToolPolicy(caps({ surfaces: ["coding"] }), [], allToolPolicyInputs(), []), { schemas: true });
		const disallowed = rows.filter((t) => !t.allowed);
		const allowed = rows.filter((t) => t.allowed);
		expect(disallowed.length, "no disallowed rows to check — pick a narrower capability").toBeGreaterThan(20);
		expect(allowed.length, "no allowed rows to check").toBeGreaterThan(5);
		expect(disallowed.filter((t) => t.jsonSchema !== undefined).map((t) => t.name), "a schema was sent for a tool the caller can never invoke").toEqual([]);
		expect(allowed.filter((t) => t.jsonSchema === undefined).map((t) => t.name), "schemas:true must carry a schema on every runnable row").toEqual([]);
		console.log(`✓ #569: schemas:true → ${allowed.length} schemas, 0 of ${disallowed.length} disallowed rows`);
	});

	it("keeps the audit fields on every row when the schemas are dropped", () => {
		// The reduction must cost nothing auditable. This is the list #569 promised stays.
		const [row] = projectToolListing(resolveToolPolicy(caps({}), [], allToolPolicyInputs(), []));
		for (const field of ["name", "scope", "mutates", "allowed", "disabled", "reason", "writeConsent", "tier", "invocableBy", "description"]) {
			expect(row, `the listing dropped ${field}, which is part of the audit`).toHaveProperty(field);
		}
	});

	it("does not narrow to the allowed set by default", () => {
		// `allowedOnly` would be the cheapest saving and is the one deliberately NOT taken:
		// "what can this agent do" is only answerable if the answer includes what it cannot.
		const all = allToolPolicyInputs();
		const rows = projectToolListing(resolveToolPolicy(caps({ surfaces: ["repo"] }), [], all, []));
		expect(rows.length).toBe(all.length);
		expect(rows.some((t) => !t.allowed), "a narrow agent must still be told what it cannot run").toBe(true);
	});
});

describe("the tier vocabulary is one list (#569)", () => {
	it("is readable at runtime and matches the type", () => {
		expect(TOOL_TIERS.length, "the tier vocabulary is empty").toBe(4);
		// Compile-time: the two declarations of this vocabulary — `ToolTier` here and the inline
		// union on `ToolDef.tier` in connectors/types.ts, which cannot import a value module — are
		// the same set. A fifth tier added to one and not the other fails `tsc`, not this assertion.
		const _bothWays: [ToolTier extends ToolDef["tier"] ? true : never, ToolDef["tier"] extends ToolTier ? true : never] = [true, true];
		expect(_bothWays).toEqual([true, true]);
	});

	it("covers every tier the listing actually returns", () => {
		const rows = resolveToolPolicy(caps({}), [], allToolPolicyInputs(), []);
		const seen = new Set(rows.map((t) => t.tier));
		expect(rows.length, "the listing collapsed").toBeGreaterThan(90);
		// The measured distribution was connector 49 / standard 30 / base 21 / runtime 4 — all four
		// live, which is why documenting two of them dropped a third of the surface.
		expect([...seen].sort(), "the listing returned a tier outside the declared vocabulary").toEqual([...TOOL_TIERS].sort());
		console.log(`✓ #569: ${seen.size} distinct tiers over ${rows.length} rows: ${[...seen].sort().join(", ")}`);
	});
});
