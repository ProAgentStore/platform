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

describe("lintResolvedAgentClaims — the safety family reaches the welcome message (#722)", () => {
	const sends = (welcome: string) =>
		JSON.stringify({
			capabilities: { surfaces: [], runtime: null, workflow: null, tools: ["gmail_search", "gmail_read_message", "gmail_reply", "gmail_send"] },
			identity: { welcomeMessage: welcome },
		});

	it("lints config.identity.welcomeMessage, not only the description", () => {
		// The false promise that shipped lived in BOTH fields, and the welcome message is the one a
		// subscriber reads first. Linting only the description would have caught half of it.
		const warnings = lintResolvedAgentClaims({
			description: "Talk to your inbox.",
			slug: "inbox-chat",
			category: "productivity",
			config: sends("I will show you anything before it is sent or archived."),
		});
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toMatch(/^Welcome message promises/);
		expect(warnings[0]).toContain("gmail_reply, gmail_send");
	});

	it("reads the RESOLVED tool allowlist — no send tool, no finding", () => {
		const config = JSON.stringify({
			capabilities: { surfaces: [], runtime: null, workflow: null, tools: ["gmail_search", "gmail_read_message", "gmail_archive"] },
			identity: { welcomeMessage: "I will show you anything before it is sent or archived." },
		});
		expect(lintResolvedAgentClaims({ description: "Talk to your inbox.", slug: "inbox-chat", category: "productivity", config })).toEqual([]);
	});

	it("survives a config with no identity at all", () => {
		const config = JSON.stringify({ capabilities: { surfaces: [], runtime: null, workflow: null, tools: ["gmail_send"] } });
		expect(lintResolvedAgentClaims({ description: "Sends the digest you asked for.", slug: "x", category: "general", config })).toEqual([]);
	});
});
