import { describe, expect, it } from "vitest";
import {
	applyStatsCardOps,
	familyForKind,
	MAX_CARD_LIMIT,
	MAX_STATS_CARDS,
	parseStatsWindow,
	resolveStatsCards,
	sanitizeStatsOverride,
	sanitizeStatsSchema,
	STATS_SOURCE_IDS,
	STATS_SOURCES,
	validateStatsCard,
	validateStatsCards,
} from "./stats-schema.js";

const leads = { id: "leads_by_suburb", title: "Leads by suburb", kind: "bar", source: "collection.group_by", params: { collection: "leads", field: "suburb", limit: 10 } };

describe("the source vocabulary", () => {
	it("is closed — a card naming a source that is not in the table is refused BY NAME", () => {
		// The whole safety story of agent-authored stats: a card names a source, never a query. A
		// silent drop would look like a save that worked, and the model (or the human) would never
		// learn the name was wrong — the failure `validateConnectionFilter` exists to prevent.
		const r = validateStatsCard({ id: "x", title: "X", kind: "number", source: "collection.raw_sql" });
		expect(r).toHaveProperty("rejection");
		if ("rejection" in r) {
			expect(r.rejection.reason).toContain('unknown source "collection.raw_sql"');
			// Naming the alternatives is what makes the refusal actionable for an LLM caller.
			expect(r.rejection.reason).toContain("usage.tokens");
		}
	});

	it("declares no source whose id could be mistaken for a query fragment", () => {
		// Guards the invariant rather than the current list: if someone adds `collection.where` or
		// anything carrying an operator, this fails and the review conversation happens.
		for (const id of STATS_SOURCE_IDS) expect(id).toMatch(/^[a-z_]+\.[a-z_]+$/);
	});

	it("gives every source a caveat, because a confident wrong number is worse than an absent one", () => {
		// The Usage page learned this the expensive way. A source with no stated limitation is a
		// source claiming it has none, which is never true of an aggregate.
		for (const s of STATS_SOURCES) expect(s.caveat.length).toBeGreaterThan(20);
	});
});

describe("kind and family", () => {
	it("refuses a kind the source cannot fill", () => {
		// `usage.tokens` produces one scalar; drawn as a table it would render an empty box that
		// looks like "no data" rather than "this combination is meaningless".
		const r = validateStatsCard({ id: "t", title: "T", kind: "table", source: "usage.tokens" });
		expect("rejection" in r && r.rejection.reason).toContain("cannot be drawn as");
	});

	it("derives family from kind — line is the only trend", () => {
		expect(familyForKind("line")).toBe("trend");
		for (const k of ["number", "bar", "table"] as const) expect(familyForKind(k)).toBe("point_in_time");
	});

	it("refuses a family that contradicts the kind instead of silently correcting it", () => {
		// A writer told "saved" about a trend card that is actually rendered live has been taught
		// something false — the set_behaviour half-apply failure in a different costume.
		const r = validateStatsCard({ id: "c", title: "C", kind: "bar", source: "runs.outcome", family: "trend" });
		expect("rejection" in r && r.rejection.reason).toContain("contradicts kind");
	});

	it("accepts a family that agrees, so a caller that sends one is not punished for it", () => {
		const r = validateStatsCard({ id: "c", title: "C", kind: "line", source: "runs.count", family: "trend" });
		expect(r).toHaveProperty("card");
	});
});

describe("params", () => {
	it("requires a declared-required param and names the one that is missing", () => {
		const r = validateStatsCard({ id: "c", title: "C", kind: "number", source: "collection.count" });
		expect("rejection" in r && r.rejection.reason).toContain('missing required param "collection"');
	});

	it("treats an ABSENT limit and an UNPARSEABLE limit differently (#243)", () => {
		// #243 shipped because an unparseable limit silently meant "drop every record". Absent takes
		// the declared default; unparseable is an error the caller is told about. Collapsing the two
		// is the whole bug.
		const absent = validateStatsCard({ id: "a", title: "A", kind: "bar", source: "runs.outcome" });
		expect("card" in absent && absent.card.params.limit).toBe(10);
		const junk = validateStatsCard({ id: "b", title: "B", kind: "bar", source: "runs.outcome", params: { limit: "lots" } });
		expect("rejection" in junk && junk.rejection.reason).toContain('param "limit"');
	});

	it("clamps a limit to the ceiling rather than trusting it", () => {
		// A stats tab someone leaves open must not become the most expensive query in the platform.
		const r = validateStatsCard({ id: "b", title: "B", kind: "bar", source: "runs.outcome", params: { limit: 100_000 } });
		expect("card" in r && r.card.params.limit).toBe(MAX_CARD_LIMIT);
	});

	it("refuses a collection name the storage engine itself would refuse", () => {
		// `col:{name}:{id}` is the DO key scheme, so a name containing `:` lets one collection's
		// prefix swallow another's. A card must not be able to address storage the engine cannot name.
		const r = validateStatsCard({ id: "c", title: "C", kind: "number", source: "collection.count", params: { collection: "leads:2026" } });
		expect("rejection" in r && r.rejection.reason).toContain("invalid collection name");
	});

	it("drops params the source did not declare instead of carrying them through", () => {
		// An undeclared param is either a typo or an attempt to reach past the vocabulary. Either
		// way nothing downstream should ever see it.
		const r = validateStatsCard({ id: "c", title: "C", kind: "number", source: "collection.count", params: { collection: "leads", user_id: "someone-else" } });
		expect("card" in r && r.card.params).toEqual({ collection: "leads" });
	});
});

describe("validateStatsCards", () => {
	it("reports every rejection while keeping the cards that validated", () => {
		// #312: "an unknown source is refused, by name, and other cards in the patch still apply".
		const { cards, rejected } = validateStatsCards([leads, { id: "bad", title: "B", kind: "number", source: "nope" }]);
		expect(cards.map((c) => c.id)).toEqual(["leads_by_suburb"]);
		expect(rejected).toHaveLength(1);
		expect(rejected[0].id).toBe("bad");
	});

	it("rejects a duplicate id rather than letting the last one win silently", () => {
		// Two cards with one id means one of them is invisible, and the author has no way to tell
		// which.
		const { cards, rejected } = validateStatsCards([leads, { ...leads, title: "Other" }]);
		expect(cards).toHaveLength(1);
		expect(rejected[0].reason).toContain("duplicate card id");
	});

	it("caps the card count and says so", () => {
		const many = Array.from({ length: MAX_STATS_CARDS + 3 }, (_, i) => ({ ...leads, id: `c${i}` }));
		const { cards, rejected } = validateStatsCards(many);
		expect(cards).toHaveLength(MAX_STATS_CARDS);
		expect(rejected).toHaveLength(3);
	});

	it("sanitizeStatsSchema returns undefined for junk, so 'declared nothing' reads the same as 'declared only junk'", () => {
		expect(sanitizeStatsSchema(undefined)).toBeUndefined();
		expect(sanitizeStatsSchema([{ id: "x", source: "nope" }])).toBeUndefined();
	});
});

describe("resolveStatsCards", () => {
	const creator = [
		{ id: "a", title: "A", kind: "number", source: "runs.count", params: {} },
		{ id: "b", title: "B", kind: "bar", source: "runs.outcome", params: { limit: 10 } },
	];

	it("returns the creator's cards when the subscriber has declared nothing", () => {
		expect(resolveStatsCards(creator, undefined).map((c) => c.id)).toEqual(["a", "b"]);
	});

	it("merges PER CARD and keeps the inherited card's position", () => {
		// Replacing wholesale would make editing one inherited card look like deleting the rest —
		// the #232 failure on the Behaviour tab.
		const out = resolveStatsCards(creator, { cards: [{ id: "a", title: "Renamed", kind: "number", source: "runs.count", params: {} }] });
		expect(out.map((c) => c.id)).toEqual(["a", "b"]);
		expect(out[0].title).toBe("Renamed");
	});

	it("appends a card the subscriber added", () => {
		const out = resolveStatsCards(creator, { cards: [leads] });
		expect(out.map((c) => c.id)).toEqual(["a", "b", "leads_by_suburb"]);
	});

	it("hides an inherited card without deleting it from the creator's template", () => {
		// A subscriber cannot delete a creator's card — that card belongs to the agent every other
		// subscriber gets. They hide it in their own view, and the creator's schema is untouched.
		const out = resolveStatsCards(creator, { hidden: ["b"] });
		expect(out.map((c) => c.id)).toEqual(["a"]);
		expect(sanitizeStatsSchema(creator)?.map((c) => c.id)).toEqual(["a", "b"]);
	});

	it("caps the MERGED set, since two writers each under the cap can exceed it together", () => {
		const bigCreator = Array.from({ length: 8 }, (_, i) => ({ ...leads, id: `k${i}` }));
		const bigSub = { cards: Array.from({ length: 8 }, (_, i) => ({ ...leads, id: `s${i}` })) };
		expect(resolveStatsCards(bigCreator, bigSub)).toHaveLength(MAX_STATS_CARDS);
	});

	it("survives config written by something looser than this validator", () => {
		// Config is a JSON blob touched by several writers over time; a read must never throw.
		expect(resolveStatsCards("not an array", { cards: 42, hidden: "b" })).toEqual([]);
		expect(sanitizeStatsOverride(null)).toEqual({ cards: [], hidden: [] });
	});
});

describe("applyStatsCardOps", () => {
	const creatorIds = ["inherited"];

	it("upserts a card and reports nothing rejected", () => {
		const { override, rejected } = applyStatsCardOps({}, [{ id: leads.id, card: leads }], creatorIds);
		expect(override.cards.map((c) => c.id)).toEqual(["leads_by_suburb"]);
		expect(rejected).toEqual([]);
	});

	it("applies the valid ops and names the invalid one, rather than failing the whole patch", () => {
		// A tool that half-applies and reports success teaches the model it changed something it did
		// not (#224). A tool that refuses everything because of one typo is just as unusable.
		const { override, rejected } = applyStatsCardOps(
			{},
			[
				{ id: leads.id, card: leads },
				{ id: "oops", card: { title: "Oops", kind: "number", source: "made.up" } },
			],
			creatorIds,
		);
		expect(override.cards.map((c) => c.id)).toEqual(["leads_by_suburb"]);
		expect(rejected[0].reason).toContain('unknown source "made.up"');
	});

	it("forces the op's id onto the card, so 'fix card A' cannot quietly create card B", () => {
		const { override } = applyStatsCardOps({}, [{ id: "wanted", card: { ...leads, id: "something_else" } }], creatorIds);
		expect(override.cards.map((c) => c.id)).toEqual(["wanted"]);
	});

	it("card: null on a SUBSCRIBER card deletes it", () => {
		const start = { cards: [leads], hidden: [] };
		const { override } = applyStatsCardOps(start, [{ id: leads.id, card: null }], creatorIds);
		expect(override.cards).toEqual([]);
		expect(override.hidden).toEqual([]);
	});

	it("card: null on an INHERITED card hides it instead, because deleting it is not the subscriber's to do", () => {
		// Without the distinction, hiding an inherited card appears to work and then silently comes
		// back on the next read — the merge would re-add it from the template every time.
		const { override } = applyStatsCardOps({}, [{ id: "inherited", card: null }], creatorIds);
		expect(override.hidden).toEqual(["inherited"]);
	});

	it("un-hides an inherited card when it is set again", () => {
		const { override } = applyStatsCardOps({ hidden: ["inherited"] }, [{ id: "inherited", card: { ...leads, id: "inherited" } }], creatorIds);
		expect(override.hidden).toEqual([]);
	});

	it("accepts a single op as well as an array, since the agent tool sets one card at a time", () => {
		const { override } = applyStatsCardOps({}, { id: leads.id, card: leads }, creatorIds);
		expect(override.cards).toHaveLength(1);
	});
});

describe("parseStatsWindow", () => {
	it("accepts the three page-level windows in both spellings", () => {
		expect(parseStatsWindow("7d")).toBe(7);
		expect(parseStatsWindow(90)).toBe(90);
	});

	it("falls back to 30 for absent, junk, and anything outside the vocabulary", () => {
		// The response always echoes the window it actually used, so a caller is never left assuming
		// it got the one it asked for.
		for (const raw of [undefined, "", "all", "365d", Number.NaN, "-7d"]) expect(parseStatsWindow(raw)).toBe(30);
	});
});
