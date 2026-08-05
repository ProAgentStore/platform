import { repoTitle } from "./repo-title";

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
	/** Present when connected to GitHub — decides the displayed title (repo-title.ts). */
	githubRepo?: string | null;
	available: boolean;
}

export type BuildsView =
	/**
	 * Show one repo's run history. `repoName` is already RESOLVED through `repoTitle`, so the
	 * drill-down header and the list row cannot disagree about what the repo is called — they did,
	 * because the header used the raw add-time name and the row used the resolved one.
	 */
	| { mode: "history"; repoId: string; repoName: string; canGoBack: boolean }
	/** Show latest-per-repo; each row selects into that repo's history. */
	| { mode: "list" };

export function resolveBuildsView(repos: readonly BuildsRepo[], openRepoId: string | null): BuildsView {
	const title = (r: BuildsRepo) => repoTitle({ name: r.repoName, githubRepo: r.githubRepo });
	if (repos.length === 1) {
		const only = repos[0];
		return { mode: "history", repoId: only.repoId, repoName: title(only), canGoBack: false };
	}
	// A selection that no longer matches a repo (it was removed while open) falls back to the
	// list rather than rendering history for something that is gone.
	const open = openRepoId ? repos.find((r) => r.repoId === openRepoId) : undefined;
	if (open) return { mode: "history", repoId: open.repoId, repoName: title(open), canGoBack: true };
	return { mode: "list" };
}
