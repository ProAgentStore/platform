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

describe("a one-repo agent gets Terminal / Issues / Builds, not a repo list", () => {
	// A one-repo Coder had `Repos | Builds` where "Repos" was one repo, Issues were nested inside
	// that repo's card, and opening the terminal took over the whole header — so every other view
	// went behind a back arrow. Those three ARE the agent's surface, so they are the navigation.
	const tab = src("CodingTab.tsx");

	it("routes a single-repo agent to its own three-view surface", () => {
		expect(tab).toContain('const [soloView, setSoloView] = useState<"terminal" | "issues" | "builds">');
		expect(tab).toContain("if (singleRepo && repos.length <= 1) {");
	});

	it("falls back to the list if the data disagrees with the declaration", () => {
		// `repos: "single"` is what the agent SAYS. Two rows in data and a solo view showing
		// repos[0] would make the other unreachable, so the guard is on the data too.
		expect(tab).toContain("repos.length <= 1");
	});

	it("keeps navigation visible instead of taking over the header", () => {
		// The header takeover is what hid Builds and Issues behind a back arrow.
		const solo = tab.slice(tab.indexOf("if (singleRepo && repos.length <= 1)"), tab.indexOf("// ── Session open"));
		expect(solo).toContain('tab("terminal", "Terminal"');
		expect(solo).toContain('tab("issues", "Issues"');
		expect(solo).toContain('tab("builds", "Builds"');
		expect(solo).not.toContain("onHeaderOverride");
	});

	it("opens Issues expanded — as its own tab there is nothing to expand into", () => {
		const solo = tab.slice(tab.indexOf("if (singleRepo && repos.length <= 1)"), tab.indexOf("// ── Session open"));
		expect(solo).toContain("startOpen");
	});

	it("offers a way to START when nothing is running, rather than an empty pane", () => {
		const solo = tab.slice(tab.indexOf("if (singleRepo && repos.length <= 1)"), tab.indexOf("// ── Session open"));
		expect(solo).toContain("Start a session");
		expect(solo).toContain("pags up");
	});

	it("ReposList no longer carries a dead single-repo branch", () => {
		// CodingTab returns before it, so the branch was unreachable — the "old page" to remove.
		const list = src("ReposList.tsx");
		expect(list).not.toContain("the repo IS the page");
		expect(list).not.toContain("repos.length === 1");
		// …but still hides add-repo in the misconfiguration fallback.
		expect(list).toContain("!singleRepo && (");
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

