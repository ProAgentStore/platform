import { describe, expect, it } from "vitest";
import { resolveConnectorAccount } from "../../connector-accounts.js";
import { candidateFromMessage, gmailScoutQuery, ingestGmailCandidates } from "../scan.js";

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
		expect(scoutLeads[0].data).toMatchObject({ status: "new", url: "https://jobs.example.com/job/42", company: "Acme", location: "Melbourne", gmail_message_id: "message-1" });
		expect(otherScoutLeads).toEqual([]);
	});

	it("uses its persisted cursor as a Gmail after-date floor after the first scan", () => {
		expect(gmailScoutQuery(null)).toContain("newer_than:30d");
		expect(gmailScoutQuery(JSON.stringify({ after: "2026-10-09T12:00:00.000Z", messageId: "m1" }))).toContain("after:2026/10/9");
	});
});
