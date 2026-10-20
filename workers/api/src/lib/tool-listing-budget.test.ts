import { describe, expect, it } from "vitest";
import { allToolPolicyInputs, LISTING_DESCRIPTION_MAX_CHARS, projectToolListing, resolveToolPolicy, type ToolListingRow } from "./instance-tool-policy.js";
import { TOOL_TIERS, type ToolTier } from "./builtin-tool-policy.js";
import type { AgentCapabilities } from "./agent-capabilities.js";
import type { ToolDef } from "./connectors/types.js";
// The MCP worker's OWN wire projection, imported rather than copied, so this measures exactly what an
// MCP host receives and cannot drift from it. A test-only reach across the Worker boundary, as
// `host-template-capture.test.ts` does for the host Worker: the real catalogue lives HERE, and the
// MCP worker cannot import it (its own wire tests run on synthetic fixtures).
import { budgetToolListing, pageToolListing } from "../../../mcp/src/instance-tools/base.js";
import { WIRE_BUDGET_BYTES } from "../../../mcp/src/wire-budget.js";

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

/**
 * 64 KiB — the acceptance criterion in #569, and a number MCP hosts actually enforce. It is asserted
 * on what the MCP tool SENDS, because that is the layer the limit belongs to: #578 cut the not-runnable
 * rows' prose in the MCP worker, not here, and since #1225 the tool sends the listing in PAGES, each
 * under `WIRE_BUDGET_BYTES` — the first describe below.
 */
const HOST_LIMIT = 64 * 1024;

/**
 * The API body's own bound — a sanity ceiling, not the host's limit (#1057).
 *
 * This route's other consumer is the console's Tool Permissions panel, which renders every row's
 * FULL description (#578's reason for cutting in MCP, not here) and has no 64 KiB limit. Holding the
 * raw body to the MCP host's number refused a new tool while what MCP sent was 45–61 KB: #1057's four
 * native tools put the body at ~67 KB. 128 KiB is about twice today's body, so a runaway — schemas
 * leaking into the default path, an unbounded description — still goes red here, long before a
 * browser would care.
 */
const API_BODY_BOUND = 128 * 1024;

const wireBytes = (rows: readonly ToolListingRow[]) => new TextEncoder().encode(JSON.stringify({ tools: rows })).length;

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

/**
 * Walk the listing the way `list_instance_tools` serves it (#1225): pages fitted to the wire budget, joined by
 * `page.nextCursor`. Returns each page's wire size and every row across the walk.
 */
function pagesOf(rows: readonly ToolListingRow[]): { sizes: number[]; rows: ToolListingRow[] } {
	const sizes: number[] = [];
	const out: ToolListingRow[] = [];
	let cursor: string | undefined;
	do {
		const page = pageToolListing({ tools: [...rows] as never, runtime: null }, cursor);
		if ("error" in page) throw new Error(page.error);
		const body = JSON.parse(page.text) as { tools: ToolListingRow[]; page: { nextCursor: string | null } };
		sizes.push(new TextEncoder().encode(page.text).length);
		out.push(...body.tools);
		cursor = body.page.nextCursor ?? undefined;
	} while (cursor && sizes.length < 200);
	return { sizes, rows: out };
}

describe("the tool listing PAGES, so no catalogue size can overflow a host (#1225)", () => {
	it("every page of the real catalogue is under the wire budget for every capability shape, and the pages tile it", () => {
		const all = allToolPolicyInputs();
		for (const [label, c] of shapes()) {
			for (const schemas of [false, true]) {
				const rows = projectToolListing(resolveToolPolicy(c, [], all, []), { schemas });
				const walked = pagesOf(rows);
				const worst = Math.max(...walked.sizes);
				expect(worst, `${label}${schemas ? " +schemas" : ""}: a page is ${worst} B, over the ${WIRE_BUDGET_BYTES} B wire budget`).toBeLessThanOrEqual(WIRE_BUDGET_BYTES);
				expect(worst).toBeLessThan(HOST_LIMIT);
				// #525: the walk is the WHOLE listing, runnable or not, in order, each once.
				expect(walked.rows.map((r) => r.name), label).toEqual(rows.map((r) => r.name));
				console.log(`✓ #1225: ${label}${schemas ? " +schemas" : ""} — ${rows.length} rows in ${walked.sizes.length} page(s), largest ${worst} B (${Math.round((worst / HOST_LIMIT) * 100)}% of the host limit)`);
			}
		}
	});

	it("still holds when the REAL catalogue grows to 4x — the acceptance test (#1225)", () => {
		const all = allToolPolicyInputs();
		const grown = Array.from({ length: 4 }, (_, k) => all.map((t) => ({ ...t, name: `${t.name}__copy${k}` }))).flat();
		expect(grown.length, "the grown catalogue is not 4x the real one").toBe(all.length * 4);
		const rows = projectToolListing(resolveToolPolicy(caps({ tools: all.map((t) => t.name) }), [], grown, []), { schemas: true });
		const walked = pagesOf(rows);
		expect(Math.max(...walked.sizes)).toBeLessThanOrEqual(WIRE_BUDGET_BYTES);
		expect(walked.rows).toHaveLength(grown.length);
		// The point of paging: unpaged, this same listing is several times the host limit.
		const unpaged = wireBytes(budgetToolListing(rows));
		expect(unpaged, "the grown listing fits unpaged — the arm above proves nothing").toBeGreaterThan(HOST_LIMIT * 2);
		console.log(`✓ #1225: ${grown.length} rows — ${unpaged} B unpaged (${(unpaged / HOST_LIMIT).toFixed(1)}x the host limit), ${walked.sizes.length} pages, largest ${Math.max(...walked.sizes)} B`);
	});
});

describe("the tool listing fits in a response (#569)", () => {
	it("keeps the API body under its sanity bound for every capability shape; what MCP sends is bounded per page (#1225)", () => {
		const all = allToolPolicyInputs();
		// G1 — the denominator. 104 rows were measured in production; under 90 means a connector or
		// the built-in catalog failed to load and this budget is being met by measuring less.
		expect(all.length, "the tool listing collapsed — a budget over a fraction of it proves nothing").toBeGreaterThan(90);
		for (const [label, c] of shapes()) {
			const rows = projectToolListing(resolveToolPolicy(c, [], all, []));
			const size = wireBytes(rows);
			// Unpaged, MCP's projection of the whole listing — the number #578 held under the host limit and that
			// #1225 stopped depending on: `list_instance_tools` now sends it in pages (asserted above), so the
			// listing may outgrow one reply without this going red. Recorded, not asserted.
			const mcp = wireBytes(budgetToolListing(rows));
			expect(rows.length, label).toBe(all.length);
			expect(size, `${label}: the API body is ${size} bytes, over its ${API_BODY_BOUND}-byte sanity bound`).toBeLessThan(API_BODY_BOUND);
			console.log(`✓ #569: ${label} — ${rows.length} rows, ${mcp} B unpaged over MCP (${Math.round((mcp / HOST_LIMIT) * 100)}% of the host limit), API body ${size} B`);
		}
	});

	it("the MCP projection is what saves it: the not-runnable rows' prose is the cut, nothing else (#578)", () => {
		// G4 — the guard can fail. Untrimmed, the permissive default no longer fits the host limit, so
		// the assertion above holds BECAUSE of budgetToolListing, not by accident of a small catalogue.
		const rows = projectToolListing(resolveToolPolicy(caps({}), [], allToolPolicyInputs(), []));
		expect(wireBytes(rows), "the untrimmed listing fits the host limit — the MCP arm above proves nothing until the catalogue outgrows it").toBeGreaterThan(HOST_LIMIT);
		const sent = budgetToolListing(rows);
		expect(sent.filter((r, i) => r.allowed && r.description !== rows[i].description)).toEqual([]);
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
		// `reach` joined the list at #584: it is what the console's "reaches outside the platform"
		// sentence is derived from, so dropping it to save bytes would put that claim back on a
		// field that does not answer it. `disabled` and `writeConsent` are pinned separately below:
		// they are omitted when default-valued, which is still a complete answer.
		for (const row of projectToolListing(resolveToolPolicy(caps({}), [], allToolPolicyInputs(), []))) {
			for (const field of ["name", "scope", "mutates", "reach", "allowed", "reason", "tier", "invocableBy", "description"]) {
				expect(row, `${row.name}: the listing dropped ${field}, which is part of the audit`).toHaveProperty(field);
			}
		}
	});

	it("bounds verbose descriptions with an explicit cut marker", () => {
		const rows = projectToolListing(resolveToolPolicy(caps({}), [], allToolPolicyInputs(), []));
		for (const row of rows) expect(row.description.length, row.name).toBeLessThanOrEqual(LISTING_DESCRIPTION_MAX_CHARS);
		const long = rows.find((row) => row.name === "subordinate_status");
		expect(long?.description).toContain("[cut: showing the first");
	});

	it("omits `disabled` / `writeConsent` exactly when default-valued, and never loses a verdict", () => {
		// 26f8ee92's regression: the catalogue had grown to ~110 bytes under the budget, so one new
		// step tool broke it. These two defaults are ~3.9 KB of the default listing. A missing field
		// MEANS the default, so the full policy must be recoverable from the row — checked for every
		// row, with one tool switched off and one consent-gated connector left ungranted.
		const all = allToolPolicyInputs();
		const gated = all.find((t) => t.connector && t.scope === "write");
		if (!gated) throw new Error("no write-scoped connector tool to exercise the consent gate");
		const off = all.find((t) => t.name !== gated.name && !t.connector)?.name ?? "";
		const policy = resolveToolPolicy(caps({ tools: all.map((t) => t.name) }), [off], all, []);
		const rows = projectToolListing(policy);
		for (const [i, row] of rows.entries()) {
			const full = policy[i];
			expect(row.name).toBe(full.name);
			expect("disabled" in row, `${row.name}: disabled present iff true`).toBe(full.disabled);
			expect(row.disabled ?? false).toBe(full.disabled);
			expect("writeConsent" in row, `${row.name}: writeConsent present iff not "n/a"`).toBe(full.writeConsent !== "n/a");
			expect(row.writeConsent ?? "n/a").toBe(full.writeConsent);
		}
		// Both branches actually exercised — a guard that only ever saw defaults proves nothing.
		expect(rows.find((r) => r.name === off)?.disabled).toBe(true);
		expect(rows.find((r) => r.name === gated.name)?.writeConsent).toBe("required");
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
