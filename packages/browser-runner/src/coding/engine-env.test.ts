import { describe, expect, it } from "vitest";
import { mergeEnv } from "./engine-env.js";

/**
 * Moved here with `mergeEnv` itself when #679 gave the spawn-env concern its own file. The
 * behaviour is unchanged; what moved is where it lives.
 */
describe("mergeEnv — the platform's engine choice must beat the machine's", () => {
	it("REMOVES a key the platform sends as empty", () => {
		// The whole reason this exists: a developer with ANTHROPIC_API_KEY exported handed it to
		// every engine, and Claude Code prefers an API key over the subscription token — so
		// picking "subscription" billed per token anyway, silently.
		const out = mergeEnv({ ANTHROPIC_API_KEY: "sk-ant-real", PATH: "/usr/bin" }, { CLAUDE_CODE_OAUTH_TOKEN: "tok", ANTHROPIC_API_KEY: "" });
		expect("ANTHROPIC_API_KEY" in out).toBe(false);
		expect(out.CLAUDE_CODE_OAUTH_TOKEN).toBe("tok");
	});

	it("keeps the rest of the machine env untouched", () => {
		const out = mergeEnv({ PATH: "/usr/bin", HOME: "/Users/x" }, { CLAUDE_CODE_OAUTH_TOKEN: "tok" });
		expect(out.PATH).toBe("/usr/bin");
		expect(out.HOME).toBe("/Users/x");
	});

	it("still lets api-key mode SET the key", () => {
		// Removal must not become a blanket ban — choosing api-key mode is legitimate.
		const out = mergeEnv({}, { ANTHROPIC_API_KEY: "sk-ant-chosen" });
		expect(out.ANTHROPIC_API_KEY).toBe("sk-ant-chosen");
	});

	it("passes the machine env straight through when the platform sends nothing", () => {
		// "machine" auth: PAGS injects nothing and must not strip anything either.
		const out = mergeEnv({ ANTHROPIC_API_KEY: "sk-ant-machine" }, undefined);
		expect(out.ANTHROPIC_API_KEY).toBe("sk-ant-machine");
	});
});
