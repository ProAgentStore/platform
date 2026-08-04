import { describe, expect, it } from "vitest";
import { authPromptGuidance, detectAuthPrompt } from "./engine-auth-prompt.js";

/** The real Gemini CLI prompt, verbatim from a live session. */
const GEMINI_MENU = `
│ ? Get started
│   How would you like to authenticate for this project?
│   ● 1. Sign in with Google
│     2. Use Gemini API Key
│     3. Vertex AI
│   Failed to sign in. Message: This client is no longer supported for Gemini Code Assist for
│   individuals. To continue using Gemini, please migrate to the Antigravity suite of products
`;

/** Claude's startup warning — printed on EVERY run, and not a sign-in request. */
const CLAUDE_NORMAL = `
[claude] ⚠ claude.ai connectors are disabled because ANTHROPIC_API_KEY or another auth source is set and takes precedence over your claude.ai login · Unset it to load your organization's connectors

❯ Please explore the repository structure.
⚙ Bash {"command":"ls -la"}
  ↳ total 264
`;

describe("detectAuthPrompt", () => {
	it("catches the real Gemini sign-in menu", () => {
		const p = detectAuthPrompt(GEMINI_MENU);
		expect(p?.kind).toBe("menu");
		expect(p?.evidence.toLowerCase()).toContain("authenticate");
	});

	it("does NOT fire on Claude's connectors warning", () => {
		// This prints on every single run. A false positive here tells the owner to sign in
		// while the engine is working fine, and they stop trusting the signal entirely.
		expect(detectAuthPrompt(CLAUDE_NORMAL)).toBeNull();
	});

	it("extracts an OAuth URL and classifies it as relayable", () => {
		const p = detectAuthPrompt("Visit the following URL to authorize:\nhttps://accounts.google.com/o/oauth2/auth?client_id=x");
		expect(p?.kind).toBe("oauth-url");
		expect(p?.url).toContain("accounts.google.com");
	});

	it("ignores a link that is not an auth host", () => {
		// Engines print docs links constantly; a bare URL must not mean "sign in".
		expect(detectAuthPrompt("See https://example.com/docs for details")).toBeNull();
	});

	it("only looks at the TAIL — a completed login is history", () => {
		// The login happened 200 lines ago and succeeded; reporting it would send the owner
		// to sign in again.
		const old = "Please sign in\nhttps://accounts.google.com/x\n" + Array(200).fill("⚙ Bash working…").join("\n");
		expect(detectAuthPrompt(old)).toBeNull();
	});

	it("stays quiet for ordinary output and empty panes", () => {
		expect(detectAuthPrompt("")).toBeNull();
		expect(detectAuthPrompt("⚙ Read file.ts\n  ↳ 1 import x")).toBeNull();
	});

	it("does not fire on 'logged in as …'", () => {
		expect(detectAuthPrompt("✓ logged in as serge@example.com")).toBeNull();
	});

	it("DOES fire when a success marker is followed by a real prompt", () => {
		// "already logged in" earlier must not mask a later re-auth request.
		const p = detectAuthPrompt("already logged in\n...\nAuthentication required\nhttps://claude.ai/oauth/authorize?x=1");
		expect(p).not.toBeNull();
		expect(p?.url).toContain("claude.ai");
	});

	it("caps the evidence so a huge line cannot flood the console", () => {
		const p = detectAuthPrompt(`Please sign in ${"x".repeat(5000)}`);
		expect((p?.evidence.length ?? 0)).toBeLessThanOrEqual(300);
	});
});

describe("authPromptGuidance", () => {
	it("explains WHY the runner's browser is the one that must be used", () => {
		const g = authPromptGuidance({ kind: "oauth-url", url: "https://accounts.google.com/x", evidence: "" });
		expect(g).toMatch(/runner machine/);
		expect(g).toMatch(/redirect/);
	});

	it("tells a menu case to drive the CLI, not click a link", () => {
		// The "I clicked the button and nothing happened" dead end.
		expect(authPromptGuidance({ kind: "menu", url: null, evidence: "" })).toMatch(/menu|choose/i);
	});
});
