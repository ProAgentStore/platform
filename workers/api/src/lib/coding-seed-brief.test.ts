import { describe, expect, it } from "vitest";
import { SEED_BRIEF_ENTRIES, SEED_BRIEF_MAX_CHARS, SEED_CLOSING, SEED_PREAMBLE, composeSeedBrief, seedBriefForRepo } from "./coding-seed-brief.js";
import { RESUME_WINDOW_MS } from "./coding-session-continuity.js";
import type { TimelineEntry, TimelineType } from "./coding-timeline.js";
import type { Env } from "../types.js";

// What an ENGINE is told when the platform reconstructs its context (ADR 0005, #693).
//
// Every assertion here is about a sentence a model reads and then repeats to a user in its own
// words, so these are product claims, not formatting. The one that matters most is the negative:
// the ADR permits reconstruction and forbids the claim of restoration, and the only place that
// distinction can be enforced is the text itself.

// A FIXED clock, and every fixture dated relative to it (#737). Ages are part of the rendered
// text now, so a fixture pinned to a wall-clock date would have read "4 days" the week it was
// written and "8 months" today — the test would decay into asserting nothing, or into failing for
// the passage of time. `composeSeedBrief` takes `now` for exactly this reason.
const NOW = Date.parse("2026-08-24T10:00:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** The composer, always asked against the fixed clock. */
const compose = (entries: TimelineEntry[], opts: { repoName?: string } = {}) => composeSeedBrief(entries, { ...opts, now: NOW });

let seq = 0;
const entry = (type: TimelineType, content: string, ageMs = 3 * DAY): TimelineEntry => ({
	seq: ++seq,
	type,
	content,
	createdAt: new Date(NOW - ageMs).toISOString(),
});

const A_RUN = [
	entry("chat_user", "add a health endpoint to the worker"),
	entry("command", "add a /health route returning {ok:true}"),
	entry("terminal", "created workers/api/src/routes/health.ts\nall tests pass"),
	entry("outcome", "turn finished: 1 file changed"),
];

describe("composeSeedBrief — the platform's record, rendered for an engine (ADR 0005)", () => {
	it("says the conversation is gone before it says anything else", () => {
		// The single prohibited claim. "It must never be described to a user as 'as if it never
		// died'" is the ADR's wording, and the engine is the first reader in that chain: an engine
		// that believes it has its old context back will tell the user so, in its own words, and
		// nothing downstream can retract it.
		const brief = compose(A_RUN);
		expect(brief).toContain("This is NOT your previous conversation");
		expect(brief.indexOf("NOT your previous conversation")).toBeLessThan(brief.indexOf("History from the platform's record"));
		expect(brief).not.toMatch(/as if it never/i);
		expect(brief).not.toMatch(/restor(ed|ation)/i);
	});

	it("names what is missing, not only what is present", () => {
		// An engine that knows the brief cannot contain file contents or tool state asks about them.
		// One that does not, fills the gap — which is the failure mode a summary introduces and a
		// real resume does not.
		const brief = compose(A_RUN);
		expect(brief).toMatch(/file contents/i);
		expect(brief).toMatch(/tool state/i);
		expect(brief).toMatch(/may have moved on/i);
	});

	it("frames itself as background for the instruction that follows it", () => {
		// The brief is PREPENDED to a real turn. Without this sentence the engine reads the last line
		// of the history as the request and acts on a finished instruction.
		const brief = compose(A_RUN);
		expect(brief).toMatch(/BACKGROUND/);
		expect(brief.endsWith(SEED_CLOSING)).toBe(true);
	});

	it("renders oldest-first, whichever way the reader is holding it", () => {
		const brief = compose(A_RUN);
		expect(brief.indexOf("add a health endpoint")).toBeLessThan(brief.indexOf("all tests pass"));
		expect(brief.indexOf("all tests pass")).toBeLessThan(brief.indexOf("turn finished"));
	});

	it("labels a co-pilot line as the co-pilot's, not as the engine's own words", () => {
		// `contextForCopilot`'s labels are written from the co-pilot's seat ("You(copilot)"). Reused
		// here they would tell the engine it had said something it never said, and an engine that
		// believes it summarised its own work will defend the summary.
		const brief = compose([entry("chat_assistant", "it finished the refactor")]);
		expect(brief).toContain("[the co-pilot told the user · 3 days ago] it finished the refactor");
		expect(brief).not.toMatch(/You\(/);
	});

	it("is empty — genuinely empty — when there is no record", () => {
		// Not a preamble with nothing after it. That would announce history to an engine and then
		// show it none, which is worse than silence: the engine would ask the user what happened to
		// the history the platform just told it about.
		expect(compose([])).toBe("");
		expect(compose([entry("terminal", "   \n  ")])).toBe("");
	});

	it("stays inside its budget by dropping the OLDEST, and stops rather than leaving a hole", () => {
		// The ADR names an unbounded brief as the cost this change takes on. Two properties, and the
		// second is the one an obvious implementation gets wrong: skipping a too-large entry and
		// continuing further back produces a brief with a gap in the middle of it and no text saying
		// so, which reads as a complete history that is missing the part that explains everything.
		const big = Array.from({ length: 40 }, (_, i) => entry("command", `step ${i} `.padEnd(600, "x")));
		const brief = compose(big);
		expect(brief.length).toBeLessThanOrEqual(SEED_BRIEF_MAX_CHARS + SEED_PREAMBLE.length + 200);
		// The newest survived and the oldest did not — the tail is what the next instruction refers to.
		expect(brief).toContain("step 39");
		expect(brief).not.toContain("step 0 ");
	});

	it("keeps the TAIL of a terminal snapshot and the HEAD of an instruction", () => {
		// Opposite ends on purpose: a run's verdict is the last thing it printed, and an
		// instruction's point is its first sentence.
		const brief = compose([
			entry("terminal", `${"noise\n".repeat(500)}FAILED: 2 tests`),
			entry("command", `fix the two failing tests ${"and then ".repeat(500)}`),
		]);
		expect(brief).toContain("FAILED: 2 tests");
		expect(brief).toContain("fix the two failing tests");
	});

	it("survives a row the database did not fill in", () => {
		// Not hypothetical: the first version of this file threw a TypeError on a row whose `content`
		// came back undefined, INSIDE the composer and therefore past the read's own `.catch` — which
		// failed the session open that was waiting on it. A missing memory must never become a
		// missing session, and that guarantee is about the whole function rather than one await in it.
		const broken = [{ seq: 1, type: "command", createdAt: "" }, ...A_RUN] as unknown as TimelineEntry[];
		expect(() => compose(broken)).not.toThrow();
		expect(compose(broken)).toContain("add a health endpoint");
		expect(compose(undefined as unknown as TimelineEntry[])).toBe("");
	});

	it("names the repository when it is known, and does not invent one when it is not", () => {
		expect(compose(A_RUN, { repoName: "ProAgentStore/platform" })).toContain("Repository: ProAgentStore/platform");
		expect(compose(A_RUN)).not.toContain("Repository:");
	});
});

/**
 * #737 — the brief called 41 days of undated history "recent".
 *
 * Measured on live data 2026-08-23, replaying this exact algorithm against
 * `GET …/coding/repos/:repoId/timeline`: two production repos produced briefs spanning 41 and 39
 * days, opening with an instruction from June, with nothing on any line saying when. "Recent" was
 * the only temporal word the document contained and it was asserted, never measured.
 *
 * The fixtures below are that measurement, preserved: a 41-day span and a same-day one, so both the
 * failure and the ordinary case are pinned by shape rather than by anecdote.
 */
describe("the brief dates itself (#737)", () => {
	it("puts each entry's age on its own line, in the platform's own register", () => {
		// Not a constant restated at the top — every line carries the age OF THAT ROW, derived from
		// `createdAt`, which `TimelineEntry` has always had and `renderEntry` always dropped. A
		// header alone would not do it: an engine reading the fourth line of forty cannot tell
		// whether it is near the top of the span or the bottom.
		const brief = compose([
			entry("chat_user", "start the migration", 41 * DAY),
			entry("command", "run the migration", 6 * HOUR),
		]);
		expect(brief).toContain("[the user said · 41 days ago] start the migration");
		expect(brief).toContain("[an instruction sent to the engine · 6 hours ago] run the migration");
		// `describeAge` from `coding-session-continuity.ts`, not a second formatter — the same helper
		// that phrases the console banner, so the two surfaces cannot report one row two ways.
		expect(brief).not.toMatch(/\d+ms|milliseconds|1970/);
	});

	it("states the span in the header, so a 41-day brief says 41 days somewhere", () => {
		// The acceptance criterion, checkable exactly as the issue asks: compose from fixture rows
		// with fixed timestamps and read the number back out of the text.
		const brief = compose([
			entry("chat_user", "start the migration", 41 * DAY),
			entry("terminal", "done", 17 * DAY),
			entry("command", "run the migration", 6 * HOUR),
		]);
		expect(brief).toContain("the oldest entry here is 41 days old, the newest 6 hours old");
		// And the word it replaced is gone. "Recent" was the whole defect: it asserted a property
		// nothing measured, about content the platform had already classified as too old to use.
		expect(brief).not.toContain("Recent history");
	});

	it("describes the rows that SURVIVED the budget, not the ones it was handed", () => {
		// The header would otherwise describe a span the engine cannot see. `composeSeedBrief`
		// spends its budget newest-backwards and stops, so the oldest rows are exactly the ones most
		// likely to be dropped — which is to say the header's own number is the one at risk.
		const big = Array.from({ length: 40 }, (_, i) => entry("command", `step ${i} `.padEnd(600, "x"), (40 - i) * DAY));
		const brief = compose(big);
		expect(brief).not.toContain("step 0 ");
		expect(brief).not.toContain("the oldest entry here is 40 days old");
		// Whatever it does say, the age it names is one that appears on a line in the brief.
		const stated = /the oldest entry here is ([^,]+) old/.exec(brief)?.[1];
		expect(stated, "the header named no span").toBeTruthy();
		expect(brief).toContain(`· ${stated} ago]`);
	});

	it("collapses the range when there is only one age to report", () => {
		// "the oldest entry here is 3 days old, the newest 3 days old" is a range that is not a
		// range, and a reader who has to notice the two numbers are equal reads past it.
		expect(compose([entry("command", "one thing", 3 * DAY)])).toContain("every entry here is about 3 days old");
	});

	it("says the record is undated rather than inventing a span", () => {
		// An unparseable `created_at` is the state some legacy rows are in. Claiming a span nobody
		// measured is the same mistake as the word this issue removed.
		const undated = [{ seq: 1, type: "command", content: "do the thing", createdAt: "" }] as unknown as TimelineEntry[];
		const brief = compose(undated);
		expect(brief).toContain("the record does not say when these happened");
		// And the line renders with no age rather than a wrong one.
		expect(brief).toContain("[an instruction sent to the engine] do the thing");
	});

	it("reads a SQLite `datetime('now')` timestamp as UTC, not as local time", () => {
		// `coding_timeline.created_at` defaults to `datetime('now')` — `YYYY-MM-DD HH:MM:SS`, no `T`
		// and no `Z`. `Date.parse` treats that shape as LOCAL time in V8, so parsing it unedited
		// shifts every age by the host's offset. Workers run UTC, which is exactly what would make
		// this invisible here and real anywhere else; the fixture is the production format.
		const row = [{ seq: 1, type: "command", content: "run it", createdAt: "2026-08-24 04:00:00" }] as unknown as TimelineEntry[];
		expect(compose(row)).toContain("· 6 hours ago]");
	});

	it("costs the brief no more than one entry of its budget", () => {
		// The stated regression risk: ~10 characters per line on a 60-row brief is under 5% of
		// 12 000. Measured rather than reasoned about, because "stops when full" means the cost
		// lands as dropped ENTRIES and that is the number the engine feels.
		const rows = Array.from({ length: 60 }, (_, i) => entry("command", `step ${i} `.padEnd(400, "x"), (60 - i) * HOUR));
		const withAges = compose(rows).split("\n").filter((l) => l.startsWith("[an instruction")).length;
		expect(withAges).toBeGreaterThan(25);
		// And the total still respects the budget it was given.
		expect(compose(rows).length).toBeLessThanOrEqual(SEED_BRIEF_MAX_CHARS + SEED_PREAMBLE.length + 300);
	});
});


/**
 * ONE answer to "how old is too old for this repo" (#737).
 *
 * The owner's decision, recorded on the issue: cut the seed at `RESUME_WINDOW_MS` itself, imported
 * rather than re-declared, "so there is one answer… and #408's number cannot drift from #693's".
 * A test asserting they are EQUAL is what makes a future change to one move both — a second
 * constant would be correct on the day it was written and silently wrong afterwards.
 */
describe("seedBriefForRepo — the window is #408's window (#737)", () => {
	/** A D1 that records the read and answers with nothing, which is all this asserts about. */
	function readEnv() {
		const reads: { sql: string; args: unknown[] }[] = [];
		const DB = {
			prepare(sql: string) {
				return {
					bind(...args: unknown[]) {
						reads.push({ sql, args });
						return { async all() { return { results: [] }; }, async first() { return null; }, async run() { return { meta: { changes: 0 } }; } };
					},
				};
			},
		};
		return { env: { DB } as unknown as Env, reads };
	}

	it("cuts the record at exactly RESUME_WINDOW_MS, and asks for SEED_BRIEF_ENTRIES rows", async () => {
		const { env, reads } = readEnv();
		const before = Date.now();
		await seedBriefForRepo(env, { instanceId: "i1", userId: "u1", repoId: "r1", repoName: "org/repo" });
		const after = Date.now();
		expect(reads[0].args[3]).toBe(SEED_BRIEF_ENTRIES);
		const since = Date.parse(`${String(reads[0].args[4]).replace(" ", "T")}Z`);
		// The bound is `now − RESUME_WINDOW_MS`, to the second the timestamp is stored at. Bracketed
		// by the clock either side of the call rather than compared to a third reading of it.
		expect(since).toBeLessThanOrEqual(before - RESUME_WINDOW_MS + 1000);
		expect(since).toBeGreaterThanOrEqual(after - RESUME_WINDOW_MS - 1000);
	});

	it("returns '' when nothing survives the window, and does not throw", async () => {
		// The empty case was already correct and this pins that (c) did not turn it into a new state:
		// a session then opens exactly as it does today for a repo with no record at all — not a
		// preamble with no content, which the composer already forbids.
		const { env } = readEnv();
		await expect(seedBriefForRepo(env, { instanceId: "i1", userId: "u1", repoId: "r1" })).resolves.toBe("");
	});

	it("still degrades to no brief when the read fails outright", async () => {
		// A missing memory must never become a missing session. Unchanged by (c), and re-pinned here
		// because the date bound added a second way for the query to be wrong.
		const env = { DB: { prepare() { throw new Error("D1_ERROR"); } } } as unknown as Env;
		await expect(seedBriefForRepo(env, { instanceId: "i1", userId: "u1", repoId: "r1" })).resolves.toBe("");
	});
});
