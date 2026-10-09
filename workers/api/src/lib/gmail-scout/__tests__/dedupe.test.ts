import { describe, expect, it } from "vitest";
import { duplicateGmailLead } from "../scan.js";
import { canonicalJobUrl, jobIdentity } from "../../job-lead-triage.js";

describe("Gmail Scout canonical URL dedupe", () => {
	it("uses the same canonical identity as ordinary stored job leads", () => {
		expect(canonicalJobUrl("https://Jobs.Example.com/role/42/?utm_source=mail&ref=weekly#apply"))
			.toBe("https://jobs.example.com/role/42");
		expect(jobIdentity({ url: "https://jobs.example.com/role/42/?source=alerts&campaign=weekly" }))
			.toBe(jobIdentity({ url: "https://Jobs.Example.com/role/42/?utm_source=mail&ref=weekly#apply" }));
	});
	it("refuses non-URLs rather than creating a lead without a canonical identity", () => {
		expect(canonicalJobUrl("javascript:alert(1)")).toBeNull();
	});
	it("rejects an existing canonical URL and a previously ingested Gmail message id", () => {
		const existing = [
			{ data: { url: "https://jobs.example.com/42?ref=weekly", gmail_message_id: "already-read" } },
		];
		expect(duplicateGmailLead({ url: "https://jobs.example.com/42?utm_source=mail", gmail_message_id: "new-message" }, existing)).toBe(true);
		expect(duplicateGmailLead({ url: "https://jobs.example.com/another", gmail_message_id: "already-read" }, existing)).toBe(true);
	});
});
