import { describe, expect, it } from "vitest";
import { type GmailScoutScanReceipt, type GmailScoutStatus, type GmailScoutScanResult, jobsPushLine, leadsNotReachingJobs, rejectionSummary, scanLogVerdict, scanNowMessage, scanSummary, scanTime } from "./gmailScout";

const scan = (over: Partial<GmailScoutScanResult> = {}): GmailScoutScanResult => ({
	mailbox: "m", candidates: 2, added: 1, deduped: 1, lastMessageId: null, rejected: {}, reused: false, handoff: "none",
	receipt: { id: "r1", instanceId: "i1", trigger: "on_demand", triggeredBy: "u1", status: "completed", startedAt: "", completedAt: null, hits: 2, candidates: 2, added: 1, deduped: 1, rejected: {}, errorMessage: null, lastMessageId: null, handoff: "none" },
	...over,
});

describe("Scan now's result, in plain words (#1023)", () => {
	it("says what was added, skipped and why — and that nothing went to the Tailor or Runner", () => {
		expect(scanNowMessage(scan({ rejected: { digest: 3, stale: 1 } }))).toBe("Scan complete: 1 lead(s) added as unverified, 1 duplicate(s) skipped, 3 digest naming no job, 1 too old not a job lead. Nothing was sent to the Tailor or Runner.");
		expect(scanNowMessage(scan())).toBe("Scan complete: 1 lead(s) added as unverified, 1 duplicate(s) skipped. Nothing was sent to the Tailor or Runner.");
	});
	it("a scan already running says so instead of claiming a result", () => {
		expect(scanNowMessage(scan({ reused: true }))).toMatch(/already running/);
	});
	it("summarises rejection reasons and ignores zero counts", () => {
		expect(rejectionSummary({ multiple_listings: 2, no_specific_job_url: 0 })).toBe("2 several jobs, none identifiable");
		expect(rejectionSummary(undefined)).toBe("");
	});
});

describe("a logged email's verdict, in plain words (#1247)", () => {
	it("names the decision and what the email was taken for, toned by outcome", () => {
		expect(scanLogVerdict({ decision: "added", classification: "single_posting" })).toEqual({ text: "Added · single posting", tone: "ok" });
		expect(scanLogVerdict({ decision: "awaiting_browser_verification", classification: "single_posting" })).toEqual({ text: "Added — awaiting browser check · single posting", tone: "warn" });
		expect(scanLogVerdict({ decision: "deduped", classification: "duplicate" }).text).toBe("Duplicate · duplicate");
		expect(scanLogVerdict({ decision: "rejected", classification: "digest" })).toEqual({ text: "Not taken · digest", tone: "muted" });
		expect(scanLogVerdict({ decision: "rejected", classification: "non_job" }).text).toBe("Not taken · not a job alert");
	});
});

describe("scanTime (#1597)", () => {
	it("shows one string for the same instant under a non-UTC TZ", () => {
		const prev = process.env.TZ;
		process.env.TZ = "Australia/Sydney";
		try {
			const lastScanAt = "2026-11-07T05:42:00.000Z";
			const receiptStartedAt = "2026-11-07T05:42:00.000Z";
			expect(scanTime(lastScanAt)).toBe(scanTime(receiptStartedAt));
			// The old bug: zone-less text parsed as local shows the UTC digits unchanged.
			expect(scanTime(lastScanAt)).not.toBe(new Date("2026-11-07T05:42:00").toLocaleString());
		} finally {
			if (prev === undefined) delete process.env.TZ; else process.env.TZ = prev;
		}
	});
});

const receipt = (over: Partial<GmailScoutScanReceipt> = {}): GmailScoutScanReceipt => ({ ...scan().receipt, startedAt: "2026-11-07T05:42:00.000Z", ...over });

describe("jobsPushLine — whether a scan's leads reached Jobs (#1591, #1605)", () => {
	it("says why nothing was sent, for every reason the API sends", () => {
		const words = {
			not_connected: "Jobs is not connected",
			ambiguous: "more than one Jobs account is connected",
			pinned_account_gone: "the chosen Jobs account is gone",
			failed: "the Jobs call failed",
			no_grant: "this agent has no Jobs grant",
		};
		for (const [reason, text] of Object.entries(words)) {
			expect(jobsPushLine(receipt({ jobsPush: { sent: 0, failed: 0, reason } }))).toBe(`not sent to Jobs: ${text}`);
		}
	});
	it("counts what was sent, and says both when a push was partial", () => {
		expect(jobsPushLine(receipt({ jobsPush: { sent: 3, failed: 0, reason: null } }))).toBe("3 sent to Jobs");
		expect(jobsPushLine(receipt({ jobsPush: { sent: 2, failed: 1, reason: "failed" } }))).toBe("2 sent to Jobs · not sent to Jobs: the Jobs call failed");
	});
	it("is empty when nothing was pushed, before a push ran, and on an older API", () => {
		expect(jobsPushLine(receipt({ jobsPush: { sent: 0, failed: 0, reason: null } }))).toBe("");
		expect(jobsPushLine(receipt({ jobsPush: null }))).toBe("");
		expect(jobsPushLine(receipt())).toBe("");
	});
	it("names an unknown reason rather than hiding it", () => {
		expect(jobsPushLine(receipt({ jobsPush: { sent: 0, failed: 0, reason: "quota_hit" } }))).toBe("not sent to Jobs: quota hit");
	});
});

describe("leadsNotReachingJobs — only the newest completed scan, only a fixable reason", () => {
	const push = (reason: string | null) => ({ sent: 0, failed: 0, reason });
	it("is true for the four incident reasons and false for no_grant, a clean push and none", () => {
		for (const reason of ["not_connected", "ambiguous", "pinned_account_gone", "failed"]) expect(leadsNotReachingJobs([receipt({ jobsPush: push(reason) })]), reason).toBe(true);
		for (const reason of ["no_grant", null]) expect(leadsNotReachingJobs([receipt({ jobsPush: push(reason) })]), String(reason)).toBe(false);
		expect(leadsNotReachingJobs([receipt()])).toBe(false);
		expect(leadsNotReachingJobs(undefined)).toBe(false);
	});
	it("reads the newest completed receipt, skipping one that is running or failed, and ignores an older incident", () => {
		const old = receipt({ id: "old", startedAt: "2026-11-06T00:00:00.000Z", jobsPush: push("not_connected") });
		const failedNewer = receipt({ id: "f", status: "failed", startedAt: "2026-11-08T00:00:00.000Z", jobsPush: push(null) });
		expect(leadsNotReachingJobs([failedNewer, receipt({ jobsPush: push("failed") }), old])).toBe(true);
		expect(leadsNotReachingJobs([failedNewer, receipt({ jobsPush: push(null) }), old])).toBe(false);
	});
});

describe("scanSummary — the one line Settings → Agent shows of the scans (#1591)", () => {
	const state = { lastScanAt: "2026-11-07T05:42:00.000Z", candidateCount: 1, dedupeCount: 0, failureCount: 0, lastFailureAt: null, lastFailureMessage: null };
	const status = (over: { state?: Partial<GmailScoutStatus["state"]>; receipts?: GmailScoutScanReceipt[] } = {}): GmailScoutStatus => ({ config: { pinnedEmail: "m", enabled: true }, state: { ...state, ...over.state }, leadCount: 0, newLeadCount: 0, receipts: over.receipts });
	const at = scanTime("2026-11-07T05:42:00.000Z");

	it("1. never asserts a state before the status loaded", () => {
		expect(scanSummary({ status: null, failed: false })).toEqual({ text: "Checking…", tone: "muted", link: false });
	});
	it("2. says it could not check, with a way to the tab", () => {
		expect(scanSummary({ status: null, failed: true })).toEqual({ text: "Couldn't check", tone: "muted", link: true });
		expect(scanSummary({ status: status(), failed: true }).text).toBe("Couldn't check");
	});
	it("3. a failure at or after the last scan is a warning", () => {
		const failedAt = "2026-11-07T06:00:00.000Z";
		expect(scanSummary({ status: status({ state: { failureCount: 2, lastFailureAt: failedAt } }), failed: false })).toEqual({ text: `Last scan failed ${scanTime(failedAt)}`, tone: "warn", link: true });
		expect(scanSummary({ status: status({ state: { failureCount: 1, lastFailureAt: state.lastScanAt } }), failed: false }).tone).toBe("warn");
		expect(scanSummary({ status: status({ state: { lastScanAt: null, failureCount: 1, lastFailureAt: failedAt } }), failed: false }).text).toMatch(/^Last scan failed/);
	});
	it("3. an old failure before a good scan is not shown", () => {
		expect(scanSummary({ status: status({ state: { failureCount: 3, lastFailureAt: "2026-11-01T00:00:00.000Z" } }), failed: false }).text).toBe(`Last scan ${at}`);
	});
	it("3 outranks 4: a failed scan hides nothing behind a Jobs problem", () => {
		const s = status({ state: { failureCount: 1, lastFailureAt: "2026-11-07T06:00:00.000Z" }, receipts: [receipt({ jobsPush: { sent: 0, failed: 0, reason: "not_connected" } })] });
		expect(scanSummary({ status: s, failed: false }).text).toMatch(/^Last scan failed/);
	});
	it("4. leads not reaching Jobs is a warning", () => {
		const s = status({ receipts: [receipt({ jobsPush: { sent: 0, failed: 0, reason: "ambiguous" } })] });
		expect(scanSummary({ status: s, failed: false })).toEqual({ text: `Last scan ${at}, leads not reaching Jobs`, tone: "warn", link: true });
	});
	it("5. a plain last scan, also when only no_grant explains an unsent push", () => {
		expect(scanSummary({ status: status(), failed: false })).toEqual({ text: `Last scan ${at}`, tone: "muted", link: true });
		const s = status({ receipts: [receipt({ jobsPush: { sent: 0, failed: 0, reason: "no_grant" } })] });
		expect(scanSummary({ status: s, failed: false }).text).toBe(`Last scan ${at}`);
	});
	it("6. no scans yet", () => {
		expect(scanSummary({ status: status({ state: { lastScanAt: null }, receipts: [] }), failed: false })).toEqual({ text: "No scans yet", tone: "muted", link: true });
	});
});
