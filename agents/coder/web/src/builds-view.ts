/**
 * Which Builds view to show — pure, so the rule is testable without a DOM.
 *
 * "Latest run per repo" is the right shape for a fleet and the wrong one for a single repo: it
 * spends a panel on one line, and answers "did the last build pass" while hiding the question you
 * actually have — when did this start failing, is it flaky. A Repo Coder owns exactly one repo.
 *
 * The two views are the same idea at different scales. The fleet list exists to CHOOSE a repo, so
 * with one repo the choice is already made and history is what's left to show. Keyed off how many
 * repos there are, not off an agent slug or a surface flag — one repo is one repo however the
 * agent was configured.
 */
export interface BuildsRepo {
	repoId: string;
	repoName: string;
	available: boolean;
}

export type BuildsView =
	/** Show one repo's run history. `canGoBack` is false when there is no list behind it. */
	| { mode: "history"; repoId: string; repoName: string; canGoBack: boolean }
	/** Show latest-per-repo; each row selects into that repo's history. */
	| { mode: "list" };

export function resolveBuildsView(repos: readonly BuildsRepo[], openRepoId: string | null): BuildsView {
	if (repos.length === 1) {
		const only = repos[0];
		return { mode: "history", repoId: only.repoId, repoName: only.repoName, canGoBack: false };
	}
	// A selection that no longer matches a repo (it was removed while open) falls back to the
	// list rather than rendering history for something that is gone.
	const open = openRepoId ? repos.find((r) => r.repoId === openRepoId) : undefined;
	if (open) return { mode: "history", repoId: open.repoId, repoName: open.repoName, canGoBack: true };
	return { mode: "list" };
}
