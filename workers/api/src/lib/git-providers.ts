/**
 * Which git host a repo lives on — as DATA, not a chain of `if (host === "gitlab.com")` (#221).
 *
 * ── The seam, and why it is drawn HERE
 *
 * The obvious abstraction — generalise `installationTokenForOwner(env, userId, owner)` — is the
 * wrong one, and #221's own audit says so. That signature encodes GitHub's GRANT model: a
 * credential is minted per *installation*, an installation is bound to an *account*, and `owner`
 * is the resource scope because on GitHub it genuinely is. GitLab's token belongs to a USER and
 * its namespaces nest arbitrarily (`group/subgroup/project`), so there is no single "owner"
 * segment to key by; Bitbucket's app passwords are user-scoped while its OAuth is
 * workspace-scoped. An interface shaped like the only implementation would force both of the
 * others to lie to it.
 *
 * So what is abstracted is the OUTPUT, not the input: every provider must be able to produce
 * "the username and secret to put in an https clone URL", and each is free to obtain that
 * however its own grant model works (see `git-credentials.ts`). This module holds only the
 * part that needs no network and no env — identity, hosts, and what the platform can actually
 * drive for that host — so the whole vocabulary is pinned by unit tests.
 *
 * ── Why `hosts` is load-bearing rather than documentation
 *
 * `mayAttachCloneCredential` is a SECURITY control, not a tidy-up. The add-repo route accepts
 * `githubRepo` and `cloneUrl` as independent fields, so `{githubRepo:"me/private", cloneUrl:
 * "https://attacker.example/x.git"}` would previously mint a real installation token for an
 * owner the caller is verified against and hand it to whatever host the clone URL named. The
 * token is the caller's own, so this is not cross-tenant — but it is a working exfiltration
 * path for a credential that reads every repo in that installation. A credential now travels
 * only to a host its own provider owns.
 */

/**
 * `other` is deliberate, and is not in #221's plan doc. A clone URL on an unrecognised host
 * (self-managed GitLab, Gitea, an internal mirror) is NOT `local` — calling it that would put a
 * "local" badge on a remote repo, which is the same class of lie as calling a GitLab repo a
 * GitHub one. It means: a real git remote, with no hosted integration behind it.
 */
export type GitProviderId = "local" | "github" | "gitlab" | "bitbucket" | "other";

/** How a clone credential for this provider is obtained. Each is a different grant model. */
export type GitCredentialModel =
	/** GitHub App installation token, minted per owner against a verified binding. */
	| "github-app"
	/** A user-scoped token from the encrypted vault (`user_api_keys`). */
	| "vault-token"
	/** Nothing to mint — public clone, or whatever credentials the user's own machine has. */
	| "none";

export interface GitProvider {
	id: GitProviderId;
	label: string;
	/**
	 * The hosts this provider owns. A clone credential is NEVER embedded in a URL on any other
	 * host — see the module header.
	 */
	hosts: string[];
	/**
	 * The username half of an https clone credential. GitHub wants `x-access-token`, GitLab
	 * `oauth2`, Bitbucket `x-token-auth` — the same token in the wrong username is a 401, which
	 * is why this is data rather than the one hardcoded string the runner used to carry.
	 */
	gitUsername: string;
	credential: GitCredentialModel;
	/** `user_api_keys.provider` backing `credential: "vault-token"`. */
	vaultProvider?: string;
	/**
	 * Namespaces nest (GitLab `group/subgroup/project`). Everything else is exactly
	 * `owner/name`, so a longer path is a web URL with extra segments to drop.
	 */
	nestedNamespaces?: boolean;
	/**
	 * What the platform can actually DRIVE for this host today — not what the host offers.
	 * GitLab has issues and pipelines; PAGS has no client for either yet, and a surface that
	 * claims otherwise is worse than one that says "not yet".
	 */
	supports: { issues: boolean; builds: boolean };
}

export const GIT_PROVIDERS: GitProvider[] = [
	{
		id: "local",
		label: "Local",
		hosts: [],
		gitUsername: "",
		credential: "none",
		supports: { issues: false, builds: false },
	},
	{
		id: "github",
		label: "GitHub",
		hosts: ["github.com", "www.github.com"],
		gitUsername: "x-access-token",
		credential: "github-app",
		supports: { issues: true, builds: true },
	},
	{
		id: "gitlab",
		label: "GitLab",
		hosts: ["gitlab.com", "www.gitlab.com"],
		// GitLab accepts a personal access token as the PASSWORD with `oauth2` as the username;
		// the same form works for an OAuth access token, so one shape covers both.
		gitUsername: "oauth2",
		credential: "vault-token",
		vaultProvider: "gitlab",
		nestedNamespaces: true,
		// Issues and pipelines are DEFERRED (#221): representing a GitLab repo honestly and
		// cloning it is this pass; a GitLab API client is not. `false` is what makes the
		// console hide those panels and the routes refuse with a true sentence.
		supports: { issues: false, builds: false },
	},
	{
		id: "bitbucket",
		label: "Bitbucket",
		hosts: ["bitbucket.org", "www.bitbucket.org"],
		gitUsername: "x-token-auth",
		// DEFERRED: Bitbucket's credential is an app password (username + secret) or a
		// workspace-scoped OAuth token. The vault is keyed `(user, provider)` and holds ONE
		// opaque secret, so an app password has nowhere to put its username. Wiring it to the
		// vault anyway would 401 on every private clone while looking configured — so
		// Bitbucket is parsed and represented, and its private repos say so.
		credential: "none",
		supports: { issues: false, builds: false },
	},
	{
		id: "other",
		label: "Git remote",
		hosts: [],
		gitUsername: "",
		credential: "none",
		supports: { issues: false, builds: false },
	},
];

const BY_ID = new Map(GIT_PROVIDERS.map((p) => [p.id, p]));
const BY_HOST = new Map(GIT_PROVIDERS.flatMap((p) => p.hosts.map((h) => [h, p] as const)));

/** The provider for an id. Unknown/absent → `local`, which grants nothing and claims nothing. */
export function gitProviderFor(id: string | null | undefined): GitProvider {
	return BY_ID.get(String(id ?? "") as GitProviderId) ?? (BY_ID.get("local") as GitProvider);
}

/** Is `id` one of the declared providers? Used to validate a caller-supplied `provider`. */
export function isGitProviderId(id: unknown): id is GitProviderId {
	return typeof id === "string" && BY_ID.has(id as GitProviderId);
}

/** A repo reference resolved from whatever the user pasted. */
export interface RepoRef {
	provider: GitProviderId;
	/** `owner/name`, or `group/subgroup/project` on GitLab. Empty when the host is unknown. */
	slug: string;
	/**
	 * The URL to actually clone from.
	 *
	 * An https input is CANONICALISED (`.git` appended, a browser path like `/-/tree/main`
	 * dropped) because the page you were looking at is not a URL git can fetch. An ssh or
	 * scp-like input is kept VERBATIM — rewriting it to https would take the clone away from the
	 * machine's own ssh keys, which for a lot of private repos is the only credential there is.
	 */
	cloneUrl: string;
	/** Browser URL for the repo. Empty when the host is unknown. */
	webUrl: string;
	/** The host as parsed, lower-cased. Kept for `other`, where it is all the identity there is. */
	host: string;
}

/** `git@host:path` (scp-like, no scheme) → a URL the WHATWG parser accepts. */
function normalizeScpLike(raw: string): string {
	const m = raw.match(/^(?:([\w.-]+)@)?([\w.-]+):(?!\/\/)(.+)$/);
	return m ? `ssh://${m[1] ? `${m[1]}@` : ""}${m[2]}/${m[3]}` : raw;
}

/**
 * What did the user point us at?
 *
 * Handles https, ssh://, and scp-like `git@host:owner/repo.git`, with or without `.git`, with or
 * without a trailing slash, and tolerates the extra path a BROWSER url carries — GitHub's
 * `/tree/main`, GitLab's `/-/tree/main`. Pasting the page you are looking at is the single most
 * common way a repo gets added, and it is not a URL git can clone.
 *
 * Returns null only for something that is not a URL at all (a bare name, an `owner/repo` slug) —
 * those keep their existing meaning at the call site, where GitHub remains the back-compatible
 * default for a bare slug.
 */
export function parseRepoRef(raw: string | null | undefined): RepoRef | null {
	const input = String(raw ?? "").trim();
	if (!input) return null;
	if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(input) && !/^[\w.-]+@[\w.-]+:/.test(input)) return null;
	let url: URL;
	try {
		url = new URL(normalizeScpLike(input));
	} catch {
		return null;
	}
	const host = url.hostname.toLowerCase();
	const provider = BY_HOST.get(host);
	// Cut GitLab's `/-/` route marker first: everything after it is UI, never namespace.
	const path = url.pathname.split("/-/")[0].replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/i, "");
	if (!provider) {
		// An unrecognised host is a real remote we simply have no integration for. Keep the URL
		// the user gave us verbatim — a self-managed GitLab clones perfectly well without us
		// knowing what it is.
		return { provider: "other", slug: path, cloneUrl: input, webUrl: "", host };
	}
	const segments = path.split("/").filter(Boolean);
	if (segments.length < 2) return { provider: provider.id, slug: "", cloneUrl: input, webUrl: "", host };
	// GitHub/Bitbucket are exactly owner/name; the rest of a browser path is `tree/main/src`.
	// GitLab nests, so keep every segment — but drop the web suffixes it does not use `/-/` for.
	const slugSegments = provider.nestedNamespaces ? segments.filter((s) => s !== "tree" && s !== "blob") : segments.slice(0, 2);
	const slug = slugSegments.join("/");
	const base = `https://${provider.hosts[0]}/${slug}`;
	const isHttps = /^https:\/\//i.test(input);
	return { provider: provider.id, slug, cloneUrl: isHttps ? `${base}.git` : input, webUrl: base, host };
}

/**
 * May a clone credential minted for `provider` be embedded in `cloneUrl`?
 *
 * The host check is the security control (module header). The https check is not decoration
 * either: a token in an `ssh://` or scp-like URL is silently ignored by git, so answering "yes"
 * there would mean minting a credential that cannot work and sending it anyway.
 *
 * An ABSENT clone URL answers true. That is deliberate back-compat, not an oversight: a repo
 * added as `owner/repo` with no URL has always had a token minted for it, and the runner only
 * ever uses the token to clone — so narrowing that here would be a behaviour change smuggled
 * into a security fix.
 */
export function mayAttachCloneCredential(provider: GitProvider, cloneUrl?: string | null): boolean {
	const url = String(cloneUrl ?? "").trim();
	if (!url) return true;
	if (!/^https:\/\//i.test(url)) return false;
	try {
		return provider.hosts.includes(new URL(url).hostname.toLowerCase());
	} catch {
		return false;
	}
}

/**
 * The one sentence a hosted surface says when it cannot serve this repo.
 *
 * PURE and centralised so "not supported yet" is never phrased as "not connected to GitHub" —
 * the message a GitLab repo used to get, which reads as a setup mistake the owner could fix.
 */
export function hostedFeatureUnavailable(provider: GitProvider, feature: "issues" | "builds" | "pull requests"): string {
	const what = feature === "issues" ? "Issues" : feature === "pull requests" ? "Pull requests" : "Build status";
	if (provider.id === "local") {
		return `${what} needs a hosted repo — this one is a local checkout. Add it by owner/repo or a GitHub URL to use ${feature}.`;
	}
	if (provider.id === "github") {
		return `${what} needs this repo's owner/name — it isn't recorded. Re-add it by owner/repo or a GitHub URL.`;
	}
	if (provider.id === "other") {
		return `${what} isn't available for this repo — PAGS has no integration for its host, so it can be cloned and coded on but not queried.`;
	}
	return `${what} isn't supported for ${provider.label} repos yet — PAGS drives GitHub only. The repo still clones and codes normally.`;
}
