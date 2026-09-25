import { describe, expect, it } from "vitest";
import { engineAttributionNote } from "./engine-attribution-note.js";

describe("engineAttributionNote — what the engines panel says about who pays (#551)", () => {
	it("says nothing for a blank preset or a non-Claude/non-Codex engine", () => {
		// A raw engine's spend never reaches the ledger (`engineMeteringNote` says exactly that,
		// one line above this one in the panel). There is nothing to attribute, and two notes both
		// saying "you will not see this" is one message too many.
		expect(engineAttributionNote("", "auto", false)).toBeNull();
		expect(engineAttributionNote("grok --permission-mode bypassPermissions -p", "api-key", true)).toBeNull();
	});

	describe("Codex — ChatGPT sign-in prevents a shell OpenAI key from deciding billing", () => {
		const cmd = "codex exec --json --sandbox danger-full-access";

		it("makes the subscription boundary explicit without claiming it can validate codex login", () => {
			const n = engineAttributionNote(cmd, "subscription", null);
			expect(n?.detail).toMatch(/OPENAI_API_KEY is removed/i);
			expect(n?.detail).toMatch(/codex login/i);
			expect(n?.detail).toMatch(/cannot validate/i);
			expect(n?.detail).toMatch(/per-token dollar amount/i);
		});

		it("names API-key billing and the Codex dollar-reporting limit", () => {
			const n = engineAttributionNote(cmd, "api-key", null);
			expect(n?.label).toMatch(/billed per token/i);
			expect(n?.detail).toMatch(/OpenAI API key/i);
			expect(n?.detail).toMatch(/not a dollar total/i);
		});

		it("keeps automatic and machine modes unattributed", () => {
			expect(engineAttributionNote(cmd, "auto", null)?.label).toMatch(/payer unknown/i);
			expect(engineAttributionNote(cmd, "machine", null)?.detail).toMatch(/cannot identify the payer/i);
		});
	});

	it("api-key is the mode that produces a charged figure", () => {
		const n = engineAttributionNote("claude --dangerously-skip-permissions", "api-key", false);
		expect(n?.attributable).toBe(true);
		expect(n?.detail).toMatch(/charged total/i);
	});

	it("subscription is attributable and explicitly NOT dollars", () => {
		// The distinction the owner needs: his API key hit a credit balance, his subscription hit
		// a session limit, and they are two different ceilings. Calling a subscription row "money"
		// would merge them again.
		const n = engineAttributionNote("claude --sub", "subscription", false);
		expect(n?.attributable).toBe(true);
		expect(n?.detail).toMatch(/tokens over a rolling window/i);
		expect(n?.detail).toMatch(/Drawn from a subscription/);
	});

	it("machine login cannot be attributed, and says what to store", () => {
		const n = engineAttributionNote("claude --machine", "machine", true);
		expect(n?.attributable).toBe(false);
		expect(n?.detail).toMatch(/Payer not established/);
		expect(n?.detail).toMatch(/Profile → API Keys/);
	});

	describe("auto — the default, whose meaning depends on the vault", () => {
		const cmd = "claude --dangerously-skip-permissions";

		it("resolves to subscription when a token is stored", () => {
			// `resolveEngineEnv` injects CLAUDE_CODE_OAUTH_TOKEN in this case, so the runner
			// observes "subscription" and the payer is established.
			const n = engineAttributionNote(cmd, "auto", true);
			expect(n?.attributable).toBe(true);
			expect(n?.detail).toMatch(/Drawn from a subscription/);
		});

		it("resolves to an unknown payer when none is stored — the state this account is in", () => {
			// `if (!token) return stripProviderKey;` → neither credential in the env → the runner
			// reports "machine-login" → `payerForEngineAuth` returns null. 99.62% of the measured
			// account's notional value arrived this way, with no surface saying so.
			const n = engineAttributionNote(cmd, "auto", false);
			expect(n?.attributable).toBe(false);
			expect(n?.label).toMatch(/no token saved/i);
			expect(n?.detail).toMatch(/Payer not established/);
			expect(n?.detail).toMatch(/Profile → API Keys/);
		});

		it("states both outcomes while the vault answer is still unknown", () => {
			// Before the lookup lands. A note that picked one half would be confidently wrong for
			// half the readers, on the mode that is the default.
			const n = engineAttributionNote(cmd, "auto", null);
			expect(n?.attributable).toBe(false);
			expect(n?.detail).toMatch(/With a Claude Code token saved/);
			expect(n?.detail).toMatch(/without one/);
		});

		it("treats an undefined mode as auto, because that is what the API does", () => {
			expect(engineAttributionNote(cmd, undefined, false)).toEqual(engineAttributionNote(cmd, "auto", false));
		});
	});
});
