import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * Repo/workdir helpers for the coding engine.
 *
 * These lived in `coding/tmux.ts` and have nothing to do with tmux — `ensureRepo` runs `git
 * clone`. The coding engine stopped using tmux when it moved to the structured stream-json
 * interface, so anyone cleaning up that module found its two most load-bearing functions
 * inside it (#247). Split out so the tmux module is only tmux, and only the terminal-operator
 * agents depend on it.
 */

/**
 * A safe, collision-resistant label derived from an arbitrary string.
 *
 * Named for tmux because that is where it started, but the coding engine uses it purely as a
 * display/identity label — no tmux target is derived from it (#247).
 */
export function sanitizeSessionName(label: string): string {
	return label.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "session";
}

/**
 * Ensure a repo is present at `dir`, cloning it from `cloneUrl` if not. Idempotent
 * — an existing checkout is left alone (no clobber). For private repos a GitHub
 * App installation token is injected as `x-access-token` into an https URL. The
 * coding CLI then runs in this directory.
 *
 * Returns the absolute working directory. Throws on clone failure so the caller
 * can surface it (a session can't start without its repo).
 */
export function ensureRepo(dir: string, opts: { cloneUrl?: string; branch?: string; token?: string } = {}): string {
	// A real checkout (has .git) is reused as-is.
	if (existsSync(join(dir, ".git"))) return dir;
	if (!opts.cloneUrl) {
		// No source to clone from — just make the directory the engine will run in.
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		return dir;
	}
	// The dir exists but has no `.git`. It could be a half-cloned/empty managed dir
	// (safe to clear) OR a real user directory the caller passed as an explicit workDir
	// (deleting it = data loss). NEVER recursively delete a non-empty non-git dir — refuse
	// instead, so a mis-wired workDir+cloneUrl can't nuke a user's files. An empty dir is
	// fine to remove (git clone needs an empty/absent target).
	if (existsSync(dir)) {
		const entries = readdirSync(dir);
		if (entries.length > 0) {
			throw new Error(`Refusing to clone into non-empty directory "${dir}" (no .git found) — move it aside or point at an empty path.`);
		}
		rmSync(dir, { recursive: true, force: true });
	}
	let url = opts.cloneUrl;
	if (opts.token && /^https:\/\//.test(url)) {
		url = url.replace(/^https:\/\//, `https://x-access-token:${opts.token}@`);
	}
	const args = ["clone", "--depth", "1"];
	if (opts.branch) args.push("--branch", opts.branch);
	args.push(url, dir);
	execFileSync("git", args, { stdio: "pipe", timeout: 180_000 });
	return dir;
}
