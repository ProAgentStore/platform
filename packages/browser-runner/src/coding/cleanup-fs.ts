/**
 * The filesystem half of post-run cleanup (#1265): per-run temp folders, git worktrees a run created, the disk
 * reading, and cache/build-output pruning. Split from cleanup.ts (the decisions and the manager) so each stays
 * readable; cleanup.ts re-exports everything here, so callers import from one place.
 *
 * Every function takes its system calls (`statfs`, `git`, the command runner) as parameters with real defaults,
 * so the promises — only a direct child of <base>/tmp is ever removed, a dirty worktree is never forced, only
 * git-ignored build outputs go, a checkout a live session uses is untouched — are tested without a real disk.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, statfsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// ── 4. Per-run temp folders and worktrees ───────────────────────────────────────────────────

const safeId = (id: string) => id.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80);

/** `<runner config dir>/tmp/<session>` — a run's TMPDIR. */
export function sessionTmpDir(baseDir: string, sessionId: string): string {
	return join(baseDir, "tmp", safeId(sessionId));
}

export function createSessionTmp(baseDir: string, sessionId: string): string | null {
	const dir = sessionTmpDir(baseDir, sessionId);
	try {
		mkdirSync(dir, { recursive: true });
		return dir;
	} catch {
		return null; // an unwritable config dir costs the isolation, not the run
	}
}

/** Remove a run's temp folder. Only ever a direct child of `<baseDir>/tmp`. */
export function removeSessionTmp(baseDir: string, sessionId: string): boolean {
	const dir = sessionTmpDir(baseDir, sessionId);
	if (dirname(dir) !== join(baseDir, "tmp")) return false;
	try {
		rmSync(dir, { recursive: true, force: true });
		return true;
	} catch {
		return false;
	}
}

/** Runner temp folders untouched for `olderThanMs` and not belonging to a live session (harsh's 24h sweep). */
export function sweepOldSessionTmp(baseDir: string, olderThanMs: number, liveIds: ReadonlySet<string>, now: number = Date.now()): string[] {
	const root = join(baseDir, "tmp");
	const removed: string[] = [];
	let names: string[] = [];
	try {
		names = readdirSync(root);
	} catch {
		return removed;
	}
	for (const name of names) {
		if (liveIds.has(name)) continue;
		const dir = join(root, name);
		try {
			if (now - statSync(dir).mtimeMs < olderThanMs) continue;
			rmSync(dir, { recursive: true, force: true });
			removed.push(dir);
		} catch {
			// best effort
		}
	}
	return removed;
}

export type Git = (cwd: string, args: string[]) => { ok: boolean; out: string };

export const realGit: Git = (cwd, args) => {
	try {
		return { ok: true, out: execFileSync("git", args, { cwd, encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 8 * 1024 * 1024 }) };
	} catch {
		return { ok: false, out: "" };
	}
};

/** Absolute paths of a checkout's worktrees, the main one first. */
export function listWorktrees(workDir: string, git: Git = realGit): string[] {
	const r = git(workDir, ["worktree", "list", "--porcelain"]);
	return r.ok ? r.out.split("\n").flatMap((l) => (l.startsWith("worktree ") ? [l.slice(9).trim()] : [])) : [];
}

/**
 * Remove the worktrees a run ADDED (anything not in `before`, never the checkout itself). `git worktree
 * remove` without --force refuses a worktree with uncommitted changes, which is exactly the promise: a
 * dirty worktree is left in place and reported, never deleted.
 */
export function removeNewWorktrees(workDir: string, before: readonly string[], git: Git = realGit): { removed: string[]; kept: string[] } {
	const removed: string[] = [];
	const kept: string[] = [];
	for (const path of listWorktrees(workDir, git)) {
		if (path === workDir || before.includes(path)) continue;
		(git(workDir, ["worktree", "remove", path]).ok ? removed : kept).push(path);
	}
	if (removed.length || kept.length) git(workDir, ["worktree", "prune"]);
	return { removed, kept };
}

// ── +. Disk and caches ──────────────────────────────────────────────────────────────────────

export const DISK_PRUNE_THRESHOLD = 0.9;

export function diskUsedFraction(path: string, statfs: typeof statfsSync = statfsSync): number | null {
	try {
		const s = statfs(path);
		const total = Number(s.blocks) * Number(s.bsize);
		return total > 0 ? 1 - (Number(s.bavail) * Number(s.bsize)) / total : null;
	} catch {
		return null;
	}
}

export function freeBytes(path: string, statfs: typeof statfsSync = statfsSync): number | null {
	try {
		const s = statfs(path);
		return Number(s.bavail) * Number(s.bsize);
	} catch {
		return null;
	}
}

/** Build outputs that are safe to delete when (and only when) git ignores them. */
export const BUILD_OUTPUT_DIRS = ["dist", "build", ".next", ".nuxt", ".turbo", ".svelte-kit", ".vite", ".parcel-cache"];

export interface PruneResult {
	prunedCaches: string[];
	removedOutputs: string[];
	skipped: string[];
}

/**
 * Prune package caches and ignored build outputs under the runner's checkouts. Limited to those, on
 * purpose: never a source file, never a tracked path, never a checkout a live session is using.
 */
export function pruneCaches(opts: { reposBaseDir: string; busyDirs: readonly string[]; home?: string; run?: (cmd: string, args: string[]) => boolean; git?: Git }): PruneResult {
	const home = opts.home ?? homedir();
	const git = opts.git ?? realGit;
	const run =
		opts.run ??
		((cmd, args) => {
			try {
				execFileSync(cmd, args, { stdio: "ignore", timeout: 180_000 });
				return true;
			} catch {
				return false;
			}
		});
	const result: PruneResult = { prunedCaches: [], removedOutputs: [], skipped: [] };
	for (const [name, cmd, args] of [["pnpm store", "pnpm", ["store", "prune"]], ["npm cache", "npm", ["cache", "clean", "--force"]]] as const) {
		if (run(cmd, [...args])) result.prunedCaches.push(name);
	}
	const derived = join(home, "Library", "Developer", "Xcode", "DerivedData");
	if (process.platform === "darwin" && existsSync(derived)) {
		try {
			rmSync(derived, { recursive: true, force: true });
			result.prunedCaches.push("Xcode DerivedData");
		} catch {
			result.skipped.push(derived);
		}
	}
	let repos: string[] = [];
	try {
		repos = readdirSync(opts.reposBaseDir).map((n) => join(opts.reposBaseDir, n));
	} catch {
		return result;
	}
	for (const repo of repos) {
		if (opts.busyDirs.includes(repo) || !existsSync(join(repo, ".git"))) continue;
		for (const name of BUILD_OUTPUT_DIRS) {
			const target = join(repo, name);
			if (!existsSync(target)) continue;
			// Ignored by git = not source and not uncommitted work. Anything else stays.
			if (!git(repo, ["check-ignore", "-q", name]).ok) {
				result.skipped.push(target);
				continue;
			}
			try {
				rmSync(target, { recursive: true, force: true });
				result.removedOutputs.push(target);
			} catch {
				result.skipped.push(target);
			}
		}
	}
	return result;
}
