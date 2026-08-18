import { describe, expect, it } from "vitest";
import { writeEnforcementReport } from "./coding-write-enforcement.js";

/**
 * #679/#676. `coding_diagnostics` answered with the constant `"acts-observed-halt"` and a note
 * saying the first wrong-repo write still LANDS. The `gh` guard makes that partly false — but only
 * on a machine whose runner actually carries it, which the cloud cannot know and must not assume.
 */
const GAPS = ["`git push` is not gated — ssh.", "A PATH shim is bypassable.", "`gh api graphql` is not classified."];
const guarded = { ghGuard: { installed: true, scope: ["proagentstore/platform"], gaps: GAPS } };

describe("writeEnforcementReport", () => {
	it("says `none` when no repository has GitHub coordinates", () => {
		expect(writeEnforcementReport([], [guarded]).enforcement).toBe("none");
	});

	it("keeps the OLD sentence, verbatim, for a machine that reported no guard", () => {
		// A runner published before #679 answers `/coding/diagnostics` with no `ghGuard` field at
		// all, and on the day this ships that is the single most likely state. Reporting the cloud's
		// intent there would tell that owner his writes are gated when nothing is gating them.
		const r = writeEnforcementReport(["ProAgentStore/platform"], [{}]);
		expect(r.enforcement).toBe("acts-observed-halt");
		expect(r.enforcementNote).toContain("The first such write still LANDS");
		expect(r.enforcementNote).toContain("runner predates the guard");
		expect(r.ghGuard).toMatchObject({ sessionsGuarded: 0, sessionsTracked: 1 });
	});

	it("names WHY a session is unguarded, in words the owner can act on", () => {
		const r = writeEnforcementReport(["o/r"], [{ ghGuard: { installed: false, reason: "gh-not-found", gaps: GAPS } }]);
		expect(r.ghGuard.reasons.join(" ")).toContain("`gh` is not installed");
	});

	it("reports the guard once EVERY live session confirmed it — and still names what it misses", () => {
		const r = writeEnforcementReport(["ProAgentStore/platform"], [guarded, guarded]);
		expect(r.enforcement).toBe("gh-guard+acts-observed-halt");
		expect(r.enforcementNote).toContain("REFUSED before it runs");
		// The half that makes this honest rather than a marketing string. A gate that claims more
		// than it does is worse than no gate: an owner reading "writeScope: [x]" must not conclude
		// a write to anything else is impossible.
		expect(r.enforcementNote).toContain("still detected from the act stream");
		expect(r.enforcementNote).toContain("git push");
		expect(r.enforcementNote).toContain("bypassable");
		expect(r.enforcementNote).toContain("graphql");
		expect(r.ghGuard).toMatchObject({ sessionsGuarded: 2, sessionsTracked: 2 });
	});

	it("does NOT claim full coverage when only some sessions are guarded", () => {
		// The state a machine switch produces: one session started by a new CLI, one relaunched by
		// an old one. Rounding that up to "guarded" is the exact overstatement this module exists
		// to prevent.
		const r = writeEnforcementReport(["ProAgentStore/platform"], [guarded, {}]);
		expect(r.enforcement).toBe("gh-guard-partial+acts-observed-halt");
		expect(r.enforcementNote).toContain("1 of 2 live session");
		expect(r.enforcementNote).toContain("predates the guard");
	});

	it("carries the runner's OWN gap list rather than restating it", () => {
		// Two lists of what is still possible, in two repos, is how one of them goes stale while
		// still being displayed.
		expect(writeEnforcementReport(["o/r"], [guarded]).ghGuard.gaps).toEqual(GAPS);
	});
});
