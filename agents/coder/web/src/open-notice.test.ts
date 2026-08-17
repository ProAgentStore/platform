import { describe, expect, it } from "vitest";
import { continuityNotice, openNotices } from "./open-notice";

/**
 * #697 — the platform decided whether it kept your conversation, phrased why, and rendered nothing.
 *
 * The reasons below are INVENTED fixtures, never copies of what `resolveSessionContinuity`
 * (`workers/api/src/lib/coding-session-continuity.ts`) currently emits. The design is that the
 * server owns the sentence and this module owns the opener it is concatenated after, so `reason` is
 * opaque text here — a string, of unknown wording, that must survive being passed through. Pinning
 * the server's literals in this file would make the two invariants one: #695 reworded four of those
 * branches (dropping "session" for "conversation"), and a test asserting the old wording would have
 * failed for a change that cannot break this module. The server's own suite guards its phrasing.
 */
describe("continuityNotice", () => {
	it("reads as reassurance on a resume, and stays quiet", () => {
		const n = continuityNotice({
			mode: "resume",
			resumeFrom: "csess_21b8d1b9",
			reason: "the previous conversation on this repo was last touched 11 hours ago",
		});
		expect(n?.text).toBe("Picking up where you left off — the previous conversation on this repo was last touched 11 hours ago.");
		// The expected case. Louder than this and the banner stops being read on the open that matters.
		expect(n?.tone).toBe("quiet");
	});

	it("warns on a fresh start, and carries whatever reason it was handed", () => {
		// Shapes, not the server's literals: a short clause, a long one, one with an em dash of its
		// own, one with a number. Whatever it is, it comes through unedited after the opener.
		for (const reason of [
			"you asked for a clean slate",
			"the previous conversation on this repo was last touched 6 days ago",
			"the runner reported a different engine — the old one is gone",
			"nothing earlier on this repo could be continued",
		]) {
			const n = continuityNotice({ mode: "fresh", resumeFrom: null, reason });
			expect(n?.text).toBe(`Started a fresh conversation — ${reason}.`);
			expect(n?.tone).toBe("warn");
		}
	});

	it("never says 'session' in the half it writes itself (#257, #408, #695)", () => {
		// The opener is the only wording this module owns, and #695 finished removing the noun from
		// the coding surface. Asserted with the reason absent, so what is measured is our prose and
		// not the server's — a reason IS rendered verbatim, and policing someone else's string here
		// would be this file claiming an invariant it cannot keep.
		expect(continuityNotice({ mode: "resume", reason: "" })?.text).not.toMatch(/session/i);
		expect(continuityNotice({ mode: "fresh", reason: "" })?.text).not.toMatch(/session/i);
	});

	it("says nothing rather than half a sentence when the block is missing or malformed", () => {
		// An older API, the reuse path, and the create-race loser all answer without `continuity`.
		expect(continuityNotice(undefined)).toBeNull();
		expect(continuityNotice(null)).toBeNull();
		expect(continuityNotice("resume")).toBeNull();
		// A mode nobody phrased an opener for cannot be rendered by guessing one.
		expect(continuityNotice({ mode: "sideways", reason: "who knows" })).toBeNull();
		expect(continuityNotice({ reason: "the previous conversation was last touched 2 hours ago" })).toBeNull();
	});

	it("keeps the headline when the reason is missing, and drops the dangling dash", () => {
		// The server contract forbids an empty reason; a client that trusted it would render
		// "Started a fresh conversation — ." the first time something else did.
		expect(continuityNotice({ mode: "fresh", resumeFrom: null })?.text).toBe("Started a fresh conversation.");
		expect(continuityNotice({ mode: "resume", reason: "   " })?.text).toBe("Picking up where you left off.");
		expect(continuityNotice({ mode: "fresh", reason: 42 })?.text).toBe("Started a fresh conversation.");
	});
});

describe("openNotices", () => {
	// A stand-in for the #549 notice, not a copy of it: `coding-session-lifecycle.ts` owns that
	// wording and is free to change it. All this module promises is that whatever arrives in
	// `notice` is passed through as its own banner, ahead of the continuity one.
	const REUSED = "platform is reusing the `claude` engine that is already running, not codex.";

	it("shows both when an open produces both, engine first, neither clobbering the other", () => {
		const out = openNotices({ notice: REUSED, continuity: { mode: "fresh", reason: "you asked for a clean slate" } });
		expect(out.map((n) => n.id)).toEqual(["inst-coding-reused-engine", "inst-coding-continuity"]);
		expect(out[0].text).toBe(REUSED);
		expect(out[1].text).toBe("Started a fresh conversation — you asked for a clean slate.");
	});

	it("carries the reuse notice alone on the path that has no continuity block", () => {
		// The live shape of a reuse: the route returns before a session is created.
		const reuse = { session: { id: "csess_1" }, runnerConnected: true, reused: true, notice: REUSED };
		expect(openNotices(reuse)).toEqual([
			{ id: "inst-coding-reused-engine", tone: "warn", text: REUSED },
		]);
	});

	it("carries the continuity notice alone on the create path", () => {
		const out = openNotices({ continuity: { mode: "resume", resumeFrom: "csess_1", reason: "the previous conversation on this repo was last touched 3 hours ago" } });
		expect(out).toHaveLength(1);
		expect(out[0].id).toBe("inst-coding-continuity");
	});

	it("says nothing about an open that changed nothing", () => {
		// A notice on every open is noise, and noise is not read.
		expect(openNotices({ notice: null, continuity: undefined })).toEqual([]);
		expect(openNotices({ notice: "   " })).toEqual([]);
		expect(openNotices(null)).toEqual([]);
		expect(openNotices(undefined)).toEqual([]);
	});
});
