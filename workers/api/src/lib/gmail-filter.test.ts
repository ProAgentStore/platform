/**
 * #719 — what a Gmail filter may do, enforced at the tool boundary rather than in a prompt, and
 * what the owner is shown before approving one.
 *
 * Invariants: no forwarding of any kind (no parameter, no action, no body key); no trash, delete or
 * spam, including through a system label; no criteria-less rule; and a card that names the mailbox,
 * the exact rule, the actions, the agent's reason, and that it applies to all FUTURE mail.
 */
import { describe, expect, it } from "vitest";
import { filterApprovalCard, gmailFilterBody, parseFilterRequest } from "./gmail-filter.js";

const base = { from: "news@shop.com", actions: ["skip_inbox"], reason: "You asked to stop seeing shop newsletters." };
const refused = (input: Record<string, unknown>) => {
	const r = parseFilterRequest(input);
	expect(r.ok).toBe(false);
	return r.ok ? "" : r.error;
};

describe("parseFilterRequest — the boundary", () => {
	it("accepts a narrow rule with an allowed action and a reason", () => {
		const r = parseFilterRequest(base);
		expect(r).toEqual({ ok: true, request: { criteria: { from: "news@shop.com" }, actions: ["skip_inbox"], reason: base.reason } });
	});

	it.each(["forward", "forward_to", "forwardTo"])("refuses a `%s` field outright — never ignored", (key) => {
		expect(refused({ ...base, [key]: "me@elsewhere.com" })).toMatch(/never created by an agent/);
	});

	it.each(["forward", "trash", "delete", "spam", "never_spam", "mark_important"])("refuses the `%s` action by name", (action) => {
		expect(refused({ ...base, actions: [action] })).toMatch(/not allowed|never created/);
	});

	it.each(["TRASH", "spam", "INBOX", "UNREAD", "IMPORTANT"])("refuses adding the system label %s — the same act by another door", (label) => {
		expect(refused({ ...base, actions: ["add_label"], label })).toMatch(/system label/);
	});

	it("refuses a rule that would match ALL mail — a negated query alone does not count", () => {
		expect(refused({ actions: ["skip_inbox"], reason: "x" })).toMatch(/match ALL mail/);
		expect(refused({ negated_query: "from:boss", actions: ["skip_inbox"], reason: "x" })).toMatch(/match ALL mail/);
	});

	it("refuses an unknown action, a missing reason, and a label without add_label", () => {
		expect(refused({ ...base, actions: ["auto_reply"] })).toMatch(/Unknown filter action/);
		expect(refused({ ...base, reason: " " })).toMatch(/reason/);
		expect(refused({ ...base, label: "Receipts" })).toMatch(/only used with the add_label/);
		expect(refused({ ...base, actions: ["add_label"] })).toMatch(/needs `label`/);
	});

	it("refuses an over-long criterion instead of truncating it into a different rule", () => {
		expect(refused({ ...base, subject: "x".repeat(301) })).toMatch(/longer than 300/);
	});
});

describe("gmailFilterBody — built from the allowlist, never from the input", () => {
	it("maps each action to Gmail's label changes, and has no forward key", () => {
		const r = parseFilterRequest({ from: "a@b.com", subject: "invoice", has_attachment: true, negated_query: "from:boss", actions: ["skip_inbox", "mark_read", "star", "add_label"], label: "Receipts", reason: "r" });
		if (!r.ok) throw new Error(r.error);
		const body = gmailFilterBody(r.request, "Label_42");
		expect(body).toEqual({
			criteria: { from: "a@b.com", subject: "invoice", negatedQuery: "from:boss", hasAttachment: true },
			action: { addLabelIds: ["STARRED", "Label_42"], removeLabelIds: ["INBOX", "UNREAD"] },
		});
		expect(JSON.stringify(body)).not.toMatch(/forward/i);
	});
});

describe("filterApprovalCard — what the owner reads before deciding", () => {
	it("names the mailbox, the exact rule, the actions, the reason, the scope and the risks", () => {
		const r = parseFilterRequest({ ...base, subject: "weekly deals", actions: ["skip_inbox", "add_label"], label: "Shopping" });
		if (!r.ok) throw new Error(r.error);
		const card = filterApprovalCard(r.request, "serge@example.com");
		const text = `${card.title}\n${card.description}\n${card.reasoning}`;
		expect(card.title).toBe("Approve Gmail filter on serge@example.com");
		expect(card.description).toContain("Mailbox: serge@example.com");
		expect(card.description).toContain("matches: from: news@shop.com AND subject: weekly deals");
		expect(card.description).toContain('Gmail will: skip the inbox (archive), add label "Shopping"');
		expect(card.description).toContain(`Agent's reason: ${base.reason}`);
		expect(text).toMatch(/applies to ALL FUTURE mail that matches/);
		expect(text).toMatch(/until you delete it in Gmail → Settings → Filters/);
		expect(text).toMatch(/hidden from your inbox/);
		expect(text).toMatch(/never forwards mail/);
		expect(text).toMatch(/also able to manage forwarding settings/);
		expect(text).toMatch(/Nothing has happened yet/);
	});
});
