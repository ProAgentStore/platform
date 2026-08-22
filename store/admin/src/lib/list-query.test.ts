import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	LIST_FILTER_FIELDS,
	LIST_PAGE,
	type ListFilters,
	buildListQuery,
	isFiltered,
	pagerRange,
	predicateKey,
} from "./list-query";

const ALL: ListFilters = { search: "s", agent: "a", owner: "o", visibility: "published", status: "active" };

describe("one predicate for the page AND the count", () => {
	it("puts every declared filter field into the query", () => {
		// The server computes the rows and the `total` from the same WHERE clause. A field
		// that reaches the client's form but not its query string makes the header count a
		// different question from the table below it.
		const q = new URLSearchParams(buildListQuery(ALL, 0));
		for (const field of LIST_FILTER_FIELDS) {
			expect(q.get(field), field).toBe(ALL[field]);
		}
	});

	it("puts every declared filter field into the page-reset key", () => {
		// The bug this closes: add a filter, wire it into the query, forget the reset. The
		// narrowed result set keeps an offset it no longer has rows for, the table renders
		// empty, and the operator reads "no matches" for a filter that matched plenty.
		// Both derivations read one declaration, so they cannot drift apart.
		for (const field of LIST_FILTER_FIELDS) {
			const changed = { ...ALL, [field]: "different" };
			expect(predicateKey(changed), field).not.toBe(predicateKey(ALL));
		}
	});

	it("does not reset the page when only the offset moves", () => {
		expect(predicateKey(ALL)).toBe(predicateKey({ ...ALL }));
	});
});

describe("buildListQuery", () => {
	it("omits an empty or whitespace-only filter instead of sending it blank", () => {
		// `search=%20` matches nothing server-side while the UI still looks unfiltered —
		// an empty table with no explanation for why.
		expect(buildListQuery({ search: "   ", owner: "" }, 0)).toBe(`limit=${LIST_PAGE}`);
		expect(isFiltered({ search: "   " })).toBe(false);
		expect(isFiltered({ search: "x" })).toBe(true);
	});

	it("trims the value it does send, so a stray space is not part of the predicate", () => {
		expect(new URLSearchParams(buildListQuery({ owner: " serge-ivo " }, 0)).get("owner")).toBe("serge-ivo");
	});

	it("omits offset on the first page so it has one canonical URL", () => {
		expect(buildListQuery({}, 0)).toBe(`limit=${LIST_PAGE}`);
		expect(new URLSearchParams(buildListQuery({}, 50)).get("offset")).toBe("50");
	});

	it("always sends an explicit limit", () => {
		// Otherwise the page size is whatever the server currently defaults to, and the
		// pager below — which does its arithmetic in units of LIST_PAGE — is wrong.
		expect(new URLSearchParams(buildListQuery(ALL, 100)).get("limit")).toBe(String(LIST_PAGE));
	});
});

describe("pagerRange", () => {
	it("hides itself when everything fits on one page", () => {
		expect(pagerRange(50, 0).visible).toBe(false);
		expect(pagerRange(0, 0).visible).toBe(false);
		expect(pagerRange(51, 0).visible).toBe(true);
	});

	it("refuses a Next that would land past the end of the result set", () => {
		// The failure this prevents: an offset beyond the last row renders as "No
		// instances match these filters" — the same screen as a wrong filter, so the
		// operator debugs the filter instead of the paging.
		const last = pagerRange(120, 100);
		expect(last.to).toBe(120);
		expect(last.hasNext).toBe(false);
		expect(last.hasPrev).toBe(true);
	});

	it("computes hasNext from the last row SHOWN, not from the offset", () => {
		// With 100 rows and a page of 50, offset 50 shows 51–100 and is the end. Deriving
		// from `offset + page < total` would agree here but disagree on an exact multiple
		// one page earlier; deriving from `to` is the same arithmetic the label displays.
		expect(pagerRange(100, 50)).toMatchObject({ from: 51, to: 100, hasNext: false });
		expect(pagerRange(100, 0)).toMatchObject({ from: 1, to: 50, hasNext: true, hasPrev: false });
	});

	it("cannot step below zero", () => {
		expect(pagerRange(200, 0).prevOffset).toBe(0);
		expect(pagerRange(200, 50).prevOffset).toBe(0);
	});

	it("reports an empty result set as 0 rather than '1–0 of 0'", () => {
		expect(pagerRange(0, 0).from).toBe(0);
		expect(pagerRange(0, 0).to).toBe(0);
	});
});

/** Strip comments before matching — see store/console/src/lib/surfaces.test.ts. */
function codeOf(relPath: string): string {
	return readFileSync(join(__dirname, relPath), "utf8")
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.split("\n")
		.map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
		.join("\n");
}

describe("both list pages build their predicate here", () => {
	it.each(["../pages/Agents.tsx", "../pages/Instances.tsx"])("%s uses the shared builder", (page) => {
		// Two hand-rolled URLSearchParams blocks is how the two pages come to disagree
		// about what "filtered" means, and how a new filter lands on one of them only.
		const src = codeOf(page);
		expect(src).toContain("buildListQuery");
		expect(src).toContain("predicateKey");
		expect(src).not.toContain("new URLSearchParams()");
	});
});

describe("the instance status filter offers only statuses a row can hold (#598)", () => {
	/** `agent_instances.status` as the server declares it: value → who writes it (`"none"` = nobody). */
	function instanceStatusWriters(): Record<string, string> {
		const src = codeOf("../../../../workers/api/src/lib/status-domain.ts");
		const block = /"agent_instances\.status":\s*\{\s*values:\s*\{([^}]*)\}/.exec(src);
		expect(block, "parsed no agent_instances.status domain from workers/api/src/lib/status-domain.ts").toBeTruthy();
		const out: Record<string, string> = {};
		for (const [, value, writer] of (block?.[1] ?? "").matchAll(/(\w+)\s*:\s*"(\w+)"/g)) out[value] = writer;
		expect(Object.keys(out).length).toBeGreaterThan(1);
		return out;
	}

	/** The options the page puts in the dropdown. */
	function offeredStatuses(): string[] {
		const m = /const STATUSES = \[([^\]]+)\]/.exec(codeOf("../pages/Instances.tsx"));
		expect(m, "parsed no STATUSES from pages/Instances.tsx").toBeTruthy();
		return (m?.[1] ?? "").split(",").map((v) => v.trim().replace(/^"|"$/g, "")).filter(Boolean);
	}

	it("drops every value nothing writes, and keeps every value something does", () => {
		// The defect this pins is not a typo, it is a category: `paused` sat in this dropdown for
		// months, was selectable, and answered with an empty list. An operator reads that as "no
		// instance is paused" — a fact about the fleet — when it is a fact about the product, which
		// has no way to pause anything. A dead value in a shipped migration is invisible; a dead
		// OPTION is a capability advertised to a human, and that is why the owner's rule (#598)
		// deletes the second and records the first.
		//
		// Checked in BOTH directions on purpose. Dropping the unwritable values is the fix; keeping
		// every writable one is what stops the fix from being "delete options until it passes" and
		// catches the opposite drift — a new status that rows can hold and no operator can filter for.
		const writers = instanceStatusWriters();
		const writable = Object.entries(writers).filter(([, w]) => w !== "none").map(([v]) => v);
		expect(offeredStatuses().sort()).toEqual(writable.sort());
	});

	it("still knows about a value nothing writes, rather than having quietly lost the record", () => {
		// The value itself stays in the schema — `check-migrations --require-history` forbids editing
		// the migration that declared it, deliberately. So this asserts the two halves of the rule
		// hold together: the server still records `paused` as unwritten, and the UI still does not
		// offer it. If pause ever acquires a writer, the test above starts demanding the option back.
		expect(instanceStatusWriters().paused).toBe("none");
		expect(offeredStatuses()).not.toContain("paused");
	});
});
