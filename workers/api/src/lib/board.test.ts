import { describe, it, expect } from "vitest";
import { jobKeyForTask, deriveFromUrl } from "./board.js";

describe("jobKeyForTask", () => {
	it("collapses the same job URL across query strings / tracking params", () => {
		const a = jobKeyForTask({ id: "t1", input: { url: "https://jobs.example.com/JobA/123?utm_source=linkedin" } });
		const b = jobKeyForTask({ id: "t2", input: { url: "https://jobs.example.com/JobA/123?source=indeed" } });
		expect(a).toBe(b);
	});

	it("ignores www + trailing slash + case", () => {
		const a = jobKeyForTask({ id: "t1", input: { url: "https://WWW.Example.com/Job/1/" } });
		const b = jobKeyForTask({ id: "t2", input: { url: "https://example.com/job/1" } });
		expect(a).toBe(b);
	});

	it("keeps different postings on the same host distinct", () => {
		const a = jobKeyForTask({ id: "t1", input: { url: "https://jobs.example.com/JobA/1" } });
		const b = jobKeyForTask({ id: "t2", input: { url: "https://jobs.example.com/JobB/2" } });
		expect(a).not.toBe(b);
	});

	it("keeps distinct jobs whose identity lives in the query string (LinkedIn currentJobId)", () => {
		const a = jobKeyForTask({ id: "t1", input: { url: "https://www.linkedin.com/jobs/view/?currentJobId=111" } });
		const b = jobKeyForTask({ id: "t2", input: { url: "https://www.linkedin.com/jobs/view/?currentJobId=222" } });
		expect(a).not.toBe(b);
	});

	it("still collapses the same query-identified job across tracking params", () => {
		const a = jobKeyForTask({ id: "t1", input: { url: "https://boards.greenhouse.io/x?gh_jid=9&utm_source=linkedin" } });
		const b = jobKeyForTask({ id: "t2", input: { url: "https://boards.greenhouse.io/x?gh_jid=9&utm_source=indeed&ref=foo" } });
		expect(a).toBe(b);
	});

	it("falls back to the task id when there is no URL", () => {
		expect(jobKeyForTask({ id: "t9" })).toBe("t9");
		expect(jobKeyForTask({ id: "t9", input: { url: "not a url" } })).toBe("t9");
	});
});

describe("deriveFromUrl", () => {
	it("prettifies the job slug and keeps the host as subtitle", () => {
		const r = deriveFromUrl("https://employmenthero.com/jobs/position/business-ai-group-pty-ltd-head-of-engineering-a8f4j/");
		expect(r.title).toBe("Business Ai Group Pty Ltd Head Of Engineering");
		expect(r.subtitle).toBe("employmenthero.com");
	});

	it("returns empty for a non-URL so the caller can fall back", () => {
		expect(deriveFromUrl("not a url")).toEqual({ title: "", subtitle: "" });
	});

	it("skips a trailing UUID and uses the company segment (Dover)", () => {
		const r = deriveFromUrl("https://app.dover.com/apply/pentanasolutions/fd3dae1c-8855-4308-9d50-27db48218d7a");
		expect(r.title).toBe("Pentanasolutions");
		expect(r.subtitle).toBe("app.dover.com");
	});

	it("skips generic route words + opaque id (Ashby → company)", () => {
		expect(deriveFromUrl("https://jobs.ashbyhq.com/xero/a547298d-33a5-45bc-ba01-d0787ac3e51b/application").title).toBe("Xero");
	});

	it("skips a numeric id and generic 'jobs' to reach the company (Greenhouse)", () => {
		expect(deriveFromUrl("https://job-boards.greenhouse.io/iconiq/jobs/8030553").title).toBe("Iconiq");
	});
});
