/**
 * A repo-level admission blocker (#1515).
 *
 * A run that stops at the pre-flight sync gate (#801: a checkout that is dirty, behind upstream or on the wrong branch)
 * says nothing about its OBJECTIVE — the next one queued behind it meets the same condition. Draining the queue anyway
 * burned one entry per attempt (FAS #350, #351, #352 in one minute) while changing nothing. This module is the one place
 * that remembers the condition, so every drain can hold the queue behind it:
 *
 *   * {@link setRepoBlocker} — written when a (non-repair) run is blocked at the gate. One row per repo; a repeat refreshes it.
 *   * {@link readRepoBlocker} / {@link listRepoBlockers} — read by the drain (`objective-queue-start.ts`) and by the queue listing.
 *   * {@link clearRepoBlocker} — written when the checkout is put right: a repair run that finished, `stash_checkout` /
 *     `discard_checkout` that left it clean, or any run that passed the gate.
 *
 * Nothing here touches the checkout or the queue's entries: a blocked queue keeps every entry, in order, until the blocker
 * clears, and then drains one entry at a time exactly as before.
 */
import { clipMarked } from "./clip-marked.js";
import type { Env } from "../types.js";

export interface RepoBlocker {
	repoId: string;
	message: string;
	since: number | null;
	/** The run that was stopped at the gate, i.e. the one that discovered it. */
	runId: string | null;
}

const MAX_MESSAGE_CHARS = 600;

/** Record (or refresh) the blocker. Never throws: a blocker that cannot be written leaves today's behaviour, not a failed run. */
export async function setRepoBlocker(env: Env, input: { instanceId: string; userId: string; repoId: string; message: string; runId?: string | null; now?: number }): Promise<void> {
	try {
		await env.DB.prepare(
			"UPDATE coding_repos SET admission_blocker = ?4, admission_blocker_at = COALESCE(admission_blocker_at, ?5), admission_blocker_run_id = COALESCE(?6, admission_blocker_run_id) WHERE id = ?1 AND instance_id = ?2 AND user_id = ?3",
		)
			.bind(input.repoId, input.instanceId, input.userId, clipMarked(input.message, MAX_MESSAGE_CHARS), input.now ?? Date.now(), input.runId ?? null)
			.run();
	} catch {
		/* best effort */
	}
}

/** Clear the blocker. Returns whether there was one. Never throws. */
export async function clearRepoBlocker(env: Env, input: { instanceId: string; userId: string; repoId: string }): Promise<boolean> {
	try {
		const r = await env.DB.prepare(
			"UPDATE coding_repos SET admission_blocker = NULL, admission_blocker_at = NULL, admission_blocker_run_id = NULL WHERE id = ?1 AND instance_id = ?2 AND user_id = ?3 AND admission_blocker IS NOT NULL",
		)
			.bind(input.repoId, input.instanceId, input.userId)
			.run();
		return (r.meta?.changes ?? 0) > 0;
	} catch {
		return false;
	}
}

interface BlockerRow {
	id: string;
	admission_blocker: string;
	admission_blocker_at: number | null;
	admission_blocker_run_id: string | null;
}
const toBlocker = (r: BlockerRow): RepoBlocker => ({ repoId: r.id, message: r.admission_blocker, since: r.admission_blocker_at, runId: r.admission_blocker_run_id });

/** The blocker on one repo, or null. A failed read is NOT a blocker: the drain's own admission re-checks. */
export async function readRepoBlocker(env: Env, instanceId: string, repoId: string): Promise<RepoBlocker | null> {
	try {
		const r = await env.DB.prepare("SELECT id, admission_blocker, admission_blocker_at, admission_blocker_run_id FROM coding_repos WHERE id = ?1 AND instance_id = ?2 AND admission_blocker IS NOT NULL")
			.bind(repoId, instanceId)
			.first<BlockerRow>();
		return r ? toBlocker(r) : null;
	} catch {
		return null;
	}
}

/** Every blocked repo on an instance, for the queue listing. */
export async function listRepoBlockers(env: Env, instanceId: string, userId: string): Promise<RepoBlocker[]> {
	try {
		const r = await env.DB.prepare("SELECT id, admission_blocker, admission_blocker_at, admission_blocker_run_id FROM coding_repos WHERE instance_id = ?1 AND user_id = ?2 AND admission_blocker IS NOT NULL ORDER BY admission_blocker_at")
			.bind(instanceId, userId)
			.all<BlockerRow>();
		return (r.results ?? []).map(toBlocker);
	} catch {
		return [];
	}
}

/** The sentence a held drain reports: what blocks and what clears it. */
export function describeRepoBlocker(b: RepoBlocker): string {
	return `repo_blocked: ${b.message} The queue is holding its entries, in order, until the checkout is put right — start a repair run (coding_loop_start with repair_checkout: true), or use stash_checkout / discard_checkout on that repo. Nothing queued behind it was started or failed.`;
}

/**
 * Mark a run as stopped at the pre-flight (#1671): the run row and its history stay exactly as they were, but the per-issue failure
 * tallies skip it, because the objective was never executed. Never throws.
 */
export async function markRunPreflightBlocked(env: Env, runId: string): Promise<void> {
	try {
		await env.DB.prepare("UPDATE agent_loop_runs SET preflight_blocked = 1 WHERE run_id = ?1").bind(runId).run();
	} catch {
		/* best effort: an unmarked run is counted as before, never lost */
	}
}
