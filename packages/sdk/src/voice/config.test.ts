import { afterEach, describe, expect, it, vi } from "vitest";

// getVoiceConfig does I/O (voice-settings); mock the SDK api client so the control-word
// resolution is unit-testable without a network.
vi.mock("../client.js", () => ({ api: vi.fn() }));
import { api } from "../client.js";
import { getVoiceConfig, invalidateVoiceConfig, resolveVoiceConfig, voiceWantsOpenAi } from "./config.js";

const mockApi = api as unknown as ReturnType<typeof vi.fn>;
function routeApi(map: Record<string, unknown>) {
	mockApi.mockImplementation(async (path: string) => {
		for (const [k, v] of Object.entries(map)) if (path.includes(k)) return v;
		return {};
	});
}

describe("getVoiceConfig — control words come from ONE place (#222)", () => {
	afterEach(() => { invalidateVoiceConfig(); mockApi.mockReset(); });

	// /v1/instances/:id/voice-settings already merges the ACCOUNT preferences server-side
	// (effectiveVoice), so its response is the whole answer. The old client-side fallback to
	// the profile's voice* fields was a second home for the same setting that silently lost;
	// migration 0075 moved the values and it is gone.
	it("takes the words from the (already server-merged) voice-settings response", async () => {
		routeApi({ "/voice-settings": { voiceSettings: { provider: "browser", muteWords: ["shush", "quiet please"] } } });
		expect((await getVoiceConfig("inst-1")).muteWords).toEqual(["shush", "quiet please"]);
	});

	it("a per-instance override still wins — that precedence is server-side and unchanged", async () => {
		routeApi({ "/voice-settings": { voiceSettings: { provider: "browser", muteWords: ["foo"] } } });
		expect((await getVoiceConfig("inst-2")).muteWords).toEqual(["foo"]);
	});

	// The regression this guards: reading the profile again here is what created the second
	// writable home in the first place. It also cost an extra round-trip on every load.
	it("never calls /v1/profile", async () => {
		routeApi({ "/voice-settings": { voiceSettings: { provider: "browser" } } });
		await getVoiceConfig("inst-3");
		const paths = mockApi.mock.calls.map((c) => String(c[0]));
		expect(paths.some((p) => p.includes("/v1/profile"))).toBe(false);
	});

	it("no words anywhere ⇒ empty (the matcher then uses the built-in per-language defaults)", async () => {
		routeApi({ "/voice-settings": { voiceSettings: { provider: "browser" } } });
		const c = await getVoiceConfig("inst-4");
		expect(c.muteWords).toEqual([]);
		expect(c.repeatWords).toEqual([]);
		expect(c.stopSpeechKeyword).toBe("");
	});

	it("carries every control-word field through, including the new unmute/exit", async () => {
		routeApi({
			"/voice-settings": {
				voiceSettings: { provider: "browser", repeatWords: ["again"], stopWords: ["over"], stopSpeechKeyword: "hush", unmuteWords: ["wake up"], exitWords: ["bye voice"] },
			},
		});
		const c = await getVoiceConfig("inst-5");
		expect(c.repeatWords).toEqual(["again"]);
		expect(c.stopWords).toEqual(["over"]);
		expect(c.stopSpeechKeyword).toBe("hush");
		expect(c.unmuteWords).toEqual(["wake up"]);
		expect(c.exitWords).toEqual(["bye voice"]);
	});
});

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

	it("parses control words from an array OR a comma/newline/semicolon string, keeping multi-word phrases", () => {
		expect(resolveVoiceConfig({ muteWords: ["mute mic", "shush"] }, false).muteWords).toEqual(["mute mic", "shush"]);
		expect(resolveVoiceConfig({ muteWords: "shush, quiet please" }, false).muteWords).toEqual(["shush", "quiet please"]);
		// A stray newline or semicolon (pasted list) still parses — space does NOT split, so
		// "stop listening" stays one phrase.
		expect(resolveVoiceConfig({ muteWords: "shush\nquiet; stop listening" }, false).muteWords).toEqual(["shush", "quiet", "stop listening"]);
	});

	it("does NOT split a multi-word phrase like 'mute mute' — spaces are preserved (#153)", () => {
		// The delimiter parse splits on comma/newline/semicolon only; a two-word mute phrase
		// stays a single phrase, so matchVoiceCommand can require the whole "mute mute".
		expect(resolveVoiceConfig({ muteWords: "mute mute" }, false).muteWords).toEqual(["mute mute"]);
		expect(resolveVoiceConfig({ muteWords: "mute mute, hush now" }, false).muteWords).toEqual(["mute mute", "hush now"]);
	});
});

describe("resolveVoiceConfig — clamping", () => {
	it("clamps silenceMs to 500–6000 and defaults to 1500", () => {
		expect(resolveVoiceConfig({ silenceMs: 100 }, false).silenceMs).toBe(500);
		expect(resolveVoiceConfig({ silenceMs: 99999 }, false).silenceMs).toBe(6000);
		expect(resolveVoiceConfig({}, false).silenceMs).toBe(1500);
		expect(resolveVoiceConfig({ silenceMs: "nope" }, false).silenceMs).toBe(1500);
	});

	// #179 — how much of a reply is read aloud. 4096 is OpenAI TTS's hard input limit, so a
	// larger saved value must be clamped rather than passed through into a 400.
	it("clamps ttsMaxChars to 200–4096 and defaults to 1500", () => {
		expect(resolveVoiceConfig({ ttsMaxChars: 10 }, false).ttsMaxChars).toBe(200);
		expect(resolveVoiceConfig({ ttsMaxChars: 99999 }, false).ttsMaxChars).toBe(4096);
		expect(resolveVoiceConfig({ ttsMaxChars: 800 }, false).ttsMaxChars).toBe(800);
		expect(resolveVoiceConfig({}, false).ttsMaxChars).toBe(1500);
		expect(resolveVoiceConfig({ ttsMaxChars: "nope" }, false).ttsMaxChars).toBe(1500);
	});

	it("clamps sensitivity to 0.4–2 and defaults to a conservative 0.8", () => {
		expect(resolveVoiceConfig({ sensitivity: 0 }, false).sensitivity).toBe(0.4);
		expect(resolveVoiceConfig({ sensitivity: 5 }, false).sensitivity).toBe(2);
		expect(resolveVoiceConfig({}, false).sensitivity).toBe(0.8);
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

describe("unmute/exit words (#152/#165) follow the same precedence as mute", () => {
	it("parses both from the instance voice settings", () => {
		const c = resolveVoiceConfig({ unmuteWords: "wake up, listen", exitWords: "bye voice" }, false);
		expect(c.unmuteWords).toEqual(["wake up", "listen"]);
		expect(c.exitWords).toEqual(["bye voice"]);
	});

	it("defaults to empty (⇒ built-in per-language phrasings) when unset", () => {
		const c = resolveVoiceConfig({}, false);
		expect(c.unmuteWords).toEqual([]);
		expect(c.exitWords).toEqual([]);
	});
})
