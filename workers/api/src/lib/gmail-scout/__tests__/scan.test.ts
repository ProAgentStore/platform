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
		const lead = candidateFromMessage({ id: "m1", threadId: "t1", from: "alerts@example.com", to: "me@example.com", cc: "", subject: "Senior Engineer at Example", date: new Date().toISOString(), messageId: "", references: "", snippet: "Location: Sydney", text: "Apply https://jobs.example.com/job/1?utm_source=mail", attachments: [] });
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
			readMessage: async () => ({ id: "message-1", threadId: "thread-1", from: "alerts@example.com", to: "me@example.com", cc: "", subject: "Platform Engineer at Acme", date: new Date().toISOString(), messageId: "", references: "", snippet: "Location: Melbourne", text: "Role: Platform Engineer\nApply https://jobs.example.com/job/42?ref=weekly", attachments: [] }),
			existing,
			insertLead: async (data) => { scoutLeads.push({ data }); return undefined; },
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

describe("concrete-job-only extraction (#1022)", () => {
	// The live payload that became lead 4de48c81 → application f8a8fba6 (inert fixture text, never sent anywhere).
	const LIVE_DIGEST = {
		id: "1a124e59da6bcf61", threadId: "t", to: "me@example.com", cc: "", messageId: "", references: "", attachments: [], snippet: "",
		from: "SEEK Recommendations <noreply@s.seek.com.au>",
		subject: "Head of IT Engineering, Data & AI [Very strong applicant] + 11 new jobs",
		date: new Date().toISOString(),
		text: ".company-info { color: #333; }\nHead of IT Engineering, Data & AI\nSouth Melbourne.\nhttps://au.seek.com/job/95135491?tracking=PAC-JobRecs-anz-1%5D",
	};

	it("rejects the live SEEK recommendation digest before it can become a lead", () => {
		expect(candidateFromMessage(LIVE_DIGEST)).toBeNull();
	});

	it("rejects it on each digest signal alone: the subject, the Recommendations sender, several listings", () => {
		expect(candidateFromMessage({ ...LIVE_DIGEST, from: "SEEK <noreply@s.seek.com.au>" })).toBeNull(); // subject
		expect(candidateFromMessage({ ...LIVE_DIGEST, subject: "Head of IT Engineering, Data & AI" })).toBeNull(); // sender
		const twoJobs = "https://au.seek.com/job/95135491?tracking=a\nhttps://au.seek.com/job/95164755?tracking=b";
		expect(candidateFromMessage({ ...LIVE_DIGEST, from: "SEEK <noreply@s.seek.com.au>", subject: "Head of IT Engineering", text: twoJobs })).toBeNull();
		for (const subject of ["20 new jobs for Project manager in All Melbourne VIC", "Sergey, we found 3 new ethical jobs for you", "EthicalJobs.com.au weekly email update - top tips", "Your saved search: Scrum Master", "Your job recommendations"]) {
			expect(candidateFromMessage({ ...LIVE_DIGEST, from: "Jobs <jobs@example.com>", subject, text: "https://jobs.example.com/job/1" })).toBeNull();
		}
	});

	it("one posting linked twice with different tracking is still ONE job, not a digest", () => {
		const text = "https://au.seek.com/job/95135491?tracking=a\nApply: https://au.seek.com/job/95135491?tracking=b";
		expect(candidateFromMessage({ ...LIVE_DIGEST, from: "SEEK <noreply@s.seek.com.au>", subject: "Head of IT Engineering at Acme", text })).toMatchObject({ url: expect.stringContaining("au.seek.com/job/95135491") });
	});

	it("still accepts a genuine single-job alert", () => {
		const c = candidateFromMessage({ ...LIVE_DIGEST, from: "Acme Careers <careers@acme.example>", subject: "Platform Engineer at Acme", text: "Company: Acme Pty Ltd\nLocation: Melbourne\nhttps://jobs.example.com/job/42" });
		expect(c).toMatchObject({ url: "https://jobs.example.com/job/42", title: "Platform Engineer at Acme", company: "Acme Pty Ltd", location: "Melbourne" });
	});

	it("never takes markup as an employer or location", () => {
		const c = candidateFromMessage({ ...LIVE_DIGEST, from: "Acme Careers <careers@acme.example>", subject: "Platform Engineer", text: ".company-info { color: #333; }\n.location-box { x: 1 }\nhttps://jobs.example.com/job/42" });
		expect(c).not.toBeNull();
		expect(c?.company).toBeUndefined();
		expect(c?.location).toBeUndefined();
	});
});
