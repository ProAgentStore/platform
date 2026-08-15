import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { checkRunLifecycle, parseConstArray, parseParks, renderRegions } from "./run-lifecycle.mjs";

/**
 * The run-lifecycle page's value sets are GENERATED (#601 AC1), so these assertions are about
 * the renderer and about what makes it go red — not about today's wording.
 *
 * Every case below feeds a synthetic source, because the point of the module is that it can be
 * shown the shape that would break it. The one test against the real tree asserts the published
 * page agrees with the real enums, which is the assertion the gate makes in CI.
 */

const ROOT = resolve(import.meta.dirname, "../..");
const read = (f) => readFileSync(resolve(ROOT, f), "utf8");

const WORK_REPORT = read("workers/api/src/lib/work-report.ts");
const LOOP_STORE = read("workers/api/src/lib/agent-loop-store.ts");
const DOC = read("platform-docs/run-lifecycle.md");

/** A minimal source pair that parses, so each test can break exactly one thing. */
const fakeWorkReport = (states, parks) =>
	`export const RUN_HEALTH_STATES = [${states.map((s) => `"${s}"`).join(", ")}] as const;\n` +
	`const PARKS: Record<RunWaitReason, Park> = {\n${parks
		.map(([k, why, deadline]) => `\t${k}: { why: "${why}", deadline: "${deadline}" },`)
		.join("\n")}\n};\n`;
const fakeLoopStore = (reasons) => `export const RUN_WAIT_REASONS = [${reasons.map((r) => `"${r}"`).join(", ")}] as const;\n`;

const FAKE = {
	workReport: fakeWorkReport(
		["working", "waiting", "stalled", "ended"],
		[
			["engine_limit", "the limit has to reset", "resume"],
			["human", "it is waiting for YOU", "give_up"],
		],
	),
	loopStore: fakeLoopStore(["engine_limit", "human"]),
};

/** Render the regions a source pair implies, and paste them into a page. What a correct page
 *  looks like is therefore never typed out here — which is the property under test. */
const pageFor = ({ workReport, loopStore }, mutate = (s) => s) => {
	const regions = renderRegions({
		healthStates: parseConstArray(workReport, "RUN_HEALTH_STATES").members,
		waitReasons: parseConstArray(loopStore, "RUN_WAIT_REASONS").members,
		parks: parseParks(workReport).parks,
	});
	return mutate(`# Run lifecycle\n\n${regions["run-health"]}\n\nprose\n\n${regions["run-wait-reasons"]}\n`);
};

const run = (input, doc) => checkRunLifecycle({ ...input, doc, docName: "platform-docs/run-lifecycle.md" });
const messages = (r) => r.failures.map((f) => f.message).join("\n");

describe("parseConstArray", () => {
	it("reads the members of the real declarations", () => {
		expect(parseConstArray(WORK_REPORT, "RUN_HEALTH_STATES").members).toEqual(["working", "waiting", "stalled", "ended"]);
		expect(parseConstArray(LOOP_STORE, "RUN_WAIT_REASONS").members).toEqual(["engine_limit", "human", "platform_interrupt"]);
	});

	it("reports a RESHAPED declaration rather than returning an empty set (ADR 0002 G3)", () => {
		// The failure that matters is not "the enum is empty" — it is "this is no longer an array".
		// Both would render an empty block, and an empty block matches an empty block, so a silent
		// [] here is a guard that passes by checking nothing.
		for (const reshaped of [
			"export type RunHealth = 'working' | 'waiting' | 'stalled' | 'ended';",
			"export enum RunHealth { working, waiting }",
			"export const RUN_HEALTH_STATES = Object.keys(PARKS) as const;",
		]) {
			const { members, error } = parseConstArray(reshaped, "RUN_HEALTH_STATES");
			expect(members).toEqual([]);
			expect(error, `no error reported for: ${reshaped}`).toMatch(/shape moved|no `export const/);
		}
	});
});

describe("parseParks", () => {
	it("reads every reason's why and deadline kind from the real table", () => {
		const { parks, error } = parseParks(WORK_REPORT);
		expect(error).toBeNull();
		// The kinds are the load-bearing half: they license opposite actions from the owner (#596).
		expect(parks.engine_limit.deadline).toBe("resume");
		expect(parks.platform_interrupt.deadline).toBe("resume");
		expect(parks.human.deadline).toBe("give_up");
	});

	it("reports a missing table instead of rendering a verbless page", () => {
		const { parks, error } = parseParks("const OTHER = {};");
		expect(parks).toEqual({});
		expect(error).toMatch(/PARKS/);
	});
});

describe("renderRegions", () => {
	it("renders the COUNT, because a hand-written size is what went stale at #588", () => {
		const three = renderRegions({ healthStates: ["working", "waiting", "stalled"], waitReasons: [], parks: {} });
		const four = renderRegions({ healthStates: ["working", "waiting", "stalled", "ended"], waitReasons: [], parks: {} });
		expect(three["run-health"]).toContain("**3** values");
		expect(four["run-health"]).toContain("**4** values");
		// The exact drift this page exists to avoid: the sentence that said "three values" after
		// `ended` arrived. It cannot be written here, because nobody writes it.
		expect(four["run-health"]).not.toContain("**3**");
	});

	it("gives a give-up deadline a different VERB from a resume one", () => {
		const { "run-wait-reasons": table } = renderRegions({
			healthStates: [],
			waitReasons: ["engine_limit", "human"],
			parks: { engine_limit: { why: "a", deadline: "resume" }, human: { why: "b", deadline: "give_up" } },
		});
		expect(table).toMatch(/`engine_limit` \| a \| \*\*resumes\*\*/);
		expect(table).toMatch(/`human` \| b \| \*\*gives up\*\*/);
		// #596's whole finding: a human handoff's deadline must never be rendered as a resume time.
		expect(table.split("\n").find((l) => l.includes("`human`"))).not.toMatch(/resumes/);
	});

	it("marks an unrecognised deadline kind as unknown rather than guessing a verb", () => {
		const { "run-wait-reasons": table } = renderRegions({
			healthStates: [],
			waitReasons: ["novel"],
			parks: { novel: { why: "x", deadline: "someday" } },
		});
		expect(table).toContain("unknown kind");
		expect(table).not.toMatch(/resumes|gives up/);
	});
});

describe("checkRunLifecycle", () => {
	it("passes when the page holds exactly what the code renders", () => {
		expect(run(FAKE, pageFor(FAKE)).failures).toEqual([]);
	});

	it("goes RED when a state is added to the enum and the page still lists the old set", () => {
		// The scenario in full: the page was correct, someone adds a fifth health state, and
		// nothing else changes. This is the drift #601 exists to prevent.
		const stale = pageFor(FAKE);
		const grown = { ...FAKE, workReport: fakeWorkReport(["working", "waiting", "stalled", "ended", "abandoned"], [["engine_limit", "the limit has to reset", "resume"], ["human", "it is waiting for YOU", "give_up"]]) };
		const r = run(grown, stale);
		expect(r.failures).toHaveLength(1);
		expect(messages(r)).toContain("**5** values");
		expect(messages(r)).toContain("abandoned");
	});

	it("goes RED when a park's deadline kind flips, even though the reason set is unchanged", () => {
		// The kind is not cosmetic — flipping `human` to a resume is exactly the claim #596 removed,
		// and a set-membership check would not notice it.
		const flipped = {
			...FAKE,
			workReport: fakeWorkReport(
				["working", "waiting", "stalled", "ended"],
				[
					["engine_limit", "the limit has to reset", "resume"],
					["human", "it is waiting for YOU", "resume"],
				],
			),
		};
		const r = run(flipped, pageFor(FAKE));
		expect(r.failures).toHaveLength(1);
		expect(messages(r)).toMatch(/gives up|resumes/);
	});

	it("goes RED when the generated region is missing entirely", () => {
		const r = run(FAKE, "# Run lifecycle\n\nAll prose, no generated region.\n");
		expect(r.failures).toHaveLength(2);
		expect(messages(r)).toContain("has no `generated:run-health` region");
	});

	it("goes RED when the page does not exist at all", () => {
		expect(run(FAKE, null).failures).toHaveLength(1);
	});

	it("fails on a parser that matched nothing, instead of comparing empty to empty (ADR 0002 G1)", () => {
		// Without the floor this is the #604 collapse in miniature: the renderer emits an empty
		// value set, the page holds an empty value set, and the two agree perfectly about nothing.
		const r = run({ ...FAKE, loopStore: fakeLoopStore(["human"]) }, pageFor(FAKE));
		expect(messages(r)).toContain("parsed 1 RUN_WAIT_REASONS member(s), expected at least 2");
	});

	it("fails when a park reason has no PARKS row, rather than documenting a guessed verb", () => {
		const r = run({ ...FAKE, loopStore: fakeLoopStore(["engine_limit", "human", "platform_interrupt"]) }, pageFor(FAKE));
		expect(messages(r)).toContain("platform_interrupt");
		expect(messages(r)).toContain("no PARKS row");
	});

	it("fails when PARKS carries a row for a reason the array does not list", () => {
		const orphaned = {
			...FAKE,
			workReport: fakeWorkReport(
				["working", "waiting", "stalled", "ended"],
				[
					["engine_limit", "a", "resume"],
					["human", "b", "give_up"],
					["ghost", "c", "resume"],
				],
			),
		};
		expect(messages(run(orphaned, pageFor(FAKE)))).toContain("ghost");
	});

	it("withholds the denominator when the check FAILED, so one run cannot print a ✓ and a ✗ about it", () => {
		// Caught by running the real gate against a drifted page: the success line printed beside
		// the failure, which reads as "mostly fine" about a check that did not pass.
		const r = run(FAKE, "# Run lifecycle\n\nnothing generated here.\n");
		expect(r.failures.length).toBeGreaterThan(0);
		expect(r.notes).toEqual([]);
	});

	it("states its denominator on success (ADR 0002 G2)", () => {
		expect(run(FAKE, pageFor(FAKE)).notes[0]).toBe(
			"run lifecycle: 2 generated region(s) in platform-docs/run-lifecycle.md == 4 health state(s) + 2 park reason(s) (2 deadline kind(s)) from 2 code file(s)",
		);
	});

	it("the PUBLISHED page agrees with the real enums", () => {
		const r = checkRunLifecycle({
			workReport: WORK_REPORT,
			loopStore: LOOP_STORE,
			doc: DOC,
			docName: "platform-docs/run-lifecycle.md",
		});
		expect(messages(r)).toBe("");
		expect(r.notes[0]).toContain("4 health state(s) + 3 park reason(s) (2 deadline kind(s))");
	});
});
