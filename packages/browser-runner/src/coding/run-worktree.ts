import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { InspectError } from "./inspect.js";

/**
 * Runner-managed git worktrees, one per run (#1670).
 *
 * The isolated checkout mode: every run works in `<root>/<repo key>/<run id>`, created at the LATEST
 * target commit, so parking one run cannot touch another run's edits (the #1547 failure was a park
 * that swept an unrelated editor's work out of one shared directory).
 *
 * ── What this module will and will not delete
 *
 *   * It only ever acts on a worktree it can VERIFY it manages: the path is inside the managed root
 *     (after resolving symlinks), git lists it as a worktree of this repository, and the marker file
 *     it wrote into that worktree's git dir names the same run. Anything else is refused untouched.
 *   * `removeCleanWorktree` removes a worktree only when it has no change at all (untracked included)
 *     AND its HEAD is verified published. It uses `git worktree remove` WITHOUT `--force`, so git
 *     itself refuses a dirty tree as a second line of defence.
 *   * Uncommitted edits are never deleted automatically. `reconcileWorktrees` after a crash removes
 *     only clean, published leftovers and REPORTS every other one, attributed to its run.
 *   * `discardWorktree` is the one deliberate destruction, and needs `authorized: true` from the
 *     caller (the cloud's explicit owner decision). It removes that one run's worktree without
 *     committing anything; commits that exist only in that worktree are pinned on
 *     `refs/pags/discarded/<run>` first, so "discard the edits" never silently loses a commit.
 *
 * Publication is serialized per repository and target (a lock file in the common git dir), rechecks
 * the target at push time, never forces, and reads the remote back instead of trusting the exit code.
 *
 * Fixed argv, no shell. Run ids are uuids; branch names use a conservative alphabet.
 */

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BRANCH = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,100}$/;
const REMOTE = /^[A-Za-z0-9._-]{1,50}$/;
const MARKER = "pags-managed.json";
const STALE_LOCK_MS = 10 * 60_000;

export const discardedRef = (runId: string) => `refs/pags/discarded/${runId}`;
export const runBranch = (runId: string) => `pags/run/${runId}`;

function git(cwd: string, argv: string[]): string {
	return execFileSync("git", argv, { cwd, encoding: "utf-8", timeout: 120_000, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}
function gitOk(cwd: string, argv: string[]): boolean {
	try {
		git(cwd, argv);
		return true;
	} catch {
		return false;
	}
}
function gitMessage(e: unknown): string {
	const raw = String((e as { stderr?: unknown }).stderr || (e instanceof Error ? e.message : e) || "git failed");
	return (raw.split("\n").map((l) => l.trim()).find((l) => l && !/^hint:/i.test(l)) ?? "git failed").replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<remote>").slice(0, 200);
}

/** A path as it is compared and hashed: separators unified, trailing slash dropped, and lower-cased only on Windows. `platform` is injectable so the three OS path shapes are testable on any host (#1710). */
export const norm = (p: string, platform: NodeJS.Platform = process.platform) => (platform === "win32" ? p.toLowerCase() : p).replace(/\\/g, "/").replace(/\/+$/, "");
function realish(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		return resolve(p);
	}
}
/** Is `child` strictly inside `parent`, after resolving symlinks and (on Windows) case? */
function inside(parent: string, child: string): boolean {
	const rel = relative(realish(parent), realish(child));
	return !!rel && !rel.startsWith("..") && !isAbsolute(rel);
}

function checkRepo(repoDir: string): void {
	if (!existsSync(join(repoDir, ".git"))) throw new InspectError(`not a git checkout: ${repoDir}`);
}
function checkRun(runId: string): void {
	if (!RUN_ID.test(runId)) throw new InspectError(`unusable run id: ${runId}`);
}
function checkRoot(root: string): void {
	if (!isAbsolute(root)) throw new InspectError("the managed worktree root must be an absolute path");
}

/** Stable per-repository directory name under the root: the repo's folder name plus a short hash of its real path. */
export function repoKey(repoDir: string): string {
	const real = realish(repoDir);
	return `${basename(real).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 40)}-${createHash("sha1").update(norm(real)).digest("hex").slice(0, 10)}`;
}
export const worktreePath = (root: string, repoDir: string, runId: string) => join(root, repoKey(repoDir), runId);

const changedFiles = (dir: string): string[] => git(dir, ["status", "--porcelain=v1", "--untracked-files=all"]).split("\n").filter(Boolean);
const headOf = (dir: string): string => git(dir, ["rev-parse", "HEAD"]).trim();
const commonDir = (dir: string): string => {
	const d = git(dir, ["rev-parse", "--git-common-dir"]).trim();
	return isAbsolute(d) ? d : resolve(dir, d);
};
const markerFile = (dir: string): string => {
	const d = git(dir, ["rev-parse", "--git-dir"]).trim();
	return join(isAbsolute(d) ? d : resolve(dir, d), MARKER);
};

export interface WorktreeMarker {
	runId: string;
	repo: string;
	target: string;
	base: string;
	branch: string | null;
	createdAt: string;
}

/** The worktree for this run, only if it is verifiably OURS: inside the root, listed by git, and marked for this run. */
export function verifyManaged(repoDir: string, root: string, runId: string): { path: string; marker: WorktreeMarker } | null {
	checkRepo(repoDir);
	checkRun(runId);
	checkRoot(root);
	const path = worktreePath(root, repoDir, runId);
	if (!existsSync(path) || !inside(root, path)) return null;
	const listed = git(repoDir, ["worktree", "list", "--porcelain"]).split("\n").filter((l) => l.startsWith("worktree ")).map((l) => norm(realish(l.slice(9))));
	if (!listed.includes(norm(realish(path)))) return null;
	try {
		const marker = JSON.parse(readFileSync(markerFile(path), "utf-8")) as WorktreeMarker;
		return marker.runId === runId ? { path, marker } : null;
	} catch {
		return null;
	}
}

export interface CreateWorktreeInput {
	root: string;
	runId: string;
	/** The configured target branch the run starts from and (in direct mode) publishes to. */
	target: string;
	remote?: string;
	/** Fetch the target first so the worktree starts at its LATEST commit. Default true when the remote exists. */
	fetch?: boolean;
	/** PR mode: create the run branch `pags/run/<run>` instead of a detached HEAD. */
	branch?: boolean;
}
export interface CreateWorktreeResult {
	ok: boolean;
	created: boolean;
	path: string | null;
	base: string | null;
	error?: string;
}

/** Create (or re-find) this run's worktree at the latest target commit. Never touches the shared checkout. */
export function createRunWorktree(repoDir: string, input: CreateWorktreeInput): CreateWorktreeResult {
	checkRepo(repoDir);
	checkRun(input.runId);
	checkRoot(input.root);
	const remote = input.remote ?? "origin";
	if (!BRANCH.test(input.target)) throw new InspectError(`unusable target branch: ${input.target}`);
	if (!REMOTE.test(remote)) throw new InspectError(`unusable remote: ${remote}`);
	const existing = verifyManaged(repoDir, input.root, input.runId);
	if (existing) return { ok: true, created: false, path: existing.path, base: existing.marker.base };
	const path = worktreePath(input.root, repoDir, input.runId);
	if (existsSync(path)) return { ok: false, created: false, path: null, base: null, error: "the run's worktree path exists but is not a verified managed worktree; left untouched" };

	const hasRemote = gitOk(repoDir, ["remote", "get-url", remote]);
	if (hasRemote && input.fetch !== false) {
		try {
			git(repoDir, ["fetch", "--quiet", remote, `+refs/heads/${input.target}:refs/remotes/${remote}/${input.target}`]);
		} catch (e) {
			return { ok: false, created: false, path: null, base: null, error: `could not fetch the target ${remote}/${input.target}: ${gitMessage(e)}` };
		}
	}
	const ref = hasRemote && gitOk(repoDir, ["rev-parse", "--verify", "--quiet", `refs/remotes/${remote}/${input.target}`]) ? `refs/remotes/${remote}/${input.target}` : `refs/heads/${input.target}`;
	let base: string;
	try {
		base = git(repoDir, ["rev-parse", "--verify", `${ref}^{commit}`]).trim();
	} catch {
		return { ok: false, created: false, path: null, base: null, error: `the target ${input.target} does not exist` };
	}
	try {
		mkdirSync(join(input.root, repoKey(repoDir)), { recursive: true });
		const branch = input.branch ? runBranch(input.runId) : null;
		git(repoDir, branch ? ["worktree", "add", "-q", "-b", branch, path, base] : ["worktree", "add", "-q", "--detach", path, base]);
		const marker: WorktreeMarker = { runId: input.runId, repo: realish(repoDir), target: input.target, base, branch, createdAt: new Date().toISOString() };
		writeFileSync(markerFile(path), JSON.stringify(marker));
		return { ok: true, created: true, path, base };
	} catch (e) {
		// A half-made worktree is ours (we just made it): unregister it, leave nothing behind.
		try {
			git(repoDir, ["worktree", "prune"]);
		} catch {
			/* nothing more to do */
		}
		return { ok: false, created: false, path: null, base: null, error: `could not create the worktree: ${gitMessage(e)}` };
	}
}

export interface WorktreeStatus {
	runId: string;
	path: string;
	head: string;
	/** Changed paths, untracked included — the edits that stay isolated and attributable to this run. */
	files: string[];
	clean: boolean;
}

/** What this run's isolated worktree holds. Parking retains these edits in place: nothing is moved, stashed or cleaned. */
export function worktreeStatus(repoDir: string, root: string, runId: string): WorktreeStatus | null {
	const m = verifyManaged(repoDir, root, runId);
	if (!m) return null;
	const files = changedFiles(m.path);
	return { runId, path: m.path, head: headOf(m.path), files, clean: files.length === 0 };
}

export interface PublishCheck {
	published: boolean;
	reason?: string;
}

/** Is this run's HEAD verifiably on the remote target (or its run branch)? A failed read is "not published", never a guess. */
export function isPublished(repoDir: string, root: string, runId: string, opts: { remote?: string; fetch?: boolean } = {}): PublishCheck {
	const m = verifyManaged(repoDir, root, runId);
	if (!m) return { published: false, reason: "not a verified managed worktree" };
	const remote = opts.remote ?? "origin";
	if (!gitOk(m.path, ["remote", "get-url", remote])) return { published: false, reason: `no remote ${remote}` };
	const head = headOf(m.path);
	const refs = [`refs/heads/${m.marker.target}`, ...(m.marker.branch ? [`refs/heads/${m.marker.branch}`] : [])];
	if (opts.fetch !== false) {
		for (const r of refs) gitOk(m.path, ["fetch", "--quiet", remote, `+${r}:refs/remotes/${remote}/${r.slice(11)}`]);
	}
	for (const r of refs) {
		const tracking = `refs/remotes/${remote}/${r.slice(11)}`;
		if (gitOk(m.path, ["rev-parse", "--verify", "--quiet", tracking]) && gitOk(m.path, ["merge-base", "--is-ancestor", head, tracking])) return { published: true };
	}
	return { published: false, reason: "HEAD is not on the remote target or run branch" };
}

export interface RemoveResult {
	removed: boolean;
	refused?: string;
}

/** Remove a terminal run's worktree — only if it is clean AND its HEAD is verified published. Never forces. */
export function removeCleanWorktree(repoDir: string, root: string, runId: string, opts: { remote?: string; fetch?: boolean } = {}): RemoveResult {
	const m = verifyManaged(repoDir, root, runId);
	if (!m) return { removed: false, refused: "not a verified managed worktree; left untouched" };
	const files = changedFiles(m.path);
	if (files.length) return { removed: false, refused: `${files.length} uncommitted file${files.length === 1 ? "" : "s"} remain; kept, isolated, for run ${runId}` };
	const pub = isPublished(repoDir, root, runId, opts);
	if (!pub.published) return { removed: false, refused: `publication is not verified (${pub.reason}); kept` };
	try {
		git(repoDir, ["worktree", "remove", m.path]); // no --force: git refuses a dirty tree as well
		git(repoDir, ["worktree", "prune"]);
		if (m.marker.branch) gitOk(repoDir, ["branch", "-d", m.marker.branch]); // merged-only delete; refuses if not fully merged
		return { removed: true };
	} catch (e) {
		return { removed: false, refused: gitMessage(e) };
	}
}

export interface DiscardResult {
	discarded: boolean;
	refused?: string;
	/** Changed paths that were deleted with the worktree. */
	files?: number;
	/** The run's HEAD, pinned on a ref when it was not already on a remote, so no commit is lost. */
	pinned?: string | null;
}

/** Explicitly authorized discard of ONE run's worktree. Commits nothing; pins commits that exist nowhere else. */
export function discardWorktree(repoDir: string, root: string, runId: string, opts: { authorized: boolean }): DiscardResult {
	if (opts.authorized !== true) return { discarded: false, refused: "discard requires explicit authorization" };
	const m = verifyManaged(repoDir, root, runId);
	if (!m) return { discarded: false, refused: "not a verified managed worktree; left untouched" };
	const files = changedFiles(m.path).length;
	const head = headOf(m.path);
	let pinned: string | null = null;
	const onRemote = git(m.path, ["for-each-ref", "--contains", head, "refs/remotes", "--format=%(refname)"]).trim().length > 0;
	if (!onRemote && head !== m.marker.base) {
		git(repoDir, ["update-ref", discardedRef(runId), head]);
		pinned = discardedRef(runId);
	}
	try {
		git(repoDir, ["worktree", "remove", "--force", m.path]);
		git(repoDir, ["worktree", "prune"]);
	} catch (e) {
		return { discarded: false, refused: gitMessage(e), files, pinned };
	}
	return { discarded: true, files, pinned };
}

export interface ReconcileReport {
	removed: string[];
	/** Leftovers that hold work or are unpublished: kept and attributed. */
	kept: Array<{ runId: string; path: string; files: number; reason: string }>;
}

/** After a crash: remove clean, published worktrees of runs that are no longer live; report every other leftover. */
export function reconcileWorktrees(repoDir: string, root: string, liveRunIds: ReadonlySet<string>, opts: { remote?: string; fetch?: boolean } = {}): ReconcileReport {
	checkRepo(repoDir);
	checkRoot(root);
	const report: ReconcileReport = { removed: [], kept: [] };
	const dir = join(root, repoKey(repoDir));
	if (!existsSync(dir)) return report;
	const listed = git(repoDir, ["worktree", "list", "--porcelain"]).split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice(9));
	for (const wt of listed) {
		if (!inside(dir, wt)) continue; // the shared checkout and anything outside the managed root are never ours
		const runId = basename(wt);
		if (!RUN_ID.test(runId) || liveRunIds.has(runId)) continue;
		const m = verifyManaged(repoDir, root, runId);
		if (!m) continue;
		const r = removeCleanWorktree(repoDir, root, runId, opts);
		if (r.removed) report.removed.push(runId);
		else report.kept.push({ runId, path: m.path, files: changedFiles(m.path).length, reason: r.refused ?? "kept" });
	}
	try {
		git(repoDir, ["worktree", "prune"]);
	} catch {
		/* best effort */
	}
	return report;
}

function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Serialize publication per repository and target. Returns a release function, or null if the lock was not obtained in time. */
function lockTarget(repoDir: string, target: string, waitMs: number): (() => void) | null {
	const file = join(commonDir(repoDir), `pags-publish-${createHash("sha1").update(target).digest("hex").slice(0, 12)}.lock`);
	const deadline = Date.now() + waitMs;
	for (;;) {
		try {
			const fd = openSync(file, "wx");
			writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
			closeSync(fd);
			return () => rmSync(file, { force: true });
		} catch {
			try {
				if (Date.now() - statSync(file).mtimeMs > STALE_LOCK_MS) rmSync(file, { force: true }); // a crashed publisher must not wedge the repo
			} catch {
				/* raced with the owner releasing it */
			}
			if (Date.now() >= deadline) return null;
			sleepSync(25);
		}
	}
}

export interface PublishResult {
	ok: boolean;
	sha: string | null;
	/** Why nothing was published; the run's work is untouched and still isolated. */
	reason?: "dirty" | "lock_timeout" | "target_moved" | "rejected" | "unverified" | "not_managed";
	error?: string;
	targetTip?: string | null;
}

/**
 * Direct publication: push the run's committed HEAD to the target. Serialized, rechecked against the CURRENT
 * target (a moved target is reported, never force-pushed over), and verified by reading the remote back.
 */
export function publishDirect(repoDir: string, root: string, runId: string, opts: { remote?: string; lockWaitMs?: number } = {}): PublishResult {
	const m = verifyManaged(repoDir, root, runId);
	if (!m) return { ok: false, sha: null, reason: "not_managed" };
	const remote = opts.remote ?? "origin";
	if (!REMOTE.test(remote)) throw new InspectError(`unusable remote: ${remote}`);
	const dirty = changedFiles(m.path);
	if (dirty.length) return { ok: false, sha: null, reason: "dirty", error: `${dirty.length} uncommitted file${dirty.length === 1 ? "" : "s"} are not published; commit them first` };
	const release = lockTarget(repoDir, `${remote}/${m.marker.target}`, opts.lockWaitMs ?? 30_000);
	if (!release) return { ok: false, sha: null, reason: "lock_timeout", error: "another publication to this target is in progress" };
	try {
		const head = headOf(m.path);
		try {
			git(m.path, ["fetch", "--quiet", remote, `+refs/heads/${m.marker.target}:refs/remotes/${remote}/${m.marker.target}`]);
		} catch (e) {
			return { ok: false, sha: head, reason: "unverified", error: `could not read the current target: ${gitMessage(e)}` };
		}
		const tracking = `refs/remotes/${remote}/${m.marker.target}`;
		const tip = git(m.path, ["rev-parse", tracking]).trim();
		if (tip !== head && !gitOk(m.path, ["merge-base", "--is-ancestor", tip, head])) return { ok: false, sha: head, reason: "target_moved", targetTip: tip, error: `${m.marker.target} moved to ${tip.slice(0, 8)} after this run started; update the run on top of it, then publish again` };
		try {
			git(m.path, ["push", "--quiet", remote, `${head}:refs/heads/${m.marker.target}`]); // never forced; branch protection is the remote's call
		} catch (e) {
			return { ok: false, sha: head, reason: "rejected", error: gitMessage(e) };
		}
		const seen = git(m.path, ["ls-remote", remote, `refs/heads/${m.marker.target}`]).split(/\s+/)[0];
		if (seen !== head) return { ok: false, sha: head, reason: "unverified", error: `the remote reads back ${seen ? seen.slice(0, 8) : "nothing"}, not the pushed commit` };
		return { ok: true, sha: head };
	} finally {
		release();
	}
}

/** PR publication: push the run branch (never the target). The cloud opens the pull request for review. */
export function publishRunBranch(repoDir: string, root: string, runId: string, opts: { remote?: string } = {}): PublishResult & { branch: string | null } {
	const m = verifyManaged(repoDir, root, runId);
	if (!m?.marker.branch) return { ok: false, sha: null, reason: "not_managed", branch: null };
	const remote = opts.remote ?? "origin";
	if (!REMOTE.test(remote)) throw new InspectError(`unusable remote: ${remote}`);
	const dirty = changedFiles(m.path);
	if (dirty.length) return { ok: false, sha: null, reason: "dirty", branch: m.marker.branch, error: `${dirty.length} uncommitted file${dirty.length === 1 ? "" : "s"} are not published; commit them first` };
	const head = headOf(m.path);
	try {
		git(m.path, ["push", "--quiet", remote, `${head}:refs/heads/${m.marker.branch}`]);
	} catch (e) {
		return { ok: false, sha: head, reason: "rejected", branch: m.marker.branch, error: gitMessage(e) };
	}
	const seen = git(m.path, ["ls-remote", remote, `refs/heads/${m.marker.branch}`]).split(/\s+/)[0];
	return seen === head ? { ok: true, sha: head, branch: m.marker.branch } : { ok: false, sha: head, reason: "unverified", branch: m.marker.branch, error: "the remote does not read back the pushed commit" };
}
