import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SURFACES, surfaceOwnsHeader, visibleSurfaces } from "./surfaces";

describe("surfaceOwnsHeader — the header takeover is DECLARED, not hardcoded to one tab", () => {
	it("grants it only to a surface that declares it", () => {
		// It used to be `if (tab !== "coding")` in InstanceDetail: a string comparison against one
		// tab name, so exactly one first-party component could ever own the header and the next one
		// to need it would have added a second hardcoded branch.
		expect(surfaceOwnsHeader("coding")).toBe(true);
		for (const id of ["chat", "knowledge", "settings", "board", "repo", "data"]) {
			expect(surfaceOwnsHeader(id), id).toBe(false);
		}
	});

	it("never grants it to an unknown or missing id", () => {
		expect(surfaceOwnsHeader(undefined)).toBe(false);
		expect(surfaceOwnsHeader("totally-made-up")).toBe(false);
		expect(surfaceOwnsHeader("")).toBe(false);
	});

	it("keeps the takeover rare — replacing the shell chrome is not a default", () => {
		// A guard on the DESIGN, not just the code: if several surfaces start claiming the header,
		// the page has two owners of the same region and the last one to mount wins.
		expect(SURFACES.filter((s) => s.ownsHeader).map((s) => s.id)).toEqual(["coding"]);
	});
});

/**
 * Strip comments before matching. Both guards below describe what the CODE may do, and the
 * explanations of the very thing they forbid necessarily quote it — without this, the comment that
 * documents the fix fails the test that protects it.
 */
function codeOf(relPath: string): string {
	return readFileSync(join(__dirname, relPath), "utf8")
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.split("\n")
		.map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
		.join("\n");
}

describe("the hardcoded branch does not come back", () => {
	it("InstanceDetail no longer clears the header by tab NAME", () => {
		// The whole point of the change is that the shell asks the registry. A future edit that
		// re-introduces `tab === "coding"` there would restore the special case while every other
		// test still passed.
		const src = codeOf("../pages/InstanceDetail.tsx");
		expect(src).toContain("surfaceOwnsHeader");
		expect(src).not.toMatch(/tab\s*!==\s*"coding"/);
		expect(src).not.toMatch(/tab\s*===\s*"coding"/);
	});

	it("no surface is singled out by slug anywhere in the registry", () => {
		// `show` must key off declared capability surfaces, never an agent's identity.
		const src = codeOf("surfaces.tsx");
		for (const slug of ["coder-repo", "coder-lead", "job-application-assistant", "repo-chat", "language-buddy"]) {
			expect(src, slug).not.toContain(slug);
		}
	});
});

describe("visibleSurfaces still derives tabs from declared capabilities", () => {
	it("a coding agent gets Coding and its work Board, but not Repo", () => {
		// Board is intentional now: a coding agent writes session cards (#206) and delegation
		// cards (#155), so hiding it left the owner unable to see work about their own agent.
		const ids = visibleSurfaces(["coding"]).map((s) => s.id);
		expect(ids).toContain("coding");
		expect(ids).toContain("board");
		expect(ids).not.toContain("repo");
	});

	it("an agent declaring nothing still gets the generic board", () => {
		expect(visibleSurfaces([]).map((s) => s.id)).toContain("board");
	});
});

describe("tabs are gated on what the agent DECLARES, not shown to everyone", () => {
	const ids = (caps: { surfaces: string[]; tools?: string[] }) => visibleSurfaces(caps).map((s) => s.id);

	it("a Repo Coder loses Indexing and Data — it has neither knowledge nor collections", () => {
		// The complaint: seven tabs on an agent that can use four. Indexing renders the vector
		// store (nothing indexed, nothing that searches it) and Data renders collections (an agent
		// with no collection tools can never create a row), so both were permanently empty.
		const coder = {
			surfaces: ["coding"],
			tools: ["repo_tree", "repo_read_file", "repo_git", "repo_remote", "github_list_issues", "github_read_issue", "github_create_issue"],
		};
		expect(ids(coder)).not.toContain("indexing");
		expect(ids(coder)).not.toContain("data");
		// …but keeps everything it does use.
		expect(ids(coder)).toEqual(expect.arrayContaining(["chat", "coding", "activity", "knowledge", "settings"]));
	});

	it("repo-chat KEEPS Indexing — indexing a codebase is the whole product", () => {
		const repoChat = { surfaces: ["repo"], tools: ["search_knowledge", "list_knowledge", "read_knowledge"] };
		expect(ids(repoChat)).toContain("indexing");
		// It still writes no collections.
		expect(ids(repoChat)).not.toContain("data");
	});

	it("an agent that declares NO tools keeps every tab — undeclared must stay permissive", () => {
		// The safety property. An agent with no allowlist gets a per-surface DEFAULT set resolved
		// server-side, so the console cannot know what it can do. Guessing would silently remove a
		// tab a live agent depends on — doc-chat and the pipeline agents declare nothing and need
		// both Indexing and Data.
		const undeclared = { surfaces: [] };
		expect(ids(undeclared)).toEqual(expect.arrayContaining(["indexing", "data", "knowledge", "board"]));
		// Same for the legacy call shape (a bare surface array).
		expect(visibleSurfaces([]).map((s) => s.id)).toContain("data");
	});

	it("Knowledge stays for everyone — it is a composite, and Memory is universal", () => {
		// Gating it on KB tools would take Memory and Rules & Tips away to hide two sub-tabs.
		const noTools = { surfaces: ["coding"], tools: ["repo_git"] };
		expect(ids(noTools)).toContain("knowledge");
	});

	it("an empty declared allowlist is still a declaration, not 'undeclared'", () => {
		// `tools: []` means the agent said it needs nothing. Treating it as undefined would make
		// the most restrictive declaration the most permissive UI.
		expect(ids({ surfaces: ["coding"], tools: [] })).not.toContain("indexing");
		expect(ids({ surfaces: ["coding"], tools: [] })).not.toContain("data");
	});
});

describe("a coding agent can see its OWN work board", () => {
	const ids = (caps: { surfaces: string[]; tools?: string[] }) => visibleSurfaces(caps).map((s) => s.id);

	it("shows Board for a coding agent — it writes cards there", () => {
		// #206 puts every coding session on the board and #155 every delegated goal. Hiding the tab
		// meant the owner had work recorded about their own agent that only a supervisor could see,
		// through subordinate_status, which reads exactly those rows.
		expect(ids({ surfaces: ["coding"] })).toContain("board");
	});

	it("still hides it where a dedicated board exists or there is no work", () => {
		// `apply` renders the same cards with its own columns — two boards would be two truths.
		expect(ids({ surfaces: ["apply"] })).not.toContain("board");
		expect(ids({ surfaces: ["apply"] })).toContain("apply");
		// repo-chat is read-only chat over an indexed codebase; it produces no work cards.
		expect(ids({ surfaces: ["repo"] })).not.toContain("board");
	});

	it("shows it for tmux, which also runs work on your machine", () => {
		expect(ids({ surfaces: ["tmux"] })).toContain("board");
	});
});

