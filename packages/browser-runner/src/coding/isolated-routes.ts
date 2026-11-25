/**
 * The runner's checkout-strategy endpoints (#1714, #1713 — slices of #1670), token-gated like the rest of `server.ts`.
 *
 *   POST /coding/admit-checkout   read-only: is a SHARED checkout clean enough to start a run in? Names the blocking paths; touches nothing.
 *   POST /coding/worktrees        the managed worktrees of one repository, run-attributed: edits held, published or not, live or not.
 *   POST /coding/worktree-publish publish an isolated session's work — `publishDirect` or `publishRunBranch`, by what the worktree was cut as.
 *   POST /coding/worktree-finish  remove that session's worktree, only when clean AND its publication reads back (`removeCleanWorktree`).
 *
 * Every one is addressed by repo (`repoId` / `workDir`) and, for the last two, `sessionId` (its uuid is the worktree's run id — the same
 * rule `isolated-start.ts` cut it by). Refusals are VALUES (`ok:false` + `reason`); a malformed request is a thrown error, which `server.ts`
 * turns into a 400. An older runner answers 404 to all of these and the cloud carries on as it did before they existed.
 *
 * Also here: {@link reconcileAllWorktrees}, run once when the runner starts — it removes only clean, published leftovers of runs that are
 * not live and reports every other one, never touching a worktree that holds an edit.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { InspectError } from "./inspect.js";
import { runIdForSession } from "./isolated-start.js";
import { admitSharedCheckout } from "./park-snapshot.js";
import { isPublished, publishDirect, publishRunBranch, reconcileWorktrees, removeCleanWorktree, repoKey, verifyManaged, worktreeStatus, type ReconcileReport } from "./run-worktree.js";

const PATHS = new Set(["/coding/admit-checkout", "/coding/worktrees", "/coding/worktree-publish", "/coding/worktree-finish"]);
const RUN_DIR = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** How many blocking / held paths one answer names; the count is always the whole count. */
const NAMED = 20;

export interface IsolatedRouteDeps {
	/** The confined checkout folder for a repo-scoped call. */
	resolveWorkDir: (input: { workDir?: string; repoId?: string }) => string;
	/** Where managed worktrees live. */
	root: string;
	/** Run ids (session uuids) with a live engine — never reported as leftovers. */
	liveRunIds: () => ReadonlySet<string>;
}

export async function handleIsolatedRoute(method: string, path: string, deps: IsolatedRouteDeps, readBody: () => Promise<Record<string, unknown>>): Promise<{ body: unknown } | null> {
	if (method !== "POST" || !PATHS.has(path)) return null;
	const b = await readBody();
	const str = (k: string): string | undefined => (typeof b[k] === "string" && b[k] ? (b[k] as string) : undefined);
	const repoDir = deps.resolveWorkDir({ workDir: str("workDir"), repoId: str("repoId") });
	if (path === "/coding/admit-checkout") {
		const a = admitSharedCheckout(repoDir);
		return { body: { ok: a.ok, blocking: a.blocking.slice(0, NAMED), blockingCount: a.blocking.length } };
	}
	if (path === "/coding/worktrees") return { body: { worktrees: listWorktrees(repoDir, deps) } };
	const sessionId = str("sessionId");
	const runId = str("runId") ?? (sessionId ? runIdForSession(sessionId) : undefined);
	if (!runId) throw new InspectError("sessionId (or runId) is required");
	const m = verifyManaged(repoDir, deps.root, runId);
	if (!m) return { body: { isolated: false } }; // no managed worktree for this run: nothing to publish or remove, and nothing was touched
	if (path === "/coding/worktree-finish") {
		const r = removeCleanWorktree(repoDir, deps.root, runId);
		return { body: { isolated: true, runId, removed: r.removed, ...(r.refused ? { refused: r.refused } : {}) } };
	}
	const pr = m.marker.branch !== null;
	// The cloud names what the stored preset says; a worktree cut the other way is not published, so a repository set to PRs never
	// pushes to its target and a direct one never opens a branch (#1713).
	const expect = str("expect");
	if (expect && expect !== (pr ? "pr" : "direct")) return { body: { isolated: true, runId, ok: false, sha: null, reason: "mode_mismatch", error: `this worktree was cut for ${pr ? "a pull request" : "a direct push"}, but the repository is now set to ${expect === "pr" ? "pull requests" : "direct push"}; nothing was published` } };
	const r = pr ? publishRunBranch(repoDir, deps.root, runId) : publishDirect(repoDir, deps.root, runId, { lockWaitMs: 10_000 });
	return { body: { isolated: true, runId, mode: pr ? "pr" : "direct", target: m.marker.target, branch: m.marker.branch, base: m.marker.base, ...r } };
}

/** Every managed worktree of this repository, attributed to its run: what it holds, whether it is published, whether its run is live. */
function listWorktrees(repoDir: string, deps: IsolatedRouteDeps) {
	const dir = join(deps.root, repoKey(repoDir));
	if (!existsSync(dir)) return [];
	const live = deps.liveRunIds();
	const out = [];
	for (const name of readdirSync(dir)) {
		if (!RUN_DIR.test(name)) continue;
		const st = worktreeStatus(repoDir, deps.root, name);
		if (!st) continue;
		const marker = verifyManaged(repoDir, deps.root, name)?.marker;
		out.push({
			runId: name,
			path: st.path,
			head: st.head,
			target: marker?.target ?? null,
			branch: marker?.branch ?? null,
			clean: st.clean,
			files: st.files.length,
			paths: st.files.slice(0, NAMED).map((l) => l.slice(3)),
			published: isPublished(repoDir, deps.root, name, { fetch: false }).published,
			live: live.has(name),
		});
	}
	return out;
}

/** The repository a managed worktree belongs to, read from the worktree itself (its git dir points at the common one). */
function repoOfWorktree(wt: string): string | null {
	try {
		const common = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: wt, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
		const abs = isAbsolute(common) ? common : resolve(wt, common);
		return basename(abs) === ".git" && existsSync(abs) ? dirname(abs) : null;
	} catch {
		return null;
	}
}

/** At runner start (#1714): reconcile the leftovers of every repository that has a worktree under `root`. Never throws. */
export function reconcileAllWorktrees(root: string, live: ReadonlySet<string>): { removed: string[]; kept: ReconcileReport["kept"] } {
	const total: { removed: string[]; kept: ReconcileReport["kept"] } = { removed: [], kept: [] };
	if (!existsSync(root)) return total;
	const repos = new Set<string>();
	try {
		for (const key of readdirSync(root)) {
			for (const run of readdirSync(join(root, key))) {
				if (!RUN_DIR.test(run)) continue;
				const repo = repoOfWorktree(join(root, key, run));
				if (repo) repos.add(repo);
			}
		}
	} catch {
		return total;
	}
	for (const repo of repos) {
		try {
			const r = reconcileWorktrees(repo, root, live);
			total.removed.push(...r.removed);
			total.kept.push(...r.kept);
		} catch {
			/* one unreadable repository must not stop the rest */
		}
	}
	return total;
}
