import { describe, expect, it } from "vitest";
import { resumeDomainsFor } from "./resume-domains.js";

describe("per-run external redirect permission", () => {
	it.each(["running", "blocked", "awaiting_review"] as const)("refuses a grant on a %s run", (status) => {
		expect(() => resumeDomainsFor(["jobs.example.com"], { status, pause: { reason: "external_redirect", domain: "jobs.example.com" } })).toThrow(/paused external_redirect/);
	});
	it.each(["login_required", "missing_answer", "captcha"] as const)("refuses a grant on a %s pause", (reason) => {
		expect(() => resumeDomainsFor(["jobs.example.com"], { status: "paused", pause: { reason, domain: "jobs.example.com" } })).toThrow(/paused external_redirect/);
	});
	it("does not infer a grant from an absent or malformed pause domain", () => {
		for (const domain of [undefined, "https://jobs.example.com", "*.example.com"]) expect(() => resumeDomainsFor(["jobs.example.com"], { status: "paused", pause: { reason: "external_redirect", domain } })).toThrow(/exact hostname/);
	});
	it("leaves answer-only resume compatible with other pause kinds", () => {
		expect(resumeDomainsFor(undefined, { status: "paused", pause: { reason: "missing_answer" } })).toEqual([]);
	});
});
