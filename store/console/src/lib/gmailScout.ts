/** Why a scanned message did not become a lead (#1023) — a category, never the message. */
export type GmailScoutRejection = "missing_fields" | "stale" | "security_alert" | "digest" | "multiple_listings" | "no_specific_job_url" | "no_work_key" | "redirect_unresolved" | "posting_not_live" | "posting_unverifiable" | "posting_mismatch";

/** One Gmail Scout scan receipt (#1023), scheduled or on demand. */
export interface GmailScoutScanReceipt {
	id: string;
	instanceId: string;
	trigger: "schedule" | "on_demand";
	triggeredBy: string | null;
	status: "running" | "completed" | "failed";
	startedAt: string;
	completedAt: string | null;
	hits: number | null;
	candidates: number | null;
	added: number | null;
	deduped: number | null;
	rejected: Partial<Record<GmailScoutRejection, number>>;
	/** Leads the server could not check, waiting for browser verification (#1030). Absent on an older API. */
	awaitingBrowserVerification?: number | null;
	errorMessage: string | null;
	lastMessageId: string | null;
	handoff: "none";
}

/** One completed Gmail Job Search Scout ingest, returned by its manual scan endpoint. */
export interface GmailScoutScanResult {
	mailbox: string | null;
	candidates: number;
	added: number;
	deduped: number;
	lastMessageId: string | null;
	rejected: Partial<Record<GmailScoutRejection, number>>;
	receipt: GmailScoutScanReceipt;
	reused: boolean;
	handoff: "none";
}

/** `POST /v1/instances/:id/gmail-scout/scan` response. */
export interface GmailScoutScanResponse {
	scan: GmailScoutScanResult;
}

const REASON: Record<GmailScoutRejection, string> = {
	missing_fields: "incomplete",
	stale: "too old",
	security_alert: "account/security mail",
	digest: "digest or summary",
	multiple_listings: "several jobs in one email",
	no_specific_job_url: "no specific job link",
	no_work_key: "unidentifiable job",
	redirect_unresolved: "job link could not be resolved",
	posting_not_live: "posting no longer live",
	posting_unverifiable: "posting could not be checked",
	posting_mismatch: "posting did not match the email",
};

/** "3 digest or summary, 1 too old" — what a scan skipped, in plain words; empty when nothing was skipped. */
export function rejectionSummary(rejected: GmailScoutScanReceipt["rejected"] | undefined): string {
	return Object.entries(rejected ?? {})
		.filter(([, n]) => (n ?? 0) > 0)
		.map(([reason, n]) => `${n} ${REASON[reason as GmailScoutRejection] ?? reason.replace(/_/g, " ")}`)
		.join(", ");
}

/** The one-line result of "Scan now": what it added and skipped, that it handed nothing on, or that one was already running. */
export function scanNowMessage(scan: GmailScoutScanResult): string {
	if (scan.reused) return "A scan is already running for this Scout — showing that one.";
	const skipped = rejectionSummary(scan.rejected);
	return `Scan complete: ${scan.added} lead(s) added as unverified, ${scan.deduped} duplicate(s) skipped${skipped ? `, ${skipped} not a job lead` : ""}. Nothing was sent to the Tailor or Runner.`;
}

// ── Browser verification of Gmail leads (#1030) — the same rows MCP's job_lead_browser_verifications reads ──

export type LeadVerificationState = "awaiting" | "dispatched" | "active" | "expired" | "mismatch" | "unverifiable" | "superseded";

export interface LeadVerification {
	leadId: string;
	canonicalUrl: string;
	expectedTitle: string | null;
	expectedCompany: string | null;
	state: LeadVerificationState;
	attempts: number;
	nextAttemptAt: string;
	lastOutcome: string | null;
	lastDetail: string | null;
}

const STATE_WORDS: Record<LeadVerificationState, string> = {
	awaiting: "waiting for the browser",
	dispatched: "being checked in the browser",
	active: "verified active — ready to triage",
	expired: "expired — closed",
	mismatch: "a different job — closed",
	unverifiable: "could not be verified",
	superseded: "you decided before the check finished",
};

/** One lead's verification, in words, and whether "Verify now" applies. */
export function leadVerificationLine(v: LeadVerification): { text: string; tone: "ok" | "warn" | "muted"; canVerifyNow: boolean } {
	const job = v.expectedTitle ? `${v.expectedTitle}${v.expectedCompany ? ` · ${v.expectedCompany}` : ""}` : "Job lead";
	const tries = v.attempts ? ` (attempt ${v.attempts})` : "";
	return {
		text: `${job}: ${STATE_WORDS[v.state]}${tries}.`,
		tone: v.state === "active" ? "ok" : v.state === "awaiting" || v.state === "dispatched" ? "warn" : "muted",
		canVerifyNow: v.state === "awaiting",
	};
}
