import { describe, expect, it } from "vitest";
import { filterReposByInstance, openConversationText, repoLabel, resolveRepoForOpen } from "./coding-tools.js";

// What an MCP caller is TOLD when it opens a repo's conversation (#696, and #693's fourth outcome).
//
// The sentences here are the whole product of `openConversation`: an MCP client gets prose, not a
// status object, so a wrong sentence is a wrong answer with nothing behind it to check. The rule
// this file holds is the one #696 stated — the console and MCP must not tell one user two different
// stories about the same open — and the rule ADR 0005 added on top of it: a reconstruction is never
// described as a memory.

const OPEN = { session: { id: "csess_1" }, runnerConnected: true };
const RESUME_REASON = "the previous conversation on this repo was last touched 3 hours ago";
const FRESH_REASON = "the previous conversation on this repo was last touched 9 days ago";

describe("openConversationText — the decision, the outcome, and which is which", () => {
	it("claims a continued conversation only when the runner confirmed one", () => {
		// `mode: "resume"` is what the CLOUD asked for. A runner published before #408 drops the
		// request and starts clean, so reporting the intent would answer "do you remember what we
		// were doing?" confidently and wrongly.
		const confirmed = openConversationText("chess-academy", { ...OPEN, continuity: { mode: "resume", reason: RESUME_REASON }, resumed: true });
		expect(confirmed).toMatch(/^Continuing this repo's previous conversation on chess-academy/);

		const unconfirmed = openConversationText("chess-academy", { ...OPEN, continuity: { mode: "resume", reason: RESUME_REASON } });
		expect(unconfirmed).toMatch(/did not confirm/);
		expect(unconfirmed).not.toMatch(/^Continuing/);
	});

	it("quotes the server's reason verbatim instead of phrasing a second one", () => {
		// The route already composes the sentence, and the console renders that same string. A
		// re-derivation here is how the two surfaces start disagreeing about one event.
		expect(openConversationText("r", { ...OPEN, continuity: { mode: "fresh", reason: FRESH_REASON } })).toContain(FRESH_REASON);
	});

	it("says the engine was BRIEFED when the machine confirmed it, and never that it remembers", () => {
		// ADR 0005's fourth outcome and its one prohibited claim. An MCP caller is usually another
		// model, which will paraphrase this to a human — so "reconstructed" has to survive the
		// paraphrase, and "remembers" must never be available to it in the first place.
		const t = openConversationText("r", { ...OPEN, continuity: { mode: "fresh", reason: FRESH_REASON }, seeded: true });
		expect(t).toMatch(/reconstructed from the platform's record/);
		expect(t).toMatch(/not the details/);
		expect(t).not.toMatch(/remember|as if it never/i);
		// The fresh start is still reported. A brief softens the gap; it does not close it, and a
		// caller that reads only the brief will not re-state what the engine is missing.
		expect(t).toMatch(/Started a fresh conversation/);
	});

	it("reports the brief on an unhonoured RESUME too — that is the case it exists for", () => {
		// #694: the cloud asked to continue, the machine could not (the resume key is a file on the
		// laptop the session left) and took the brief instead. Both facts are true and both belong.
		const t = openConversationText("r", { ...OPEN, continuity: { mode: "resume", reason: RESUME_REASON }, resumed: false, seeded: true });
		expect(t).toMatch(/did not confirm/);
		expect(t).toMatch(/reconstructed from the platform's record/);
	});

	it("mentions no brief when a confirmed resume made one unnecessary", () => {
		// The runner only reaches for the brief when it has no conversation, so the two outcomes are
		// mutually exclusive. Saying both would describe an engine that holds its own history and a
		// summary of the same history.
		const t = openConversationText("r", { ...OPEN, continuity: { mode: "resume", reason: RESUME_REASON }, resumed: true, seeded: true });
		expect(t).not.toMatch(/reconstructed/);
	});

	it("says the continuity is UNKNOWN rather than guessing, when the server reported none", () => {
		expect(openConversationText("r", OPEN)).toMatch(/no continuity decision/);
	});

	it("leads with the runner diagnosis when nothing is connected", () => {
		const t = openConversationText("r", { ...OPEN, runnerConnected: false, continuity: { mode: "fresh", reason: FRESH_REASON } });
		expect(t).toMatch(/pags up/);
	});

	it("does not report a decision on a REUSE — it is the conversation it is reusing", () => {
		const t = openConversationText("r", { ...OPEN, reused: true, notice: "reusing the `claude` engine already running." });
		expect(t).toMatch(/^Already talking to r/);
		expect(t).not.toMatch(/fresh conversation|Continuing/);
	});

	it("reports the brief on a REUSE, which is what a relocated session answers with (#738)", () => {
		// The third of the three surfaces #694 claimed reported a briefed engine. `brief` used to be
		// appended only inside the two `continuity` branches, so the two answers a re-attached
		// session actually produces — "reused" and "no continuity decision" — were exactly the two
		// that dropped it. A relocated session produces both, so the surface was silent on the one
		// path the brief exists for.
		//
		// "Already talking to r" is true of the session id and false of the engine. The brief is
		// what keeps the caller from reading the first as the second.
		const t = openConversationText("r", { ...OPEN, reused: true, notice: "reusing the `claude` engine already running.", seeded: true });
		expect(t).toMatch(/^Already talking to r/);
		expect(t).toMatch(/reconstructed from the platform's record/);
		expect(t).not.toMatch(/remember|as if it never/i);
		// Unchanged for an ordinary reuse: no brief, nothing said.
		expect(openConversationText("r", { ...OPEN, reused: true })).not.toMatch(/reconstructed/);
	});

	it("reports the brief when no decision was reported — the honest shape of a re-attach (#738)", () => {
		// A re-attach decides nothing, so "no continuity decision" is the correct answer rather than
		// a sign of an old API. `seeded` still answers the question the caller asked.
		const t = openConversationText("r", { ...OPEN, seeded: true });
		expect(t).toMatch(/no continuity decision/);
		expect(t).toMatch(/reconstructed from the platform's record/);
		expect(openConversationText("r", OPEN)).not.toMatch(/reconstructed/);
	});
});

describe("resolveRepoForOpen — a question beats a guess (#696)", () => {
	it("asks which repo rather than opening one the caller never named", () => {
		const out = resolveRepoForOpen([{ id: "r1", name: "chess" }, { id: "r2", name: "platform" }]);
		expect("ask" in out && out.ask).toMatch(/2 repos/);
	});

	it("takes the only repo, and the named one when there are several", () => {
		expect(resolveRepoForOpen([{ id: "r1" }])).toEqual({ repo: { id: "r1" } });
		expect(resolveRepoForOpen([{ id: "r1" }, { id: "r2" }], "r2")).toEqual({ repo: { id: "r2" } });
	});

	it("names an unknown repo id back rather than dropping it", () => {
		// The server owns the 404. Swallowing the id here would turn a clear "no such repo" into a
		// question about repos the caller did not ask about.
		expect(resolveRepoForOpen([{ id: "r1" }], "gone")).toEqual({ repo: { id: "gone" } });
	});

	it("says there is nothing attached when there is nothing attached", () => {
		const out = resolveRepoForOpen([]);
		expect("ask" in out && out.ask).toMatch(/coding_repo_add/);
	});

	it("labels a repo by name, falling back to its id rather than to nothing", () => {
		expect(repoLabel({ id: "r1", name: "chess" })).toBe("chess");
		expect(repoLabel({ id: "r1" })).toBe("r1");
	});
});

describe("filterReposByInstance — cross-instance contamination guard (#692)", () => {
	// The normal path: all repos carry the correct instanceId → all pass through.
	it("passes through repos whose instanceId matches the requested instance", () => {
		const repos = [
			{ id: "r1", instanceId: "inst-A" },
			{ id: "r2", instanceId: "inst-A" },
		];
		expect(filterReposByInstance(repos, "inst-A")).toEqual(repos);
	});

	// The transport mis-routing case: response for inst-B delivered to inst-A caller.
	// The filter catches this and returns empty rather than wrong repos.
	it("filters out repos whose instanceId belongs to a different instance", () => {
		const repos = [
			{ id: "r1", instanceId: "inst-B" },
			{ id: "r2", instanceId: "inst-B" },
		];
		expect(filterReposByInstance(repos, "inst-A")).toEqual([]);
	});

	// Mixed response (edge case: partial mis-routing).
	it("keeps only the repos that match, drops the rest", () => {
		const repos = [
			{ id: "r1", instanceId: "inst-A" },
			{ id: "r2", instanceId: "inst-B" },
		];
		expect(filterReposByInstance(repos, "inst-A")).toEqual([{ id: "r1", instanceId: "inst-A" }]);
	});

	// Defensive pass-through: older API versions or test fixtures without an instanceId field.
	it("passes through repos that have no instanceId field", () => {
		const repos = [{ id: "r1" }, { id: "r2" }];
		expect(filterReposByInstance(repos, "inst-A")).toEqual(repos);
	});

	// Empty input stays empty.
	it("returns empty for an empty repos array", () => {
		expect(filterReposByInstance([], "inst-A")).toEqual([]);
	});
});
