import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * #1247 — a Gmail Scout scan receipt expands to every email it matched: a link that opens each one,
 * what it was taken for, the decision and why, the lead it became, and a digest's jobs one by one.
 * Routes are stubbed; this asserts what is shown.
 */
const API = "https://api.proagentstore.online";
const INSTANCE = { id: "inst-1", agent_id: "agent-1", name: "Job Search Scout 2", status: "active", slug: "job-search-scout", category: "productivity", icon_bg: "#7c3aed", sourceMode: "gmail", capabilities: { surfaces: [], runtime: null } };
const LINK = "https://mail.google.com/mail/u/serge.pro.job@gmail.com/#all/m-digest";
const RECEIPT = { id: "scan-1", instanceId: "inst-1", trigger: "schedule", triggeredBy: null, status: "completed", startedAt: "2026-10-20T00:00:00Z", completedAt: "2026-10-20T00:00:05Z", hits: 2, candidates: 1, added: 1, deduped: 0, rejected: { digest: 1 }, errorMessage: null, lastMessageId: "m-job", query: "(subject:(job)) newer_than:2d", window: { newerThanDays: 2 }, scanLog: { path: "/v1/instances/inst-1/gmail-scout/scan-log?scan_id=scan-1", tool: "gmail_scout_scan_log", scan_id: "scan-1" }, handoff: "none" };
const item = (over: Record<string, unknown>) => ({ seq: 0, messageId: "m", threadId: "t", gmailLink: null, sender: "SEEK <noreply@s.seek.com.au>", subject: "s", receivedAt: "Mon, 20 Oct 2026", snippet: null, read: null, classification: "single_posting", evidence: null, decision: "added", rejection: null, reason: "r", leadId: null, leadUrl: null, job: null, ...over });
const LOG = {
	scan: RECEIPT,
	total: 2,
	nextCursor: null,
	items: [
		item({ seq: 0, messageId: "m-job", gmailLink: "https://mail.google.com/mail/u/serge.pro.job@gmail.com/#all/m-job", subject: "Platform Engineer at Acme", reason: "Added as an unverified lead: one specific job posting.", leadId: "lead-7", leadUrl: "https://proagentstore.online/console/instances/inst-1/data" }),
		item({
			seq: 1, messageId: "m-digest", gmailLink: LINK, subject: "20 new jobs for Platform Engineer", classification: "digest", decision: "rejected", rejection: "digest",
			reason: "This is a digest or recommendation email listing several jobs.", evidence: 'subject contains "20 new jobs"',
			subItems: [item({ seq: 1, classification: "digest_item", decision: "rejected", reason: "Listed inside a digest.", job: { title: "Site Reliability Engineer", company: null, url: "https://www.seek.com.au/job/1" } })],
		}),
	],
};

async function mock(page: Page) {
	await page.addInitScript((t) => window.localStorage.setItem("pags:session", t), "test-pags-token");
	const logReads: string[] = [];
	await page.route(`${API}/**`, async (route) => {
		const url = new URL(route.request().url());
		const json = (data: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(data) });
		if (url.pathname === "/v1/auth/me") return json({ id: "user-1", login: "tester", name: "Test User", display_name: "Test User", avatar: "https://example.com/a.png", roles: ["user"], boardConfig: null });
		if (url.pathname === "/v1/instances/my/instances") return json({ instances: [INSTANCE] });
		if (url.pathname === "/v1/instances/inst-1/gmail-scout/status") return json({ config: { pinnedEmail: "serge.pro.job@gmail.com", enabled: true }, state: { lastScanAt: null, candidateCount: 1, dedupeCount: 0, failureCount: 0, lastFailureAt: null, lastFailureMessage: null }, leadCount: 1, newLeadCount: 1, receipts: [RECEIPT] });
		if (url.pathname === "/v1/instances/inst-1/gmail-scout/scan-log") {
			logReads.push(url.search);
			return json(LOG);
		}
		if (url.pathname === "/v1/instances/inst-1/job-leads/browser-verifications") return json({ leads: [] });
		if (url.pathname === "/v1/triggers") return json({ triggers: [] });
		if (url.pathname === "/v1/triggers/actions") return json({ actions: [] });
		if (url.pathname === "/v1/triggers/preview") return json({ schedule: null, timezone: null, jitterMinutes: null, runs: [], issues: [], error: null });
		return json({});
	});
	return { logReads };
}

test("a scan receipt opens to each email it matched, with its decision, reason and link (#1247)", async ({ page }) => {
	const { logReads } = await mock(page);
	await page.goto("/console/instances/inst-1/settings");
	const receipts = page.getByTestId("gmail-scout-receipts");
	await receipts.getByRole("button", { name: "Show 2 email(s)" }).click();
	const log = page.getByTestId("gmail-scout-scan-log");
	await expect(log).toContainText("Searched: (subject:(job)) newer_than:2d");
	await expect(log).toContainText("Added · single posting");
	await expect(log).toContainText("Lead lead-7");
	await expect(log).toContainText("Not taken · digest");
	await expect(log).toContainText('Evidence: subject contains "20 new jobs"');
	await expect(log.getByRole("link", { name: "Open email" }).nth(1)).toHaveAttribute("href", LINK);
	await expect(log.getByRole("list", { name: "Jobs listed in this email" })).toContainText("Site Reliability Engineer");
	expect(logReads).toEqual(["?scan_id=scan-1"]);
});
