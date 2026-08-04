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
