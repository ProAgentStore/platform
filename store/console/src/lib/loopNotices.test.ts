import { describe, expect, it } from "vitest";
import { loopCompletionNotice, loopStartFailureNotice, loopStartNotice } from "./loopNotices";

describe("loopStartNotice", () => {
	it("says where the work will happen when the loop drives an engine, not this chat", () => {
		const text = loopStartNotice({ driver: "coding", objective: "fix the build", maxIterations: 8 });
		expect(text).toContain("**Coding** tab");
		expect(text).toContain("Up to 8 steps");
	});

	it("does not send a chat-driven loop looking for a Coding tab it does not have", () => {
		const text = loopStartNotice({ driver: null, objective: "summarise the inbox", maxIterations: 3 });
		expect(text).not.toContain("Coding");
		expect(text).toContain("summarise the inbox");
	});

	it("trims the objective — the composer's stray newline is not part of the goal", () => {
		expect(loopStartNotice({ objective: "  tidy up\n", maxIterations: 1 })).toContain("working on: tidy up\n\n");
	});
});

describe("loopStartFailureNotice", () => {
	it("reports the message of an Error and the value of anything else", () => {
		expect(loopStartFailureNotice(new Error("budget exhausted"))).toBe("Could not start the loop: budget exhausted");
		expect(loopStartFailureNotice("503")).toBe("Could not start the loop: 503");
	});
});

describe("loopCompletionNotice", () => {
	// Rule 1: the workflow writes the coding driver's outcome server-side, so it must survive the
	// tab closing — and a client-side line here would be the second copy of it in one thread.
	it("stays silent for the coding driver, which narrates itself", () => {
		expect(loopCompletionNotice({ status: "complete", stopReason: "done", driver: "coding", adopted: false })).toBeNull();
		expect(loopCompletionNotice({ status: "failed", stopReason: "error", driver: "coding", adopted: true })).toBeNull();
	});

	// Rule 2: N tabs may watch one run. Only the tab that started it writes to the log.
	it("shows an adopted run's ending without writing it to the log", () => {
		const notice = loopCompletionNotice({ status: "complete", stopReason: "done", driver: null, adopted: true });
		expect(notice).not.toBeNull();
		expect(notice?.persist).toBe(false);
	});

	it("persists the ending of a run this tab started", () => {
		expect(loopCompletionNotice({ status: "complete", stopReason: "done", adopted: false })?.persist).toBe(true);
	});

	it("distinguishes finishing from being stopped, and names the reason", () => {
		expect(loopCompletionNotice({ status: "complete", stopReason: "done", adopted: false })?.text).toBe("Loop complete:");
		expect(loopCompletionNotice({ status: "cancelled", stopReason: "cancelled", adopted: false })?.text).toBe("Loop stopped (cancelled):");
	});

	it("falls back to the status when the server gives no stop reason", () => {
		expect(loopCompletionNotice({ status: "failed", stopReason: null, adopted: false })?.text).toBe("Loop stopped (failed):");
		expect(loopCompletionNotice({ status: "failed", adopted: false })?.text).toBe("Loop stopped (failed):");
	});

	it("appends the server's detail when there is one", () => {
		expect(loopCompletionNotice({ status: "complete", stopReason: "done", detail: "12 files changed", adopted: false })?.text)
			.toBe("Loop complete: 12 files changed");
	});
});
