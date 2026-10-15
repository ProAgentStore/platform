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

/**
 * Give a folderless GitHub binding its folder, in place — its id, instructions, sessions and timeline
 * stay (#884). Only while it still has no folder: a concurrent add that set one first wins, and this
 * answers null rather than moving that binding to a second folder.
 */
export async function attachWorkdir(env: Env, instanceId: string, repoId: string, workdir: string): Promise<CodingRepo | null> {
	const row = await env.DB.prepare(
		`UPDATE coding_repos SET workdir = ?3, updated_at = datetime('now')
		 WHERE id = ?1 AND instance_id = ?2 AND (workdir IS NULL OR trim(workdir) = '') RETURNING *`,
	)
		.bind(repoId, instanceId, workdir)
		.first<RepoRow>();
	return row ? toRepo(row) : null;
}

/**
 * The OTHER binding on this instance that already uses `path` as its folder, or null (#829, PR835).
 *
 * One checkout, one binding: the paired add refuses a folder another binding holds
 * (`routes/coding-repo-add.ts`), and moving a repo (`PUT /coding/repos/:id`) onto such a folder was
 * the way round it — leaving session and engine resolution two repos to choose between for one
 * directory. The repo being moved is never its own conflict: a respelling of its own path (a trailing
 * `/`) matches itself and is allowed.
 */
export async function folderHeldByAnother(env: Env, instanceId: string, repoId: string, path: string): Promise<CodingRepo | null> {
	const holder = await findRepoByWorkdir(env, instanceId, [path]);
	return holder && holder.id !== repoId ? holder : null;
}

/** The 409 body for a move onto a folder another binding holds — names that binding, as the add's refusal does. */
export function folderTakenRefusal(path: string, holder: CodingRepo): { error: string; existingId: string; existingName: string } {
	return {
		error: `\`${path}\` is already the folder of "${holder.name}" on this instance. Remove that binding first (coding_repo_remove), or choose another folder.`,
		existingId: holder.id,
		existingName: holder.name,
	};
}
