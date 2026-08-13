import { describe, expect, it } from "vitest";
import { engineAttributionNote } from "./engine-attribution-note.js";

describe("engineAttributionNote — what the engines panel says about who pays (#551)", () => {
	it("says nothing for a preset with no command, or for an engine that writes no row at all", () => {
		// A raw engine's spend never reaches the ledger (`engineMeteringNote` says exactly that,
		// one line above this one in the panel). There is nothing to attribute, and two notes both
		// saying "you will not see this" is one message too many.
		expect(engineAttributionNote("", "auto", false)).toBeNull();
		expect(engineAttributionNote("codex exec --sandbox danger-full-access", "api-key", true)).toBeNull();
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
