/**
 * The cloud's side of the PR-merge evidence contract (#1350, `merge.v === 1`).
 *
 * The runner reports what GitHub told it about a completed, synchronous `gh pr merge`
 * (packages/browser-runner/src/coding/merge-evidence.ts). That payload crosses a relay from a machine the platform
 * does not control, so it is INPUT, never proof: this module validates its shape strictly, and the queue tick then
 * re-reads the pull request and merge commit from GitHub with the owner's own credential before any note posts.
 *
 * A runner that predates the contract sends no `merge` at all. That is not "a merge with no details", it is a gap, and
 * it holds the note (hold code `pr_merge_old_runner`) instead of being filled in from the branch HEAD.
 */
export type MergeMethod = "merge" | "squash" | "rebase";

export interface MergeEvidence {
	v: 1;
	repo: string;
	pr: number;
	baseRef: string;
	method: MergeMethod;
	beforeSha: string;
	afterSha: string;
	mergedAt: string;
	mergedBy: string;
	actor: string;
}

/** Why the runner could not prove a merge it saw succeed (mirrors the runner's `MergeUnverified`). */
export const MERGE_UNVERIFIED = ["auto", "scheduled", "unrecognized_output", "not_merged", "wrong_branch", "method_unknown", "method_mismatch", "actor_mismatch", "unreadable", "malformed"] as const;
export type MergeUnverified = (typeof MERGE_UNVERIFIED)[number];

const FULL_SHA = /^[0-9a-f]{40}$/;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/;
const BRANCH = /^[A-Za-z0-9._/-]{1,200}$/;
const REPO = /^[\w.-]{1,100}\/[\w.-]{1,100}$/;

/** A runner-reported `merge` object that is exactly the v1 contract, or null. Nothing is trimmed, defaulted or guessed. */
export function parseMergeEvidence(raw: unknown): MergeEvidence | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const m = raw as Record<string, unknown>;
	if (m.v !== 1) return null;
	const sha = (v: unknown) => (typeof v === "string" && FULL_SHA.test(v.toLowerCase()) ? v.toLowerCase() : null);
	const before = sha(m.beforeSha);
	const after = sha(m.afterSha);
	if (
		typeof m.repo !== "string" || !REPO.test(m.repo) ||
		!Number.isSafeInteger(m.pr) || (m.pr as number) < 1 ||
		typeof m.baseRef !== "string" || !BRANCH.test(m.baseRef) ||
		(m.method !== "merge" && m.method !== "squash" && m.method !== "rebase") ||
		!before || !after || before === after ||
		typeof m.mergedAt !== "string" || !Number.isFinite(Date.parse(m.mergedAt)) ||
		typeof m.mergedBy !== "string" || !LOGIN.test(m.mergedBy) ||
		typeof m.actor !== "string" || !LOGIN.test(m.actor)
	) return null;
	return { v: 1, repo: m.repo, pr: m.pr as number, baseRef: m.baseRef, method: m.method, beforeSha: before, afterSha: after, mergedAt: m.mergedAt, mergedBy: m.mergedBy, actor: m.actor };
}

export const isMergeUnverified = (v: unknown): v is MergeUnverified => typeof v === "string" && (MERGE_UNVERIFIED as readonly string[]).includes(v);

/** `gh pr merge … --auto` (or the merge queue) asks for a merge later; the command line alone says so. */
export const commandSchedulesMerge = (command: string): boolean => /\bgh\s+pr\s+merge\b[^&|;\n]*\s--(?:auto|merge-queue)\b/.test(command);
