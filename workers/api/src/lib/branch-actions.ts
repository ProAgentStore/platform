/**
 * Branch inventory, integration and removal on the machine that holds a repo's checkout (#1700, #1701).
 *
 * One transport for the runner endpoints (`packages/browser-runner/src/coding/branch-routes.ts`). What
 * it adds over `callRunner` is the part the cloud owns:
 *
 *   * the repo must be this user's, on this instance (`getRepo`), and the machine is the one NAMED — a
 *     mutation never falls back to "whichever machine is bound", because a branch or stash lives in ONE
 *     machine's checkout and the same repo on another machine is a different set of refs;
 *   * every way the machine cannot be reached is a NAMED failure (`unreachable`, `unconfirmed`,
 *     `old_runner`, `refused`, `failed`) — never an empty list, which would read as "no branches";
 *   * a mutation that loses the machine mid-call says its outcome is UNKNOWN and what to read to settle it.
 *
 * The refusals that belong to git (stale tip, protected, checked out, diverged, failing checks) come back
 * from the runner as values and are passed through unchanged, so the cloud never restates a rule the runner
 * enforces.
 */
import { callRunner, getBoundRunnerConn, getRunnerConn, type RunnerConn } from "./runner-client.js";
import { getRepo } from "./coding-store.js";
import { clipMarked } from "./clip-marked.js";
import { runnerUpgradeClause } from "./runner-upgrade.js";
import { isRunnerUnreachable } from "./runner-unreachable.js";
import type { Env } from "../types.js";

/** The CLI release whose runner serves the branch and stash routes. Named in the refusal. */
export const BRANCH_TOOLS_MIN_CLI = "0.4.252";

/** The CLI release whose runner serves the owner's worktree discard (#1709). */
export const WORKTREE_DISCARD_MIN_CLI = "0.4.255";

/** Above the runner's own git timeouts (a live `ls-remote`, a fetch, a push) so a slow remote is reported, not cut off. */
export const BRANCH_TIMEOUT_MS = 120_000;

export type BranchRunnerPath = "/coding/branches" | "/coding/branch-integrate" | "/coding/branch-delete" | "/coding/stashes" | "/coding/stash-drop" | "/coding/worktree-discard";

export type BranchFailure = "no_repo" | "unreachable" | "unconfirmed" | "old_runner" | "refused" | "failed";

export type BranchOutcome<T> =
	| { ok: true; machine: string | null; repo: { id: string; name: string }; result: T }
	| { ok: false; reason: BranchFailure; machine: string | null; error: string; outcome?: "not-started" | "unknown" };

export async function callBranchRunner<T>(
	env: Env,
	input: { instanceId: string; userId: string; repoId: string; path: BranchRunnerPath; body: Record<string, unknown>; node?: string | null; mutating: boolean },
	deps: { conn?: RunnerConn | null; call?: typeof callRunner } = {},
): Promise<BranchOutcome<T>> {
	const repo = await getRepo(env, input.instanceId, input.userId, input.repoId).catch(() => null);
	if (!repo) return { ok: false, reason: "no_repo", machine: null, error: `repo ${input.repoId} is not registered on this instance` };
	const node = input.node?.trim() || null;
	const conn = deps.conn !== undefined ? deps.conn : node ? await getRunnerConn(env, input.instanceId, input.userId, node).catch(() => null) : await getBoundRunnerConn(env, input.instanceId, input.userId).catch(() => null);
	const machine = conn?.runnerNode ?? node;
	if (!conn || (node && conn.runnerNode && conn.runnerNode.toLowerCase() !== node.toLowerCase())) {
		return { ok: false, reason: "unreachable", outcome: "not-started", machine, error: `${machine ? `The machine ${machine}` : "The machine that holds this checkout"} has no live runner connection (it is offline, its \`pags up\` is not running, or the instance is paused or not attached to it), so nothing was read or changed. Bring the runner online or attach the instance, then try again.` };
	}
	try {
		const result = await (deps.call ?? callRunner)<T>(conn, input.path, { workDir: repo.workdir || undefined, repoId: repo.id, ...input.body }, { timeoutMs: BRANCH_TIMEOUT_MS });
		return { ok: true, machine, repo: { id: repo.id, name: repo.name }, result };
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		if (/→ 404|not found/i.test(message)) return { ok: false, reason: "old_runner", machine, error: input.path === "/coding/worktree-discard" ? runnerUpgradeClause({ what: "discard a run's isolated worktree", minCli: WORKTREE_DISCARD_MIN_CLI, node: machine }) : runnerUpgradeClause({ what: "inspect or change this repo's branches and stashes", minCli: BRANCH_TOOLS_MIN_CLI, node: machine }) };
		if (isRunnerUnreachable(e)) {
			return { ok: false, reason: "unconfirmed", ...(input.mutating ? { outcome: "unknown" as const } : {}), machine, error: `${machine ? `The machine ${machine}` : "The machine"} went away before it answered (${clipMarked(message, 120, { within: true })}).${input.mutating ? " It is NOT known whether the change ran: read the branches or stashes again and compare against the receipt you expected before repeating it." : ""}` };
		}
		return { ok: false, reason: /→ 400/.test(message) ? "refused" : "failed", machine, error: `The machine declined or failed the request: ${clipMarked(message, 240, { within: true })}` };
	}
}
