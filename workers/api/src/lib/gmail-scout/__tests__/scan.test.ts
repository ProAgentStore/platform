import { describe, expect, it } from "vitest";
import { resolveConnectorAccount } from "../../connector-accounts.js";
import { candidateFromMessage } from "../scan.js";

describe("Gmail Scout scan", () => {
	it("fails closed when several Gmail accounts are not pinned", () => {
		const out = resolveConnectorAccount([{ accountId: "a@example.com", label: "a@example.com", connectedAt: null, grantedScopes: null }, { accountId: "b@example.com", label: "b@example.com", connectedAt: null, grantedScopes: null }], undefined, "Gmail");
		expect(out).toMatchObject({ ok: false, reason: "ambiguous" });
	});
	it("creates display-safe Gmail provenance without retaining the mail body", () => {
		const lead = candidateFromMessage({ id: "m1", threadId: "t1", from: "alerts@example.com", to: "me@example.com", cc: "", subject: "Senior Engineer — Example", date: "2026-10-09", messageId: "", references: "", snippet: "", text: "Apply https://jobs.example.com/job/1?utm_source=mail", attachments: [] });
		expect(lead).toMatchObject({ url: "https://jobs.example.com/job/1", gmail_message_id: "m1", source: "Gmail (jobs.example.com)" });
		expect(lead).not.toHaveProperty("text");
	});
});
