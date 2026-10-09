import { describe, expect, it } from "vitest";
import type { Env } from "../../../types.js";
import { resolveConnectorAccount } from "../../connector-accounts.js";
import { candidateFromMessage, gmailScoutQuery, ingestGmailCandidates, readGmailScoutLeadRecords } from "../scan.js";

describe("Gmail Scout scan", () => {
	it("fails closed when several Gmail accounts are not pinned", () => {
		const out = resolveConnectorAccount([{ accountId: "a@example.com", label: "a@example.com", connectedAt: null, grantedScopes: null }, { accountId: "b@example.com", label: "b@example.com", connectedAt: null, grantedScopes: null }], undefined, "Gmail");
		expect(out).toMatchObject({ ok: false, reason: "ambiguous" });
	});
	it("creates display-safe Gmail provenance without retaining the mail body", () => {
		const lead = candidateFromMessage({ id: "m1", threadId: "t1", from: "alerts@example.com", to: "me@example.com", cc: "", subject: "Senior Engineer at Example", date: "2026-10-09", messageId: "", references: "", snippet: "Location: Sydney", text: "Apply https://jobs.example.com/job/1?utm_source=mail", attachments: [] });
		expect(lead).toMatchObject({ url: "https://jobs.example.com/job/1", gmail_message_id: "m1", source: "Gmail", source_domain: "jobs.example.com", company: "Example", location: "Sydney" });
		expect(lead).not.toHaveProperty("text");
	});

	it("marks, rather than silently cuts, bounded Gmail display metadata", () => {
		const lead = candidateFromMessage({
			id: "m-long", threadId: "t-long", from: `alerts-${"x".repeat(400)}@example.com`, to: "me@example.com", cc: "",
			subject: `Role at ${"Acme ".repeat(80)}`, date: new Date().toISOString(), messageId: "", references: "",
			snippet: "", text: `Company: ${"Acme ".repeat(40)}\nApply https://jobs.example.com/job/long`, attachments: [],
		});
		expect(lead?.title).toContain("[cut: showing the first");
		expect(lead?.gmail_subject).toContain("[cut: showing the first");
		expect(lead?.gmail_from).toContain("[cut: showing the first");
		expect(lead?.gmail_provenance).toMatchObject({ provider: "gmail", message_id: "m-long", source_domain: "jobs.example.com" });
	});

	it("writes a mocked Gmail alert only to the source Scout's private lead collection", async () => {
		const scoutLeads: Array<{ data: Record<string, unknown> }> = [];
		const existing: Array<{ data: Record<string, unknown> }> = [];
		const otherScoutLeads: Array<{ data: Record<string, unknown> }> = [];
		const result = await ingestGmailCandidates({
			hits: [{ id: "message-1" }],
			readMessage: async () => ({ id: "message-1", threadId: "thread-1", from: "alerts@example.com", to: "me@example.com", cc: "", subject: "Platform Engineer at Acme", date: "2026-10-09", messageId: "", references: "", snippet: "Location: Melbourne", text: "Role: Platform Engineer\nApply https://jobs.example.com/job/42?ref=weekly", attachments: [] }),
			existing,
			insertLead: async (data) => { scoutLeads.push({ data }); },
		});
		expect(result).toEqual({ candidates: 1, added: 1, deduped: 0 });
		expect(scoutLeads).toHaveLength(1);
		expect(scoutLeads[0].data).toMatchObject({ status: "unverified", work_key: "url:https://jobs.example.com/job/42", url: "https://jobs.example.com/job/42", company: "Acme", location: "Melbourne", gmail_message_id: "message-1", verification: { state: "unverified", source: "gmail_alert" }, gmail_provenance: { provider: "gmail", message_id: "message-1" } });
		expect(otherScoutLeads).toEqual([]);
	});

	it("uses its persisted cursor as a Gmail after-date floor after the first scan", () => {
		expect(gmailScoutQuery(null)).toContain("newer_than:2d");
		expect(gmailScoutQuery(JSON.stringify({ after: "2026-10-09T12:00:00.000Z", messageId: "m1" }))).toContain("after:2026/10/9");
	});

	it("rejects stale, security, asset, account, and generic listing links instead of making an unverified lead", () => {
		const base = { id: "m", threadId: "t", from: "alerts@example.com", to: "me@example.com", cc: "", date: new Date().toISOString(), messageId: "", references: "", snippet: "", attachments: [] };
		for (const message of [
			{ ...base, subject: "Security alert", text: "https://jobs.example.com/job/42" },
			{ ...base, subject: "Role", text: "https://jobs.example.com/assets/logo.svg" },
			{ ...base, subject: "Role", text: "https://jobs.example.com/jobs" },
			{ ...base, subject: "Role", text: "https://jobs.example.com/jobs/search/platform" },
			{ ...base, subject: "Role", text: "https://jobs.example.com/account/apply/42" },
			{ ...base, subject: "Role", text: "javascript:alert(1)" },
			{ ...base, subject: "Old role", date: "2020-01-01", text: "https://jobs.example.com/job/42" },
		]) expect(candidateFromMessage(message)).toBeNull();
	});

	it("treats only an absent private lead collection as empty for a first scan", async () => {
		const requests: string[] = [];
		const env = {
			AGENT: {
				idFromName: (id: string) => id,
				get: () => ({ fetch: async (request: Request) => {
					requests.push(new URL(request.url).pathname);
					return Response.json({ error: "Not found" }, { status: 404 });
				} }),
			},
		} as unknown as Env;

		await expect(readGmailScoutLeadRecords(env, "new-scout")).resolves.toEqual([]);
		expect(requests).toEqual(["/collections/job_leads"]);
	});
});
