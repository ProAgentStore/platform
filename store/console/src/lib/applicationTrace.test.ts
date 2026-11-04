import { describe, expect, it } from "vitest";
import { applicationTraceLabel } from "./applicationTrace";

describe("application trace descriptions", () => {
	it("names the navigated URL without authentication components", () => {
		expect(applicationTraceLabel({ type: "browser.navigated", detail: { url: "https://user:pass@au.seek.com/job/95534692?token=private#fragment" } })).toBe("Opened page — https://au.seek.com/job/95534692");
	});
	it("distinguishes permission from performed clicks and tells the owner when a target was never recorded", () => {
		expect(applicationTraceLabel({ type: "policy.decision", detail: { tool: "browser_click", decision: "allowed", target: "Apply" } })).toBe("Allowed click “Apply”");
		expect(applicationTraceLabel({ type: "policy.decision", detail: { tool: "browser_click", class: "action", decision: "completed", target: "Apply" } })).toBe("Clicked “Apply”");
		expect(applicationTraceLabel({ type: "policy.decision", detail: { tool: "browser_click", decision: "failed", target: "Apply", reason: "login_required" } })).toBe("Failed click “Apply” — login required");
		expect(applicationTraceLabel({ type: "policy.decision", detail: { tool: "browser_click", decision: "allowed" } })).toContain("target not recorded");
	});
	it("distinguishes an exact-byte staging filename from site attachment acceptance", () => {
		expect(applicationTraceLabel({ type: "artifact.staged", detail: { kind: "resume", source: "resume.md", path: "resume.txt" } })).toBe("Prepared resume.txt from resume.md; identical bytes");
		expect(applicationTraceLabel({ type: "artifact.uploaded", detail: { kind: "resume", status: "selected", reason: "site_acceptance_unconfirmed" } })).toBe("Selected resume; site acceptance unconfirmed");
	});

	it("explains the actual sign-in failure and never promotes an attempted submit to confirmation", () => {
		expect(applicationTraceLabel({ type: "policy.decision", detail: { tool: "agent_sign_in", decision: "failed", reason: "This run's browser cannot accept sign-in secret placeholders." } })).toContain("Automatic sign-in failed: This run's browser cannot accept sign-in secret placeholders");
		expect(applicationTraceLabel({ type: "submit.attempted", detail: {} })).toBe("Attempted submission — confirmation pending");
	});
});
