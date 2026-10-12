/**
 * The wire shape of Gmail-lead browser verification (#1030) and its list response — kept apart from
 * the dispatcher (`job-lead-browser-verification.ts`) so the console can compare its own copy against
 * it in `store/console/src/lib/types.test.ts` (#1045).
 */
import type { BrowserVerificationOutcome } from "./job-lead-triage.js";

export type VerificationState = "awaiting" | "dispatched" | "active" | "expired" | "mismatch" | "unverifiable" | "superseded";

export interface LeadVerification {
	instanceId: string;
	leadId: string;
	workKey: string | null;
	canonicalUrl: string;
	expectedTitle: string | null;
	expectedCompany: string | null;
	state: VerificationState;
	attempts: number;
	nextAttemptAt: string;
	awaitingSince: string;
	lastOutcome: BrowserVerificationOutcome | null;
	lastDetail: string | null;
	updatedAt: string;
}

/** `GET /v1/instances/:id/job-leads/browser-verifications` response. */
export interface LeadVerificationListResponse {
	leads: LeadVerification[];
	attempts: VerificationAttempt[];
}

export interface VerificationAttempt {
	id: string;
	leadId: string;
	attempt: number;
	runId: string | null;
	state: "dispatched" | "completed" | "no_runtime" | "refused";
	outcome: BrowserVerificationOutcome | null;
	detail: string | null;
	createdAt: string;
	completedAt: string | null;
}
