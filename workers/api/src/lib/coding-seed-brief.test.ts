import { describe, expect, it } from "vitest";
import { SEED_BRIEF_MAX_CHARS, SEED_CLOSING, SEED_PREAMBLE, composeSeedBrief } from "./coding-seed-brief.js";
import type { TimelineEntry, TimelineType } from "./coding-timeline.js";

// What an ENGINE is told when the platform reconstructs its context (ADR 0005, #693).
//
// Every assertion here is about a sentence a model reads and then repeats to a user in its own
// words, so these are product claims, not formatting. The one that matters most is the negative:
// the ADR permits reconstruction and forbids the claim of restoration, and the only place that
// distinction can be enforced is the text itself.

let seq = 0;
const entry = (type: TimelineType, content: string): TimelineEntry => ({
	seq: ++seq,
	type,
	content,
	createdAt: "2026-08-20T10:00:00Z",
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
		const brief = composeSeedBrief(A_RUN);
		expect(brief).toContain("This is NOT your previous conversation");
		expect(brief.indexOf("NOT your previous conversation")).toBeLessThan(brief.indexOf("Recent history"));
		expect(brief).not.toMatch(/as if it never/i);
		expect(brief).not.toMatch(/restor(ed|ation)/i);
	});

	it("names what is missing, not only what is present", () => {
		// An engine that knows the brief cannot contain file contents or tool state asks about them.
		// One that does not, fills the gap — which is the failure mode a summary introduces and a
		// real resume does not.
		const brief = composeSeedBrief(A_RUN);
		expect(brief).toMatch(/file contents/i);
		expect(brief).toMatch(/tool state/i);
		expect(brief).toMatch(/may have moved on/i);
	});

	it("frames itself as background for the instruction that follows it", () => {
		// The brief is PREPENDED to a real turn. Without this sentence the engine reads the last line
		// of the history as the request and acts on a finished instruction.
		const brief = composeSeedBrief(A_RUN);
		expect(brief).toMatch(/BACKGROUND/);
		expect(brief.endsWith(SEED_CLOSING)).toBe(true);
	});

	it("renders oldest-first, whichever way the reader is holding it", () => {
		const brief = composeSeedBrief(A_RUN);
		expect(brief.indexOf("add a health endpoint")).toBeLessThan(brief.indexOf("all tests pass"));
		expect(brief.indexOf("all tests pass")).toBeLessThan(brief.indexOf("turn finished"));
	});

	it("labels a co-pilot line as the co-pilot's, not as the engine's own words", () => {
		// `contextForCopilot`'s labels are written from the co-pilot's seat ("You(copilot)"). Reused
		// here they would tell the engine it had said something it never said, and an engine that
		// believes it summarised its own work will defend the summary.
		const brief = composeSeedBrief([entry("chat_assistant", "it finished the refactor")]);
		expect(brief).toContain("[the co-pilot told the user] it finished the refactor");
		expect(brief).not.toMatch(/You\(/);
	});

	it("is empty — genuinely empty — when there is no record", () => {
		// Not a preamble with nothing after it. That would announce history to an engine and then
		// show it none, which is worse than silence: the engine would ask the user what happened to
		// the history the platform just told it about.
		expect(composeSeedBrief([])).toBe("");
		expect(composeSeedBrief([entry("terminal", "   \n  ")])).toBe("");
	});

	it("stays inside its budget by dropping the OLDEST, and stops rather than leaving a hole", () => {
		// The ADR names an unbounded brief as the cost this change takes on. Two properties, and the
		// second is the one an obvious implementation gets wrong: skipping a too-large entry and
		// continuing further back produces a brief with a gap in the middle of it and no text saying
		// so, which reads as a complete history that is missing the part that explains everything.
		const big = Array.from({ length: 40 }, (_, i) => entry("command", `step ${i} `.padEnd(600, "x")));
		const brief = composeSeedBrief(big);
		expect(brief.length).toBeLessThanOrEqual(SEED_BRIEF_MAX_CHARS + SEED_PREAMBLE.length + 200);
		// The newest survived and the oldest did not — the tail is what the next instruction refers to.
		expect(brief).toContain("step 39");
		expect(brief).not.toContain("step 0 ");
	});

	it("keeps the TAIL of a terminal snapshot and the HEAD of an instruction", () => {
		// Opposite ends on purpose: a run's verdict is the last thing it printed, and an
		// instruction's point is its first sentence.
		const brief = composeSeedBrief([
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
		expect(() => composeSeedBrief(broken)).not.toThrow();
		expect(composeSeedBrief(broken)).toContain("add a health endpoint");
		expect(composeSeedBrief(undefined as unknown as TimelineEntry[])).toBe("");
	});

	it("names the repository when it is known, and does not invent one when it is not", () => {
		expect(composeSeedBrief(A_RUN, { repoName: "ProAgentStore/platform" })).toContain("Repository: ProAgentStore/platform");
		expect(composeSeedBrief(A_RUN)).not.toContain("Repository:");
	});
});
