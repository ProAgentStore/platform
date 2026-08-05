import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A Repo Coder owns exactly ONE repo (capabilities.surfaceOptions.coding.repos === "single").
 * Rendering add-repo and a multi-repo list it can never use is what made a *configured* agent
 * look identical to the hardcoded Coder — the complaint that motivated surface options.
 *
 * Asserted on the source because the affordances are conditional JSX, and the value here is
 * that the gate EXISTS and is wired end-to-end, not how React renders it.
 */
const src = (f: string) => readFileSync(join(import.meta.dirname, f), "utf8");

describe("single-repo agents hide the multi-repo affordances", () => {
	it("ReposList gates the + Add button on singleRepo", () => {
		expect(src("ReposList.tsx")).toContain("!singleRepo && (");
	});

	it("ReposList gates the add form too — not just the button", () => {
		// Hiding only the button would leave the form reachable if state were ever set.
		expect(src("ReposList.tsx")).toContain("{showAddRepo && !singleRepo && (");
	});

	it("defaults to FALSE so every existing coding agent is unchanged", () => {
		// The hardcoded Coder and any agent declaring a bare `surfaces:["coding"]` must keep
		// the full multi-repo UI.
		expect(src("ReposList.tsx")).toContain("singleRepo = false");
		expect(src("CodingTab.tsx")).toContain("singleRepo = false");
	});

	it("CodingTab threads the flag down rather than re-deriving it", () => {
		// One source of truth: the server's declared capability, passed through the surface
		// context. Re-deriving it in the component would drift.
		expect(src("CodingTab.tsx")).toContain("singleRepo={singleRepo}");
	});
});

describe("a one-repo agent gets the repo, not a list containing it", () => {
	// A list exists so you can CHOOSE. With one repo there is nothing to choose between, so the
	// card wrapper, the "Repositories" heading and the "1 active session" strip were all counting
	// and framing a single thing — the same complaint that produced the Builds change.
	const src_ = src("ReposList.tsx");

	it("renders the repo directly when singleRepo and exactly one repo", () => {
		expect(src_).toContain("if (singleRepo && repos.length === 1)");
		// `bare` drops the row chrome so it reads as the page, not as a list item.
		expect(src_).toContain("<RepoCard r={repos[0]} bare />");
	});

	it("does not count sessions in the single-repo view", () => {
		// activeCount is computed only on the list path now.
		const single = src_.slice(src_.indexOf("if (singleRepo && repos.length === 1)"), src_.indexOf("const activeCount"));
		expect(single).not.toContain("activeCount");
	});

	it("uses ONE naming rule for the repo, whatever it was added as", () => {
		// repoTitle: the GitHub coordinate when there is one, else the folder name — so the header
		// stops showing `fws/platform` (last two PATH segments) as if it were an owner/repo slug.
		expect(src_).toContain("repoTitle(r)");
		expect(src_).not.toMatch(/>\{r\.name\}</);
	});

	it("marks a local-only repo as local, so a folder name is not misread as a slug", () => {
		expect(src_).toContain("!repoIsGitHub(r)");
	});

	it("still offers add-repo on a MULTI-repo agent", () => {
		expect(src_).toContain("!singleRepo && (");
	});
});

describe("Work on this issue actually starts work", () => {
	const tab = src("CodingTab.tsx");

	it("hands the issue to the LOOP, not to a box that no longer renders", () => {
		// It called setChatInput, which only ever fed the Co-pilot's input. With the Co-pilot
		// declared off for a configurable Repo Coder (#209) that box is gone, so "Work on this"
		// opened an empty terminal and silently dropped the objective.
		const fn = tab.slice(tab.indexOf("const workOnIssue"), tab.indexOf("const repoLabel"));
		expect(fn).toContain("/loop`");
		expect(fn).toContain("objective");
	});

	it("does not send it to the Assistant chat, which cannot drive the engine", () => {
		// A Repo Coder declares drive:false, so its chat would TALK about the issue and change
		// nothing — the failure #210 exists to prevent. The loop dispatches to the Pilot instead.
		const fn = tab.slice(tab.indexOf("const workOnIssue"), tab.indexOf("const repoLabel"));
		expect(fn).not.toContain("/chat`");
	});

	it("keeps the objective if starting the loop fails", () => {
		// Losing the text you asked for is worse than an unstarted run you can retry.
		const fn = tab.slice(tab.indexOf("const workOnIssue"), tab.indexOf("const repoLabel"));
		expect(fn).toMatch(/catch \{[\s\S]*setChatInput\(objective\)/);
	});
});

describe("clicking Coding lands on the Coding view, not inside a session", () => {
	const tab = src("CodingTab.tsx");

	it("does not restore the last session for a ONE-repo agent", () => {
		// "Restore the repo I was in" answers a multi-repo question. With one repo it fired on
		// every visit, so clicking the Coding tab dropped you straight into a terminal and Builds,
		// Issues and the repo's own status sat behind a back arrow you had to know to press.
		const fn = tab.slice(tab.indexOf("// Auto-open a session on mount"), tab.indexOf("const closeTerminal"));
		expect(fn).toContain("} else if (!singleRepo) {");
		expect(fn).toContain("loadLastRepo(instanceId)");
	});

	it("still honours a deep link to a specific session, for everyone", () => {
		// /coding/csess_x was explicitly asked for; only the implicit restore is scoped.
		const fn = tab.slice(tab.indexOf("// Auto-open a session on mount"), tab.indexOf("const closeTerminal"));
		expect(fn).toContain("if (initialSessionId) {");
	});
});

