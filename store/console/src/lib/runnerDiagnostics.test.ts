import { describe, expect, it } from "vitest";
import { type CodingDiagnostics, consoleFix, diagnosticsHeadline, orderedIssues } from "./runnerDiagnostics";

const diag = (summary: Partial<CodingDiagnostics["summary"]> = {}, issues: CodingDiagnostics["issues"] = []): CodingDiagnostics => ({
	summary: { runnerOnline: true, runnerStatus: "online", activeSessions: 0, healthySessions: 0, needsReauth: false, issueCount: 0, ...summary },
	issues,
});

describe("the diagnosis on the Runner card (#929 finding 7)", () => {
	it("leads with the LIVE status, the sessions, a pending sign-in and the problem count", () => {
		expect(diagnosticsHeadline(diag())).toBe("Runner online · no problems found");
		expect(diagnosticsHeadline(diag({ runnerOnline: false, runnerStatus: "unresponsive", activeSessions: 2, healthySessions: 1, needsReauth: true, issueCount: 3 }))).toBe(
			"Runner unresponsive · 1 of 2 active sessions healthy · the coding engine is waiting for you to sign in · 3 problems found",
		);
	});

	it("says each fix with this card's controls, not the MCP tool names", () => {
		expect(consoleFix("Move some agents to another machine (set_instance_runner_node), or stop the work running beside them.")).toBe(
			"Move some agents to another machine (Runs on, below), or stop the work running beside them.",
		);
		expect(consoleFix("Call force_runner_attach for this instance.")).toBe("Use Reattach for this instance.");
		expect(consoleFix(undefined)).toBe("");
	});

	it("lists errors before warnings before notes", () => {
		const out = orderedIssues([
			{ severity: "info", message: "note" },
			{ severity: "warn", message: "warning" },
			{ severity: "error", message: "broken" },
		]);
		expect(out.map((i) => i.severity)).toEqual(["error", "warn", "info"]);
	});
});
