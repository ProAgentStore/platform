/**
 * The cloud half of the checkout strategy at run boundaries (#1714, #1713 — slices of #1670).
 *
 * Three decisions, all conditional on what the owner stored for the repository, and all inert for a repository that stored nothing:
 *
 *   1. {@link sharedAdmissionRefusal} — a repository whose preset is explicitly `shared-direct` is admitted only onto a clean checkout.
 *      The runner answers read-only with the blocking paths; nothing is stashed, reset or cleaned. NO stored preset admits as it always has.
 *   2. {@link notIsolatedRefusal} — an isolated repository whose runner did not report a worktree (an older runner ignores `strategy`)
 *      is refused, in words, instead of silently running in the shared checkout the owner chose not to use.
 *   3. {@link publishIsolatedRun} — at the end of an isolated run: publish what it committed (`publishDirect`, or `publishRunBranch` plus a
 *      pull request), and remove its worktree only after the runner has read the publication back. Dirty or unpublished work stays where it is.
 *
 * Every runner call here may 404 on an older runner; each is treated as "not isolated, nothing to do" and the run carries on as before.
 */
import { effectiveWorkdir, getCheckout, machineIdForNode } from "./coding-repo-checkouts.js";
import { appendTimeline } from "./coding-timeline.js";
import { nameFiles } from "./coding-resume-sync.js";
import { strategyForRunner } from "./checkout-strategy.js";
import { openRunPullRequest } from "./github-pr-open.js";
import { callRunner, type RunnerConn } from "./runner-client.js";
import type { CodingRepo } from "./coding-types.js";
import type { Env } from "../types.js";

/** Why a fresh open must not go ahead on this shared checkout, or null to go ahead. Only an explicit `shared-direct` is ever asked. */
export async function sharedAdmissionRefusal(conn: RunnerConn, repo: Pick<CodingRepo, "id" | "name"> & Partial<Pick<CodingRepo, "workdir" | "strategy">>): Promise<string | null> {
	if (repo.strategy !== "shared-direct") return null;
	const a = await callRunner<{ ok?: boolean; blocking?: string[]; blockingCount?: number }>(conn, "/coding/admit-checkout", { workDir: repo.workdir || undefined, repoId: repo.id }).catch(() => null);
	if (a?.ok !== false) return null; // clean, an older runner, or a checkout the runner could not read: admit as before
	const n = a.blockingCount ?? a.blocking?.length ?? 0;
	return `${repo.name || "This repository"} uses a shared checkout, and it is not clean: ${n} uncommitted path${n === 1 ? " is" : "s are"} in the way (${nameFiles(a.blocking ?? [])}). Nothing was stashed, reset or cleaned — they are exactly as they were. Commit or move them to start a run here, or switch the repository to an isolated checkout.`;
}

/** The sentence for an isolated repository whose runner started the engine without a worktree, or null when it did isolate (or the repository is not isolated). */
export function notIsolatedRefusal(repo: Pick<CodingRepo, "name"> & Partial<Pick<CodingRepo, "strategy">>, started: { checkout?: unknown } | null | undefined, node?: string | null): string | null {
	if (!strategyForRunner(repo.strategy)) return null;
	const c = started?.checkout as { mode?: unknown; path?: unknown } | undefined;
	if (c?.mode === "worktree" && typeof c.path === "string") return null;
	return `${repo.name || "This repository"} is set to ${repo.strategy}, but ${node ? `the runner on ${node}` : "the runner"} did not report an isolated worktree for this run — it is too old to isolate (update it with \`npm i -g @proagentstore/cli\`). The run was not started, because it would have used the shared checkout the repository is set not to use.`;
}

type Published = {
	isolated?: boolean;
	ok?: boolean;
	mode?: "direct" | "pr";
	target?: string;
	branch?: string | null;
	sha?: string | null;
	reason?: string;
	error?: string;
};

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * Publish an isolated run's work and, once that reads back, remove its worktree. Returns the sentence it recorded, or null when this
 * run has nothing isolated (shared/direct repository, an older runner, no worktree). Never throws: the run's verdict does not depend on it.
 */
export async function publishIsolatedRun(
	env: Env,
	conn: RunnerConn,
	input: { instanceId: string; userId: string; sessionId: string; repo: CodingRepo; objective?: string; runId?: string | null },
): Promise<string | null> {
	const { repo } = input;
	if (!strategyForRunner(repo.strategy)) return null;
	const expect = repo.strategy === "isolated-pr" ? "pr" : "direct";
	// This machine's own folder for the repository (#1142), the way `startSessionOnRunnerConn` finds it — the worktree is cut from THAT checkout.
	const machineId = await machineIdForNode(env, input.instanceId, input.userId, conn.runnerNode ?? "").catch(() => null);
	const checkout = machineId ? await getCheckout(env, input.instanceId, input.userId, repo.id, machineId).catch(() => null) : null;
	const where = { sessionId: input.sessionId, repoId: repo.id, workDir: effectiveWorkdir(checkout, repo.workdir) || undefined };
	const say = async (line: string): Promise<string> => {
		await appendTimeline(env, { sessionId: input.sessionId, instanceId: input.instanceId, userId: input.userId, type: "system", content: line }).catch(() => undefined);
		return line;
	};
	try {
		const p = await callRunner<Published>(conn, "/coding/worktree-publish", { ...where, expect }).catch(() => null);
		if (p?.isolated !== true) return null;
		if (!p.ok) {
			return say(`This run's work was NOT published (${p.reason ?? "refused"}${p.error ? `: ${p.error}` : ""}). It stays in its own worktree on the machine, untouched — nothing was pushed and nothing was deleted.`);
		}
		const sha = p.sha ? p.sha.slice(0, 8) : "the run's commit";
		let line: string;
		if (p.mode === "pr") {
			const title = clip(`${(input.objective ?? "").split("\n")[0]?.trim() || "Coder run"}`, 120);
			const pr = repo.githubRepo
				? await openRunPullRequest(env, input.userId, {
						githubRepo: repo.githubRepo,
						head: p.branch ?? "",
						base: p.target ?? repo.branch,
						title,
						body: `Opened for review by a ProAgentStore coding run${input.runId ? ` (\`${input.runId}\`)` : ""} on \`${p.branch}\` at ${sha}.\n\nThe repository is set to publish through pull requests, so nothing was pushed to \`${p.target}\`.`,
					})
				: ({ ok: false, error: "the repository has no GitHub coordinates" } as const);
			if (!pr.ok) return say(`The run's branch \`${p.branch}\` (${sha}) was pushed, but its pull request could not be opened: ${pr.error}. The worktree is kept; the branch is on the remote.`);
			line = `Opened pull request #${pr.number} for review (${pr.url}) from \`${p.branch}\` at ${sha}${pr.existed ? " — it was already open" : ""}.`;
		} else {
			line = `Published ${sha} to \`${p.target}\` (read back from the remote).`;
		}
		const done = await callRunner<{ removed?: boolean; refused?: string }>(conn, "/coding/worktree-finish", where).catch(() => null);
		return say(done?.removed ? `${line} Its worktree was removed.` : `${line} Its worktree was kept${done?.refused ? ` (${done.refused})` : ""}.`);
	} catch (e) {
		return say(`Publishing this run's isolated work failed (${e instanceof Error ? clip(e.message, 160) : "unknown error"}). It stays in its own worktree, untouched.`).catch(() => null);
	}
}

/** One managed worktree of an isolated repository, as the runner reports it: run-attributed, what it holds, whether it is published. */
export interface RetainedWorktree {
	runId: string;
	path: string;
	head: string;
	target: string | null;
	branch: string | null;
	clean: boolean;
	files: number;
	paths: string[];
	published: boolean;
	live: boolean;
}

/**
 * What the machine is holding for each isolated repository (#1714): every managed worktree, so an edit that was kept rather than deleted is
 * visible and attributed to its run. Repositories that are not isolated, and an older runner (404), contribute nothing.
 */
export async function retainedWorktrees(conn: RunnerConn, repos: Array<Pick<CodingRepo, "id" | "name"> & Partial<Pick<CodingRepo, "workdir" | "strategy">>>): Promise<Array<{ repoId: string; repoName: string; worktrees: RetainedWorktree[] }>> {
	const out: Array<{ repoId: string; repoName: string; worktrees: RetainedWorktree[] }> = [];
	for (const repo of repos.filter((r) => strategyForRunner(r.strategy)).slice(0, 10)) {
		const r = await callRunner<{ worktrees?: RetainedWorktree[] }>(conn, "/coding/worktrees", { repoId: repo.id, workDir: repo.workdir || undefined }).catch(() => null);
		if (r?.worktrees?.length) out.push({ repoId: repo.id, repoName: repo.name, worktrees: r.worktrees });
	}
	return out;
}
