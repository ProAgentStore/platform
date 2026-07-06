import { describe, it, expect } from "vitest";
import { jobKeyForTask } from "./board.js";

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

	it("falls back to the task id when there is no URL", () => {
		expect(jobKeyForTask({ id: "t9" })).toBe("t9");
		expect(jobKeyForTask({ id: "t9", input: { url: "not a url" } })).toBe("t9");
	});
});
