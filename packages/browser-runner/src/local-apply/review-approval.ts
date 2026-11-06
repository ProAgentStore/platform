/** A live review lease is execution continuity, not proof of absence of arbitrary Full-mode effects. */
import { RunnerInputError } from "../errors.js";
import type { LocalApplyReviewAuthorization, LocalApplyTaskEnvelope } from "./contract.js";
import type { PreparedUpload } from "./documents.js";

interface ReviewPage { isClosed(): boolean; url(): string }
export interface ReviewApprovalLease {
	checkpointId: string;
	expiresAt: number;
	budgetMs: number;
	page: ReviewPage;
	url: string;
	authorization?: LocalApplyReviewAuthorization;
}

export function reviewApprovalFailure(lease: ReviewApprovalLease | undefined, page: ReviewPage | null | undefined, now: number): string | null {
	if (!lease || lease.authorization) return null;
	if (now >= lease.expiresAt) return "The bounded owner-review approval wait expired.";
	try { if (!page || page !== lease.page || page.isClosed() || page.url() !== lease.url) return "The exact owner-review browser page is no longer available or its URL changed."; }
	catch { return "The exact owner-review browser page is unavailable."; }
	return null;
}

export function validateReviewAuthorization(raw: unknown, envelope: LocalApplyTaskEnvelope, artifact: (kind: "resume" | "cover_letter") => PreparedUpload | { error: string }): LocalApplyReviewAuthorization {
	const a = raw as Partial<LocalApplyReviewAuthorization> | null;
	const safe = (s: unknown): s is string => typeof s === "string" && /^[A-Za-z0-9_.:-]{1,300}$/.test(s);
	if (!a || !safe(a.id) || !safe(a.gateId) || a.instanceId !== envelope.instanceId || a.applicationId !== envelope.applicationId || !Array.isArray(a.artifacts) || a.artifacts.length !== envelope.artifacts.length) throw new RunnerInputError("A scoped submission authorization for this exact application is required.", 409);
	const seen = new Set<string>();
	for (const file of a.artifacts) {
		if (!file || seen.has(file.kind) || !envelope.artifacts.some((expected) => expected.kind === file.kind && expected.sha256 === file.sha256)) throw new RunnerInputError("The approved document identities do not match this run.", 409);
		seen.add(file.kind);
		const prepared = artifact(file.kind);
		if ("error" in prepared || (prepared.sourceSha256 ?? prepared.sha256) !== file.sha256) throw new RunnerInputError("An approved source or prepared PDF changed; submission remains unauthorized.", 409);
	}
	return { id: a.id, gateId: a.gateId, instanceId: a.instanceId, applicationId: a.applicationId, artifacts: a.artifacts.map(({ kind, sha256 }) => ({ kind, sha256 })) };
}

export function sameReviewAuthorization(a: LocalApplyReviewAuthorization, b: unknown): boolean {
	const other = b as LocalApplyReviewAuthorization | null;
	return !!other && a.id === other.id && a.gateId === other.gateId && a.instanceId === other.instanceId && a.applicationId === other.applicationId && Array.isArray(other.artifacts) && other.artifacts.length === a.artifacts.length && a.artifacts.every((file) => other.artifacts.filter((candidate) => candidate?.kind === file.kind && candidate.sha256 === file.sha256).length === 1);
}
