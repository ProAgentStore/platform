/**
 * `my_agents`: the roster is never cut, and `config` stays reachable (#595).
 *
 * The second claim is the one worth a test. Dropping `config` — 60.9% of the payload — is the
 * obvious way to make this tool fit, and it would remove the only path an owner has to their own
 * agent's capabilities, pipelines and settings schema: `agent_info` reads the PUBLIC record, which
 * carries no `config` and 404s for a draft, and 26 of the 41 agents on the account that produced
 * this issue are drafts. A future change that "simplifies" the page by dropping the field should
 * fail here rather than in production six weeks later.
 */

import { describe, expect, it } from "vitest";
import { type OwnedAgent, buildAgentListing } from "./agent-listing.js";
import { WIRE_BUDGET_BYTES, wireBytes } from "./wire-budget.js";

type Parsed = {
	total: number;
	roster: { id: unknown; slug: unknown; name: unknown; status: unknown; visibility: unknown }[];
	rosterOmitted?: number;
	page: { offset: number; count: number; of: number; nextOffset: number | null; hasMore: boolean; note?: string };
	agents: { id: string; config: string }[];
};

/** Agents shaped like the real ones: a long tail of `"{}"` configs and a few very large. */
const agents = (n: number, configBytes = (i: number) => (i === 0 ? 13_097 : i < 17 ? 1200 : 4)) =>
	Array.from({ length: n }, (_, i) => ({
		id: `agent_${i}`,
		slug: `agent-${i}`,
		name: `Agent ${i}`,
		status: i % 2 ? "active" : "inactive",
		visibility: i % 3 ? "draft" : "published",
		description: "d".repeat(208),
		config: "c".repeat(Math.max(2, configBytes(i)) - 2),
	}));

const parse = (text: string) => JSON.parse(text) as Parsed;

describe("buildAgentListing — the roster is never the thing that gets cut", () => {
	it("names every owned agent even when detail fits for only some", () => {
		// The #503 failure, in this tool's clothes: a Lead answered "3" to "how many agents do you
		// have" for two days because the count lived in the part that got truncated.
		const all = agents(400, () => 1200);
		const out = parse(buildAgentListing({ agents: all }).text);
		expect(out.total).toBe(400);
		expect(out.roster).toHaveLength(400);
		expect(out.roster.map((r) => r.slug)).toEqual(all.map((a) => a.slug));
		expect(out.agents.length).toBeLessThan(400);
		expect(out.page.of).toBe(400);
	});

	it("carries the state a supervisor triages on, in the roster line itself", () => {
		const out = parse(buildAgentListing({ agents: agents(5) }).text);
		expect(out.roster[1]).toEqual({ id: "agent_1", slug: "agent-1", name: "Agent 1", status: "active", visibility: "draft" });
	});

	it("keeps the reply inside the budget", () => {
		const out = buildAgentListing({ agents: agents(400, () => 1200) });
		expect(wireBytes(out.text)).toBeLessThanOrEqual(WIRE_BUDGET_BYTES);
	});

	it("says so when even the roster had to be shortened, rather than shortening it quietly", () => {
		// Only reachable on a roster far larger than this feature was built for; it degrades LAST
		// and never silently, which is the same rule applied to itself.
		const out = buildAgentListing({ agents: agents(4000, () => 4) });
		const parsed = parse(out.text);
		expect(parsed.total).toBe(4000);
		expect(parsed.roster.length).toBeLessThan(4000);
		expect(parsed.rosterOmitted).toBe(4000 - parsed.roster.length);
		expect(wireBytes(out.text)).toBeLessThanOrEqual(WIRE_BUDGET_BYTES);
	});

	it("omits rosterOmitted entirely when the roster is whole", () => {
		expect(parse(buildAgentListing({ agents: agents(5) }).text).rosterOmitted).toBeUndefined();
	});
});

describe("buildAgentListing — config is paged, never dropped", () => {
	it("returns each paged agent's full record, config included", () => {
		const out = parse(buildAgentListing({ agents: agents(5) }).text);
		expect(out.agents).toHaveLength(5);
		// The capability check: `my_agents` is the only reader of this field on the whole MCP
		// surface. If this ever comes back undefined, an owner can no longer read their own
		// agent's capabilities, pipelines or settings schema through any tool.
		expect(out.agents.every((a) => typeof a.config === "string" && a.config.length > 0)).toBe(true);
		expect(out.agents[0].config.length).toBe(13_095);
	});

	it("reaches every agent's config across pages, with no gap and no repeat", () => {
		const all = agents(300, () => 1200);
		const seen: string[] = [];
		let offset: number | null = 0;
		let calls = 0;
		while (offset !== null) {
			const out = parse(buildAgentListing({ agents: all, offset }).text);
			for (const a of out.agents) {
				expect(typeof a.config).toBe("string");
				seen.push(a.id);
			}
			offset = out.page.nextOffset;
			if (++calls > 60) throw new Error("paging did not terminate");
		}
		expect(seen).toEqual(all.map((a) => a.id));
		expect(calls).toBeGreaterThan(1);
	});

	it("ships an agent whose config alone exceeds the budget, and says the page is oversized", () => {
		// `site-builder` is 13,097 B today and nothing bounds a pipeline definition. A page that
		// silently skipped such a row would make that agent's configuration unreadable — the exact
		// outcome dropping the field would have caused, arriving by a quieter route.
		const one = [{ id: "agent_big", slug: "big", name: "Big", status: "active", visibility: "draft", config: "c".repeat(90_000) }];
		const out = buildAgentListing({ agents: one });
		const parsed = parse(out.text);
		expect(parsed.agents).toHaveLength(1);
		expect(parsed.agents[0].config.length).toBe(90_000);
		expect(parsed.page.note).toContain("over this tool's");
	});

	it("passes through a column it has never been taught about", () => {
		// #468: only the five roster fields are named, so a column added to the table appears in
		// the page without an edit to this module.
		// Cast because `OwnedAgent` names only the five roster fields ON PURPOSE — an index
		// signature would make that a lie. The column still has to survive the round trip.
		const row = { id: "a", slug: "s", name: "n", status: "active", visibility: "draft", brand_new_column: "kept" } as OwnedAgent;
		const out = parse(buildAgentListing({ agents: [row] }).text);
		expect((out.agents[0] as unknown as { brand_new_column: string }).brand_new_column).toBe("kept");
	});
});
