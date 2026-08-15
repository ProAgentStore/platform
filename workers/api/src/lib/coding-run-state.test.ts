import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	CODING_RUN_STATES,
	ENGINE_RUN_STATES,
	isEngineRunState,
	refusingEngineIssue,
	resolveRunState,
} from "./coding-run-state.js";

describe("resolveRunState — three worlds that used to be one answer (#593)", () => {
	it("does not collapse an absent runner into an idle engine", () => {
		// `routes/coding.ts:234` answered `idle` here. Nobody looked at an engine on this path.
		expect(resolveRunState({ sessionActive: true, runnerConnected: false })).toBe("offline");
	});

	it("does not collapse a failed probe into an idle engine", () => {
		// `routes/coding.ts:240` answered `idle` here too — runner connected, no snapshot back.
		expect(resolveRunState({ sessionActive: true, runnerConnected: true })).toBe("unknown");
		expect(resolveRunState({ sessionActive: true, runnerConnected: true, engineRunState: null })).toBe("unknown");
	});

	it("reports an ended session as ended, whatever a stale snapshot says", () => {
		expect(resolveRunState({ sessionActive: false, runnerConnected: true, engineRunState: "thinking" })).toBe("ended");
	});

	it("passes through the engine's own three words, and only those", () => {
		for (const s of ENGINE_RUN_STATES) {
			expect(resolveRunState({ sessionActive: true, runnerConnected: true, engineRunState: s })).toBe(s);
		}
	});

	it("turns a word no engine can emit into `unknown`, never `idle`", () => {
		// `working` is the value the MCP description advertised for six weeks. If a runner ever sent
		// it, passing it through would make the advertised vocabulary true by accident.
		expect(resolveRunState({ sessionActive: true, runnerConnected: true, engineRunState: "working" })).toBe("unknown");
		expect(isEngineRunState("working")).toBe(false);
	});

	it("agrees with the runner's own union, derived from its source", () => {
		// The engine half of this vocabulary is a COPY of `CodingSnapshot.runState`. Derived from
		// the runner's source rather than restated, so the two cannot drift apart silently.
		const src = readFileSync(
			join(import.meta.dirname, "../../../../packages/browser-runner/src/coding/runtime.ts"),
			"utf8",
		);
		const m = src.match(/runState:\s*((?:"[a-z]+"\s*\|?\s*)+)/);
		expect(m, "could not find CodingSnapshot.runState in the runner source — the guard stopped measuring").toBeTruthy();
		const union = [...(m?.[1] ?? "").matchAll(/"([a-z]+)"/g)].map((x) => x[1]);
		expect(union.length, "parsed no members from the runner's union").toBeGreaterThanOrEqual(3);
		expect([...ENGINE_RUN_STATES].sort()).toEqual([...union].sort());
		expect(union).not.toContain("working");
	});

	it("publishes exactly six states", () => {
		expect([...CODING_RUN_STATES]).toEqual(["idle", "thinking", "responding", "ended", "offline", "unknown"]);
	});
});

describe("refusingEngineIssue — an engine that is up but refusing is an issue (#593)", () => {
	const live = {
		sessionLabel: "c306e923 (platform)",
		alive: true,
		run: {
			status: "needs_human",
			waitingReason: "engine_limit",
			detail: "the limit does not reset until 2026-08-17 16:00 +10:00, which is beyond the 6 hours a run may wait",
		},
	};

	it("reports the live bd43f4de case, which scored issueCount: 0", () => {
		// Measured: `healthySessions: 1, issueCount: 0, issues: [], live.alive: true,
		// runState: "idle"` — while the pane's last two lines were "You've hit your weekly limit ·
		// resets Aug 17 at 4pm" and "[error]". Every rule in the route fires on a runner or relay
		// fault, so the engine being up and refusing was invisible.
		const issue = refusingEngineIssue(live);
		expect(issue, "a refusing engine must not yield zero issues").not.toBeNull();
		expect(issue?.message).toContain("up but not working");
		expect(issue?.message).toContain("usage limit");
	});

	it("carries the run's own reason, so the issue says WHY", () => {
		expect(refusingEngineIssue(live)?.message).toContain("2026-08-17");
		expect(refusingEngineIssue(live)?.fix).toContain("another CLI engine");
	});

	it("says nothing about a session that is genuinely working", () => {
		// The other half of the bar: a guard that fires on everything is as useless as one that
		// fires on nothing.
		expect(refusingEngineIssue({ sessionLabel: "s", alive: true, run: { status: "running", waitingReason: "", detail: "" } })).toBeNull();
	});

	it("says nothing when there is no run behind the session", () => {
		// A hand-driven engine has no loop run, and inventing a verdict for it would be a guess.
		expect(refusingEngineIssue({ sessionLabel: "s", alive: true, run: null })).toBeNull();
		expect(refusingEngineIssue({ sessionLabel: "s", alive: true, run: undefined })).toBeNull();
	});

	it("reports a human handoff as a warning, and a platform interrupt as info", () => {
		const human = refusingEngineIssue({ sessionLabel: "s", alive: true, run: { status: "needs_human", waitingReason: "human", detail: "takeover requested" } });
		expect(human?.severity).toBe("warn");
		expect(human?.message).toContain("waiting for a person");
		const interrupt = refusingEngineIssue({ sessionLabel: "s", alive: true, run: { status: "running", waitingReason: "platform_interrupt", detail: "" } });
		// Being resumed after our OWN deploy is not the owner's problem to fix.
		expect(interrupt?.severity).toBe("info");
	});

	it("still reports a park whose reason nothing recognises", () => {
		// A new `RunWaitReason` must not become invisible by being new.
		const issue = refusingEngineIssue({ sessionLabel: "s", alive: true, run: { status: "running", waitingReason: "some_new_reason", detail: "" } });
		expect(issue).not.toBeNull();
		expect(issue?.message).toContain("some_new_reason");
	});

	it("a parked run whose engine is NOT alive is still reported, worded honestly", () => {
		const issue = refusingEngineIssue({ sessionLabel: "s", alive: false, run: { status: "needs_human", waitingReason: "engine_limit", detail: "" } });
		expect(issue?.message).toContain("the engine is not running");
	});
});
