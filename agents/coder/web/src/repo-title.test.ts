import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { repoIsGitHub, repoProviderBadge, repoProviderLabel, repoTitle, repoHasHostedPanel, repoIssuesUnavailable, repoLinkTitle, repoPullsUnavailable } from "./repo-title";

describe("repoTitle — one meaning, however the repo was added", () => {
	it("prefers the GitHub coordinate over the add-time nickname", () => {
		// The bug: a repo added as a local path gets name "fws/platform" — the last two PATH
		// segments — which reads as an owner/repo slug and is not one. The real repo is
		// freewebstore-online/platform. Same element, two meanings, decided by input format.
		expect(repoTitle({ name: "fws/platform", githubRepo: "freewebstore-online/platform" }))
			.toBe("freewebstore-online/platform");
	});

	it("gives the same answer however the SAME repo was added", () => {
		// Added by path, by slug, or by URL — all resolve to one identity once the remote is known.
		const gh = "freewebstore-online/platform";
		expect(repoTitle({ name: "fws/platform", githubRepo: gh })).toBe(gh);
		expect(repoTitle({ name: gh, githubRepo: gh })).toBe(gh);
		expect(repoTitle({ name: "platform", githubRepo: gh })).toBe(gh);
	});

	it("falls back to the folder name for a local-only repo", () => {
		expect(repoTitle({ name: "my-notes", githubRepo: null })).toBe("my-notes");
		expect(repoTitle({ name: "my-notes" })).toBe("my-notes");
		// Whitespace-only is not an identity.
		expect(repoTitle({ name: "my-notes", githubRepo: "   " })).toBe("my-notes");
	});

	it("never renders an empty label", () => {
		// An unnamed repo would otherwise leave the header blank, which is worse than a placeholder.
		expect(repoTitle({ name: "" })).toBe("this repo");
		expect(repoTitle({ name: "  ", githubRepo: "" })).toBe("this repo");
	});

	it("says whether the title is a GitHub coordinate, so the UI need not guess", () => {
		// This is what lets a local repo be marked `local` instead of leaving a bare `a/b` to be
		// misread as a slug — the exact confusion this helper exists to end.
		expect(repoIsGitHub({ name: "fws/platform", githubRepo: "o/r" })).toBe(true);
		expect(repoIsGitHub({ name: "fws/platform" })).toBe(false);
	});

	it("uses the provider-neutral slug, which is the general form of the same rule (#221)", () => {
		// GitLab namespaces nest, so `owner/repo` cannot hold the identity at all.
		expect(repoTitle({ name: "project", provider: "gitlab", repoSlug: "group/subgroup/project" })).toBe("group/subgroup/project");
		// And it equals githubRepo for every GitHub repo, so this widened nothing there.
		expect(repoTitle({ name: "platform", provider: "github", repoSlug: "o/r", githubRepo: "o/r" })).toBe("o/r");
	});
});

describe("repoProviderBadge — the badge names the HOST", () => {
	it("no longer calls a GitLab repo `local`", () => {
		// The bug: the badge asked only "does it have a githubRepo?", so a correctly configured
		// GitLab repo was labelled as having no remote at all.
		expect(repoProviderBadge({ name: "group/project", provider: "gitlab", repoSlug: "group/project" })).toBe("GitLab");
		expect(repoProviderBadge({ name: "w/r", provider: "bitbucket", repoSlug: "w/r" })).toBe("Bitbucket");
		expect(repoProviderBadge({ name: "team/service", provider: "other" })).toBe("git");
	});

	it("stays silent for GitHub — the owner/repo title already says it", () => {
		expect(repoProviderBadge({ name: "fws/platform", provider: "github", githubRepo: "o/r" })).toBeNull();
		// And for a payload from a deployment that predates the column.
		expect(repoProviderBadge({ name: "fws/platform", githubRepo: "o/r" })).toBeNull();
	});

	it("still says `local` for a local checkout", () => {
		expect(repoProviderBadge({ name: "my-notes", provider: "local" })).toBe("local");
		expect(repoProviderBadge({ name: "my-notes" })).toBe("local");
	});

	it("labels every provider for the settings panel", () => {
		expect(repoProviderLabel("github")).toBe("GitHub");
		expect(repoProviderLabel("gitlab")).toBe("GitLab");
		expect(repoProviderLabel("bitbucket")).toBe("Bitbucket");
		expect(repoProviderLabel("other")).toBe("Git remote");
		expect(repoProviderLabel(null)).toBe("Local");
	});
});

describe("the hosted panels follow the provider, not `githubRepo` (#221 phase 2)", () => {
	const github = { name: "o/r", provider: "github", repoSlug: "o/r", githubRepo: "o/r" };
	const gitlab = { name: "project", provider: "gitlab", repoSlug: "group/sub/project" };
	const bitbucket = { name: "widget", provider: "bitbucket", repoSlug: "team/widget" };
	const local = { name: "fws/platform", provider: "local" };
	const other = { name: "mirror", provider: "other", repoSlug: "some/where" };

	it("names the host each row's link actually opens", () => {
		expect(repoLinkTitle(github)).toBe("Open on GitHub");
		expect(repoLinkTitle(gitlab)).toBe("Open on GitLab");
		expect(repoLinkTitle(bitbucket)).toBe("Open on Bitbucket");
		// No host to name — and neither can render these panels — so the neutral answer, never a guess.
		expect(repoLinkTitle(local)).toBe("Open in a new tab");
		expect(repoLinkTitle(other)).toBe("Open in a new tab");
		// A payload from before `provider` existed still reads a GitHub coordinate as GitHub.
		expect(repoLinkTitle({ name: "o/r", githubRepo: "o/r" })).toBe("Open on GitHub");
	});

	it("shows Issues and Pulls for GitHub, GitLab and Bitbucket — the panels GitLab and Bitbucket used to be denied", () => {
		for (const repo of [github, gitlab, bitbucket]) {
			expect(repoHasHostedPanel(repo, "issues"), repo.provider).toBe(true);
			expect(repoHasHostedPanel(repo, "pulls"), repo.provider).toBe(true);
		}
		// The two that the old `githubRepo` gate rendered nothing for — the defect, named.
		expect(gitlab).not.toHaveProperty("githubRepo");
		expect(bitbucket).not.toHaveProperty("githubRepo");
	});

	it("shows neither for a local repo or an unreadable remote, nor for a hosted repo with no coordinate to ask about", () => {
		for (const repo of [local, other, { name: "x", provider: "gitlab" }, { name: "x" }]) {
			expect(repoHasHostedPanel(repo, "issues")).toBe(false);
			expect(repoHasHostedPanel(repo, "pulls")).toBe(false);
		}
	});

	it("says what is actually missing — never that GitLab or Bitbucket are unsupported", () => {
		expect(repoIssuesUnavailable(local)).toBe("This repo is local-only — it isn't connected to GitHub, GitLab or Bitbucket, so it has no issues to show.");
		expect(repoPullsUnavailable(local)).toBe("This repo is local-only — it isn't connected to GitHub, GitLab or Bitbucket, so it has no pull requests to show.");
		expect(repoIssuesUnavailable(other)).toBe("This repo's remote isn't on GitHub, GitLab or Bitbucket, so PAGS can't read its issues.");
		expect(repoPullsUnavailable({ name: "x", provider: "gitlab" })).toBe("PAGS doesn't know which GitLab repository this is, so it has no pull requests to show — set it in this repo's settings.");
		for (const repo of [local, other, { name: "x", provider: "gitlab" }, { name: "x", provider: "bitbucket" }]) {
			expect(repoIssuesUnavailable(repo)).not.toMatch(/aren't supported|not supported/);
			expect(repoPullsUnavailable(repo)).not.toMatch(/aren't supported|not supported/);
		}
	});
});

describe("every place that renders a hosted panel asks the provider (#221 phase 2)", () => {
	// Source-level, because the panels mount inside components with no renderer in this repo's unit
	// suite. The defect was a `githubRepo` gate at each mount — GitLab and Bitbucket repos rendered
	// nothing — so the guard is that no mount of either panel is gated on `githubRepo` again.
	const source = (f: string) => readFileSync(new URL(`./${f}`, import.meta.url), "utf8");
	it.each(["ReposList.tsx", "CodingTab.tsx"])("%s gates Issues and Pulls on repoHasHostedPanel", (f) => {
		const src = source(f);
		expect(src).toMatch(/repoHasHostedPanel\([^)]*"issues"\)/);
		expect(src).toMatch(/repoHasHostedPanel\([^)]*"pulls"\)/);
		expect(src).not.toMatch(/githubRepo\s*(&&|\?)\s*(\(\s*)?(<div[^>]*>\s*)?<(RepoIssues|PullsPanel)/);
	});
	it.each(["RepoIssues.tsx", "PullsPanel.tsx"])("%s names the link's host instead of hardcoding GitHub", (f) => {
		expect(source(f)).not.toContain('title="Open on GitHub"');
		expect(source(f)).toContain("title={repoLinkTitle(repo)}");
	});
});
