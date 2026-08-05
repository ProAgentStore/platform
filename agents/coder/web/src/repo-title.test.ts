import { describe, expect, it } from "vitest";
import { repoIsGitHub, repoTitle } from "./repo-title";

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
});
