/**
 * The Scans tab's states and the Settings one-liner (#1591), rendered for real (server-side markup) and asserted on what is
 * shown. Clicking, Scan now and the load path are Playwright's (e2e/scans-tab.spec.ts, #282).
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { type GmailScoutScanReceipt, type GmailScoutStatus, type LeadVerification, scanSummary } from "../../lib/gmailScout";
import { ScanSummaryLine } from "../settings/GmailScoutSection";
import ScansView, { type ScansViewProps } from "./ScansView";

const receipt = (over: Partial<GmailScoutScanReceipt> = {}): GmailScoutScanReceipt => ({
	id: "scan-1", instanceId: "inst-1", trigger: "schedule", triggeredBy: null, status: "completed", startedAt: "2026-11-07T05:42:00.000Z", completedAt: "2026-11-07T05:42:05.000Z",
	hits: 2, candidates: 1, added: 1, deduped: 0, rejected: {}, errorMessage: null, lastMessageId: null, handoff: "none", ...over,
});
const status = (over: Partial<GmailScoutStatus> = {}): GmailScoutStatus => ({
	config: { pinnedEmail: "serge.pro.job@gmail.com", enabled: true },
	state: { lastScanAt: "2026-11-07T05:42:00.000Z", candidateCount: 1, dedupeCount: 0, failureCount: 0, lastFailureAt: null, lastFailureMessage: null },
	leadCount: 1, newLeadCount: 1, receipts: [receipt()], ...over,
});
const verification = (over: Partial<LeadVerification> = {}): LeadVerification => ({ leadId: "lead-1", canonicalUrl: "https://x", expectedTitle: "Platform Engineer", expectedCompany: "Acme", state: "awaiting", attempts: 0, nextAttemptAt: "", lastOutcome: null, lastDetail: null, ...over });

function view(over: Partial<ScansViewProps> = {}) {
	const props: ScansViewProps = {
		instanceId: "inst-1", status: status(), error: null, verifications: [], busy: false, message: "", openScan: null, hasData: true,
		onRetry: () => undefined, onScan: () => undefined, onVerify: () => undefined, onToggleScan: () => undefined, ...over,
	};
	return renderToStaticMarkup(createElement(MemoryRouter, null, createElement(ScansView, props)));
}

describe("Scans tab states", () => {
	it("loading: says so, claims nothing", () => {
		const html = view({ status: null });
		expect(html).toContain('data-testid="scans-loading"');
		expect(html).not.toContain("Scan now");
		expect(html).not.toContain("No scans yet");
	});

	it("error: LoadFailed with the reason and a Retry, no empty state", () => {
		const html = view({ status: null, error: "boom" });
		expect(html).toContain('data-testid="scans-load-failed"');
		expect(html).toContain("Couldn&#x27;t load the Gmail scans.");
		expect(html).toContain("boom");
		expect(html).toContain("Retry");
		expect(html).not.toContain("No scans yet");
	});

	it("a failed refresh keeps the last good scans visible beneath a compact error", () => {
		const html = view({ error: "offline" });
		expect(html).toContain('data-testid="scans-refresh-failed"');
		expect(html).toContain('data-testid="gmail-scout-receipts"');
	});

	it("empty: 'No scans yet · Scan now', with the one Scan now button and no counters", () => {
		const html = view({ status: status({ state: { lastScanAt: null, candidateCount: 0, dedupeCount: 0, failureCount: 0, lastFailureAt: null, lastFailureMessage: null }, receipts: [] }) });
		expect(html).toContain('data-testid="scans-empty"');
		expect(html).toMatch(/No scans yet · <button[^>]*>Scan now<\/button>/);
		expect(html.match(/Scan now/g)).toHaveLength(1);
		expect(html).not.toContain("Candidates");
	});

	it("source off: 'Gmail source is off · Turn on in Settings' to Settings → Agent, and no Scan now at all", () => {
		for (const s of [status({ config: { pinnedEmail: "m", enabled: false } }), status({ config: { pinnedEmail: "m", enabled: false }, receipts: [], state: { lastScanAt: null, candidateCount: 0, dedupeCount: 0, failureCount: 0, lastFailureAt: null, lastFailureMessage: null } })]) {
			const html = view({ status: s });
			expect(html).toContain("Gmail source is off · ");
			expect(html).toMatch(/<a [^>]*href="\/instances\/inst-1\/settings\?subtab=agent"[^>]*>Turn on in Settings<\/a>/);
			expect(html).not.toContain("Scan now");
			expect(html).not.toContain("No scans yet");
		}
	});

	it("with scans: the counters, Scan now in the header, and the receipt row", () => {
		const html = view();
		for (const label of ["Last scan", "Candidates", "Duplicates", "New leads"]) expect(html).toContain(label);
		expect(html).toContain(">Scan now<");
		expect(html).toContain("1 added, 0 duplicate(s)");
		expect(html).not.toContain("email(s)"); // no scanLog on this receipt: no per-email button
	});

	it("a failure is its own line", () => {
		const s = status();
		s.state = { ...s.state, failureCount: 2, lastFailureAt: "2026-11-07T06:00:00.000Z", lastFailureMessage: "Gmail 401" };
		expect(view({ status: s })).toContain("2 scan failure(s)");
		expect(view({ status: s })).toContain("Gmail 401");
	});
});

describe("Scans tab — the Jobs push outcome (#1605)", () => {
	const withPush = (reason: string | null, sent = 0) => status({ receipts: [receipt({ jobsPush: { sent, failed: 0, reason } })] });

	it("the newest completed scan not reaching Jobs shows the warning line, linked to Permissions", () => {
		const html = view({ status: withPush("not_connected") });
		expect(html).toContain("Leads are not reaching Jobs · ");
		expect(html).toMatch(/<a [^>]*href="\/instances\/inst-1\/permissions"[^>]*>Fix in Permissions<\/a>/);
		expect(html).toContain("not sent to Jobs: Jobs is not connected");
	});

	it("no_grant explains the row but is not an incident", () => {
		const html = view({ status: withPush("no_grant") });
		expect(html).toContain("not sent to Jobs: this agent has no Jobs grant");
		expect(html).not.toContain("Leads are not reaching Jobs");
	});

	it("a sent count shows on the row, with no warning", () => {
		const html = view({ status: withPush(null, 3) });
		expect(html).toContain("3 sent to Jobs");
		expect(html).not.toContain("Leads are not reaching Jobs");
	});

	it("an older API (no jobsPush) shows neither", () => {
		const html = view();
		expect(html).not.toContain("sent to Jobs");
		expect(html).not.toContain("Leads are not reaching Jobs");
	});
});

describe("Scans tab — the verification queue", () => {
	it("lists the queue with Verify now (waiting) and Verify again (unverifiable), and offers Triage in Data for an active lead only when Data is shown", () => {
		const queue = [verification(), verification({ leadId: "lead-2", state: "unverifiable", closedReason: "consent_expired" }), verification({ leadId: "lead-3", state: "active" })];
		const html = view({ verifications: queue });
		expect(html).toContain("Verify now");
		expect(html).toContain("Verify again");
		expect(html).toMatch(/<a [^>]*href="\/instances\/inst-1\/data\?lead=lead-3"[^>]*>Triage in Data<\/a>/);
		expect(view({ verifications: queue, hasData: false })).not.toContain("Triage in Data");
	});
});

describe("Settings → Agent one-liner", () => {
	const line = (s: GmailScoutStatus | null, failed = false) => renderToStaticMarkup(createElement(MemoryRouter, null, createElement(ScanSummaryLine, { instanceId: "inst-1", summary: scanSummary({ status: s, failed }) })));
	const ok = (s: GmailScoutStatus) => line(s);

	it("renders the six states in precedence, each linking to the tab except Checking…", () => {
		const checking = line(null);
		expect(checking).toContain("Checking…");
		expect(checking).not.toContain("View scans");

		const failedLoad = line(null, true);
		expect(failedLoad).toContain("Couldn&#x27;t check · ");
		expect(failedLoad).toMatch(/<a [^>]*href="\/instances\/inst-1\/scans"[^>]*>View scans<\/a>/);

		const failedScan = status();
		failedScan.state = { ...failedScan.state, failureCount: 1, lastFailureAt: "2026-11-07T06:00:00.000Z" };
		expect(ok(failedScan)).toContain("Last scan failed ");
		expect(ok(failedScan)).toContain("text-warning");

		const jobs = ok(status({ receipts: [receipt({ jobsPush: { sent: 0, failed: 0, reason: "failed" } })] }));
		expect(jobs).toContain(", leads not reaching Jobs · ");
		expect(jobs).toContain("text-warning");

		const plain = ok(status());
		expect(plain).toMatch(/Last scan [^<]+ · <a [^>]*href="\/instances\/inst-1\/scans"/);
		expect(plain).not.toContain("text-warning");

		const none = ok(status({ state: { lastScanAt: null, candidateCount: 0, dedupeCount: 0, failureCount: 0, lastFailureAt: null, lastFailureMessage: null }, receipts: [] }));
		expect(none).toContain("No scans yet · ");
		expect(none).toContain("View scans");
	});
});
