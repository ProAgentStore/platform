import { describe, expect, it } from "vitest";
import { formatSpeed, voiceSummary } from "./voiceSummary";

/**
 * The rule this module restates, copied from `resolveVoiceConfig` in
 * packages/sdk/src/voice/config.ts. If the SDK's fallback changes, this fails here first.
 */
function sdkResolves(vs: Record<string, unknown>, hasOpenAiKey: boolean) {
	return {
		sttProvider: String(vs.sttMode || "") === "openai" && hasOpenAiKey ? "openai" : "browser",
		ttsProvider: String(vs.provider || "").includes("openai") && hasOpenAiKey ? "openai" : "browser",
	};
}

describe("formatSpeed", () => {
	it("spells the same speed one way", () => {
		// The default read "1.0×" while the no-value fallback beside it read "1×".
		expect(formatSpeed(100)).toBe("1×");
		expect(formatSpeed(undefined)).toBe("1×");
		expect(formatSpeed(200)).toBe("2×");
	});

	it("keeps the digits that carry meaning", () => {
		expect(formatSpeed(125)).toBe("1.25×");
		expect(formatSpeed(150)).toBe("1.5×");
		expect(formatSpeed(25)).toBe("0.25×");
	});

	it("does not render NaN for a non-numeric setting", () => {
		expect(formatSpeed("fast")).toBe("1×");
		expect(formatSpeed(Number.NaN)).toBe("1×");
	});
});

describe("voiceSummary", () => {
	const whisper = { sttMode: "openai", provider: "openai", speed: 100 };

	// The bug this module exists for: the line is labelled "what you are getting", and said the
	// opposite of what every turn actually ran on.
	it("does not claim Whisper when there is no key to run it with", () => {
		expect(voiceSummary(whisper, false)).toBe("Dictation · Browser voice · 1× · needs an OpenAI key");
	});

	it("says why, so a lost setting and a missing key are distinguishable", () => {
		expect(voiceSummary(whisper, false)).toMatch(/needs an OpenAI key/);
		expect(voiceSummary({ sttMode: "browser" }, false)).not.toMatch(/needs an OpenAI key/);
	});

	it("agrees with the SDK resolver for every combination", () => {
		for (const sttMode of ["openai", "browser", undefined]) {
			for (const provider of ["openai", "browser", undefined]) {
				for (const hasKey of [true, false]) {
					const vs = { sttMode, provider };
					const resolved = sdkResolves(vs, hasKey);
					const line = voiceSummary(vs, hasKey);
					expect(line.startsWith(resolved.sttProvider === "openai" ? "Whisper" : "Dictation")).toBe(true);
					expect(line.includes(resolved.ttsProvider === "openai" ? "OpenAI voice" : "Browser voice")).toBe(true);
				}
			}
		}
	});

	it("reports the saved choice while the key answer is still in flight", () => {
		// Asserting the fallback before /v1/keys/status answers would flash a wrong claim and then
		// correct itself, which reads as the setting having changed.
		expect(voiceSummary(whisper, null)).toBe("Whisper · OpenAI voice · 1×");
	});

	it("describes platform defaults when nothing is saved yet", () => {
		expect(voiceSummary(null, true)).toBe("Dictation · Browser voice · 1×");
		expect(voiceSummary({}, false)).toBe("Dictation · Browser voice · 1×");
	});

	it("matches any openai-flavoured tts provider id, not just the bare name", () => {
		expect(voiceSummary({ provider: "openai-tts" }, true)).toContain("OpenAI voice");
	});
});
