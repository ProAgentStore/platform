import { describe, expect, it } from "vitest";
import { BASE } from "../agent-do-tools.js";
import { getRegistryTool, registryTools } from "./tool-registry.js";
import { statsPromptBlock, type StatsCard } from "./stats-schema.js";

const card = (over: Partial<StatsCard> = {}): StatsCard => ({ id: "leads", title: "Leads per day", kind: "line", source: "collection.count", params: { collection: "leads" }, ...over });

describe("the agent's own stats tools (#312)", () => {
	it("registers get_stats and set_stats_card at base tier", () => {
		// Base for the same reason get_behaviour/set_behaviour are: ANY agent can be asked "how many
		// this week" or "start tracking that", and an agent with no proper home for the answer
		// invents one — the path that put `preference:response_style` into memory (#226).
		for (const name of ["get_stats", "set_stats_card"]) {
			expect(getRegistryTool(name)?.tier, name).toBe("base");
			expect(BASE, name).toContain(name);
		}
	});

	it("exposes NO tool that can write the creator's agent-level schema", () => {
		// #312's hard boundary: a subscriber's agent editing the agent template would change what
		// every OTHER subscriber gets. The only writer is `set_stats_card`, which patches the
		// instance override. Asserted over the whole registry so a later tool cannot quietly
		// acquire the capability.
		const writers = registryTools().filter((t) => /stats/i.test(t.name) && /^set_/.test(t.name));
		expect(writers.map((t) => t.name)).toEqual(["set_stats_card"]);
		for (const t of registryTools()) expect(t.name).not.toMatch(/agent_stats_schema/);
	});

	it("tells the model that a null day is not a zero, in the tool description itself", () => {
		// The description is the only place the model reads before it calls. Without this it reads
		// a gap as a bad day and reports "you found zero leads on Tuesday" — the #313 misreport,
		// arrived at through the tool instead of through the chart.
		const desc = getRegistryTool("get_stats")?.description ?? "";
		expect(desc).toMatch(/not zero|is not zero/i);
		expect(desc).toMatch(/no run/i);
	});

	it("warns, in set_stats_card's description, that a new trend card starts empty", () => {
		// "Add a chart of leads per day" produces an empty chart until tomorrow. That is correct
		// (there is no backfill) and surprising unless the tool says so up front.
		expect(getRegistryTool("set_stats_card")?.description ?? "").toMatch(/starts empty|start.* empty|tomorrow/i);
	});
});

describe("statsPromptBlock", () => {
	it("says NOTHING when the agent has no cards", () => {
		// #254 in miniature: a prompt asserting a capability the tool set contradicts. An agent with
		// no cards must not be told it has a dashboard, or it will answer from an imagined one.
		expect(statsPromptBlock([])).toBe("");
	});

	it("lists the card titles and marks which are daily trends", () => {
		const block = statsPromptBlock([card(), card({ id: "board", title: "Open items", kind: "bar", source: "board.by_column", params: {} })]);
		expect(block).toContain("Leads per day (daily trend)");
		expect(block).toContain("Open items (current)");
	});

	it("tells the agent to READ the numbers rather than estimate them", () => {
		// The failure this prevents: an agent that has get_stats but answers "roughly 100 leads"
		// from a record dump it happened to see earlier in the conversation.
		expect(statsPromptBlock([card()])).toMatch(/get_stats/);
		expect(statsPromptBlock([card()])).toMatch(/never estimate/i);
	});
});
