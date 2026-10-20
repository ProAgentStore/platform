/** Browser verification of Gmail leads in the console (#1030): the sentences, the Apply gate, MCP parity. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type LeadVerification, leadVerificationLine } from "./gmailScout";
import { canTriage, JOB_LEAD_PIPELINE } from "./jobLeads";

const v = (over: Partial<LeadVerification> = {}): LeadVerification => ({
	leadId: "lead-1",
	canonicalUrl: "https://au.indeed.com/viewjob?jk=0123456789abcdef",
	expectedTitle: "Platform Engineer",
	expectedCompany: "Acme",
	state: "awaiting",
	attempts: 0,
	nextAttemptAt: "",
	lastOutcome: null,
	lastDetail: null,
	...over,
});

describe("a lead closed only for site consent (#1235)", () => {
	it("says why, and offers to verify again — the server reopens it once the site is allowed", () => {
		expect(leadVerificationLine(v({ state: "unverifiable", closedReason: "consent_expired" }))).toEqual({
			text: "Platform Engineer · Acme: closed because its site was not allowed in time — allow the site, then verify again.",
			tone: "warn",
			canVerifyNow: true,
		});
		// Any other closure stays closed in the UI too.
		expect(leadVerificationLine(v({ state: "unverifiable", closedReason: null })).canVerifyNow).toBe(false);
	});
});

describe("lead browser verification (#1030)", () => {
	it("says what the browser found, and offers Verify now only while waiting", () => {
		expect(leadVerificationLine(v())).toEqual({ text: "Platform Engineer · Acme: waiting for the browser.", tone: "warn", canVerifyNow: true });
		expect(leadVerificationLine(v({ state: "active", attempts: 1 }))).toEqual({ text: "Platform Engineer · Acme: verified active — ready to triage (attempt 1).", tone: "ok", canVerifyNow: false });
		expect(leadVerificationLine(v({ state: "mismatch" })).text).toMatch(/a different job — closed/);
	});

	it("an awaiting lead cannot be applied for — only set aside — and has its own board column", () => {
		expect(canTriage("awaiting_browser_verification", "apply")).toBe(false);
		for (const a of ["skip", "defer", "archive"] as const) expect(canTriage("awaiting_browser_verification", a)).toBe(true);
		expect(JOB_LEAD_PIPELINE.indexOf("awaiting_browser_verification")).toBe(JOB_LEAD_PIPELINE.indexOf("unverified") + 1);
	});

	it("reads and dispatches through the same routes as MCP's job_lead_browser_verifications / verify_job_lead_now", () => {
		const mcp = readFileSync(join(__dirname, "../../../../workers/mcp/src/instance-tools/browser-verification.ts"), "utf8");
		const ui = readFileSync(join(__dirname, "../tabs/settings/GmailScoutSection.tsx"), "utf8");
		for (const route of ["/job-leads/browser-verifications", "/browser-verification`"]) {
			expect(mcp).toContain(route);
			expect(ui).toContain(route);
		}
	});
});
