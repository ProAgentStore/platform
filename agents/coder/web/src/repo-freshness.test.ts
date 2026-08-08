/**
 * #440 — a row that says "Path unusable" must also say how old that claim is.
 *
 * `pas/platform` read broken for five days from a verdict taken by something that never looked at
 * the directory. Every surface stated it with the same confidence on day five as on day one, so
 * the two things a user needs to tell apart — "the platform checked and it is broken" and "nobody
 * has looked since Monday" — were rendered identically.
 */
import { describe, expect, it } from "vitest";
import { repoFreshnessLabel, staleListNotice } from "./repo-freshness";

const NOW = Date.parse("2026-08-08T09:00:00Z");
const local = { workdir: "~/dev/stores/pas/platform" };

describe("repoFreshnessLabel", () => {
	it("says NEVER CHECKED rather than nothing when no machine has looked", () => {
		// The state every row carried before migration 0110, and the one that matters most: the
		// status is what somebody assumed. Rendering nothing here would leave it indistinguishable
		// from a verdict taken a minute ago.
		expect(repoFreshnessLabel(local, NOW)).toBe("never checked");
	});

	it("reads the timestamp as UTC, which is what D1 writes", () => {
		// `datetime('now')` has no zone. Handed to `Date.parse` as-is a browser reads it as LOCAL,
		// so in Sydney a check taken four minutes ago renders as ten hours old — a wrong answer
		// that looks exactly as authoritative as a right one.
		expect(repoFreshnessLabel({ ...local, cloneCheckedAt: "2026-08-08 08:56:00" }, NOW)).toBe("checked 4 min ago");
	});

	it("accepts an ISO timestamp too — the same instant either way", () => {
		expect(repoFreshnessLabel({ ...local, cloneCheckedAt: "2026-08-08T08:56:00Z" }, NOW)).toBe("checked 4 min ago");
	});

	it("scales to hours and days, because five days is the case that produced the ticket", () => {
		expect(repoFreshnessLabel({ ...local, cloneCheckedAt: "2026-08-08 06:00:00" }, NOW)).toBe("checked 3h ago");
		expect(repoFreshnessLabel({ ...local, cloneCheckedAt: "2026-08-03 01:44:25" }, NOW)).toBe("checked 5d ago");
	});

	it("never renders a check in the future when the clocks disagree", () => {
		expect(repoFreshnessLabel({ ...local, cloneCheckedAt: "2026-08-08 09:03:00" }, NOW)).toBe("checked just now");
	});

	it("treats an unparseable value as never checked, not as an age", () => {
		expect(repoFreshnessLabel({ ...local, cloneCheckedAt: "sometime" }, NOW)).toBe("never checked");
	});

	it("says nothing at all about a cloned repo — it has no checkout to look at", () => {
		expect(repoFreshnessLabel({ cloneCheckedAt: "2026-08-08 08:56:00" }, NOW)).toBeNull();
	});
});

describe("staleListNotice", () => {
	it("says the rows are last-known when the list could not re-check", () => {
		const note = staleListNotice({ ran: false, checked: 0, reason: "This agent is pinned to Sergeys-Mac-mini.local, which isn't connected." }, 7);
		expect(note).toMatch(/last known/i);
		// The server's diagnosis is carried verbatim: it is the only thing that can name a stale
		// "Runs on" pin, and a hardcoded "run `pags up`" here would be the #341 mistake — telling
		// someone to run the command they are already running.
		expect(note).toContain("Sergeys-Mac-mini.local");
	});

	it("says nothing when the list DID re-check — silence is the healthy state", () => {
		expect(staleListNotice({ ran: true, checked: 7 }, 7)).toBeNull();
	});

	it("says nothing for an API that predates the field", () => {
		// A console deployed ahead of the Worker must degrade to the old, quieter behaviour rather
		// than claim staleness it cannot know about.
		expect(staleListNotice(undefined, 7)).toBeNull();
	});

	it("says nothing when there is no local checkout to have checked", () => {
		expect(staleListNotice({ ran: false, checked: 0, reason: "x" }, 0)).toBeNull();
	});
});
