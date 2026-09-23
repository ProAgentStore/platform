import { getRepo } from "./coding-store.js";
import type { CodingRepo } from "./coding-types.js";
import type { GitProviderId } from "./git-providers.js";
import type { Env } from "../types.js";

/**
 * What makes two bindings on one instance the SAME repository (#829).
 *
 * An instance may hold several distinct repos — that is supported. What is always wrong is two
 * rows for the identical repo: sessions resolve to one of them, and the other is by construction
 * stale (both production occurrences had one row `ready` with a live session and a twin stuck in
 * `cloning` or pointing at an empty folder, and `coding_loop_start` picked the broken one).
 *
 * The strongest identity available wins: a GitHub `owner/repo` (case-insensitive — GitHub is), else
 * another host's provider + slug, else the raw clone URL, else the local folder.
 */
export interface RepoIdentity {
	githubRepo?: string;
	provider?: GitProviderId;
	repoSlug?: string;
	cloneUrl?: string;
	workdir?: string;
}

/** The existing binding on this instance for the same repository, if there is one (#829). */
export async function findDuplicateBinding(
	env: Env,
	instanceId: string,
	userId: string,
	identity: RepoIdentity,
	excludeRepoId?: string,
): Promise<CodingRepo | null> {
	let clause: string;
	let args: string[];
	if (identity.githubRepo) {
		clause = "lower(github_repo) = lower(?4)";
		args = [identity.githubRepo];
	} else if (identity.repoSlug && identity.provider && identity.provider !== "local") {
		clause = "lower(repo_slug) = lower(?4) AND provider = ?5";
		args = [identity.repoSlug, identity.provider];
	} else if (identity.cloneUrl) {
		clause = "clone_url = ?4";
		args = [identity.cloneUrl];
	} else if (identity.workdir) {
		clause = "workdir = ?4";
		args = [identity.workdir];
	} else {
		return null;
	}
	const row = await env.DB.prepare(
		`SELECT id FROM coding_repos WHERE instance_id = ?1 AND user_id = ?2 AND id <> ?3 AND ${clause} ORDER BY created_at ASC LIMIT 1`,
	)
		.bind(instanceId, userId, excludeRepoId ?? "", ...args)
		.first<{ id: string }>();
	return row ? getRepo(env, instanceId, userId, row.id) : null;
}

/** The unique indexes of migration 0156 refused a write — the race the pre-check cannot close. */
export function isUniqueViolation(err: unknown): boolean {
	return /UNIQUE constraint failed/i.test(err instanceof Error ? err.message : String(err));
}
