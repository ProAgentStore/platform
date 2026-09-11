/**
 * The Instances tab's type-to-filter (#795).
 *
 * The decision this file guards is "which instances does the user see for what they typed", which
 * is a value, so it is tested as one. The INPUT that carries the query is a component and stays
 * Playwright's job — see `Dashboard.instances.test.ts` for the source guard on the wiring and
 * `e2e/console.spec.ts` for the box itself.
 */
import { describe, expect, it } from "vitest";
import { filterInstances, instanceMatches, normalizeQuery } from "./instanceSearch.js";
import type { Instance } from "./types";

/** Real-shaped rows: the e2e fixture's instance, plus siblings that make the edges visible. */
function inst(over: Partial<Instance> & { id: string }): Instance {
	return {
		agent_id: "agent-1",
		slug: "an-instance",
		name: "An Instance",
		status: "active",
		created_at: "2026-01-01T00:00:00Z",
		...over,
	};
}

const JOBS = inst({ id: "i1", name: "Job Application Assistant", slug: "job-application-assistant" });
const CODER = inst({ id: "i2", name: "Repo Coder", slug: "repo-coder", description: "Writes code for a job" });
const FAS = inst({ id: "i3", name: "FAS platform", slug: "fas-platform" });
const LIST = [JOBS, CODER, FAS];

describe("normalizeQuery", () => {
	it("lowercases, so matching is case-insensitive as #795 asks", () => {
		expect(normalizeQuery("JoB")).toBe("job");
	});

	it("trims — a trailing space is what typing looks like mid-word", () => {
		// Untrimmed, " job" and "job " match nothing, and the list blanks on a keystroke the user
		// cannot see. This is the whole reason the function exists rather than an inline toLowerCase.
		expect(normalizeQuery("  job  ")).toBe("job");
	});

	it("treats whitespace-only as no query at all", () => {
		expect(normalizeQuery("   ")).toBe("");
		expect(normalizeQuery("")).toBe("");
	});

	it("survives a missing value instead of throwing", () => {
		expect(normalizeQuery(undefined as unknown as string)).toBe("");
	});
});

describe("instanceMatches", () => {
	it("matches a substring of the name", () => {
		expect(instanceMatches(JOBS, "application")).toBe(true);
	});

	it("matches mid-word, not just at a word boundary", () => {
		// "plic" is inside "Application". A prefix-only match would fail this, and users type
		// fragments of the middle of a name constantly.
		expect(instanceMatches(JOBS, "plic")).toBe(true);
	});

	it("matches a substring of the slug — the handle, which the card never shows", () => {
		// The slug is what appears in URLs and MCP calls, so it is often the string in mind. Note
		// the hyphen: this query cannot match the name, which spells it with spaces.
		expect(instanceMatches(JOBS, "application-assist")).toBe(true);
	});

	it("normalizes the CALLER's query too, so raw input never silently matches nothing", () => {
		// The trap this guards: a contract of "pass me something lowercased" reads fine and
		// returns an empty list the first time someone forgets.
		expect(instanceMatches(JOBS, "  JOB Application  ")).toBe(true);
	});

	it("does not match on description — prose would make a short query match everything", () => {
		// CODER's description contains "job". Matching it would put Repo Coder in the results for
		// a search for the Job assistant, which is the failure that makes a filter box useless.
		expect(CODER.description).toContain("job");
		expect(instanceMatches(CODER, "job")).toBe(false);
	});

	it("does not fuzzy-match across a gap — #795 scoped this to substring", () => {
		// A real, deliberate limit, recorded so a future change to it is a decision and not a
		// surprise: "app assistant" is not a substring of "Job Application Assistant".
		expect(instanceMatches(JOBS, "app assistant")).toBe(false);
	});

	it("matches everything when the query is empty or blank", () => {
		expect(instanceMatches(CODER, "")).toBe(true);
		expect(instanceMatches(CODER, "   ")).toBe(true);
	});

	it("does not throw on a row missing name or slug", () => {
		// The list is server data; a defensive read here is cheaper than a blank tab.
		const bare = { id: "i9" } as unknown as Instance;
		expect(instanceMatches(bare, "job")).toBe(false);
		expect(instanceMatches(bare, "")).toBe(true);
	});
});

describe("filterInstances", () => {
	it("narrows to the matches, preserving the server's order", () => {
		// Order is the server's answer, not something the filter gets to restyle — a list that
		// reshuffles as you type is harder to use than one that only shortens.
		expect(filterInstances(LIST, "a").map((i) => i.id)).toEqual(["i1", "i3"]);
	});

	it("can narrow to exactly one", () => {
		expect(filterInstances(LIST, "repo").map((i) => i.id)).toEqual(["i2"]);
	});

	it("returns empty when nothing matches — the caller owns that state, not this function", () => {
		// Dashboard renders a distinct no-match message for this. Returning the full list on no
		// match ("be helpful") would make the box look broken instead.
		expect(filterInstances(LIST, "zzz")).toEqual([]);
	});

	it("returns the SAME array for an empty query, not a copy", () => {
		// Identity, not just equality. This runs on every keystroke and every render; a fresh
		// array for an unchanged list is a new identity for no new content.
		expect(filterInstances(LIST, "")).toBe(LIST);
		expect(filterInstances(LIST, "   ")).toBe(LIST);
	});

	it("never mutates the input", () => {
		const before = [...LIST];
		filterInstances(LIST, "repo");
		expect(LIST).toEqual(before);
	});

	it("handles an empty list", () => {
		expect(filterInstances([], "job")).toEqual([]);
	});
});
