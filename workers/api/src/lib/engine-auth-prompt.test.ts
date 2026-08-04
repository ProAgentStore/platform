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

describe("detectAuthPrompt — the sign-in URL drives the owner's real browser", () => {
	// `/signin` feeds this URL to the runner's `/browser/act {navigate}`, which opens it in the
	// owner's REAL-PROFILE, already-logged-in Chrome, presented by the console as a legitimate
	// engine sign-in. So any string the engine prints must not be able to choose the page.
	it("rejects a lookalike host — the substring match's failure", () => {
		const p = detectAuthPrompt("Please sign in: https://accounts.google.com.evil.example/login");
		expect(p?.url).toBeNull();
	});

	it("rejects an auth host appearing in the QUERY of an attacker URL", () => {
		const p = detectAuthPrompt("Authentication required https://evil.example/?next=https://claude.ai/x");
		expect(p?.url).toBeNull();
	});

	it("rejects a path-scoped host used off its path", () => {
		// `github.com/login` is a sign-in page; `github.com/anything-else` is a repo link that
		// happens to sit in the output of a coding agent constantly.
		expect(detectAuthPrompt("Please sign in https://github.com/ProAgentStore/platform/issues/1")?.url).toBeNull();
		expect(detectAuthPrompt("Please sign in https://github.com/login/device")?.url).toContain("github.com/login");
	});

	it("rejects http, which is never a legitimate sign-in page", () => {
		expect(detectAuthPrompt("Please sign in http://accounts.google.com/o/oauth2")?.url).toBeNull();
	});

	it("still accepts the real thing, including a subdomain", () => {
		expect(detectAuthPrompt("Please sign in https://accounts.google.com/o/oauth2/auth?x=1")?.url).toContain("accounts.google.com");
		expect(detectAuthPrompt("Authentication required https://auth.openai.com/authorize")?.url).toContain("auth.openai.com");
	});

	it("drops trailing sentence punctuation rather than failing to parse", () => {
		// Engines print URLs mid-prose; a trailing "." used to ride along into the navigate call.
		const p = detectAuthPrompt("Please sign in at https://claude.ai/oauth/authorize.");
		expect(p?.url).toBe("https://claude.ai/oauth/authorize");
	});
});
