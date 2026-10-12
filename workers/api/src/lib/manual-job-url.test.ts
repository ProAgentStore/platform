import { describe, expect, it } from "vitest";
import { validateManualJobUrl } from "./manual-job-url.js";

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
		["https://careers.example.com/jobs/123", "provider_not_allowed"],
		["https://www.seek.com.au.attacker.example/job/81234567", "provider_not_allowed"],
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
