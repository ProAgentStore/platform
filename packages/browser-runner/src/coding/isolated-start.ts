import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { RunnerInputError } from "../errors.js";
import { type RepoStrategy, resolveStrategy, strategyProblems } from "./checkout-strategy.js";
import { createRunWorktree } from "./run-worktree.js";

/**
 * Where a session's engine runs when the repository's strategy is isolated (#1708, a slice of #1670).
 *
 * `strategy` is what the cloud sent at `/coding/start`. Absent or `shared` mean the repository's own folder, exactly as before; this
 * module only ever ADDS a managed worktree for an explicit `worktree` checkout and never touches the shared folder. A session id is
 * `csess_<uuid>`; the uuid is the worktree's run id, so a re-start of the same session finds the same worktree.
 */

const SESSION_UUID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** A session's worktree run id: the uuid in `csess_<uuid>`, or undefined for an id that carries none. */
export const runIdForSession = (sessionId: string): string | undefined => SESSION_UUID.exec(sessionId)?.[1];

export interface IsolatedCheckout {
	mode: "worktree";
	path: string;
	/** The commit the worktree started at (the latest target commit). */
	base: string;
	target: string;
	publish: RepoStrategy["publish"];
	/** False when this start re-found the session's existing worktree. */
	created: boolean;
}

/** Where managed worktrees live: beside the managed clones' folder, never inside a repository. */
export const worktreeRootFor = (reposBaseDir: string): string => join(reposBaseDir, "..", "worktrees");

function currentBranch(dir: string): string | null {
	try {
		const b = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
		return b && b !== "HEAD" ? b : null;
	} catch {
		return null;
	}
}

/** The session's isolated checkout, or null when its strategy is the shared one. A refusal is a `RunnerInputError` carrying the reason. */
export function startIsolatedCheckout(sharedDir: string, root: string, input: { sessionId: string; strategy?: unknown; branch?: string }): IsolatedCheckout | null {
	if (input.strategy === undefined || input.strategy === null) return null;
	const strategy = resolveStrategy(input.strategy);
	if (strategy.checkout !== "worktree") return null;
	const problems = strategyProblems(strategy);
	if (problems.length) throw new RunnerInputError(problems[0]);
	const runId = runIdForSession(input.sessionId);
	if (!runId) throw new RunnerInputError(`cannot name an isolated worktree for session ${input.sessionId}`);
	const target = input.branch || currentBranch(sharedDir);
	if (!target) throw new RunnerInputError("an isolated checkout needs a target branch, and the repository's folder is on none; set the repository's branch");
	let made: ReturnType<typeof createRunWorktree>;
	try {
		made = createRunWorktree(sharedDir, { root, runId, target, branch: strategy.publish === "pr" });
	} catch (e) {
		throw new RunnerInputError(e instanceof Error ? e.message : String(e));
	}
	if (!made.ok || !made.path || !made.base) throw new RunnerInputError(made.error ?? "could not create the isolated worktree");
	return { mode: "worktree", path: made.path, base: made.base, target, publish: strategy.publish, created: made.created };
}
