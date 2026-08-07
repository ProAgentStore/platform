// What did the user type into "Add a repo"?
//
// One text box accepts four different things — a local checkout, a clone URL, an `owner/repo`
// slug, or a bare name — and the answer is a DIFFERENT request body in each case. The server
// branches hard on which field arrives (routes/coding-repos.ts): `localPath` means "run in the
// user's own checkout, never clone", `cloneUrl` is handed to git verbatim, and `githubRepo` is
// what unlocks builds, issues and private-repo installation tokens.
//
// It lived inline in the click handler, so the only way to find out what a given string became
// was to type it and see what got created.
//
// ── The classification bug this found
//
// The old chain tested `val.includes(".git")` for "is this a clone URL" — a SUBSTRING test, on
// the most common suffix in the GitHub namespace. `.github.io` contains `.git`. So:
//
//   torvalds/torvalds.github.io  ->  { cloneUrl: "torvalds/torvalds.github.io" }
//   mysite.github.io             ->  { cloneUrl: "mysite.github.io" }
//   owner/repo.git               ->  { cloneUrl: "owner/repo.git" }
//
// None of those is a URL. The server's `parseGithubRepo` finds no `github.com` in them, so the
// repo is created with no `githubRepo` (no builds, no issues) and a `cloneUrl` git cannot fetch
// — the clone fails on the runner, well away from the box that accepted it. Every GitHub Pages
// user site in existence is named `<user>.github.io`, and `owner/repo.git` is what you get by
// pasting a clone URL and deleting the host.
//
// The suffix is now anchored, and the `owner/repo` shape is recognised on the OWNER — GitHub
// logins are `[A-Za-z0-9-]` only, so a first segment carrying a dot is a hostname, not a login.

/** Exactly one of these fields; the server branches on which one arrives. */
export type AddRepoBody =
	| { localPath: string }
	| { cloneUrl: string }
	| { githubRepo: string; cloneUrl: string }
	| { name: string };

/** A GitHub login: alphanumerics and hyphens, no dots. A dotted first segment is a host. */
const OWNER = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
/** A GitHub repository name. Dots are legal here — `foo.github.io`, `dotfiles.git`. */
const REPO = /^[\w.-]+$/;

/**
 * Classify the add-repo box, or null when there is nothing to add.
 *
 * Order is the specification: a local path is decided by its first character, an explicit URL by
 * carrying a scheme, and only then is a slash read as `owner/repo`.
 */
export function parseRepoInput(raw: string): AddRepoBody | null {
	const val = raw.trim();
	if (!val) return null;

	// A path on the runner machine. `~` and `/` were always accepted; `./`, `../` and a Windows
	// drive letter are the same statement and used to fall through to "a name".
	if (/^(~|\/|\.\.?\/|[A-Za-z]:[\\/])/.test(val)) return { localPath: val };

	// Carries its own scheme — hand it to git as-is. `git@host:owner/repo.git` has no `://`.
	if (val.includes("://") || val.startsWith("git@")) return { cloneUrl: val };

	const slash = val.indexOf("/");
	if (slash > 0) {
		const owner = val.slice(0, slash);
		const rest = val.slice(slash + 1);
		// A dotted first segment is a hostname: someone pasted a URL without the scheme
		// (`github.com/owner/repo`). Prefixing https makes it a URL the server can parse an
		// `owner/repo` back out of — the old chain stored it as the LITERAL githubRepo
		// "github.com/owner/repo", which is not a GitHub coordinate.
		if (owner.includes(".")) return { cloneUrl: `https://${val}` };
		// `owner/repo`, with the clone URL derived rather than typed. The `.git` suffix is
		// stripped from the coordinate and put back on the URL.
		const repo = rest.replace(/\.git$/, "");
		if (OWNER.test(owner) && REPO.test(repo) && !repo.includes("/")) {
			return { githubRepo: `${owner}/${repo}`, cloneUrl: `https://github.com/${owner}/${repo}.git` };
		}
		// A slash, but neither a coordinate nor a host — `a/b/c`, or a login with a space in it.
		// Sending it as a clone URL asks git to fetch nonsense; as a name it is at least a repo
		// the user can point at a source afterwards.
		return { name: val };
	}

	// A bare `.git` suffix with no slash — `dotfiles.git` — is still a name, not a URL.
	return { name: val };
}
