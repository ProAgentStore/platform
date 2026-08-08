/**
 * What to CALL a repo, consistently — pure, so the rule is testable and shared.
 *
 * `repo.name` is derived at add-time from whatever you typed, so it means different things
 * depending on how the repo arrived (`routes/instances.ts` attachSettingRepo, and the add-repo
 * route):
 *
 *   ~/dev/stores/fws/platform   → name "fws/platform"                  (last two PATH segments)
 *   freewebstore-online/platform → name "freewebstore-online/platform" (the GitHub slug)
 *   https://github.com/o/r.git   → name "o/r"                          (stripped URL)
 *
 * So the header could read `fws/platform` — which LOOKS like an `owner/repo` coordinate and is
 * not one; the real repo there is `freewebstore-online/platform`. Same UI element, two different
 * meanings, decided by input format the user has long forgotten.
 *
 * One rule instead: a repo connected to a HOST is called by its hosted coordinate, because that
 * is its canonical identity and the thing that matches what you see on the host. A local-only
 * repo has no such identity, so it keeps its folder name — and the badge says so, rather than
 * leaving a bare `a/b` to be misread as a slug.
 */
export interface RepoIdentity {
	name: string;
	githubRepo?: string | null;
	/** #221: local | github | gitlab | bitbucket | other. Absent on a pre-#221 payload. */
	provider?: string | null;
	/** The provider-neutral coordinate — `group/subgroup/project` on GitLab. */
	repoSlug?: string | null;
}

export function repoTitle(repo: RepoIdentity): string {
	// `repoSlug` first: it is the general form and equals `githubRepo` for every GitHub repo, so
	// this is a widening, not a change. `githubRepo` stays as the fallback for a payload from a
	// deployment that predates the column.
	const slug = (repo.repoSlug || repo.githubRepo || "").trim();
	return slug || (repo.name || "").trim() || "this repo";
}

/** True when the title is a real GitHub coordinate rather than a local folder name. */
export function repoIsGitHub(repo: RepoIdentity): boolean {
	return !!(repo.githubRepo || "").trim();
}

/**
 * Why this repo's Issues panel is empty — the client-side mirror of the API's
 * `hostedFeatureUnavailable`.
 *
 * PURE and here rather than inline in the panel, because the wrong version of this sentence is
 * what #221 is about on this surface: "isn't connected to GitHub" reads as a setup mistake to
 * someone whose GitLab repo is connected perfectly well. The gap is ours, and it says so.
 */
export function repoIssuesUnavailable(repo: RepoIdentity): string {
	const provider = (repo.provider || "").trim();
	if (provider && provider !== "local" && provider !== "github") {
		return `Issues aren't supported for ${repoProviderLabel(provider)} repos yet — PAGS drives GitHub issues only.`;
	}
	return "This repo isn't connected to GitHub, so it has no issues to show.";
}

/** The same sentence for the Pulls panel (#401) — same rule, its own noun. */
export function repoPullsUnavailable(repo: RepoIdentity): string {
	const provider = (repo.provider || "").trim();
	if (provider && provider !== "local" && provider !== "github") {
		return `Pull requests aren't supported for ${repoProviderLabel(provider)} repos yet — PAGS drives GitHub only.`;
	}
	return "This repo isn't connected to GitHub, so it has no pull requests to show.";
}

/** The host's display name. Mirrors `GIT_PROVIDERS` in the API's lib/git-providers.ts. */
export function repoProviderLabel(provider?: string | null): string {
	switch ((provider || "").trim()) {
		case "github":
			return "GitHub";
		case "gitlab":
			return "GitLab";
		case "bitbucket":
			return "Bitbucket";
		case "other":
			return "Git remote";
		default:
			return "Local";
	}
}

/**
 * The badge next to the title, or null when the title already says everything.
 *
 * A GitLab repo used to render the `local` badge, because the only question the UI asked was
 * "does it have a githubRepo?" — so a correctly-configured GitLab repo was labelled as having
 * no remote at all. Naming the provider is the whole point of #221 on this surface: the user
 * must be able to see which host a repo is on without opening its settings.
 */
export function repoProviderBadge(repo: RepoIdentity): string | null {
	const provider = (repo.provider || "").trim() || (repoIsGitHub(repo) ? "github" : "local");
	switch (provider) {
		// GitHub says it by showing an owner/repo coordinate; a badge would be noise on the
		// overwhelmingly common case.
		case "github":
			return null;
		case "gitlab":
			return "GitLab";
		case "bitbucket":
			return "Bitbucket";
		case "other":
			return "git";
		default:
			return "local";
	}
}
