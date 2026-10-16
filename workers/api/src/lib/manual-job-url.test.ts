import { describe, expect, it } from "vitest";
import { genericPostingUrl, validateManualJobUrl } from "./manual-job-url.js";

describe("validateManualJobUrl (#1056)", () => {
	it.each([
		["https://www.seek.com.au/job/81234567?type=standard&ref=search&sol=PERSONALSOL", "https://www.seek.com.au/job/81234567", "seek"],
		["https://www.linkedin.com/jobs/view/platform-engineer-at-acme-4012345678/?trackingId=SECRET%3D%3D&refId=SECRET&midToken=SECRET", "https://www.linkedin.com/jobs/view/4012345678", "linkedin"],
		["https://www.linkedin.com/jobs/search/?currentJobId=4012345678&keywords=engineer", "https://www.linkedin.com/jobs/view/4012345678", "linkedin"],
		["https://au.indeed.com/viewjob?jk=0123456789abcdef&from=serp&tk=PERSONAL", "https://au.indeed.com/viewjob?jk=0123456789abcdef", "indeed"],
	])("keeps only the canonical posting of %s", (raw, canonicalUrl, provider) => {
		const out = validateManualJobUrl(raw);
		expect(out).toEqual({ ok: true, canonicalUrl, provider });
		expect(JSON.stringify(out)).not.toMatch(/SECRET|PERSONAL|tracking|refId|ref=|sol=|tk=/);
	});

	it.each([
		["http://www.seek.com.au/job/81234567", "not_https"],
		["not a url", "not_https"],
		["https://user:pass@www.seek.com.au/job/81234567", "not_https"],
		["https://127.0.0.1/job/81234567", "private_target"],
		["https://10.0.0.5/viewjob?jk=0123456789abcdef", "private_target"],
		["https://jobs.internal/job/1", "private_target"],
		// #1098: a career site's home, search or category page is not ONE posting.
		["https://careers.example.com/", "no_posting_id"],
		["https://careers.example.com/careers", "no_posting_id"],
		["https://careers.example.com/jobs?q=engineer&location=Melbourne", "no_posting_id"],
		["https://careers.example.com/en-au/search?token=SECRET", "no_posting_id"],
		["https://www.seek.com.au/jobs-in-information-communication-technology", "no_posting_id"],
		["https://www.linkedin.com/jobs/search/?keywords=engineer", "no_posting_id"],
		["https://www.linkedin.com/comm/jobs/view/abc?midToken=SECRET", "no_posting_id"],
	])("refuses %s as %s, without echoing it", (raw, reason) => {
		const out = validateManualJobUrl(raw);
		expect(out).toMatchObject({ ok: false, reason });
		expect(JSON.stringify(out)).not.toContain("SECRET");
		expect(JSON.stringify(out)).not.toContain(raw);
	});
});

describe("a posting on any other site (#1098)", () => {
	it.each([
		["https://careers.example.com/jobs/123", "https://careers.example.com/jobs/123"],
		["https://racv.wd3.myworkdayjobs.com/en-US/RACV_Careers/job/Melbourne/Head-of-Engineering_R12345?utm_source=x", "https://racv.wd3.myworkdayjobs.com/en-US/RACV_Careers/job/Melbourne/Head-of-Engineering_R12345"],
		["https://job-boards.greenhouse.io/acme?gh_jid=4567890&gh_src=SECRET", "https://job-boards.greenhouse.io/acme?gh_jid=4567890"],
		["https://careers.example.com/jobs?jobId=R-20931&sessionId=SECRET&email=SECRET", "https://careers.example.com/jobs?jobId=R-20931"],
		["https://CAREERS.example.com/job/42/#apply", "https://careers.example.com/job/42"],
	])("accepts %s as ONE posting, keeping what identifies it and nothing personal", (raw, canonicalUrl) => {
		const out = validateManualJobUrl(raw);
		expect(out).toEqual({ ok: true, canonicalUrl, provider: "other" });
		expect(JSON.stringify(out)).not.toContain("SECRET");
	});

	it("a lookalike of a known provider is just another site — the known provider's rules never apply to it", () => {
		expect(validateManualJobUrl("https://www.seek.com.au.attacker.example/job/81234567")).toEqual({ ok: true, canonicalUrl: "https://www.seek.com.au.attacker.example/job/81234567", provider: "other" });
	});

	it("is the same URL however it was pasted, so a second paste dedupes", () => {
		expect(genericPostingUrl("https://careers.example.com/job/42/?utm_campaign=a&b=2&a=1#x")).toBe(genericPostingUrl("https://careers.example.com/job/42?a=1&b=2&utm_source=z"));
	});
});
