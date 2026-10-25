import type { Env } from "../types.js";

/**
 * Other instances of this owner that already have this GitHub repo registered (#1323). One coder per repo:
 * the lock is scoped by instance + repo id, so two coders on one repository do not hold each other's
 * lock and nothing else warns about it.
 */
export async function otherCodersOnRepo(env: Env, userId: string, instanceId: string, githubRepo: string): Promise<Array<{ instanceId: string; repoId: string }>> {
	const { results } = await env.DB.prepare("SELECT instance_id, id FROM coding_repos WHERE user_id = ?1 AND instance_id <> ?2 AND lower(github_repo) = lower(?3)")
		.bind(userId, instanceId, githubRepo)
		.all<{ instance_id: string; id: string }>();
	return (results ?? []).map((r) => ({ instanceId: r.instance_id, repoId: r.id }));
}

/** The warning to return with a new binding, or undefined when no other coder has the repo. */
export async function duplicateCoderWarning(env: Env, userId: string, instanceId: string, githubRepo: string | null | undefined): Promise<string | undefined> {
	if (!githubRepo) return undefined;
	const others = await otherCodersOnRepo(env, userId, instanceId, githubRepo).catch(() => []);
	if (!others.length) return undefined;
	return `${githubRepo} is also registered on ${others.length === 1 ? "another coder" : `${others.length} other coders`} (${[...new Set(others.map((o) => o.instanceId))].join(", ")}). Keep one coder per repository: their checkout locks do not cover each other, so two coders can work the same repo at once.`;
}
