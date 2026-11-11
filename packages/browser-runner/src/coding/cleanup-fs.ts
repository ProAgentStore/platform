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
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync, statSync, statfsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// ── 4. Per-run temp folders and worktrees ───────────────────────────────────────────────────

const safeId = (id: string) => id.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80);

/**
 * #1565: a Unix domain socket binds through `sockaddr_un.sun_path`, which POSIX caps at
 * around 100-108 bytes depending on the platform (measured 104 on macOS, via `sizeof(struct
 * sockaddr_un.sun_path)`). `sessionTmpDir` below is nested under the user's home-based config dir
 * and leaves little headroom under that budget: on the real machine that hit this, `sessionTmpDir`
 * itself (`~/.config/proagentstore/browser-runner/tmp/csess_<uuid>`) measured 96 bytes — NOT at the
 * limit by itself, but tsx's own IPC subdirectory alone (`tsx-<euid>`, no filename yet) pushed the
 * combined path to exactly 104, the limit, before any filename was added; the full failing path
 * (that subdirectory plus a `<pid>.pipe` filename) measured 115 bytes. Reproduced directly: a
 * socket-using tool a session's engine spawns (tsx, esbuild, Vite, Playwright, …) that derives its
 * own IPC path from `$TMPDIR` then appends its OWN subdirectory and filename, and the combined path
 * silently collides with whatever the kernel's truncated prefix already names — `bind()` returns
 * `EADDRINUSE`, not the `ENAMETOOLONG` you would expect, and it happens on the FIRST bind, with no
 * live listener involved at all.
 *
 * `/tmp` is POSIX-conventional and short by construction for exactly this reason. A session's real
 * scratch content keeps living under `sessionTmpDir` (unchanged — the cleanup/sweep bookkeeping
 * below is keyed on that exact path); only what gets EXPORTED to a spawned engine as `TMPDIR` is
 * redirected here, short enough to leave any nested tool's own subdirectory and filename comfortable
 * headroom under the limit. The leaf name is a hash of the full session id, not a prefix slice of
 * it — slicing `csess_<uuid>` would spend most of the short budget on the fixed `csess_` prefix and
 * leave too little of the id's actual entropy to stay collision-safe across concurrent sessions.
 */
const SOCKET_SAFE_TMP_ROOT = "/tmp";
const SOCKET_SAFE_TOKEN_LEN = 16;

/**
 * The leaf hashes `(uid, baseDir, sessionId)`, not the session id alone. `/tmp` is shared across
 * every local user AND every runner installation on the machine — hashing the session id alone
 * would let two different runners (different `baseDir`s, e.g. two accounts, or two separately
 * configured runner installs) legitimately compute the SAME leaf for an unrelated session, and a
 * sweep acting on that leaf by name alone could then touch the OTHER runner's live directory.
 * Folding in `baseDir` (and `uid`, belt-and-suspenders) makes the name itself runner-scoped, on top
 * of the ownership check below.
 */
export function socketSafeTmpDir(baseDir: string, sessionId: string): string {
	const uid = typeof process.getuid === "function" ? process.getuid() : 0;
	// `JSON.stringify([...])`, not a space-joined template string: a delimiter-joined string is
	// ambiguous at its boundaries — `(uid, "/a b", "c")` and `(uid, "/a", "b c")` concatenate to the
	// identical "<uid> /a b c" and would hash to the same leaf for two genuinely different sessions.
	// JSON array encoding quotes and escapes every element independently — a literal NUL in an
	// element becomes an escape sequence in the JSON text, never an embedded raw byte — so two
	// different tuples can never canonicalize to the same input string.
	const token = createHash("sha1").update(JSON.stringify([uid, baseDir, sessionId])).digest("hex").slice(0, SOCKET_SAFE_TOKEN_LEN);
	return join(SOCKET_SAFE_TMP_ROOT, `pags-tmp-${token}`);
}

/**
 * `/tmp` is world-writable (sticky bit): a short, hash-derived name is NOT by itself proof the
 * directory is ours. Another local user could pre-create the exact path — as a plain directory
 * left open to everyone, or as a symlink pointing somewhere sensitive — before this session ever
 * claims it; `mkdirSync(dir, {recursive:true})` silently no-ops on an already-existing path without
 * changing its mode or following/rejecting a symlink. `lstatSync` (not `statSync`, which follows
 * symlinks) plus an explicit uid+mode check is what actually proves ownership: a symlink fails
 * `isDirectory()` outright, a directory owned by another uid is refused, and group/other access is
 * refused too, so a predictable name never becomes a write target or a traversal into someone
 * else's tree.
 */
function looksSafe(st: { isDirectory(): boolean; uid: number; mode: number }): boolean {
	if (!st.isDirectory()) return false; // rejects a symlink (even one pointing at a real dir) and any non-directory
	if (typeof process.getuid === "function" && st.uid !== process.getuid()) return false;
	return (st.mode & 0o077) === 0; // no group or other access
}

export function isOwnedSafeDir(path: string): boolean {
	try {
		return looksSafe(lstatSync(path));
	} catch {
		return false;
	}
}

export interface SocketSafeDirIdentity {
	dir: string;
	dev: number;
	ino: number;
}

/**
 * Creates the socket-safe TMPDIR and returns the identity (`{dev, ino}`) the caller needs to
 * revalidate it later, in one place — rather than the caller doing its own separate `lstat` right
 * after, which would leave a second, narrower TOCTOU gap of its own between this function returning
 * and that later call running. `mkdir`/`lstat` are injectable (real defaults) so the "directory
 * vanishes between create and stat" path — which must refuse cleanly, never throw into whatever
 * spawns an engine off the result — is exercised directly in a test, not left to timing luck.
 */
export function createSocketSafeTmp(
	baseDir: string,
	sessionId: string,
	deps: { mkdir?: typeof mkdirSync; lstat?: typeof lstatSync } = {},
): SocketSafeDirIdentity | null {
	// Windows named pipes (`\\?\pipe\<name>`) aren't addressed through `sockaddr_un.sun_path` at
	// all — the whole motivating collision in the comment above `SOCKET_SAFE_TMP_ROOT` is a POSIX
	// Unix-domain-socket problem that does not exist on Windows. Refuse here rather than mkdir a
	// `\tmp\...` path relative to whatever the current drive happens to be, which is not a
	// meaningful location on Windows and was never the thing this exists to fix. The caller
	// (`CleanupManager.engineEnv`) does not even reach this on win32 — see its own platform branch —
	// this guard exists so a direct caller gets a clean refusal instead of a wrong path.
	if (process.platform === "win32") return null;
	const mkdir = deps.mkdir ?? mkdirSync;
	const lstat = deps.lstat ?? lstatSync;
	const dir = socketSafeTmpDir(baseDir, sessionId);
	try {
		// Deliberately NOT `{recursive:true}`: the only ancestor is `/tmp`, which already exists, so
		// this is a single atomic create-or-fail. `{recursive:true}` treats an ALREADY-OCCUPIED path
		// as a silent, successful no-op — which is exactly how a pre-existing same-uid 0700 directory
		// (a crashed prior allocation nothing cleaned up, an unrelated private directory of the same
		// uid that coincidentally collides with this hash, or something planted) would get silently
		// ADOPTED here and later deleted on cleanup as if this very call had created it. `EEXIST`
		// below is the proof this call needs: only a directory THIS call itself just created, this
		// instant, is ever trusted enough to remove later — never one merely found already there,
		// however innocuous its ownership/mode looks. A caller's own legitimate REPEAT allocation for
		// the same session (the normal, expected case across more than one `engineEnv` call) is
		// handled one layer up, in `CleanupManager.engineEnv`, by reusing its own tracked value rather
		// than ever calling this a second time for a session it already holds one for.
		mkdir(dir, { mode: 0o700 });
	} catch {
		return null; // EEXIST, an unwritable /tmp, or anything else — all refused identically
	}
	try {
		// Same stat captures BOTH the "did it really come out the way we asked" ownership check
		// (defends against an exotic umask/mode-clamping surprise — never a substitute for the
		// atomicity above, which has already ruled out "something else was already here") and the
		// `{dev, ino}` identity a caller needs to safely reuse or remove this later.
		const st = lstat(dir);
		return looksSafe(st) ? { dir, dev: st.dev, ino: st.ino } : null;
	} catch {
		return null; // vanished between mkdir and stat — refuse cleanly, never throw into the caller
	}
}

/** Remove a session's socket-safe TMPDIR. Only ever a direct child of {@link SOCKET_SAFE_TMP_ROOT}, and only when it is actually ours. */
export function removeSocketSafeTmp(baseDir: string, sessionId: string): boolean {
	const dir = socketSafeTmpDir(baseDir, sessionId);
	if (dirname(dir) !== SOCKET_SAFE_TMP_ROOT) return false;
	if (!existsSync(dir)) return true; // nothing to remove is success, same as sessionTmpDir's own cleanup
	if (!isOwnedSafeDir(dir)) return false; // never recurse into a planted symlink or another user's directory
	try {
		rmSync(dir, { recursive: true, force: true });
		return true;
	} catch {
		return false;
	}
}

/**
 * A specific, already-known socket-safe dir's age in ms, or null when it cannot be read. Deliberately
 * NOT a directory scan: `/tmp` is shared machine-wide, and a sweep that enumerates everything under
 * a shared prefix risks acting on a path this runner never allocated — another runner's live session,
 * another local user's directory, or (since the name is a hash) a coincidental collision. The caller
 * (`CleanupManager`) sweeps only the exact sessions IT recorded allocating, never the filesystem at large.
 */
export function socketSafeTmpAgeMs(baseDir: string, sessionId: string, now: number = Date.now()): number | null {
	try {
		return now - statSync(socketSafeTmpDir(baseDir, sessionId)).mtimeMs;
	} catch {
		return null;
	}
}

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
