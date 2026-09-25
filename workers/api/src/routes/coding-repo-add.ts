/**
 * The strict coding-repo add (#849) and the duplicate-binding answer every add shares (#829).
 * Split out of `coding-repos.ts`, which registers the route that calls into it.
 */
import type { Context } from "hono";
import { callRunner, getBoundRunnerConn, READ_TIMEOUT_MS } from "../lib/runner-client.js";
import { createRepo, findExistingRepoBinding, updateRepoClone } from "../lib/coding-store.js";
import { checkWorkdirVia } from "../lib/coding-workdir.js";
import { parseRepoRef } from "../lib/git-providers.js";
import { sqlTime } from "../lib/sql-time.js";

/** The 409 for an add that would bind a GitHub repo this instance already has (#829). */
export function duplicateBinding(c: Context, githubRepo: string, existing: { id: string; name: string }) {
	return c.json(
		{
			error: `${githubRepo} is already bound to this instance${existing.name ? ` as "${existing.name}"` : ""} — use that binding, or remove it first`,
			githubRepo,
			existingId: existing.id,
			existingName: existing.name,
		},
		409,
	);
}

/** D1 surfaces a unique-index violation only as message text. */
export function isUniqueViolation(e: unknown): boolean {
	return /UNIQUE constraint failed/i.test(e instanceof Error ? e.message : String(e));
}

/**
 * Add a coding repo with BOTH halves at once (#849): the local checkout the engine runs in AND
 * the GitHub identity every `github_*` tool and the routing hint key off.
 *
 * Before this, one `path` meant EITHER a folder OR an owner/repo, so a binding made over MCP was
 * always half a binding — GitHub-aware but never checked out (`cloning` forever), or checked out
 * but anonymous. Here nothing is stored until both halves are proven on the machine: the folder
 * is a real checkout, and its `origin` resolves to GitHub (matching `githubRepoIn` when given).
 * A missing half is refused by name — never defaulted, never dropped.
 */
export async function addPairedRepo(c: Context, instanceId: string, uid: string, name: string, localPath: string, githubRepoIn: string | undefined) {
	const refuse = (error: string) => c.json({ error }, 400);
	if (!localPath) {
		return refuse(
			`Missing the local workdir: a coding repo needs the folder of its checkout as well as ${githubRepoIn ? `\`${githubRepoIn}\`` : "its GitHub owner/repo"}. Pass the checkout's path (~/dev/...).`,
		);
	}
	const conn = await getBoundRunnerConn(c.env, instanceId, uid).catch(() => null);
	if (!conn) {
		return refuse(
			`No machine is connected, so \`${localPath}\` cannot be verified as a checkout nor its GitHub origin read. Run \`pags up\` on the machine that has it, then add the repo again.`,
		);
	}
	const verdict = await checkWorkdirVia(conn, localPath);
	if (verdict.state !== "ok") return refuse(`Invalid local workdir: ${verdict.detail}`);
	const remote = await callRunner<{ remote?: string | null }>(conn, "/coding/git-remote", { workDir: localPath }, { timeoutMs: READ_TIMEOUT_MS })
		.then((r) => r.remote ?? null)
		.catch(() => null);
	const ref = parseRepoRef(remote);
	if (ref?.provider !== "github" || !ref.slug) {
		return refuse(
			`Missing the GitHub origin: \`${localPath}\` has ${remote ? `origin \`${remote}\`, which is not a GitHub repository` : "no readable `origin` remote"}. A coding repo must be a checkout of a GitHub repo.`,
		);
	}
	if (githubRepoIn && githubRepoIn.toLowerCase() !== ref.slug.toLowerCase()) {
		return refuse(`\`${localPath}\` is a checkout of ${ref.slug}, not ${githubRepoIn} — pass the folder that holds ${githubRepoIn}, or omit github_repo.`);
	}
	const existing = await findExistingRepoBinding(c.env, instanceId, ref.slug);
	if (existing) return duplicateBinding(c, ref.slug, existing);
	const created = await createRepo(c.env, instanceId, uid, {
		name: name || ref.slug,
		workdir: localPath,
		githubRepo: ref.slug,
		provider: "github",
		repoSlug: ref.slug,
		webUrl: ref.webUrl || undefined,
		cloneUrl: ref.cloneUrl,
	}).catch((e: unknown) => {
		if (isUniqueViolation(e)) return null;
		throw e;
	});
	if (!created) {
		const dup = await findExistingRepoBinding(c.env, instanceId, ref.slug);
		return duplicateBinding(c, ref.slug, dup ?? { id: "", name: "" });
	}
	// The folder was looked at a moment ago — record that look, as every other verified path does.
	await updateRepoClone(c.env, created.id, { cloneStatus: "ready", cloneError: null, checkedNow: true });
	return c.json({ repo: { ...created, cloneStatus: "ready", cloneCheckedAt: sqlTime() } }, 201);
}
