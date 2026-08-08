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

/**
 * Source with comments removed. Several assertions below forbid a pattern, and the comment
 * explaining WHY necessarily contains it — without this, the note documenting a fix fails the
 * test protecting it.
 */
const code = (f: string) =>
	src(f)
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.split("\n")
		.map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
		.join("\n");

describe("single-repo agents hide the multi-repo affordances", () => {
	it("ReposList gates the + Add button on singleRepo", () => {
		expect(src("ReposList.tsx")).toContain("!singleRepo && (");
	});

	it("ReposList gates the add form too — not just the button", () => {
		// Hiding only the button would leave the form reachable if state were ever set.
		expect(src("ReposList.tsx")).toContain("{((showAddRepo && !singleRepo) || needsFirstRepo) && (");
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

describe("a one-repo agent gets Terminal / Issues / Pulls / Builds, not a repo list", () => {
	// A one-repo Coder had `Repos | Builds` where "Repos" was one repo, Issues were nested inside
	// that repo's card, and opening the terminal took over the whole header — so every other view
	// went behind a back arrow. Those views ARE the agent's surface, so they are the navigation.
	// Pulls joined them in #401: under the safest merge policy (#314) a pull request IS the agent's
	// output, and it was the one artefact this surface could not show.
	const tab = src("CodingTab.tsx");

	it("routes a single-repo agent to its own four-view surface", () => {
		expect(tab).toContain('const [soloView, setSoloView] = useState<"terminal" | "issues" | "pulls" | "builds">');
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
		expect(solo).toContain('tab("pulls", "Pulls"');
		expect(solo).toContain('tab("builds", "Builds"');
		expect(solo).not.toContain("onHeaderOverride");
	});

	it("the header-override EFFECT is also skipped — not just the render path", () => {
		// The effect fires on `openSession` alone, so the solo view started a session and then had
		// its page header replaced anyway: the instance tab bar vanished and two sets of chrome
		// stacked. Rendering a different tree is not enough when an effect pushes the old one.
		expect(tab).toContain("if (singleRepo || !openSession || !onHeaderOverride) return;");
	});

	it("carries the session actions the takeover used to provide", () => {
		// Without these the solo view could START a session and never stop it.
		const solo = tab.slice(tab.indexOf("if (singleRepo && repos.length <= 1)"), tab.indexOf("// ── Session open"));
		expect(solo).toContain("endSession");
		expect(solo).toContain("restartSession");
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

/**
 * Hiding add-repo at ONE repo is right; hiding it at ZERO is what made a deleted repo
 * unrecoverable (#411).
 *
 * The hiding was always paired with something else that could set the repo: a `repo` field in
 * Agent settings, which seeded a `coding_repos` row the FIRST time it was saved and was read by
 * nothing afterwards. That half-wire is the bug this pair of tickets came from ("I updated it,
 * but it is still using the old one"), migration 0101 deletes the field, and the add form is what
 * takes its place — so a one-repo agent with no repo has an affordance rather than a sign pointing
 * at a control that no longer exists.
 */
describe("a one-repo agent with NO repo can still add one", () => {
	const list = src("ReposList.tsx");
	const tab = code("CodingTab.tsx");

	it("ReposList shows the add form at zero repos, even when singleRepo", () => {
		expect(list).toContain("const needsFirstRepo = singleRepo && repos.length === 0;");
		expect(list).toContain("|| needsFirstRepo) && (");
	});

	it("the solo view — the ONLY surface a one-repo agent reaches — carries the form itself", () => {
		// CodingTab returns its solo branch before ReposList is ever rendered for this agent, so
		// ReposList's empty state alone would still be unreachable.
		const solo = tab.slice(tab.indexOf("if (singleRepo && repos.length <= 1)"), tab.indexOf("// ── Session open"));
		expect(solo).toContain("{!solo ? (");
		expect(solo).toContain("<AddRepoForm");
	});

	it("both surfaces render the SAME form, not two copies of an input and a button", () => {
		// Two copies is how a console acquires a fourteenth button shape (#366/#367) — and the
		// lesson of this very ticket is that one fact gets one place, control included.
		for (const f of ["ReposList.tsx", "CodingTab.tsx"]) {
			expect(code(f), f).toContain('import AddRepoForm from "./AddRepoForm"');
			expect(code(f), f).not.toContain('aria-label="Repository path or URL"');
		}
	});

	it("no empty state still points at the deleted Agent-settings field", () => {
		// The sentence that sent an owner to a control that did nothing, in both places it appeared.
		for (const f of ["ReposList.tsx", "CodingTab.tsx"]) {
			expect(code(f), f).not.toContain("Settings → Agent settings");
		}
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

describe("the Terminal tab shows the terminal", () => {
	const tab = src("CodingTab.tsx");

	// The three branches that used to be asserted here as SOURCE STRINGS inside the effect
	// ("} else if (singleRepo) {") are now driven directly — see session-open.test.ts, which
	// answers questions this file never could, like what a deep link to an ENDED session does.
	// What is left here is the wiring: the effect must still USE that decision and still feed it
	// the remembered repo, which no unit test of the pure module can see.
	it("delegates the choice rather than re-deriving it", () => {
		const autoOpen = tab.slice(tab.indexOf("// Auto-open a session on mount"), tab.indexOf("const closeTerminal"));
		expect(autoOpen).toContain("pickAutoOpenSession({");
		expect(autoOpen).toContain("lastRepoId: loadLastRepo(instanceId)");
		expect(autoOpen).toContain("singleRepo,");
		expect(autoOpen).toContain("initialSessionId,");
	});

	it("still runs at most ONCE per mount", () => {
		// A later `sessions` refresh (loadCoding on start/end/add) must not re-open a session the
		// user has since closed, or yank them off the Terminal view.
		const autoOpen = tab.slice(tab.indexOf("// Auto-open a session on mount"), tab.indexOf("const closeTerminal"));
		expect(autoOpen).toContain("if (autoOpenedRef.current) return;");
	});

	it("offers Start — never Open — when nothing is running", () => {
		// With auto-attach, being on this branch means there IS no session; an "Open" button here
		// would point at nothing.
		const src_ = code("CodingTab.tsx");
		const solo = src_.slice(src_.indexOf("if (singleRepo && repos.length <= 1)"));
		expect(solo).toContain("Start a session");
		expect(solo).not.toContain("Open session");
	});
});

/**
 * #440 — the surface must offer a way to re-take a verdict, and must not present a stale one as
 * current. Asserted on the source for the same reason as everything above: these are conditional
 * JSX and a prop thread, and what matters is that the wiring EXISTS end to end.
 */
describe("a wrong or old verdict has a remedy on the page", () => {
	const list = code("ReposList.tsx");
	const tab = code("CodingTab.tsx");

	it("offers Re-check on a repo that HAS a folder on a machine", () => {
		// Gated on `workdir`: a cloned repo has no checkout to look at, and a control that
		// describes a check which never happens is worse than none.
		expect(list).toContain("/recheck`,");
		expect(list).toContain("{r.workdir && (");
	});

	it("renders the SERVER's verdict sentence, never one composed here", () => {
		// The console and the chat are handed the same sentence on purpose (#405) — two surfaces
		// describing one directory two ways is the failure that keeps recurring.
		expect(list).toContain("d.verdict?.detail");
		expect(list).toContain("d.reason");
	});

	it("shows how old the stored verdict is, from the column and not from updatedAt", () => {
		// `updated_at` is bumped by any edit to the row, so rendering it as an age would be a
		// precise-looking claim the platform cannot support. That is why 0110 exists.
		expect(list).toContain("repoFreshnessLabel(r)");
		expect(list).not.toContain("r.updatedAt");
	});

	it("says when the list itself could not re-check", () => {
		expect(list).toContain("staleListNotice(recheck,");
		expect(list).toContain("repos-stale-notice");
	});

	it("CodingTab threads the server's report down rather than guessing at it", () => {
		// Deriving "did it re-check" in the component from `runnerOnline` would be a guess: the
		// list's resolver honours the instance's "Runs on" pin and the status dot does not, which
		// is exactly the disagreement that made #440 unreadable from outside.
		expect(tab).toContain("setRepoRecheck(repoData.recheck)");
		expect(tab).toContain("recheck={repoRecheck}");
	});
});
