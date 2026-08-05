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
 * One rule instead: a repo connected to GitHub is called by its GitHub coordinate, because that
 * is its canonical identity and the thing that matches what you see on github.com. A local-only
 * repo has no such identity, so it keeps its folder name — and `local` says so, rather than
 * leaving a bare `a/b` to be misread as a slug.
 */
export interface RepoIdentity {
	name: string;
	githubRepo?: string | null;
}

export function repoTitle(repo: RepoIdentity): string {
	const gh = (repo.githubRepo || "").trim();
	return gh || (repo.name || "").trim() || "this repo";
}

/** True when the title is a real GitHub coordinate rather than a local folder name. */
export function repoIsGitHub(repo: RepoIdentity): boolean {
	return !!(repo.githubRepo || "").trim();
}
