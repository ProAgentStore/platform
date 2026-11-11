import type { Page } from "@playwright/test";

/**
 * The API a Gmail Scout's Scans tab (#1591) and Settings → Agent source line read, answered locally. It handles only
 * `/v1/instances/inst-1/gmail-scout/*` and `/job-leads/*browser-verification*` and `fallback()`s everything else, so it
 * layers over any other mock: register that one first (Playwright runs the LAST registered route first).
 *
 * `requests` records `METHOD /path?query` for everything it answered; `state` is mutable so a Scan now or a Verify is
 * visible on the re-read that follows.
 */
const API = "https://api.proagentstore.online";
const PREFIX = "/v1/instances/inst-1";

export const SCOUT_RECEIPT = {
	id: "scan-1", instanceId: "inst-1", trigger: "schedule", triggeredBy: null, status: "completed", startedAt: "2026-11-07T05:42:00.000Z", completedAt: "2026-11-07T05:42:05.000Z",
	hits: 2, candidates: 1, added: 1, deduped: 0, rejected: { digest: 1 }, awaitingBrowserVerification: 1, jobsPush: null, errorMessage: null, lastMessageId: "m-job",
	query: "(subject:(job)) newer_than:2d", window: { newerThanDays: 2 }, scanLog: { path: `${PREFIX}/gmail-scout/scan-log?scan_id=scan-1`, tool: "gmail_scout_scan_log", scan_id: "scan-1" }, handoff: "none",
};

const verification = (leadId: string, state: string, over: Record<string, unknown> = {}) => ({
	leadId, canonicalUrl: `https://www.seek.com.au/job/${leadId}`, expectedTitle: `Platform Engineer ${leadId}`, expectedCompany: "Acme Pty Ltd", state, attempts: 0, nextAttemptAt: "2026-11-07T06:00:00.000Z", lastOutcome: null, lastDetail: null, ...over,
});

export interface ScansMockOptions {
	/** `GET …/gmail-scout/status` answers 500 this many times before it answers. */
	statusFailures?: number;
	enabled?: boolean;
	receipts?: unknown[];
	lastScanAt?: string | null;
	failureCount?: number;
	lastFailureAt?: string | null;
	verifications?: Array<Record<string, unknown>>;
}

/** A scan, a digest, a Jobs problem and every verification state a row can be in. */
export function seededScans(): ScansMockOptions {
	return {
		receipts: [{ ...SCOUT_RECEIPT, jobsPush: { sent: 0, failed: 0, reason: "not_connected" } }, { ...SCOUT_RECEIPT, id: "scan-0", startedAt: "2026-11-06T05:42:00.000Z", trigger: "on_demand", jobsPush: { sent: 3, failed: 0, reason: null } }],
		lastScanAt: "2026-11-07T05:42:00.000Z",
		verifications: [verification("lead-wait", "awaiting"), verification("lead-closed", "unverifiable", { closedReason: "consent_expired" }), verification("lead-active", "active", { attempts: 1 })],
	};
}

export async function installScansRoutes(page: Page, opts: ScansMockOptions = seededScans()) {
	const requests: string[] = [];
	let failuresLeft = opts.statusFailures ?? 0;
	const receipts = [...(opts.receipts ?? [])] as Array<Record<string, unknown>>;
	const verifications = [...(opts.verifications ?? [])];
	let lastScanAt = opts.lastScanAt ?? null;

	await page.route(`${API}/**`, async (route) => {
		const req = route.request();
		const url = new URL(req.url());
		if (!url.pathname.startsWith(`${PREFIX}/gmail-scout/`) && !url.pathname.startsWith(`${PREFIX}/job-leads/`)) return route.fallback();
		const rest = url.pathname.slice(PREFIX.length);
		const method = req.method();
		const json = (data: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
		requests.push(`${method} ${rest}${url.search}`);

		if (rest === "/gmail-scout/status") {
			if (failuresLeft > 0) {
				failuresLeft--;
				return json({ error: "Gmail status unavailable" }, 500);
			}
			return json({
				config: { pinnedEmail: "owner@example.com", enabled: opts.enabled ?? true },
				state: { lastScanAt, candidateCount: 1, dedupeCount: 0, failureCount: opts.failureCount ?? 0, lastFailureAt: opts.lastFailureAt ?? null, lastFailureMessage: opts.failureCount ? "Gmail 401" : null },
				leadCount: 4, newLeadCount: 2, receipts,
			});
		}
		if (rest === "/gmail-scout/scan" && method === "POST") {
			const receipt = { ...SCOUT_RECEIPT, id: `scan-${receipts.length + 1}`, trigger: "on_demand", startedAt: "2026-11-08T01:00:00.000Z", jobsPush: { sent: 1, failed: 0, reason: null } };
			receipts.unshift(receipt);
			lastScanAt = receipt.startedAt;
			return json({ scan: { mailbox: "owner@example.com", candidates: 1, added: 1, deduped: 0, lastMessageId: "m", rejected: {}, receipt, reused: false, handoff: "none" } });
		}
		if (rest === "/gmail-scout/scan-log") return json({ scan: SCOUT_RECEIPT, total: 0, nextCursor: null, items: [] });
		if (rest === "/job-leads/browser-verifications") return json({ leads: verifications });
		const verify = rest.match(/^\/job-leads\/([^/]+)\/browser-verification$/);
		if (verify && method === "POST") {
			const v = verifications.find((x) => x.leadId === decodeURIComponent(verify[1]));
			if (v) Object.assign(v, { state: "dispatched" });
			return json({ state: "dispatched", lead: v });
		}
		return route.fallback();
	});
	return { requests };
}
