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
 * Which host a repo is on, reading a pre-#221 payload (no `provider`) as GitHub when it carries a
 * GitHub coordinate and as local otherwise — the same fallback `repoProviderBadge` uses.
 */
function repoProvider(repo: RepoIdentity): string {
	return (repo.provider || "").trim() || (repoIsGitHub(repo) ? "github" : "local");
}

/**
 * The hosted panels the API can serve per provider — a mirror of `supports` in the API's
 * `lib/git-providers.ts`, pinned against it by `repo-title.test.ts`. Since #221 phases 3–4 and
 * `1f0d3a33` GitLab and Bitbucket serve issues AND pulls, so gating a panel on `githubRepo` hid
 * surfaces that work (and told the owner they did not).
 */
export const HOSTED_PANELS: Readonly<Record<string, { issues: boolean; pulls: boolean }>> = {
	github: { issues: true, pulls: true },
	gitlab: { issues: true, pulls: true },
	bitbucket: { issues: true, pulls: true },
};

/** Can this repo show its host's Issues / Pulls panel? It needs a host that serves it AND a coordinate to ask about. */
export function repoHasHostedPanel(repo: RepoIdentity, panel: "issues" | "pulls"): boolean {
	const slug = (repo.repoSlug || repo.githubRepo || "").trim();
	return !!slug && HOSTED_PANELS[repoProvider(repo)]?.[panel] === true;
}

/**
 * The tooltip on a row's external link. It names the host the link actually goes to — "Open on
 * GitHub" on a GitLab merge request is a small lie on every row. A repo with no known host cannot
 * render these panels at all, so its answer is the neutral one rather than a guess.
 */
export function repoLinkTitle(repo: RepoIdentity): string {
	const provider = repoProvider(repo);
	return HOSTED_PANELS[provider] ? `Open on ${repoProviderLabel(provider)}` : "Open in a new tab";
}

/**
 * Why this repo's Issues panel is empty — the client-side mirror of the API's refusal.
 *
 * PURE and here rather than inline in the panel, because the wrong version of this sentence is
 * what #221 is about on this surface. It used to tell a GitLab or Bitbucket owner their host was
 * unsupported, which stopped being true when phases 3–4 shipped; it now names the only real gaps —
 * a local-only repo, a remote PAGS cannot read, or a hosted repo whose coordinate is unknown.
 */
export function repoIssuesUnavailable(repo: RepoIdentity): string {
	return unavailable(repo, "issues");
}

/** The same sentence for the Pulls panel (#401) — same rule, its own noun. */
export function repoPullsUnavailable(repo: RepoIdentity): string {
	return unavailable(repo, "pull requests");
}

function unavailable(repo: RepoIdentity, noun: string): string {
	const provider = repoProvider(repo);
	if (HOSTED_PANELS[provider]) return `PAGS doesn't know which ${repoProviderLabel(provider)} repository this is, so it has no ${noun} to show — set it in this repo's settings.`;
	if (provider === "other") return `This repo's remote isn't on GitHub, GitLab or Bitbucket, so PAGS can't read its ${noun}.`;
	return `This repo is local-only — it isn't connected to GitHub, GitLab or Bitbucket, so it has no ${noun} to show.`;
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
	switch (repoProvider(repo)) {
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
