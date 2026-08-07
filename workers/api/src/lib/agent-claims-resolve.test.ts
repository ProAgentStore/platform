import { describe, expect, it } from "vitest";
import { lintResolvedAgentClaims } from "./agent-claims-resolve.js";

const CLAIM = "Runs a headless browser and posts on your behalf.";

describe("lintResolvedAgentClaims (#362)", () => {
	it("flags a runtime claim on an agent declaring no runtime and no workflow", () => {
		const warnings = lintResolvedAgentClaims({ description: CLAIM, slug: "poster", category: "general", config: "{}" });
		expect(warnings.length).toBeGreaterThan(0);
		expect(warnings.join(" ")).toContain("no runtime/workflow");
	});

	it("stays quiet once the capability is declared", () => {
		const config = JSON.stringify({ capabilities: { surfaces: [], runtime: "browser", workflow: "BROWSER_TASK" } });
		expect(lintResolvedAgentClaims({ description: CLAIM, slug: "poster", category: "general", config })).toEqual([]);
	});

	it("honours the slug/category FALLBACK, so a legacy agent is not accused of overclaiming", () => {
		// `coder` resolves runtime:"coding"/workflow:"CODING_SESSION" from the slug alone, with
		// nothing in config.capabilities. Linting the declared block would have called its honest
		// copy a lie — the reason this reads the resolver the runtime reads.
		expect(lintResolvedAgentClaims({ description: "Drives Claude Code through a local runner.", slug: "coder", category: "code", config: null })).toEqual([]);
		expect(lintResolvedAgentClaims({ description: "Drives Claude Code through a local runner.", slug: "whatever", category: "code", config: null })).toEqual([]);
	});

	it("catches the mismatch from the OTHER direction — capabilities dropped under unchanged copy", () => {
		const before = JSON.stringify({ capabilities: { surfaces: [], runtime: "browser", workflow: "BROWSER_TASK" } });
		const after = JSON.stringify({ capabilities: { surfaces: [], runtime: null, workflow: null } });
		expect(lintResolvedAgentClaims({ description: CLAIM, slug: "poster", category: "general", config: before })).toEqual([]);
		expect(lintResolvedAgentClaims({ description: CLAIM, slug: "poster", category: "general", config: after }).length).toBeGreaterThan(0);
	});

	it("says nothing about copy that promises nothing runtime-shaped", () => {
		expect(lintResolvedAgentClaims({ description: "Answers questions about your documents.", slug: "kb", category: "general", config: "{}" })).toEqual([]);
	});

	it("is silent on an empty description and on unreadable config", () => {
		expect(lintResolvedAgentClaims({ description: "", slug: "kb", category: "general", config: "{" })).toEqual([]);
		expect(lintResolvedAgentClaims({ description: null, slug: "kb", category: "general", config: null })).toEqual([]);
	});
});
