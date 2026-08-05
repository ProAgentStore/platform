import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	defaultTranslationSettings,
	defaultVoiceSettings,
	parseAccountPreferences,
	parseVoiceWords,
	resolveTranslation,
	resolveVoice,
	sanitizeTranslationSettings,
	sanitizeVoiceSettings,
	STT_MODELS,
	VOICE_PROVIDERS,
} from "./preferences.js";

describe("resolveVoice — the precedence chain (#211)", () => {
	it("walks platform → account → instance override → declared language", () => {
		// The load-bearing assertion of the whole feature, as ONE chain. Each layer is visible in
		// the result, so a regression that drops a layer can't hide behind the others.
		const platform = resolveVoice(undefined, undefined);
		expect(platform.speed).toBe(100);
		expect(platform.sttMode).toBe("browser");

		const account = sanitizeVoiceSettings({ speed: 130, sttMode: "openai", language: "en-GB" });
		expect(resolveVoice(account, undefined).speed).toBe(130);

		// The override changes speed and inherits sttMode from the ACCOUNT, not the platform.
		const withOverride = resolveVoice(account, { speed: 90 });
		expect(withOverride.speed).toBe(90);
		expect(withOverride.sttMode).toBe("openai");

		// A declared voiceLanguage beats even the override — but only on `language`.
		const declared = resolveVoice(account, { speed: 90, language: "fr-FR" }, "zh-CN");
		expect(declared.language).toBe("zh-CN");
		expect(declared.speed).toBe(90);
		expect(declared.sttMode).toBe("openai");
	});

	it("a declared language changes NOTHING but the language", () => {
		const account = sanitizeVoiceSettings({ speed: 130, provider: "openai-realtime", commandsEnabled: false });
		const a = resolveVoice(account, undefined);
		const b = resolveVoice(account, undefined, "ja-JP");
		expect(b).toEqual({ ...a, language: "ja-JP" });
	});

	it("an empty declared language is ignored, not treated as a value", () => {
		// An agent with a `voiceLanguage` field the subscriber hasn't set yet must not blank the
		// language — that would leave STT/TTS with no locale at all.
		const account = sanitizeVoiceSettings({ language: "de-DE" });
		expect(resolveVoice(account, undefined, "").language).toBe("de-DE");
		expect(resolveVoice(account, undefined, "   ").language).toBe("de-DE");
	});
});

describe("resolveVoice — absent override is not the same as an empty one", () => {
	it("undefined means 'use my defaults'", () => {
		const account = sanitizeVoiceSettings({ speed: 130 });
		expect(resolveVoice(account, undefined).speed).toBe(130);
		expect(resolveVoice(account, null).speed).toBe(130);
	});

	it("an override INHERITS unspecified fields from the account, never from the platform", () => {
		// The correction to the original design note. If `{}` reset to platform defaults, then a
		// partial override — `{speed: 90}` from the API or MCP — would silently discard every other
		// account preference and drop the user back to browser TTS at 1.0×. An override is a diff
		// from your defaults, not a replacement of them. Presence is tracked separately by the
		// caller (`hasOverride`), which is what makes the "customise" toggle honest.
		const account = sanitizeVoiceSettings({ speed: 130, sttMode: "openai", provider: "openai-realtime", keepAwake: false });
		expect(resolveVoice(account, {})).toEqual(resolveVoice(account, undefined));
		const partial = resolveVoice(account, { speed: 90 });
		expect(partial).toEqual({ ...resolveVoice(account, undefined), speed: 90 });
	});

	it("an override can set a boolean flag OFF — false must not read as 'unspecified'", () => {
		// `commandsEnabled: false` is the whole point of the toggle. Treating falsy as absent is
		// the classic way an opt-out silently does nothing.
		const account = sanitizeVoiceSettings({ commandsEnabled: true, keepAwake: true, confirmLanguage: true });
		const out = resolveVoice(account, { commandsEnabled: false, keepAwake: false, confirmLanguage: false });
		expect(out).toMatchObject({ commandsEnabled: false, keepAwake: false, confirmLanguage: false });
	});

	it("an override can clear a keyword list back to empty", () => {
		const account = sanitizeVoiceSettings({ repeatWords: "again, once more" });
		expect(account.repeatWords).toEqual(["again", "once more"]);
		expect(resolveVoice(account, { repeatWords: [] }).repeatWords).toEqual([]);
		// …but omitting the field keeps the account's list.
		expect(resolveVoice(account, { speed: 90 }).repeatWords).toEqual(["again", "once more"]);
	});
});

describe("sanitizeVoiceSettings — the clamps, now in ONE place", () => {
	it("keeps every bound the instance route used to enforce inline", () => {
		const wild = sanitizeVoiceSettings({
			speed: 9999, silenceMs: 1, maxDictationMs: 1, sensitivity: 99, provider: "evil", sttMode: "evil",
		});
		expect(wild.speed).toBe(200);
		expect(wild.silenceMs).toBe(500);
		expect(wild.maxDictationMs).toBe(10000);
		expect(wild.sensitivity).toBe(2);
		expect(wild.provider).toBe("browser");
		expect(wild.sttMode).toBe("browser");

		const low = sanitizeVoiceSettings({ speed: -5, sensitivity: 0 });
		expect(low.speed).toBe(50);
		expect(low.sensitivity).toBe(0.4);
	});

	it("does NOT round sensitivity — it is fractional", () => {
		// Reusing the integer clamp here would collapse 0.8 to 1 and quietly change every user's
		// mic threshold.
		expect(sanitizeVoiceSettings({ sensitivity: 1.4 }).sensitivity).toBe(1.4);
		expect(defaultVoiceSettings().sensitivity).toBe(0.8);
	});

	it("accepts only known providers and STT models", () => {
		expect(sanitizeVoiceSettings({ provider: "gemini-live" }).provider).toBe("gemini-live");
		expect(sanitizeVoiceSettings({ sttModel: "whisper-1" }).sttModel).toBe("whisper-1");
		// An unknown model falls back rather than reaching the transcription API.
		expect(sanitizeVoiceSettings({ sttModel: "gpt-9" }).sttModel).toBe("gpt-4o-transcribe");
	});

	it("caps keyword lists at 20 entries of 40 chars", () => {
		const many = Array.from({ length: 40 }, (_, i) => `w${i}`);
		expect(parseVoiceWords(many)).toHaveLength(20);
		expect(parseVoiceWords(["x".repeat(200)])[0]).toHaveLength(40);
	});

	it("splits keywords on comma/newline/semicolon but NOT space", () => {
		// A command phrase can be multi-word ("mute mic"); splitting on space would break it.
		expect(parseVoiceWords("again, once more; say that\npardon")).toEqual(["again", "once more", "say that", "pardon"]);
	});
});

describe("translation preferences", () => {
	it("resolves with the same absent-vs-empty rule as voice", () => {
		const account = sanitizeTranslationSettings({ enabled: true, target: "Chinese", transliterate: true });
		expect(resolveTranslation(account, undefined)).toEqual(account);
		expect(resolveTranslation(account, {})).toEqual(account);
		expect(resolveTranslation(account, { enabled: false })).toEqual({ ...account, enabled: false });
	});

	it("defaults wordTap ON and fontSize medium, and rejects a junk size", () => {
		expect(defaultTranslationSettings()).toMatchObject({ wordTap: true, fontSize: "medium", enabled: false });
		expect(sanitizeTranslationSettings({ fontSize: "gigantic" }).fontSize).toBe("medium");
		expect(sanitizeTranslationSettings({ fontSize: "large" }).fontSize).toBe("large");
	});
});

describe("parseAccountPreferences — a corrupt blob must not break sign-in", () => {
	it("returns empty preferences for junk rather than throwing", () => {
		for (const bad of ["", null, undefined, "{not json", "[]", "42", '"str"']) {
			expect(parseAccountPreferences(bad as string)).toEqual({});
		}
	});

	it("sanitizes on the way out, so a hand-edited row can't bypass the clamps", () => {
		const p = parseAccountPreferences(JSON.stringify({ voice: { speed: 9999 }, translation: { fontSize: "huge" } }));
		expect(p.voice?.speed).toBe(200);
		expect(p.translation?.fontSize).toBe("medium");
	});

	it("leaves a section undefined when it was never set", () => {
		// undefined is what makes "use my defaults" distinguishable downstream.
		const p = parseAccountPreferences(JSON.stringify({ voice: { speed: 120 } }));
		expect(p.voice?.speed).toBe(120);
		expect(p.translation).toBeUndefined();
	});
});

describe("cross-package drift — the allowlist has to agree with the code that uses it", () => {
	// The API and the SDK are separate packages with no dependency between them, so these
	// constants can only be kept in sync by a test. The failure is not theoretical: if the SDK's
	// DEFAULT_STT_MODEL is not in the API's allowlist, `unknownVoiceField` 400s a save of the
	// value the SDK itself chose — voice silently stops being configurable.
	const read = (rel: string) => readFileSync(join(__dirname, rel), "utf8");

	it("the SDK's DEFAULT_STT_MODEL is a model the API will accept", () => {
		const src = read("../../../../packages/sdk/src/voice/stt.ts");
		const m = src.match(/export const DEFAULT_STT_MODEL = "([^"]+)"/);
		expect(m, "DEFAULT_STT_MODEL no longer declared as a string literal").toBeTruthy();
		expect(STT_MODELS).toContain(m?.[1]);
		// …and it is what an unconfigured user gets, so the two defaults cannot diverge either.
		expect(defaultVoiceSettings().sttModel).toBe(m?.[1]);
	});

	it("every model the console offers is one the API will accept", () => {
		// A <option> outside the allowlist is a control that 400s when you use it.
		const src = read("../../../../store/console/src/components/VoiceFields.tsx");
		const block = src.slice(src.indexOf('id="voice-stt-model"'));
		const offered = [...block.slice(0, block.indexOf("</select>")).matchAll(/<option value="([^"]+)"/g)].map((x) => x[1]);
		expect(offered.length).toBeGreaterThan(0);
		expect(offered.filter((v) => !STT_MODELS.includes(v as never))).toEqual([]);
	});

	it("every TTS provider the console offers is one the API will accept", () => {
		const src = read("../../../../store/console/src/components/VoiceFields.tsx");
		const block = src.slice(src.indexOf('id="voice-tts-provider"'));
		const offered = [...block.slice(0, block.indexOf("</select>")).matchAll(/<option value="([^"]+)"/g)].map((x) => x[1]);
		expect(offered.length).toBeGreaterThan(0);
		expect(offered.filter((v) => !VOICE_PROVIDERS.includes(v as never))).toEqual([]);
	});
});
