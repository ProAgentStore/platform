import { describe, expect, it } from "vitest";
import { type GmailScoutScanResult, rejectionSummary, scanNowMessage } from "./gmailScout";

const scan = (over: Partial<GmailScoutScanResult> = {}): GmailScoutScanResult => ({
	mailbox: "m", candidates: 2, added: 1, deduped: 1, lastMessageId: null, rejected: {}, reused: false, handoff: "none",
	receipt: { id: "r1", instanceId: "i1", trigger: "on_demand", triggeredBy: "u1", status: "completed", startedAt: "", completedAt: null, hits: 2, candidates: 2, added: 1, deduped: 1, rejected: {}, errorMessage: null, lastMessageId: null, handoff: "none" },
	...over,
});

describe("Scan now's result, in plain words (#1023)", () => {
	it("says what was added, skipped and why — and that nothing went to the Tailor or Runner", () => {
		expect(scanNowMessage(scan({ rejected: { digest: 3, stale: 1 } }))).toBe("Scan complete: 1 lead(s) added as unverified, 1 duplicate(s) skipped, 3 digest or summary, 1 too old not a job lead. Nothing was sent to the Tailor or Runner.");
		expect(scanNowMessage(scan())).toBe("Scan complete: 1 lead(s) added as unverified, 1 duplicate(s) skipped. Nothing was sent to the Tailor or Runner.");
	});
	it("a scan already running says so instead of claiming a result", () => {
		expect(scanNowMessage(scan({ reused: true }))).toMatch(/already running/);
	});
	it("summarises rejection reasons and ignores zero counts", () => {
		expect(rejectionSummary({ multiple_listings: 2, no_specific_job_url: 0 })).toBe("2 several jobs in one email");
		expect(rejectionSummary(undefined)).toBe("");
	});
});
