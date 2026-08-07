import { describe, expect, it } from "vitest";
import {
	issueWasHandled,
	loopOutcomeNotice,
	loopRunEnded,
	loopStartFailureNotice,
	loopStartNotice,
} from "./coding-loop-run";

describe("loopRunEnded", () => {
	it("treats every status but `running` as terminal", () => {
		// The watcher's only stopping condition. Enumerating the terminal ones instead would need
		// this file to be updated every time `statusFor` grows a value, and the failure mode of
		// missing one is a watcher that polls a finished run forever.
		expect(loopRunEnded({ status: "running" })).toBe(false);
		for (const s of ["completed", "failed", "needs_human", "cancelled"]) {
			expect(loopRunEnded({ status: s })).toBe(true);
		}
	});
});

describe("loopOutcomeNotice", () => {
	it("says complete only for a clean finish", () => {
		expect(loopOutcomeNotice({ status: "completed", stopReason: "done", detail: "suite is green" })).toBe(
			"Loop complete: suite is green",
		);
	});

	it("names the stop REASON, not the status", () => {
		// `failed` and `max_iterations` both carry status `failed`. Reporting the status would tell
		// someone their objective was impossible when it merely ran out of steps — two different
		// things to do next.
		expect(loopOutcomeNotice({ status: "failed", stopReason: "max_iterations", detail: "gave up after 10 steps" })).toContain(
			"max_iterations",
		);
		expect(loopOutcomeNotice({ status: "failed", stopReason: "budget", detail: "hit its spend limit" })).toContain("budget");
	});

	it("falls back to the status when the server reports no reason", () => {
		expect(loopOutcomeNotice({ status: "cancelled" })).toBe("Loop stopped (cancelled).");
	});

	it("never trails a bare colon when there is no detail", () => {
		// The shape the old code produced: `Loop complete: ${reason || ""}`, which printed
		// "Loop complete:" with nothing after it whenever the reason was empty.
		expect(loopOutcomeNotice({ status: "completed", stopReason: "done" })).toBe("Loop complete.");
		expect(loopOutcomeNotice({ status: "completed", stopReason: "done", detail: "   " })).toBe("Loop complete.");
	});
});

describe("issueWasHandled — issues-mode only strikes an issue off on a clean finish", () => {
	it("advances on done", () => {
		expect(issueWasHandled({ status: "completed", stopReason: "done" })).toBe(true);
	});

	it("keeps the issue open for every other ending", () => {
		// The browser loop advanced on `done` and kept the issue on escalate/failed so you could
		// retry it. The run-row vocabulary has MORE ways to not-finish than `/loop-decide` did, and
		// every one of them is a run that touched the issue without resolving it. Striking it off
		// would walk the backlog leaving half-done work behind — with the branch still checked out.
		for (const reason of ["failed", "escalated", "max_iterations", "budget", "no_progress", "cancelled"]) {
			expect(issueWasHandled({ status: "failed", stopReason: reason })).toBe(false);
		}
		expect(issueWasHandled({ status: "failed" })).toBe(false);
	});
});

describe("loopStartNotice", () => {
	it("says the run survives the tab, which is the whole change", () => {
		const msg = loopStartNotice({ driver: "coding", objective: "get the suite green", maxIterations: 10 });
		expect(msg).toContain("get the suite green");
		expect(msg).toContain("close this tab");
		expect(msg).toContain("10");
	});

	it("warns when the Loop is NOT going to drive the engine", () => {
		// Reachable on this tab only if the agent declares no CODING_SESSION workflow, in which
		// case `loopDriverFor` falls back to the chat loop — and the terminal the user is watching
		// never moves. Silence here is indistinguishable from a broken button.
		expect(loopStartNotice({ driver: "chat", objective: "x", maxIterations: 5 })).toMatch(/chat rather than the engine/i);
	});

	it("assumes the engine when the server did not say", () => {
		// An older API that answers no `driver` must not produce a warning about a dispatch nobody
		// reported — on this tab the coding driver is overwhelmingly what ran.
		expect(loopStartNotice({ objective: "x", maxIterations: 5 })).not.toMatch(/chat rather than/i);
	});

	it("truncates a long objective rather than pasting a whole issue body into the thread", () => {
		const long = "a".repeat(500);
		const msg = loopStartNotice({ driver: "coding", objective: long, maxIterations: 10 });
		expect(msg).toContain("…");
		expect(msg).not.toContain("a".repeat(200));
	});
});

describe("loopStartFailureNotice", () => {
	it("carries the server's refusal verbatim", () => {
		// The refusals that reach here are the ones worth reading: the driver claim ("already being
		// worked on"), the runner diagnosis, and the repo check — each names what to do next.
		expect(loopStartFailureNotice(new Error("fws/platform is already being worked on"))).toContain(
			"already being worked on",
		);
		expect(loopStartFailureNotice("boom")).toContain("boom");
	});
});
