/**
 * The runner's endpoint for the owner's authorized discard of one run's isolated worktree (#1709, a slice of #1670).
 *
 *   POST /coding/worktree-discard   preview (default) or remove ONE run's managed worktree
 *
 * `discardWorktree` is the deliberate destruction in `run-worktree.ts`: it removes only a worktree it can verify it manages, commits nothing,
 * and pins commits that exist nowhere else on `refs/pags/discarded/<run>`. This file adds what the wire needs around it. Like the branch and
 * stash mutations it previews unless `dryRun` is EXACTLY false, executing needs the HEAD the preview returned (a worktree that moved since is
 * refused), and a refusal is a value (`ok:false` + `reason`). A session still running in that worktree is refused: the owner abandons the run first.
 * The cloud only reaches this from the owner's route; no agent tool does. A function of its inputs so it is testable without a socket.
 */
import { InspectError } from "./inspect.js";
import { discardedRef, discardWorktree, verifyManaged, worktreeStatus } from "./run-worktree.js";

const PATH = "/coding/worktree-discard";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{40}$/i;
const PREVIEW_PATHS = 50;

/** What the route needs of the runtime (structural, so a test passes plain functions). */
export interface WorktreeRouteDeps {
	repoWorkDir: (input: { workDir?: string; repoId?: string }) => string;
	/** Where managed worktrees live on this machine. */
	worktreeRoot: () => string;
	/** Sessions known to the runtime; one with `alive` still has an engine process. */
	list: () => Array<{ sessionId: string; alive: boolean }>;
}

export async function handleWorktreeRoute(method: string, path: string, deps: WorktreeRouteDeps, readBody: () => Promise<Record<string, unknown>>): Promise<{ body: unknown } | null> {
	if (method !== "POST" || path !== PATH) return null;
	const b = await readBody();
	const str = (k: string): string | undefined => (typeof b[k] === "string" && b[k] ? (b[k] as string) : undefined);
	const runId = str("runId");
	if (!runId || !UUID.test(runId)) throw new InspectError("`runId` must be the run's uuid");
	const repoDir = deps.repoWorkDir({ workDir: str("workDir"), repoId: str("repoId") });
	const root = deps.worktreeRoot();
	const status = worktreeStatus(repoDir, root, runId);
	if (!status) return { body: { ok: false, reason: "not_managed", error: "No managed worktree for that run in this repository; nothing was changed." } };
	if (deps.list().some((x) => x.alive && x.sessionId.toLowerCase().endsWith(runId.toLowerCase()))) {
		return { body: { ok: false, reason: "session_live", error: "That run's engine is still running in this worktree. Abandon the run first; nothing was changed." } };
	}
	const facts = { runId, path: status.path, head: status.head, files: status.files.length, changed: status.files.filter((_l, i) => i < PREVIEW_PATHS).map((l) => l.slice(3)) };
	if (b.dryRun !== false) return { body: { ok: true, dryRun: true, ...facts, effect: "Removes this one worktree and its uncommitted files. Nothing is committed. A commit that exists only here is pinned first.", pinRef: discardedRef(runId) } };
	const expected = str("expectedHead");
	if (!expected || !SHA.test(expected)) throw new InspectError("`expectedHead` is required to execute: preview first and pass the head it returned");
	if (expected.toLowerCase() !== status.head.toLowerCase()) return { body: { ok: false, reason: "stale_head", ...facts, error: "The worktree's HEAD moved since the preview; nothing was changed. Preview again." } };
	const result = discardWorktree(repoDir, root, runId, { authorized: true });
	if (!result.discarded) return { body: { ok: false, reason: "refused", ...facts, error: result.refused ?? "the worktree was not discarded" } };
	const gone = verifyManaged(repoDir, root, runId) === null;
	return {
		body: {
			ok: gone,
			...(gone ? {} : { reason: "not_removed", error: "git reported success but the worktree is still registered; read it back before repeating." }),
			...facts,
			discardedFiles: result.files ?? 0,
			pinned: result.pinned ?? null,
			recovery: result.pinned ? `git worktree add <path> ${result.pinned} (committed work only; uncommitted files are not recoverable)` : "Nothing was committed in this worktree; uncommitted files are not recoverable.",
		},
	};
}
