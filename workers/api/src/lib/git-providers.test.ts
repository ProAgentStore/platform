import { describe, expect, it } from "vitest";
import {
	GIT_PROVIDERS,
	gitProviderFor,
	hostedFeatureUnavailable,
	isGitProviderId,
	mayAttachCloneCredential,
	parseRepoRef,
	supportsHostedFeature,
} from "./git-providers.js";

/**
 * The provider vocabulary (#221). Three properties are load-bearing and each has its own block:
 *
 *   1. a GitLab/Bitbucket URL is recognised as ITSELF — the bug being fixed is that it was
 *      stored as an empty GitHub repo and then rendered as a local checkout;
 *   2. every GitHub shape the old `parseGithubRepo` regex handled still resolves, because
 *      `routes/coding-shared.ts` now delegates to this parser;
 *   3. a credential never leaves its provider's hosts.
 */

describe("parseRepoRef — GitHub shapes (the ones that must not regress)", () => {
	it("reads https, with or without .git or a trailing slash", () => {
		expect(parseRepoRef("https://github.com/ProAgentStore/platform.git")).toMatchObject({ provider: "github", slug: "ProAgentStore/platform" });
		expect(parseRepoRef("https://github.com/ProAgentStore/platform")).toMatchObject({ provider: "github", slug: "ProAgentStore/platform" });
		expect(parseRepoRef("https://github.com/ProAgentStore/platform/")).toMatchObject({ slug: "ProAgentStore/platform" });
	});

	it("reads an ssh remote — the shape detect-github gets back from `git remote`", () => {
		expect(parseRepoRef("git@github.com:ProAgentStore/platform.git")).toMatchObject({ provider: "github", slug: "ProAgentStore/platform" });
		expect(parseRepoRef("ssh://git@github.com/ProAgentStore/platform.git")).toMatchObject({ slug: "ProAgentStore/platform" });
	});

	it("keeps dots and hyphens in both halves (org.name/repo-name.js)", () => {
		expect(parseRepoRef("https://github.com/some-org/my.repo-name.js")?.slug).toBe("some-org/my.repo-name.js");
	});

	it("canonicalises an https URL but keeps an ssh one VERBATIM", () => {
		// Rewriting ssh → https would take the clone away from the machine's own keys, which for
		// a private repo is often the only credential there is.
		expect(parseRepoRef("https://github.com/o/r")?.cloneUrl).toBe("https://github.com/o/r.git");
		expect(parseRepoRef("git@github.com:o/r.git")?.cloneUrl).toBe("git@github.com:o/r.git");
	});

	it("resolves the BROWSER url, which is what people actually paste", () => {
		expect(parseRepoRef("https://github.com/o/r/tree/main/src")?.slug).toBe("o/r");
	});

	it("does not substring-match the host — an attacker path is not a GitHub repo", () => {
		// The regex this replaces matched `github.com` anywhere in the string, so
		// `https://evil.example/github.com/o/r` read as the GitHub repo `o/r`.
		expect(parseRepoRef("https://evil.example/github.com/o/r")?.provider).toBe("other");
	});

	it("returns null — not a throw — for the absent remote detect-github can receive", () => {
		expect(parseRepoRef(null)).toBeNull();
		expect(parseRepoRef(undefined)).toBeNull();
		expect(parseRepoRef("")).toBeNull();
		// A bare slug is NOT a URL; the add-repo route keeps its own GitHub-default meaning for it.
		expect(parseRepoRef("owner/repo")).toBeNull();
	});
});

describe("parseRepoRef — the providers this issue is about", () => {
	it("recognises GitLab as GitLab, not as an empty GitHub repo", () => {
		expect(parseRepoRef("https://gitlab.com/group/project.git")).toMatchObject({
			provider: "gitlab",
			slug: "group/project",
			webUrl: "https://gitlab.com/group/project",
		});
	});

	it("keeps GitLab's NESTED namespace, which `owner/repo` cannot express", () => {
		// This is why the GitHub-shaped column could not simply be generalised in place.
		expect(parseRepoRef("https://gitlab.com/group/subgroup/project.git")?.slug).toBe("group/subgroup/project");
		expect(parseRepoRef("git@gitlab.com:group/subgroup/project.git")?.slug).toBe("group/subgroup/project");
	});

	it("drops GitLab's `/-/` route marker — everything after it is UI, never namespace", () => {
		expect(parseRepoRef("https://gitlab.com/group/project/-/tree/main/src")?.slug).toBe("group/project");
		expect(parseRepoRef("https://gitlab.com/group/project/-/issues/7")?.cloneUrl).toBe("https://gitlab.com/group/project.git");
	});

	it("recognises Bitbucket, whose slug is exactly workspace/repo", () => {
		expect(parseRepoRef("https://bitbucket.org/workspace/repo.git")).toMatchObject({ provider: "bitbucket", slug: "workspace/repo" });
	});

	it("calls an unknown host `other` — a real remote with no integration, NOT local", () => {
		const ref = parseRepoRef("https://git.internal.example/team/service.git");
		expect(ref).toMatchObject({ provider: "other", host: "git.internal.example", slug: "team/service" });
		// The URL is kept verbatim: a self-managed GitLab clones fine without us knowing what it is.
		expect(ref?.cloneUrl).toBe("https://git.internal.example/team/service.git");
	});
});

describe("mayAttachCloneCredential — the host gate", () => {
	const github = gitProviderFor("github");
	const gitlab = gitProviderFor("gitlab");

	it("refuses to put a GitHub credential in a URL on another host", () => {
		// `githubRepo` and `cloneUrl` are independent add-repo body fields, so this pairing is
		// reachable: without the gate it hands a live installation token to an arbitrary host.
		expect(mayAttachCloneCredential(github, "https://attacker.example/x.git")).toBe(false);
		expect(mayAttachCloneCredential(github, "https://gitlab.com/group/project.git")).toBe(false);
		expect(mayAttachCloneCredential(gitlab, "https://github.com/o/r.git")).toBe(false);
	});

	it("allows the provider's own hosts", () => {
		expect(mayAttachCloneCredential(github, "https://github.com/o/r.git")).toBe(true);
		expect(mayAttachCloneCredential(gitlab, "https://gitlab.com/group/project.git")).toBe(true);
	});

	it("refuses a non-https URL — git ignores a token there, so sending one is pure exposure", () => {
		expect(mayAttachCloneCredential(github, "git@github.com:o/r.git")).toBe(false);
		expect(mayAttachCloneCredential(github, "http://github.com/o/r.git")).toBe(false);
		expect(mayAttachCloneCredential(github, "not a url")).toBe(false);
	});

	it("allows an ABSENT clone URL — back-compat for a repo added as owner/repo", () => {
		expect(mayAttachCloneCredential(github, undefined)).toBe(true);
		expect(mayAttachCloneCredential(github, "")).toBe(true);
	});
});

describe("the registry itself", () => {
	it("resolves ids, and falls back to `local` for anything unknown", () => {
		expect(gitProviderFor("gitlab").id).toBe("gitlab");
		expect(gitProviderFor("nope").id).toBe("local");
		expect(gitProviderFor(null).id).toBe("local");
		expect(isGitProviderId("bitbucket")).toBe(true);
		expect(isGitProviderId("nope")).toBe(false);
	});

	it("gives every provider that can mint a credential a git username", () => {
		// The username half is provider-specific and used to be one hardcoded string in the
		// runner; a provider that mints without one would 401 on every private clone.
		for (const p of GIT_PROVIDERS) {
			if (p.credential !== "none") expect(p.gitUsername, p.id).not.toBe("");
		}
	});

	it("declares what each host can actually be ASKED, one flag per surface", () => {
		// The three flags move independently on purpose. GitLab reads issues and pipelines
		// (`gitlab-api.ts`) but has no merge-request client, and a single `hosted:boolean` would
		// have made turning the first two on assert the third.
		expect(gitProviderFor("github").supports).toEqual({ issues: true, builds: true, pulls: true });
		expect(gitProviderFor("gitlab").supports).toEqual({ issues: true, builds: true, pulls: false });
		for (const id of ["bitbucket", "other", "local"]) {
			expect(gitProviderFor(id).supports, id).toEqual({ issues: false, builds: false, pulls: false });
		}
	});

	it("supportsHostedFeature is the only read of the flags, and is not truthy-loose", () => {
		expect(supportsHostedFeature(gitProviderFor("gitlab"), "issues")).toBe(true);
		expect(supportsHostedFeature(gitProviderFor("gitlab"), "pulls")).toBe(false);
		expect(supportsHostedFeature(gitProviderFor("local"), "builds")).toBe(false);
	});
});

describe("hostedFeatureUnavailable — an unavailable surface says WHY, honestly", () => {
	it("names the provider and the gap for a surface it genuinely cannot drive", () => {
		// Merge requests: GitLab HAS them, PAGS has no client. "yet" is the true word.
		const msg = hostedFeatureUnavailable(gitProviderFor("gitlab"), "pulls");
		expect(msg).toContain("GitLab");
		expect(msg).toMatch(/yet/);
		// The old wording told a perfectly connected GitLab repo it "isn't connected to GitHub",
		// which reads as a setup mistake the owner could fix. It cannot be fixed by the owner.
		expect(msg).not.toMatch(/isn't connected to GitHub/);
		// And it must not say GitHub is the only thing PAGS drives — since #221 phase 3 that is
		// false, and this sentence is read by a GitLab user whose Issues panel works.
		expect(msg).not.toMatch(/GitHub only/);
	});

	it("distinguishes a MISSING coordinate from an undrivable host, per provider", () => {
		// The provider CAN answer — so the only thing wrong is that we don't know what to ask
		// about. Fusing these two was what told a working GitLab repo it wasn't connected.
		const gl = hostedFeatureUnavailable(gitProviderFor("gitlab"), "issues");
		expect(gl).toMatch(/project path/); // GitLab namespaces nest; "owner/name" would be wrong
		expect(gl).not.toMatch(/yet/);
		const gh = hostedFeatureUnavailable(gitProviderFor("github"), "issues");
		expect(gh).toMatch(/owner\/name/);
		// Bitbucket has no client at all — a different sentence, and it must not ask the owner to
		// re-add a repo whose coordinate is already perfectly well recorded.
		expect(hostedFeatureUnavailable(gitProviderFor("bitbucket"), "issues")).toMatch(/yet/);
	});

	it("still tells a local checkout the actionable thing", () => {
		expect(hostedFeatureUnavailable(gitProviderFor("local"), "issues")).toMatch(/local checkout/);
	});
});
