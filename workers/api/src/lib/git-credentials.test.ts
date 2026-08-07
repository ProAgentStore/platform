import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Env } from "../types.js";

/**
 * The token-minting seam (#221) — the part of provider-neutrality that is hard to get right,
 * because the three grant models do not share a shape.
 *
 * What is asserted here:
 *   · GitHub still resolves through `installationTokenForOwner`, unchanged, including the
 *     verified-installation binding that stops cross-tenant private-repo access;
 *   · GitLab resolves through the ENCRYPTED VAULT, with its own username;
 *   · a credential never travels to a host outside its provider's — the exfiltration path the
 *     add-repo route's two independent fields (`githubRepo` + `cloneUrl`) opens.
 */

const installationTokenForOwner = vi.fn();
const readConnectorRefreshToken = vi.fn();

vi.mock("./github-app.js", () => ({
	installationTokenForOwner: (...args: unknown[]) => installationTokenForOwner(...args),
}));
vi.mock("./connector-oauth.js", () => ({
	readConnectorRefreshToken: (...args: unknown[]) => readConnectorRefreshToken(...args),
}));

const { resolveCloneCredential } = await import("./git-credentials.js");

const env = {} as Env;

beforeEach(() => {
	installationTokenForOwner.mockReset();
	readConnectorRefreshToken.mockReset();
});

describe("GitHub — unchanged", () => {
	it("mints an installation token for the repo's OWNER and labels it x-access-token", async () => {
		installationTokenForOwner.mockResolvedValue("ghs_live");
		const cred = await resolveCloneCredential(env, "u1", {
			provider: "github",
			githubRepo: "ProAgentStore/platform",
			cloneUrl: "https://github.com/ProAgentStore/platform.git",
		});
		expect(cred).toEqual({ username: "x-access-token", token: "ghs_live" });
		expect(installationTokenForOwner).toHaveBeenCalledWith(env, "u1", "ProAgentStore");
	});

	it("resolves a row written BEFORE the provider column existed", async () => {
		// Migration 0097 backfills, but a caller holding a legacy object (or a test fixture) has
		// no `provider` at all. `github_repo` present meant GitHub — the only thing it could mean.
		installationTokenForOwner.mockResolvedValue("ghs_live");
		const cred = await resolveCloneCredential(env, "u1", { githubRepo: "o/r" });
		expect(cred?.token).toBe("ghs_live");
	});

	it("returns null (clone it publicly) when no token can be minted — never throws", async () => {
		installationTokenForOwner.mockResolvedValue(null);
		expect(await resolveCloneCredential(env, "u1", { provider: "github", githubRepo: "o/r" })).toBeNull();
		installationTokenForOwner.mockRejectedValue(new Error("GitHub is down"));
		expect(await resolveCloneCredential(env, "u1", { provider: "github", githubRepo: "o/r" })).toBeNull();
	});

	it("does not even attempt a mint without an owner", async () => {
		expect(await resolveCloneCredential(env, "u1", { provider: "github" })).toBeNull();
		expect(installationTokenForOwner).not.toHaveBeenCalled();
	});
});

describe("GitLab — the new provider, on its own grant model", () => {
	it("reads the user-scoped token from the encrypted vault, as oauth2", async () => {
		readConnectorRefreshToken.mockResolvedValue("glpat-abc");
		const cred = await resolveCloneCredential(env, "u1", {
			provider: "gitlab",
			repoSlug: "group/subgroup/project",
			cloneUrl: "https://gitlab.com/group/subgroup/project.git",
		});
		expect(cred).toEqual({ username: "oauth2", token: "glpat-abc" });
		// Through the vault helper — envelope-encrypted `user_api_keys`, never a new plaintext store.
		expect(readConnectorRefreshToken).toHaveBeenCalledWith(env, "u1", "gitlab", "GitLab");
		// And NOT through GitHub's owner-scoped installation model, which has no meaning here:
		// "group" is not an account that can have an App installed on it.
		expect(installationTokenForOwner).not.toHaveBeenCalled();
	});

	it("degrades to an unauthenticated clone when no key is stored", async () => {
		// The vault helper raises a 400 for a missing row; that is the ORDINARY state for a
		// public repo, so it must not surface as an error to the clone path.
		readConnectorRefreshToken.mockRejectedValue(new Error("GitLab is not connected"));
		expect(await resolveCloneCredential(env, "u1", { provider: "gitlab", repoSlug: "g/p" })).toBeNull();
	});
});

describe("providers with no credential model", () => {
	it("mints nothing for local, bitbucket or an unknown host", async () => {
		// Bitbucket is DEFERRED (#221): its app password is a username + secret, and the vault
		// holds one opaque value per provider. Wiring it anyway would 401 while looking configured.
		for (const provider of ["local", "bitbucket", "other"]) {
			expect(await resolveCloneCredential(env, "u1", { provider, repoSlug: "w/r", cloneUrl: "https://bitbucket.org/w/r.git" })).toBeNull();
		}
		expect(readConnectorRefreshToken).not.toHaveBeenCalled();
		expect(installationTokenForOwner).not.toHaveBeenCalled();
	});
});

describe("a credential never leaves its provider's hosts", () => {
	it("refuses to hand a GitHub token to a clone URL on another host", async () => {
		installationTokenForOwner.mockResolvedValue("ghs_live");
		// Reachable today: `githubRepo` and `cloneUrl` are independent fields on the add-repo
		// body, so this pair is a request anyone can make. The token is the caller's own, which
		// is why it is not cross-tenant — but it reads every repo in that installation, and it
		// would be handed to a host of the caller's choosing.
		const cred = await resolveCloneCredential(env, "u1", {
			provider: "github",
			githubRepo: "me/private",
			cloneUrl: "https://attacker.example/x.git",
		});
		expect(cred).toBeNull();
		expect(installationTokenForOwner).not.toHaveBeenCalled();
	});

	it("refuses to hand a GitLab token to a GitHub URL", async () => {
		readConnectorRefreshToken.mockResolvedValue("glpat-abc");
		expect(
			await resolveCloneCredential(env, "u1", { provider: "gitlab", repoSlug: "g/p", cloneUrl: "https://github.com/o/r.git" }),
		).toBeNull();
	});
});
