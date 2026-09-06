import { describe, expect, it } from "vitest";
import { KEY_HINT_LENGTH, keyHint } from "./key-hint.js";

// Self-labelling, low-entropy fixtures for the same reason keys.integration.test.ts uses them
// (#295): long random-looking tails in a file about key handling make gitleaks cry wolf.
const ANTHROPIC = "sk-ant-api03-EXAMPLE-NOT-A-REAL-KEY-4f2a";
const OPENAI = "sk-EXAMPLE-NOT-A-REAL-KEY-9b71";

describe("keyHint", () => {
	it("is the LAST four characters and nothing else", () => {
		expect(keyHint(ANTHROPIC)).toBe("4f2a");
		expect(keyHint(OPENAI)).toBe("9b71");
	});

	it("never returns more than KEY_HINT_LENGTH, for any input", () => {
		// The bound is the security property, so it is asserted against the constant rather than
		// against "4" — widening it has to be a deliberate edit to key-hint.ts, not a test that
		// quietly still passes.
		for (const k of [ANTHROPIC, OPENAI, "x".repeat(500), '{"accountId":"acct","token":"cf-EXAMPLE-TOKEN-VALUE-abcd"}']) {
			expect(keyHint(k)?.length ?? 0).toBeLessThanOrEqual(KEY_HINT_LENGTH);
		}
	});

	it("never returns the middle, or any prefix", () => {
		const hint = keyHint(ANTHROPIC) as string;
		expect(ANTHROPIC.endsWith(hint)).toBe(true);
		expect(ANTHROPIC.startsWith(hint)).toBe(false);
		// The whole key must not be recoverable or even substantially exposed by the hint.
		expect(ANTHROPIC).not.toContain(`${hint}${hint}`);
	});

	it("hints the TOKEN inside the Cloudflare envelope, not the JSON encoding", () => {
		// The stored plaintext for cloudflare is `{"accountId":…,"token":…}`. Hinting it raw gives
		// `ue"}` — four characters of the encoding, identical for every account.
		const stored = '{"accountId":"acct-1234","token":"cf-EXAMPLE-TOKEN-VALUE-7c3d"}';
		expect(keyHint(stored)).toBe("7c3d");
		expect(keyHint(stored)).not.toBe('e"}}'.slice(-4));
	});

	it("falls back to the raw string when a `{`-prefixed value is not the envelope", () => {
		expect(keyHint("{not-json-at-all-just-braces-2b8e")).toBe("2b8e");
		expect(keyHint('{"accountId":"a"}')).toBe('"a"}'.slice(-4));
	});

	it("refuses to hint a value too short for four characters to be a hint", () => {
		// Four of eight is half the secret. A real provider key is 40–120 characters, so this only
		// ever refuses something that was not one.
		expect(keyHint("short12")).toBeNull();
		expect(keyHint("abcdefghijk")).toBeNull();
		expect(keyHint("abcdefghijkl")).toBe("ijkl");
	});

	it("has nothing to say about an absent key", () => {
		expect(keyHint(null)).toBeNull();
		expect(keyHint(undefined)).toBeNull();
		expect(keyHint("")).toBeNull();
		expect(keyHint("      ")).toBeNull();
	});
});
