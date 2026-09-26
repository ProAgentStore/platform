/**
 * The Coder web decides which hosted panels to render from `HOSTED_PANELS`, a hand-kept mirror of
 * `GIT_PROVIDERS[].supports` (#221 phase 2). Before it existed the panels were gated on `githubRepo`,
 * so GitLab and Bitbucket repos — whose issues and pulls this API serves — never saw either panel.
 * A mirror that can drift is the same defect waiting, so it is pinned here: a provider that gains or
 * loses `issues`/`pulls` in the API fails this test until the console says the same.
 */
import { describe, expect, it } from "vitest";
import { HOSTED_PANELS, repoProviderLabel } from "../../../../agents/coder/web/src/repo-title";
import { GIT_PROVIDERS } from "./git-providers.js";

describe("the Coder web's hosted-panel table mirrors the provider table", () => {
	it("offers a panel exactly where the API serves it", () => {
		const fromApi = Object.fromEntries(
			GIT_PROVIDERS.filter((p) => p.supports.issues || p.supports.pulls).map((p) => [p.id, { issues: p.supports.issues, pulls: p.supports.pulls }]),
		);
		expect(HOSTED_PANELS).toEqual(fromApi);
	});

	it("labels every hosted provider with the API's own name for it", () => {
		for (const p of GIT_PROVIDERS.filter((p) => HOSTED_PANELS[p.id])) expect(repoProviderLabel(p.id)).toBe(p.label);
	});
});
