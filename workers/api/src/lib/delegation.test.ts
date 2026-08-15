import { describe, expect, it } from "vitest";
import { CARD_DETAIL_MAX } from "./card-detail.js";
import { delegationTaskRecord } from "./delegation.js";
import { runOutcomeNote } from "./coding-run-report.js";
import { summarizeActs } from "./engine-acts.js";
import { COMPLETENESS_LEGEND, fitStatusPayload } from "./subordinate-payload.js";

/**
 * The delegation card's detail, held to what #568 measured.
 *
 * The fixture is REBUILT the way production builds it — `summarizeActs` → `runOutcomeNote` →
 * `delegationTaskRecord` — rather than hand-typed, so a change to any link in that chain is caught
 * here instead of quietly making this file agree with itself. The acts are the fifteen
 * `act.consequential` rows recorded for run `deleg-ae7fa3f2` on instance `bd43f4de`: fourteen
 * pushes to the trunk and one recursive delete, every one `irreversible: true`.
 */
const ACTS_15 = [
	...Array.from({ length: 14 }, () => ({ summary: "pushed directly to the trunk origin main", irreversible: true })),
	{ summary: "deleted files recursively", irreversible: true },
];

/** The Cloudflare subrequest ceiling that ended that run (#523), verbatim. */
const RUN_ERROR =
	"run error: Too many API requests by single Worker invocation. To configure this limit, refer to https://developers.cloudflare.com/workers/wrangler/configuration/#limits";

const NOTE = runOutcomeNote({
	outcome: "failed",
	detail: RUN_ERROR,
	breach: "",
	authorityNote: null,
	actLine: summarizeActs(ACTS_15),
});

const card = (opts: { acts?: typeof ACTS_15 } = {}) =>
	delegationTaskRecord({
		id: "deleg-ae7fa3f2",
		targetLabel: "apps/chess-academy",
		objective: "commit directly to main, push. Do NOT create feature branches.",
		status: "failed",
		now: "2026-08-12T00:00:00.000Z",
		note: NOTE,
		...opts,
	});

describe("delegationTaskRecord — the card's detail is budgeted, not a 300-char prefix (#568)", () => {
	it("reproduces the defect's input: a note over the cap whose acts clause starts past it", () => {
		// The denominator, stated. Without this the assertions below could pass against a note that
		// never needed cutting, which is how this class of guard fails silently. 375 characters
		// against a 300-character field, with `Acts:` beginning at 182 — so the four summaries and
		// the "and 11 more" that carries the real total are what the old prefix threw away.
		expect(NOTE.length).toBeGreaterThan(CARD_DETAIL_MAX);
		expect(NOTE).toContain("; and 11 more.");
		expect(NOTE.indexOf("Acts:")).toBeLessThan(CARD_DETAIL_MAX);
		expect(NOTE.indexOf("; and 11 more.")).toBeGreaterThan(CARD_DETAIL_MAX);
	});

	it("states 15, and is inside the cap", () => {
		const detail = String(card({ acts: ACTS_15 }).description);
		expect(detail).toMatch(/^15 acts, all irreversible:/);
		expect(detail.length).toBeLessThanOrEqual(CARD_DETAIL_MAX);
	});

	it("no longer emits the exact string the board showed", () => {
		// Measured on the live card: 300 characters, ending `…pushed directly to th`, naming two
		// of fifteen irreversible acts, with no ellipsis — it reads as a finished sentence.
		const OLD = NOTE.slice(0, CARD_DETAIL_MAX);
		expect(OLD).toHaveLength(300);
		expect(OLD.endsWith("pushed directly to th")).toBe(true);
		expect(OLD.match(/pushed directly to the trunk origin main/g)).toHaveLength(2);
		expect(OLD).not.toMatch(/15|and 11 more/);

		const detail = String(card({ acts: ACTS_15 }).description);
		expect(detail).not.toBe(OLD);
		expect(detail.endsWith("…")).toBe(true);
	});

	it("keeps the error that put the card in Failed", () => {
		// Rejected alternative: show only the acts. The error is WHY it is in that column.
		expect(String(card({ acts: ACTS_15 }).description)).toContain("outcome: failed — run error: Too many API requests");
	});

	it("leaves the complete text on `reasoning`, which board.ts returns alongside", () => {
		const t = card({ acts: ACTS_15 });
		expect(String(t.reasoning)).toContain(NOTE);
		expect(String(t.reasoning)).toContain("; and 11 more.");
		expect(String(t.reasoning).length).toBeGreaterThan(String(t.description).length);
	});

	it("is unchanged for a card whose run reported no acts", () => {
		// A raw engine reports nothing, and most delegations are short. This is the common path and
		// it must not grow a headline it cannot justify.
		const short = delegationTaskRecord({
			id: "deleg-1", targetLabel: "fws/platform", objective: "green the suite",
			status: "completed", now: "2026-08-05T12:00:00.000Z", note: "outcome: done — 3 tests fixed",
		});
		expect(short.description).toBe("outcome: done — 3 tests fixed");
		expect(card().description).not.toMatch(/^\d+ acts/);
	});

	it("writes no description at all while the run is live", () => {
		// That field belongs to the Pilot's progress line until the terminal write (#207B).
		expect(
			delegationTaskRecord({ id: "d", targetLabel: "r", objective: "o", status: "running", now: "2026-08-05T12:00:00.000Z" }),
		).not.toHaveProperty("description");
	});
});

describe("the count survives the SECOND trim (#568 regression risk)", () => {
	const detail = String(card({ acts: ACTS_15 }).description);

	it("still names 15 at every width `subordinate-payload` cuts a string to", () => {
		// `reduceValue`/`collapseSubordinate` re-cut this same string at 240 / 140 / 90 / 80 chars
		// on their way down the ladder. Front-loading the count is what makes it survive all four;
		// the old prefix named no acts at any of them.
		for (const chars of [240, 140, 90, 80]) {
			expect(detail.slice(0, chars), `at ${chars} chars`).toMatch(/^15 acts, all irreversible/);
			expect(NOTE.slice(0, CARD_DETAIL_MAX).slice(0, chars)).not.toMatch(/15 acts/);
		}
	});

	it("reaches a supervisor's reply with the count intact, where the OLD detail named no acts", () => {
		// End to end through the ladder `subordinate_status` actually uses. Six subordinates and a
		// 4,200-character budget put it on `terse`, which cuts every prose string to NINETY
		// characters — the narrowest rung that still carries a card's detail at all. Both strings
		// are 300 characters, so both land on the same rung and the comparison is fair.
		const board = (d: string) =>
			Array.from({ length: 6 }, (_, i) => ({
				instanceId: `i${i}`,
				name: `coder ${i}`,
				subscription: "active",
				work: [{ instanceId: `i${i}`, id: "deleg-ae7fa3f2", kind: "delegation", status: "failed", title: "Delegated: commit directly to main", detail: d, updatedAt: "2026-08-12T00:00:00.000Z" }],
				runs: [],
			}));
		const roster = board("").map((s) => ({ instanceId: s.instanceId, name: s.name, subscription: "active" }));
		// The budget is stated as LEGEND + headroom, not as a bare 4,200 (#589). `fitStatusPayload`
		// always prepends `COMPLETENESS_LEGEND`, so a fixed number silently measures a different
		// rung every time that legend is edited — which is what happened here when #589 gave
		// `activity` five words and had to say so. The 2,996 characters of headroom is the number
		// that put six of these subordinates on `terse` when this test was written, and it is the
		// quantity the assertion is actually about.
		const fit = (d: string) => fitStatusPayload({ asOf: null, roster, subordinates: board(d), legend: "", maxChars: COMPLETENESS_LEGEND.length + 2_996 });

		const now = fit(detail);
		expect(now.level, "the rung this asserts against").toBe("terse");
		expect(now.content).toContain("15 acts, all irreversible");

		// The denominator: the SAME ladder, the same budget, the string the old writer produced.
		const before = fit(NOTE.slice(0, CARD_DETAIL_MAX));
		expect(before.level).toBe("terse");
		expect(before.content).not.toMatch(/\d+ acts/);
	});
});
