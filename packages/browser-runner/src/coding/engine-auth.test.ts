import { describe, expect, it } from "vitest";
import { resolveEngineAuth } from "./engine-auth.js";
import { mergeEnv } from "./headless.js";

// #248 — the money question ("subscription, or am I billing per token?") answered from the env the
// process is actually spawned with, not from the setting that was supposed to produce it.

describe("resolveEngineAuth — what the engine actually ran on", () => {
	it("reports api-key when the provider key is present", () => {
		expect(resolveEngineAuth("claude", { ANTHROPIC_API_KEY: "sk-ant-x" })).toBe("api-key");
	});

	it("reports subscription when only the OAuth token is present", () => {
		expect(resolveEngineAuth("claude", { CLAUDE_CODE_OAUTH_TOKEN: "tok" })).toBe("subscription");
	});

	it("reports machine-login when neither is present", () => {
		expect(resolveEngineAuth("claude", { PATH: "/usr/bin" })).toBe("machine-login");
	});

	it("an API KEY BEATS a subscription token — because the CLI itself prefers it", () => {
		// The whole failure this exists to expose: both present, the bill says per-token. Calling
		// that "subscription" would reproduce the illusion instead of dispelling it.
		expect(resolveEngineAuth("claude", { CLAUDE_CODE_OAUTH_TOKEN: "tok", ANTHROPIC_API_KEY: "sk-ant-x" })).toBe("api-key");
	});

	it("treats a present-but-empty var as NO credential", () => {
		// An inherited `ANTHROPIC_API_KEY=` from the shell is not a key. Reporting "api-key" for it
		// would warn about per-token billing that isn't happening.
		expect(resolveEngineAuth("claude", { ANTHROPIC_API_KEY: "" })).toBe("machine-login");
		expect(resolveEngineAuth("claude", { ANTHROPIC_API_KEY: "   " })).toBe("machine-login");
	});

	it("uses each engine's OWN key var, not Anthropic's", () => {
		expect(resolveEngineAuth("codex", { OPENAI_API_KEY: "sk-o" })).toBe("api-key");
		expect(resolveEngineAuth("gemini", { GEMINI_API_KEY: "g" })).toBe("api-key");
		expect(resolveEngineAuth("grok", { XAI_API_KEY: "x" })).toBe("api-key");
		// A Claude key in the shell must not make a Codex session look like it bills Anthropic.
		expect(resolveEngineAuth("codex", { ANTHROPIC_API_KEY: "sk-ant-x" })).toBe("machine-login");
	});

	it("only Claude has a subscription token — others fall through to machine-login", () => {
		expect(resolveEngineAuth("codex", { CLAUDE_CODE_OAUTH_TOKEN: "tok" })).toBe("machine-login");
		expect(resolveEngineAuth("generic", { CLAUDE_CODE_OAUTH_TOKEN: "tok" })).toBe("machine-login");
	});

	it("never returns the credential itself — only the enum", () => {
		const out = resolveEngineAuth("claude", { ANTHROPIC_API_KEY: "sk-ant-SECRET" });
		expect(out).toBe("api-key");
		expect(JSON.stringify(out)).not.toContain("SECRET");
	});
});

describe("resolveEngineAuth over the REAL merged env (the spawn path)", () => {
	// These compose with mergeEnv exactly as HeadlessSession does, so the reported answer is the
	// one the child process gets — the whole point of observing rather than restating.

	it("'subscription' mode strips the shell's key, so the token actually wins", () => {
		const machine = { ANTHROPIC_API_KEY: "sk-ant-shell", PATH: "/usr/bin" };
		const overlay = { CLAUDE_CODE_OAUTH_TOKEN: "tok", ANTHROPIC_API_KEY: "" }; // "" = remove
		expect(resolveEngineAuth("claude", mergeEnv(machine, overlay) as Record<string, string | undefined>)).toBe("subscription");
	});

	it("the DOCUMENTED silent-billing regression: no strip ⇒ the shell key wins and we say so", () => {
		// A runner too old to honour empty-means-remove reproduces the original bug. This is the
		// case that used to be invisible; now it resolves to api-key and the cloud warns.
		const machine = { ANTHROPIC_API_KEY: "sk-ant-shell" };
		const overlay = { CLAUDE_CODE_OAUTH_TOKEN: "tok" }; // no strip
		expect(resolveEngineAuth("claude", mergeEnv(machine, overlay) as Record<string, string | undefined>)).toBe("api-key");
	});

	it("'auto' with no stored token, on a clean shell, is machine-login", () => {
		const merged = mergeEnv({ PATH: "/usr/bin" }, { ANTHROPIC_API_KEY: "" });
		expect(resolveEngineAuth("claude", merged as Record<string, string | undefined>)).toBe("machine-login");
	});

	it("'api-key' mode with a vault key resolves to api-key", () => {
		const merged = mergeEnv({ PATH: "/usr/bin" }, { ANTHROPIC_API_KEY: "sk-ant-vault" });
		expect(resolveEngineAuth("claude", merged as Record<string, string | undefined>)).toBe("api-key");
	});

	it("'api-key' mode with NO vault key inherits the shell wholesale — the quiet hole", () => {
		// resolveEngineEnv returns undefined when the vault has no key, so nothing is stripped and
		// the machine's own key silently supplies the credential the platform didn't.
		const merged = mergeEnv({ ANTHROPIC_API_KEY: "sk-ant-shell" }, undefined);
		expect(resolveEngineAuth("claude", merged as Record<string, string | undefined>)).toBe("api-key");
	});
});
