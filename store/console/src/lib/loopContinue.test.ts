/**
 * Which ended runs offer Continue (#806), and the one assertion that is not about this file.
 *
 * The last test reads the WORKER's own `RESUMABLE_STOP_REASONS` and requires the two lists to
 * match. The module header explains why a copy is acceptable and which direction of drift is
 * survivable; this is what keeps the drift from happening silently anyway. It is a source read
 * rather than an import because the console and the worker are separate builds — importing worker
 * code into a console test would bring `Env` and the D1 types with it.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { canContinueRun, CONTINUABLE_STOP_REASONS, continueBody, previewLines, type ContinuePreview } from "./loopContinue";

describe("canContinueRun", () => {
	it.each(["interrupted", "max_iterations", "engine_limit", "provider_credit"])("offers Continue after %s", (stopReason) => {
		expect(canContinueRun({ status: "failed", stopReason })).toBe(true);
	});

	it.each(["done", "failed", "cancelled", "escalated", "no_progress", "budget"])("does not offer it after %s", (stopReason) => {
		expect(canContinueRun({ status: "failed", stopReason })).toBe(false);
	});

	it("never offers it on a run that is still going", () => {
		// Belt and braces: a running run carries no stop reason today, but a Continue button
		// underneath a live Stop button is the one outcome that must be impossible by construction.
		expect(canContinueRun({ status: "running", stopReason: null })).toBe(false);
		expect(canContinueRun({ status: "running", stopReason: "max_iterations" })).toBe(false);
	});

	it("says no to a run it knows nothing about", () => {
		expect(canContinueRun(null)).toBe(false);
		expect(canContinueRun(undefined)).toBe(false);
		expect(canContinueRun({ status: "failed" })).toBe(false);
	});
});

describe("the copy of the server's list", () => {
	it("matches RESUMABLE_STOP_REASONS in the API worker", () => {
		const source = readFileSync(new URL("../../../../workers/api/src/lib/agent-loop-store.ts", import.meta.url).pathname, "utf8");
		const declared = /export const RESUMABLE_STOP_REASONS = \[([^\]]*)\]/.exec(source);
		expect(declared).not.toBeNull();
		const server = [...(declared as RegExpExecArray)[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
		expect(server.length).toBeGreaterThan(0);
		expect([...CONTINUABLE_STOP_REASONS]).toEqual(server);
	});
});

/**
 * What the review panel puts on screen (#806 item 2).
 *
 * The assertion that matters most is the NEGATIVE one: the headline is the server's sentence and
 * this module must never compose its own. Two places phrasing "what carries forward" is how the
 * page comes to promise work the run then re-does — #806's own complaint, arrived at from the
 * other direction.
 */
const preview = (over: Partial<ContinuePreview> = {}, briefing: Partial<ContinuePreview["briefing"]> = {}): ContinuePreview => ({
	runId: "run-1",
	canContinue: true,
	refusal: null,
	maxIterations: 20,
	summary: "The new run would be told what this run left behind — 2 actions already landed.",
	...over,
	briefing: {
		kind: "this-run",
		predecessorRunId: "run-1",
		landed: ["pushed 3 commits to main", "opened PR #12"],
		landedOverflow: 0,
		unobserved: 0,
		uncommittedFiles: 0,
		workingTree: "read",
		caveat: null,
		note: "PLATFORM NOTE …",
		...briefing,
	},
});

describe("previewLines — the panel behind the Continue button", () => {
	it("leads with the SERVER's sentence, verbatim", () => {
		const p = preview();
		expect(previewLines(p)[0]).toBe(p.summary);
	});

	it("lists the landed actions so the headline's count can be checked, not just taken", () => {
		expect(previewLines(preview())).toEqual(
			expect.arrayContaining(["· pushed 3 commits to main", "· opened PR #12"]),
		);
	});

	it("says how many more there were rather than silently truncating", () => {
		expect(previewLines(preview({}, { landedOverflow: 7 }))).toContain("· …and 7 more");
	});

	it("shows the unreadable-tree caveat, which is the difference between a promise and a guess", () => {
		const lines = previewLines(preview({}, { workingTree: "unavailable", uncommittedFiles: null, caveat: "could not read the tree" }));
		expect(lines).toContain("could not read the tree");
	});

	it("names the ceiling the button would spend", () => {
		expect(previewLines(preview({ maxIterations: 40 }))).toContain("Continuing would give the new run up to 40 steps.");
	});

	it("omits the ceiling on a run that cannot be continued — it describes nothing there", () => {
		const lines = previewLines(preview({ canContinue: false, refusal: "that run finished its objective" }));
		expect(lines.some((l) => l.includes("would give the new run up to"))).toBe(false);
		expect(lines).toContain("This run cannot be continued: that run finished its objective");
	});

	it("renders the nothing-carries-forward case without inventing reassurance", () => {
		// The decision-changing state: Continue here is a restart on a fresh budget. The panel must
		// pass that through rather than soften it, and it must not list acts it does not have.
		const lines = previewLines(
			preview(
				{ summary: "Nothing carries forward: the new run would start from the objective alone and whatever is in the repository." },
				{ kind: "none", predecessorRunId: null, landed: [], note: null },
			),
		);
		expect(lines[0]).toMatch(/^Nothing carries forward/);
		expect(lines.some((l) => l.startsWith("·"))).toBe(false);
	});

	it("never composes a headline of its own — every summary reaches the panel unchanged", () => {
		// Mutation guard: if someone replaces the first line with a locally built sentence, an
		// arbitrary server string stops appearing and this goes red.
		for (const summary of ["anything at all", "Nothing carries forward: …", ""]) {
			expect(previewLines(preview({ summary }))[0]).toBe(summary);
		}
	});
});

describe("what the stopped run had worked out, and what the owner adds (#806 items 2 and 3(b))", () => {
	it("quotes the run's own notes, attributed — never listed bare beside the landed acts", () => {
		const lines = previewLines(preview({}, { learned: ["Fix written. Next: rebase and push."] }));
		const at = lines.indexOf("What the run noted to itself as it worked — its own words, not checked:");
		expect(at).toBeGreaterThan(0);
		expect(lines[at + 1]).toBe("“Fix written. Next: rebase and push.”");
		expect(lines).not.toContain("· Fix written. Next: rebase and push.");
	});

	it("says nothing about notes when there are none, or when an older API omits the field", () => {
		expect(previewLines(preview({}, { learned: [] })).join("\n")).not.toContain("noted to itself");
		expect(previewLines(preview()).join("\n")).not.toContain("noted to itself");
	});

	it("sends an EMPTY body unless the owner actually typed something", () => {
		expect(continueBody(undefined)).toEqual({});
		expect(continueBody("  \n ")).toEqual({});
		expect(continueBody("  rebase first \n")).toEqual({ note: "rebase first" });
	});
});
