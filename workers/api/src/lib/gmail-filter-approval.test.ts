/**
 * #719 end to end on the real schema: `gmail_create_filter` has NO standing authority.
 *
 * Owner decision 2026-10-14 — filter creation only with explicit per-action owner approval:
 *  1. Even with Gmail write access set to "Always allow", a call does not create anything: it
 *     becomes an approval card on the board. Gmail is never contacted at that point.
 *  2. The card shows the mailbox, the exact rule and actions, the agent's reason, and that it is
 *     a standing rule for future mail; the call it carries is bound to that mailbox.
 *  3. An invalid filter (forwarding, trash, …) or a mailbox without the filter permission is
 *     refused to the model — no card is put in front of the owner.
 *  4. Only the approved call runs (`preApprovedTicketId`, set by the board's approve route and
 *     nowhere else), creating exactly the filter shown — and not if the agent now resolves to a
 *     different mailbox than the one the owner approved for.
 * Write consent is still required: no consent row, no card.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./d1-sqlite.js";
import { TOOL_APPROVAL_TASK_TYPE } from "./tool-approval.js";
import { runRegistryTool } from "./tool-registry.js";
import type { Env } from "../types.js";

const SETTINGS_BASIC = "https://www.googleapis.com/auth/gmail.settings.basic";
const READONLY = "https://www.googleapis.com/auth/gmail.readonly";
const FILTER = { from: "news@shop.com", actions: ["skip_inbox", "add_label"], label: "Shopping", reason: "You asked to stop seeing shop newsletters." };

let d1: RealSchemaD1;
let env: Env;
let gmailCalls: Array<{ url: string; method: string; body: unknown }>;

function account(accountId: string, scopes: string) {
	d1.exec(
		`INSERT INTO user_api_keys (user_id, provider, account_id, key_ciphertext, dek_wrapped, iv, account_label, granted_scopes)
		 VALUES ('u1', 'gmail', '${accountId}', x'00', x'00', x'00', '${accountId}', '${scopes}')`,
	);
}
const pin = (accountId: string) => d1.exec(`UPDATE agent_instances SET config = '${JSON.stringify({ connectorAccounts: { gmail: accountId } })}' WHERE id = 'inst-1'`);
const consent = (mode: "always" | "ask") => d1.exec(`INSERT INTO instance_connector_consent (instance_id, user_id, connector, scope, mode) VALUES ('inst-1', 'u1', 'gmail', 'write', '${mode}')`);
const tickets = () => d1.sqlite.prepare("SELECT id, type, status, payload FROM instance_runtime_tasks WHERE instance_id = 'inst-1'").all() as Array<{ id: string; type: string; status: string; payload: string }>;
const ctx = (over: Record<string, unknown> = {}) => ({ env, instanceId: "inst-1", userId: "u1", connectorClient: () => ({ token: async () => "gmail-token" }), ...over }) as unknown as Parameters<typeof runRegistryTool>[1];

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["inst-1"] });
	gmailCalls = [];
	vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input instanceof Request ? input.url : input);
		gmailCalls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
		if (url.endsWith("/labels")) return Response.json({ labels: [{ id: "Label_7", name: "Shopping", type: "user" }, { id: "TRASH", name: "TRASH", type: "system" }] });
		if (url.endsWith("/settings/filters")) return Response.json({ id: "filter-123" });
		return new Response("unexpected", { status: 500 });
	});
	// The instance's own state: email permission on (the Gmail tools' first gate).
	env = { DB: d1.DB, AGENT: { idFromName: (n: string) => n, get: () => ({ fetch: async () => Response.json({ permissions: { email: true } }) }) } } as unknown as Env;
});
afterEach(() => {
	vi.unstubAllGlobals();
	d1.close();
});

describe("no standing authority: every call is an approval card", () => {
	it("under \"Always allow\" a filter call is QUEUED with the full card, and Gmail is not contacted", async () => {
		account("serge@example.com", `${READONLY} ${SETTINGS_BASIC}`);
		consent("always");
		const res = await runRegistryTool("gmail_create_filter", ctx(), FILTER);

		expect(res.success).toBe(true);
		expect(res.content).toMatch(/^Nothing has been sent\. gmail_create_filter is waiting for the owner's approval/);
		expect(res.content).toMatch(/always needs the owner's approval for each call/);
		expect(gmailCalls).toEqual([]);

		const [t] = tickets();
		expect(t.type).toBe(TOOL_APPROVAL_TASK_TYPE);
		expect(t.status).toBe("needs_approval");
		const payload = JSON.parse(t.payload);
		expect(payload.title).toBe("Approve Gmail filter on serge@example.com");
		expect(payload.description).toContain("Mailbox: serge@example.com");
		expect(payload.description).toContain("from: news@shop.com");
		expect(payload.description).toContain('add label "Shopping"');
		expect(payload.description).toContain(FILTER.reason);
		expect(payload.reasoning).toMatch(/ALL FUTURE mail/);
		expect(payload.reasoning).toMatch(/never forwards mail/);
		// The call the ticket carries is fixed by the platform and bound to the mailbox shown.
		expect(payload.action).toEqual({ action: "call_tool", config: {}, params: { tool: "gmail_create_filter", args: { ...FILTER, mailbox_account: "serge@example.com" } } });
	});

	it("a model cannot pre-bind a mailbox: its own mailbox_account is replaced by the resolved one", async () => {
		account("serge@example.com", `${READONLY} ${SETTINGS_BASIC}`);
		consent("always");
		await runRegistryTool("gmail_create_filter", ctx(), { ...FILTER, mailbox_account: "attacker@evil.com" });
		expect(JSON.parse(tickets()[0].payload).action.params.args.mailbox_account).toBe("serge@example.com");
	});

	it("still needs write consent — no consent row, no card", async () => {
		account("serge@example.com", `${READONLY} ${SETTINGS_BASIC}`);
		const res = await runRegistryTool("gmail_create_filter", ctx(), FILTER);
		expect(res.success).toBe(false);
		expect(tickets().filter((t) => t.type === TOOL_APPROVAL_TASK_TYPE)).toEqual([]);
		expect(gmailCalls).toEqual([]);
	});
});

describe("refused before anything reaches the owner", () => {
	it.each([
		["a forwarding filter", { ...FILTER, forward: "me@elsewhere.com" }, /never created by an agent/],
		["a trash filter", { ...FILTER, actions: ["trash"] }, /not allowed/],
		["a rule matching all mail", { actions: ["skip_inbox"], reason: "x" }, /match ALL mail/],
	])("%s", async (_why, input, msg) => {
		account("serge@example.com", `${READONLY} ${SETTINGS_BASIC}`);
		consent("always");
		const res = await runRegistryTool("gmail_create_filter", ctx(), input);
		expect(res.success).toBe(false);
		expect(res.content).toMatch(msg);
		expect(tickets()).toEqual([]);
	});

	it("a mailbox without the filter permission: refused, naming the Allow action", async () => {
		account("serge@example.com", READONLY);
		consent("always");
		const res = await runRegistryTool("gmail_create_filter", ctx(), FILTER);
		expect(res.success).toBe(false);
		expect(res.content).toMatch(/Allow: Create filters \(each one approved by you\)/);
		expect(tickets()).toEqual([]);
	});
});

describe("the approved call", () => {
	async function queueAndApprove(): Promise<Record<string, unknown>> {
		await runRegistryTool("gmail_create_filter", ctx(), FILTER);
		return JSON.parse(tickets()[0].payload).action.params.args;
	}

	it("creates exactly the filter on the card, once", async () => {
		account("serge@example.com", `${READONLY} ${SETTINGS_BASIC}`);
		consent("always");
		const args = await queueAndApprove();
		const res = await runRegistryTool("gmail_create_filter", ctx({ preApprovedTicketId: "t-1" }), args);
		expect(res.success).toBe(true);
		expect(res.content).toContain("filter-123");
		const creates = gmailCalls.filter((c) => c.url.endsWith("/settings/filters"));
		expect(creates).toEqual([
			{
				url: "https://gmail.googleapis.com/gmail/v1/users/me/settings/filters",
				method: "POST",
				body: { criteria: { from: "news@shop.com" }, action: { addLabelIds: ["Label_7"], removeLabelIds: ["INBOX"] } },
			},
		]);
	});

	it("is refused if the agent now uses a different mailbox than the one the owner approved for", async () => {
		account("serge@example.com", `${READONLY} ${SETTINGS_BASIC}`);
		consent("always");
		const args = await queueAndApprove();
		account("work@example.com", `${READONLY} ${SETTINGS_BASIC}`);
		pin("work@example.com");
		const res = await runRegistryTool("gmail_create_filter", ctx({ preApprovedTicketId: "t-1" }), args);
		expect(res.success).toBe(false);
		expect(res.content).toMatch(/approved for a different Gmail account/);
		expect(gmailCalls.filter((c) => c.url.endsWith("/settings/filters"))).toEqual([]);
	});

	it("a label that does not exist is refused, never created", async () => {
		account("serge@example.com", `${READONLY} ${SETTINGS_BASIC}`);
		consent("always");
		const args = { ...(await queueAndApprove()), label: "Nope" };
		const res = await runRegistryTool("gmail_create_filter", ctx({ preApprovedTicketId: "t-1" }), args);
		expect(res.success).toBe(false);
		expect(res.content).toMatch(/no label named "Nope"/);
		expect(gmailCalls.filter((c) => c.url.endsWith("/settings/filters"))).toEqual([]);
	});
});
