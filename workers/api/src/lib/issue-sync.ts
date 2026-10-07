/**
 * Keep a coder's issue cards in step with GitHub (#895) — a poll on the per-minute cron.
 *
 * The `commit-close` / `deploy-watch` pattern: a bounded batch of repos per tick, oldest-synced first so
 * the batch rotates over every repo, and a forward-only watermark (`coding_repos.issues_synced_since`).
 *
 *   - FIRST sync of a repo (no watermark): its OPEN issues become backlog tickets. Closed history is
 *     not imported — a board is about what is left to do, not an archive.
 *   - EVERY later sync: issues UPDATED since the watermark, closed ones included. An issue that already
 *     has a ticket gets its cache refreshed (so closing or relabelling it on GitHub moves its card); an
 *     open one with no ticket becomes backlog; a closed one with no ticket is left alone.
 *
 * Reads go through the conditional GitHub cache (an unchanged page is a 304). A repo GitHub cannot be
 * read for keeps its watermark — "unreadable" is not "nothing changed" — and is stamped so the batch
 * moves on. Never throws: the cron's other sweeps are independent failure domains.
 */
import type { Env } from "../types.js";
import { logError } from "./error-log.js";
import { listIssuesForSync } from "./github-issues.js";
import { issueCacheFrom, upsertIssueTicket } from "./issue-tickets.js";

/** Repos per tick. Each costs one GitHub request on an ordinary tick (usually a 304). */
export const ISSUE_SYNC_BATCH = 10;
/** Pages of 100 read per repo per tick — the first sync's seed, or a burst of updates. */
export const ISSUE_SYNC_MAX_PAGES = 2;

interface SyncRepo {
	id: string;
	instance_id: string;
	user_id: string;
	github_repo: string;
	issues_synced_since: string | null;
}

export interface RepoSyncResult {
	repoId: string;
	githubRepo: string;
	unreadable: boolean;
	created: number;
	updated: number;
	seen: number;
}

/** Sync one repo's issues into its instance's tickets. */
export async function syncRepoIssues(env: Env, repo: SyncRepo, now: number = Date.now()): Promise<RepoSyncResult> {
	const seeding = !repo.issues_synced_since;
	const out: RepoSyncResult = { repoId: repo.id, githubRepo: repo.github_repo, unreadable: false, created: 0, updated: 0, seen: 0 };
	let watermark = repo.issues_synced_since;
	for (let page = 1; page <= ISSUE_SYNC_MAX_PAGES; page++) {
		const res = await listIssuesForSync(env, repo.user_id, repo.github_repo, { state: seeding ? "open" : "all", since: repo.issues_synced_since, page });
		if (res.unreadable) {
			out.unreadable = page === 1;
			break;
		}
		for (const issue of res.issues) {
			out.seen++;
			if (!watermark || issue.updatedAt > watermark) watermark = issue.updatedAt;
			const has = await env.DB.prepare("SELECT 1 AS ok FROM tickets WHERE instance_id = ?1 AND user_id = ?2 AND repo_id = ?3 AND issue_number = ?4")
				.bind(repo.instance_id, repo.user_id, repo.id, issue.number)
				.first<{ ok: number }>();
			if (!has && issue.state !== "open") continue;
			const r = await upsertIssueTicket(env, repo.instance_id, repo.user_id, { repoId: repo.id, issueNumber: issue.number, cache: issueCacheFrom(repo.github_repo, issue), linkedBy: "sync" });
			if (r.created) out.created++;
			else out.updated++;
		}
		if (!res.hasMore) break;
	}
	// Stamped either way, so an unreadable repo does not pin the batch; the watermark only moves on a read.
	await env.DB.prepare("UPDATE coding_repos SET issues_synced_at = ?2, issues_synced_since = ?3 WHERE id = ?1")
		.bind(repo.id, now, out.unreadable ? repo.issues_synced_since : (watermark ?? new Date(now).toISOString()))
		.run();
	return out;
}

const REPOS_SQL = `SELECT r.id, r.instance_id, r.user_id, r.github_repo, r.issues_synced_since
	   FROM coding_repos r JOIN agent_instances i ON i.id = r.instance_id AND i.user_id = r.user_id
	  WHERE r.github_repo IS NOT NULL AND r.github_repo <> '' AND i.status = 'active'`;

/** Every GitHub-bound repo of one instance, now — `POST …/board/issues/sync`. */
export async function syncInstanceIssues(env: Env, instanceId: string, userId: string): Promise<RepoSyncResult[]> {
	const { results } = await env.DB.prepare(`${REPOS_SQL} AND r.instance_id = ?1 AND r.user_id = ?2`).bind(instanceId, userId).all<SyncRepo>();
	const out: RepoSyncResult[] = [];
	for (const repo of results ?? []) out.push(await syncRepoIssues(env, repo));
	return out;
}

/** The cron tick. Never throws. */
export async function runIssueSync(env: Env, now: number = Date.now()): Promise<void> {
	let repos: SyncRepo[] = [];
	try {
		const { results } = await env.DB.prepare(`${REPOS_SQL} ORDER BY COALESCE(r.issues_synced_at, 0) ASC LIMIT ?1`).bind(ISSUE_SYNC_BATCH).all<SyncRepo>();
		repos = results ?? [];
	} catch (err) {
		await logError(env, { source: "issue-sync", level: "warn", message: `issue sync could not read coding_repos: ${err instanceof Error ? err.message : String(err)}` }).catch(() => undefined);
		return;
	}
	for (const repo of repos) {
		try {
			await syncRepoIssues(env, repo, now);
		} catch (err) {
			await logError(env, {
				source: "issue-sync",
				level: "warn",
				message: `issue sync skipped ${repo.github_repo}: ${err instanceof Error ? err.message : String(err)}`,
				userId: repo.user_id,
				context: { repoId: repo.id, instanceId: repo.instance_id },
			}).catch(() => undefined);
		}
	}
}
