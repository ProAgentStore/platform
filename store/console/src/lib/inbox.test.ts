import { describe, expect, it } from "vitest";
import { ageLabel, expiryLabel, failedSources, filtersToQuery, parseFilters, toggled, truncatedSources } from "./inbox";

const parse = (qs: string) => parseFilters(new URLSearchParams(qs));

describe("inbox filters in the URL", () => {
	it("round-trips kinds, instances, agent, urgency and sort", () => {
		const f = parse("kind=takeover&kind=task&instance=i1&agent=coder-repo&urgency=blocking&sort=expiring");
		expect(f).toEqual({ kinds: ["takeover", "task"], instances: ["i1"], agent: "coder-repo", urgency: "blocking", sort: "expiring", triage: "review", needsComputer: false });
		expect(parse(filtersToQuery(f).toString())).toEqual(f);
	});
	it("drops unknown values and defaults the sort, leaving the default out of the URL", () => {
		const f = parse("kind=bogus&urgency=huge&sort=sideways");
		expect(f).toEqual({ kinds: [], instances: [], agent: null, urgency: null, sort: "urgency", triage: "review", needsComputer: false });
		expect(filtersToQuery(f).toString()).toBe("");
	});
	it("keeps the triage view and the needs-computer filter in the URL (#1697)", () => {
		const f = parse("triage=deferred&needs_computer=1&triage2=x");
		expect(f).toMatchObject({ triage: "deferred", needsComputer: true });
		expect(filtersToQuery(f).toString()).toBe("triage=deferred&needs_computer=1");
		expect(parse("triage=bogus").triage).toBe("review");
	});
	it("toggles a multi-select value on and off", () => {
		expect(toggled(["task"], "takeover")).toEqual(["task", "takeover"]);
		expect(toggled(["task", "takeover"], "task")).toEqual(["takeover"]);
	});
});

describe("inbox wording", () => {
	const now = Date.parse("2026-11-20T12:00:00Z");
	it("ages compactly", () => {
		expect(ageLabel("2026-11-20T11:59:50Z", now)).toBe("just now");
		expect(ageLabel("2026-11-20T11:15:00Z", now)).toBe("45m");
		expect(ageLabel("2026-11-20T07:00:00Z", now)).toBe("5h");
		expect(ageLabel("2026-11-15T12:00:00Z", now)).toBe("5d");
	});
	it("counts down an expiry, and says nothing without one", () => {
		expect(expiryLabel(null, now)).toBeNull();
		expect(expiryLabel("2026-11-20T12:12:00Z", now)).toBe("gives up in 12m");
		expect(expiryLabel("2026-11-20T11:00:00Z", now)).toBe("expiring now");
	});
	it("names the sources that failed or were capped, so an empty list is not read as nothing waiting", () => {
		const res = { sources: [{ kind: "task", ok: false }, { kind: "takeover", ok: true, truncated: true }, { kind: "approval", ok: true }] } as never;
		expect(failedSources(res)).toEqual(["task"]);
		expect(truncatedSources(res)).toEqual(["takeover"]);
	});
});
