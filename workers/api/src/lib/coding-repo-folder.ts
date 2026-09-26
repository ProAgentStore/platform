/**
 * A coding repo looked up, and completed, by its FOLDER (#853 finding 10) — what the paired add
 * (`routes/coding-repo-add.ts`) needs so a checkout bound locally is finished in place rather than
 * bound a second time. Split out of `coding-store.ts`, whose row mapping it reuses.
 */
import type { Env } from "../types.js";
import type { CodingRepo } from "./coding-types.js";
import { type RepoRow, toRepo } from "./coding-store.js";

/**
 * The instance's binding for a folder, if it has one (#853 finding 10) — matched against every form
 * of the path the caller knows (as typed, as the machine resolved it), trailing slashes ignored.
 * Paths are not canonicalised beyond that: a `~/…` row and an absolute request meet only through the
 * resolved form, and two spellings through a symlink do not meet at all.
 */
export async function findRepoByWorkdir(env: Env, instanceId: string, paths: string[]): Promise<CodingRepo | null> {
	const forms = [...new Set(paths.map((p) => p.trim().replace(/\/+$/, "")).filter(Boolean))];
	if (forms.length === 0) return null;
	const row = await env.DB.prepare(
		`SELECT * FROM coding_repos WHERE instance_id = ?1 AND rtrim(workdir, '/') IN (${forms.map((_, i) => `?${i + 2}`).join(", ")}) ORDER BY updated_at DESC LIMIT 1`,
	)
		.bind(instanceId, ...forms)
		.first<RepoRow>();
	return row ? toRepo(row) : null;
}

/** Give a local-only binding its GitHub identity, in place — its id, sessions and timeline stay (#853 finding 10). */
export async function attachGithubIdentity(
	env: Env,
	instanceId: string,
	repoId: string,
	identity: { githubRepo: string; webUrl?: string; cloneUrl?: string },
): Promise<void> {
	await env.DB.prepare(
		`UPDATE coding_repos SET github_repo = ?3, provider = 'github', repo_slug = ?3, web_url = ?4, clone_url = ?5, updated_at = datetime('now')
		 WHERE id = ?1 AND instance_id = ?2 AND (github_repo IS NULL OR github_repo = '')`,
	)
		.bind(repoId, instanceId, identity.githubRepo, identity.webUrl ?? null, identity.cloneUrl ?? null)
		.run();
}
