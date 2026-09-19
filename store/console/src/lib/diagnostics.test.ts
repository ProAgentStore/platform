import { describe, expect, it } from "vitest";
import {
	ACTIVE_WITHIN_MS,
	PERSISTENT_AFTER_MS,
	describeRecurrence,
	filterSignatures,
	headline,
	describeFacets,
	humanDuration,
	instancesIn,
	recurrenceOf,
	sourcesOf,
	totalsOf,
	triageOrder,
	type ErrorSignature,
} from "./diagnostics";

const NOW = Date.parse("2026-09-20T12:00:00Z");
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString().slice(0, 19).replace("T", " ");
const DAY = 86_400_000;
const HOUR = 3_600_000;

function sig(over: Partial<ErrorSignature> = {}): ErrorSignature {
	return {
		key: "commit-close-watch::no github app installation token",
		source: "commit-close-watch",
		sample: "no GitHub App installation token for owner",
		pattern: "no github app installation token for owner",
		count: 1,
		rows: 1,
		users: 1,
		level: "warn",
		firstSeen: at(0),
		lastSeen: at(0),
		lastStatus: null,
		lastId: "e1",
		facets: { instances: [], repos: [], failureClasses: [], resumed: false, ended: false },
		...over,
	};
}

describe("recurrenceOf — time spanned, not occurrences", () => {
	it("flags the #823 case: a warning repeating across days", () => {
		// The literal issue: commit-close-watch failing hourly for days. At a one-hour write-side
		// collapse bucket that is ~72 rows, each looking like a fresh incident.
		const f = recurrenceOf(sig({ count: 72, rows: 72, firstSeen: at(3 * DAY), lastSeen: at(5 * 60_000) }), NOW);
		expect(f.kind).toBe("persistent");
		expect(f.spanMs).toBe(3 * DAY - 5 * 60_000);
		expect(f.active).toBe(true);
	});

	it("does NOT call a loud burst persistent — span is the test, not volume", () => {
		// A thousand occurrences in one minute is an incident. Labelling it "unaddressed" would put
		// the loudest thing of the day under the badge meant for the quiet thing nobody noticed.
		expect(recurrenceOf(sig({ count: 1000, firstSeen: at(60_000), lastSeen: at(0) }), NOW).kind).toBe("recurring");
	});

	it("never calls a single occurrence a pattern, however old", () => {
		expect(recurrenceOf(sig({ count: 1, firstSeen: at(30 * DAY), lastSeen: at(30 * DAY) }), NOW).kind).toBe("once");
	});

	it("separates STILL HAPPENING from merely on record", () => {
		const live = recurrenceOf(sig({ count: 50, firstSeen: at(2 * DAY), lastSeen: at(60_000) }), NOW);
		const done = recurrenceOf(sig({ count: 50, firstSeen: at(9 * DAY), lastSeen: at(6 * DAY) }), NOW);
		expect(live.active).toBe(true);
		expect(done.active).toBe(false);
		expect(done.kind).toBe("persistent"); // still unaddressed — it just stopped
	});

	it("reads D1's zoneless timestamps as UTC", () => {
		// `datetime('now')` writes "YYYY-MM-DD HH:MM:SS" with no zone. Parsing that as LOCAL time
		// shifts every span by the viewer's offset — enough to move a 23-hour span across the
		// persistent threshold, in either direction, depending on where the reader is sitting.
		const f = recurrenceOf(sig({ count: 2, firstSeen: "2026-09-18 12:00:00", lastSeen: "2026-09-20 12:00:00" }), NOW);
		expect(f.spanMs).toBe(2 * DAY);
		expect(f.sinceMs).toBe(0);
	});

	it("clamps clock skew rather than reporting a negative age", () => {
		expect(recurrenceOf(sig({ lastSeen: at(-60_000) }), NOW).sinceMs).toBe(0);
	});

	it("pins the two thresholds", () => {
		expect(PERSISTENT_AFTER_MS).toBe(DAY);
		expect(ACTIVE_WITHIN_MS).toBe(HOUR);
	});
});

describe("describeRecurrence", () => {
	it("distinguishes still-happening from unaddressed", () => {
		expect(describeRecurrence(sig({ count: 72, rows: 72, firstSeen: at(3 * DAY), lastSeen: at(120_000) }), NOW))
			.toBe("72 times over 2 days — still happening, last 2 minutes ago.");
		expect(describeRecurrence(sig({ count: 72, rows: 72, firstSeen: at(9 * DAY), lastSeen: at(5 * DAY) }), NOW))
			.toBe("72 times over 4 days — unaddressed, last 5 days ago.");
	});

	it("says plainly when something happened once", () => {
		expect(describeRecurrence(sig({ count: 1, firstSeen: at(2 * HOUR), lastSeen: at(2 * HOUR) }), NOW))
			.toBe("Once, 2 hours ago.");
	});

	it("states span and recency as separate facts", () => {
		// A reader given only one of them assumes the other.
		// Span is first→last (6h), recency is last→now (30m). Deliberately different numbers, so a
		// implementation that reported one of them twice would fail here.
		const text = describeRecurrence(sig({ count: 9, firstSeen: at(6 * HOUR + 30 * 60_000), lastSeen: at(30 * 60_000) }), NOW);
		expect(text).toContain("over 6 hours");
		expect(text).toContain("last 30 minutes ago");
	});
});

describe("humanDuration — one unit, never two", () => {
	it.each([
		[30_000, "less than a minute"],
		[60_000, "1 minute"],
		[90_000, "1 minute"],
		[2 * 60_000, "2 minutes"],
		[HOUR, "1 hour"],
		[47 * HOUR, "47 hours"],
		[48 * HOUR, "2 days"],
		[3 * DAY, "3 days"],
	])("%i → %s", (msSpan, expected) => {
		expect(humanDuration(msSpan)).toBe(expected);
	});
});

describe("triageOrder — a thing recurring for days is not buried under what happened last", () => {
	it("ranks anything persistent above a loud one-off, and errors first within each", () => {
		const persistentWarn = sig({ key: "a", level: "warn", count: 72, firstSeen: at(3 * DAY), lastSeen: at(60_000) });
		const loudError = sig({ key: "b", level: "error", count: 900, firstSeen: at(120_000), lastSeen: at(0) });
		const persistentError = sig({ key: "c", level: "error", count: 30, firstSeen: at(4 * DAY), lastSeen: at(60_000) });
		const order = [persistentWarn, loudError, persistentError].sort((x, y) => triageOrder(x, y, NOW)).map((s) => s.key);
		// persistent error > persistent warn > loud error. The 900-occurrence burst does not take a
		// slot from ANYTHING that has been broken for days — #823's own incident was a warn, and
		// ranking level above persistence buried exactly that under a nine-minute burst.
		expect(order).toEqual(["c", "a", "b"]);
	});
});

describe("filterSignatures", () => {
	const rows = [
		sig({ key: "a", source: "commit-close-watch", level: "warn", count: 72, firstSeen: at(3 * DAY), lastSeen: at(0) }),
		sig({ key: "b", source: "coding", level: "error", count: 3, firstSeen: at(HOUR), lastSeen: at(0) }),
		sig({ key: "c", source: "coding", level: "warn", count: 1 }),
	];

	it("filters by level, source, and persistence independently", () => {
		expect(filterSignatures(rows, { level: "error" }, NOW).map((s) => s.key)).toEqual(["b"]);
		expect(filterSignatures(rows, { source: "coding" }, NOW).map((s) => s.key)).toEqual(["b", "c"]);
		expect(filterSignatures(rows, { persistentOnly: true }, NOW).map((s) => s.key)).toEqual(["a"]);
		expect(filterSignatures(rows, { source: "coding", persistentOnly: true }, NOW)).toEqual([]);
	});

	it("treats a missing level as an error, not as a warn", () => {
		// A pre-0103 row has no level. Defaulting it to `warn` would hide real failures behind the
		// quieter filter — the failure mode this page exists to stop.
		const legacy = [sig({ key: "x", level: undefined as unknown as string })];
		expect(filterSignatures(legacy, { level: "error" }, NOW).map((s) => s.key)).toEqual(["x"]);
		expect(filterSignatures(legacy, { level: "warn" }, NOW)).toEqual([]);
	});
});

describe("sourcesOf", () => {
	it("derives the chips from the data, most-affected first", () => {
		expect(
			sourcesOf([
				sig({ source: "coding", count: 5 }),
				sig({ source: "commit-close-watch", count: 72 }),
				sig({ source: "coding", count: 10 }),
			]),
		).toEqual([
			{ source: "commit-close-watch", count: 72 },
			{ source: "coding", count: 15 },
		]);
	});
});

describe("totalsOf and headline", () => {
	it("counts occurrences, not rows, and leads with what is unaddressed", () => {
		const rows = [
			sig({ key: "a", level: "warn", count: 72, rows: 72, firstSeen: at(3 * DAY), lastSeen: at(0) }),
			sig({ key: "b", level: "error", count: 4, rows: 4, firstSeen: at(HOUR), lastSeen: at(0) }),
		];
		const t = totalsOf(rows, NOW);
		expect(t).toEqual({ signatures: 2, occurrences: 76, errors: 1, warnings: 1, persistent: 1 });
		expect(headline(t)).toBe("1 problem has been recurring for a day or more.");
	});

	it("says NOTHING on a clean account, and nothing when everything is recent", () => {
		// A page that always announces something teaches people its announcements mean nothing —
		// which is the failure this page exists to fix, one level up.
		expect(headline(totalsOf([], NOW))).toBeNull();
		expect(headline(totalsOf([sig({ count: 9, firstSeen: at(HOUR), lastSeen: at(0) })], NOW))).toBeNull();
	});

	it("pluralises the headline", () => {
		const two = [
			sig({ key: "a", count: 9, firstSeen: at(3 * DAY), lastSeen: at(0) }),
			sig({ key: "b", count: 9, firstSeen: at(4 * DAY), lastSeen: at(0) }),
		];
		expect(headline(totalsOf(two, NOW))).toBe("2 problems have been recurring for a day or more.");
	});
});

describe("describeFacets — what it touched, said as a lower bound (#823)", () => {
	const facets = (over: Partial<ErrorSignature["facets"]> = {}) => ({
		instances: [],
		repos: [],
		failureClasses: [],
		resumed: false,
		ended: false,
		...over,
	});

	it("names the coding-failure facts the issue asked for", () => {
		expect(
			describeFacets({ rows: 1, facets: facets({ instances: ["inst-1"], repos: ["acme/api"], failureClasses: ["infra_transient"], resumed: true }) }),
		).toBe("inst-1 · acme/api · infra_transient · resumed");
	});

	it("resolves instance ids to names when it can", () => {
		expect(describeFacets({ rows: 1, facets: facets({ instances: ["inst-1"] }) }, (id) => (id === "inst-1" ? "Heartfull Coder" : id)))
			.toBe("Heartfull Coder");
	});

	it('says "seen on" once the bucket is wider than the samples it retained', () => {
		// A collapsed row keeps TWO context samples. Listing them as though they were the complete
		// set is the confident-wrong-answer this whole feature is meant to avoid — and two names
		// look like a list, which is why it has to be said rather than left to the reader.
		expect(describeFacets({ rows: 72, facets: facets({ instances: ["inst-1", "inst-2"] }) }))
			.toBe("seen on inst-1, inst-2");
		// One row cannot have hidden anything, so it states them plainly.
		expect(describeFacets({ rows: 1, facets: facets({ instances: ["inst-1"] }) })).toBe("inst-1");
	});

	it("reports both dispositions when a bucket saw both", () => {
		expect(describeFacets({ rows: 9, facets: facets({ resumed: true, ended: true }) })).toBe("some resumed, some ended");
		expect(describeFacets({ rows: 9, facets: facets({ ended: true }) })).toBe("ended");
	});

	it("is null when there is nothing to say", () => {
		// Most sources carry no instance, repo or class. An empty separator line is noise.
		expect(describeFacets({ rows: 1, facets: facets() })).toBeNull();
	});
});

describe("instancesIn", () => {
	it("collects every instance any signature touched, sorted and deduped", () => {
		expect(
			instancesIn([
				sig({ key: "a", facets: { instances: ["zz", "aa"], repos: [], failureClasses: [], resumed: false, ended: false } }),
				sig({ key: "b", facets: { instances: ["aa"], repos: [], failureClasses: [], resumed: false, ended: false } }),
			]),
		).toEqual(["aa", "zz"]);
	});
});
