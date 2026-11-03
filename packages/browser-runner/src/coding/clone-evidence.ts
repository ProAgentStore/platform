/**
 * What a background clone's destination actually proves, for reconciliation after a crash or
 * forced restart (#1459) — never "a `.git` directory and an origin exist", which a clone that died
 * mid-transport leaves behind just as readily as a finished one.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

/** The same two URL shapes `cloneUrlFor` in `repo-clone-job.ts` builds — duplicated rather than
 *  imported, so this module (which that one imports, for reconciliation) never depends back on it. */
function candidateCloneUrls(slug: string): string[] {
	return [`https://github.com/${slug}.git`, `git@github.com:${slug}.git`];
}

export type CloneEvidence = "completed" | "incomplete";

function git(cwd: string, ...args: string[]): { status: number | null; stdout: string } {
	const env: NodeJS.ProcessEnv = { ...process.env, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0" };
	for (const key of Object.keys(env)) if (key.startsWith("GIT_") && key !== "GIT_TERMINAL_PROMPT") delete env[key];
	const result = spawnSync("git", args, { cwd, env, encoding: "utf8", timeout: 10_000 });
	return { status: result.error ? null : result.status, stdout: (result.stdout ?? "").trim() };
}

/** `origin` under either transport the machine might have used (#858's `auto`). */
function originMatches(url: string, slug: string): boolean {
	const normalized = url.replace(/\/$/, "").toLowerCase();
	return candidateCloneUrls(slug).some((candidate) => normalized === candidate.toLowerCase());
}

/**
 * `completed` only when EVERY piece of evidence a finished `git clone` must leave is present: no
 * stale lock from an operation that never finished, a resolvable `HEAD`, and `origin` naming the
 * exact repo this job was asked to clone — not merely some repo. Anything else, including the
 * directory not existing at all, is `incomplete`: never guessed into success.
 */
export function inspectCloneEvidence(path: string, slug: string): CloneEvidence {
	if (!existsSync(path)) return "incomplete";
	// A lock left behind means some git operation (the clone itself, or a later one) was
	// interrupted mid-write — the working tree cannot be trusted regardless of what else resolves.
	for (const lock of [".git/index.lock", ".git/HEAD.lock"]) if (existsSync(`${path}/${lock}`)) return "incomplete";
	const head = git(path, "rev-parse", "--verify", "HEAD");
	if (head.status !== 0 || !head.stdout) return "incomplete";
	const origin = git(path, "remote", "get-url", "origin");
	if (origin.status !== 0 || !originMatches(origin.stdout, slug)) return "incomplete";
	return "completed";
}
