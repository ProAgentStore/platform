/**
 * The ONE place a clone credential is minted, for any git provider (#221).
 *
 * Three call sites used to open with the same two lines — `ownerOf(repo.githubRepo)` then
 * `installationTokenForOwner(...)` — and hand the result to the runner as a bare `token`
 * (`coding-session-open.ts`, the Coding-tab `/run` route, the Overseer's delegation). Each of
 * them was a hardcoded answer to "how does GitHub authenticate a clone", so adding a provider
 * meant editing all three identically or leaving one behind.
 *
 * What crosses this boundary is a CREDENTIAL, not a token: the username half differs per
 * provider and is exactly what the runner had hardcoded. See `git-providers.ts` for why the
 * seam is drawn here rather than by generalising `installationTokenForOwner`'s signature —
 * GitHub's owner-scoped installation model does not survive contact with GitLab's user-scoped
 * token, and an interface shaped like one implementation would force the other to lie.
 *
 * Nothing here weakens GitHub's path: it still goes through `installationTokenForOwner`, which
 * still refuses to mint without the verified installation binding that stops cross-tenant
 * private-repo access.
 */
import { readConnectorRefreshToken } from "./connector-oauth.js";
import { installationTokenForOwner } from "./github-app.js";
import { gitProviderFor, mayAttachCloneCredential, type GitProvider } from "./git-providers.js";
import type { Env } from "../types.js";

/** The username/secret pair that goes into an https clone URL. */
export interface GitCloneCredential {
	username: string;
	token: string;
}

/** The fields of a `coding_repos` row this resolution needs — nothing else. */
export interface CloneTarget {
	provider?: string | null;
	/** GitHub's `owner/name`. Still the compatibility identity for pre-#221 rows. */
	githubRepo?: string | null;
	/** The provider-neutral slug (`group/subgroup/project` on GitLab). */
	repoSlug?: string | null;
	cloneUrl?: string | null;
}

/**
 * The owner half of an `owner/repo` — what a GitHub installation is keyed by.
 *
 * A private copy of `routes/coding-shared.ts`'s helper, deliberately: `lib/*` may not import
 * `routes/*` (the acyclic rule `import-graph.test.ts` enforces), and moving the routes one here
 * would drag the tenant gate and the runner-conn helpers along with it.
 */
function ownerOf(slug: string): string {
	return slug.split("/")[0] ?? "";
}

/**
 * A repo with no stored `provider` (every row written before migration 0097, and any caller
 * that only knows the legacy shape) still has to resolve. `github_repo` present means GitHub —
 * that was the only thing it could ever mean.
 */
function providerFor(repo: CloneTarget): GitProvider {
	if (repo.provider) return gitProviderFor(repo.provider);
	return gitProviderFor(repo.githubRepo ? "github" : "local");
}

/**
 * Read a user-scoped provider token out of the encrypted vault (`user_api_keys`), or null.
 *
 * Never throws: an absent key is the ORDINARY state for a public repo, and the caller's
 * contract is "no credential → clone it publicly". `readConnectorRefreshToken` raises a 400 for
 * a missing row and a 500 with no KEK, both of which mean the same thing here.
 */
async function vaultToken(env: Env, userId: string, provider: GitProvider): Promise<string | null> {
	if (!provider.vaultProvider) return null;
	return readConnectorRefreshToken(env, userId, provider.vaultProvider, provider.label).catch(() => null);
}

/**
 * The credential to clone `repo` with, or null for "clone it publicly / with whatever the
 * machine already has". Never throws — a clone that cannot be authenticated must still be
 * attempted, because most repos are public and a local checkout needs nothing at all.
 */
export async function resolveCloneCredential(env: Env, userId: string, repo: CloneTarget): Promise<GitCloneCredential | null> {
	const provider = providerFor(repo);
	if (provider.credential === "none") return null;
	// SECURITY: a credential only ever travels to a host its own provider owns. Without this,
	// `{githubRepo:"me/private", cloneUrl:"https://attacker.example/x.git"}` — two independent
	// fields on the add-repo route — hands a live installation token to an arbitrary host.
	if (!mayAttachCloneCredential(provider, repo.cloneUrl)) return null;
	const slug = (repo.repoSlug || repo.githubRepo || "").trim();
	switch (provider.credential) {
		case "github-app": {
			const owner = ownerOf(slug);
			if (!owner) return null;
			const token = await installationTokenForOwner(env, userId, owner).catch(() => null);
			return token ? { username: provider.gitUsername, token } : null;
		}
		case "vault-token": {
			const token = await vaultToken(env, userId, provider);
			return token ? { username: provider.gitUsername, token } : null;
		}
	}
}
