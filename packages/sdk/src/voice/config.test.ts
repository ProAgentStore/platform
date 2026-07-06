import { describe, expect, it } from "vitest";
import { resolveVoiceConfig, voiceWantsOpenAi } from "./config.js";

describe("voiceWantsOpenAi", () => {
	it("true when TTS provider is an openai variant", () => {
		expect(voiceWantsOpenAi({ provider: "openai-realtime" })).toBe(true);
	});
	it("true when STT mode is openai (Whisper)", () => {
		expect(voiceWantsOpenAi({ sttMode: "openai" })).toBe(true);
	});
	it("false for the browser defaults", () => {
		expect(voiceWantsOpenAi({})).toBe(false);
		expect(voiceWantsOpenAi({ provider: "browser", sttMode: "browser" })).toBe(false);
	});
});

describe("resolveVoiceConfig — provider fallback", () => {
	it("uses Whisper + OpenAI TTS only when the key is present", () => {
		const cfg = resolveVoiceConfig({ provider: "openai-realtime", sttMode: "openai" }, true);
		expect(cfg.sttProvider).toBe("openai");
		expect(cfg.ttsProvider).toBe("openai");
	});

	it("falls back to the browser voice when the key is MISSING (never fails)", () => {
		const cfg = resolveVoiceConfig({ provider: "openai-realtime", sttMode: "openai" }, false);
		expect(cfg.sttProvider).toBe("browser");
		expect(cfg.ttsProvider).toBe("browser");
	});

	it("browser defaults regardless of key", () => {
		const cfg = resolveVoiceConfig({}, true);
		expect(cfg.sttProvider).toBe("browser");
		expect(cfg.ttsProvider).toBe("browser");
	});

	it("never leaks the key to the browser", () => {
		expect(resolveVoiceConfig({ sttMode: "openai" }, true).apiKey).toBe("");
	});
});

describe("resolveVoiceConfig — clamping", () => {
	it("clamps silenceMs to 500–6000 and defaults to 1500", () => {
		expect(resolveVoiceConfig({ silenceMs: 100 }, false).silenceMs).toBe(500);
		expect(resolveVoiceConfig({ silenceMs: 99999 }, false).silenceMs).toBe(6000);
		expect(resolveVoiceConfig({}, false).silenceMs).toBe(1500);
		expect(resolveVoiceConfig({ silenceMs: "nope" }, false).silenceMs).toBe(1500);
	});

	it("clamps sensitivity to 0.4–2 and defaults to 1", () => {
		expect(resolveVoiceConfig({ sensitivity: 0 }, false).sensitivity).toBe(0.4);
		expect(resolveVoiceConfig({ sensitivity: 5 }, false).sensitivity).toBe(2);
		expect(resolveVoiceConfig({}, false).sensitivity).toBe(1);
	});

	it("defaults voice + language", () => {
		const cfg = resolveVoiceConfig({}, false);
		expect(cfg.voice).toBe("alloy");
		expect(cfg.language).toBe("en-US");
	});

	it("reads a nested openai voice", () => {
		expect(resolveVoiceConfig({ openai: { voice: "shimmer" } }, true).voice).toBe("shimmer");
	});

	it("defaults STT to the real-time model, and honours a saved override", () => {
		expect(resolveVoiceConfig({}, true).sttModel).toBe("gpt-4o-transcribe");
		expect(resolveVoiceConfig({ sttModel: "gpt-4o-mini-transcribe" }, true).sttModel).toBe("gpt-4o-mini-transcribe");
		// A non-string junk value falls back to the default rather than leaking through.
		expect(resolveVoiceConfig({ sttModel: 42 }, true).sttModel).toBe("gpt-4o-transcribe");
	});
});
