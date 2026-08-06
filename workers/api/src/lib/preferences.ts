// Account-level preferences, and how they resolve against a per-agent override (#211).
//
// Voice and translation settings were stored ONLY on `agent_instances.config`, so "I prefer Whisper
// over browser dictation" and "read replies at 1.2×" had to be set once per agent — and a new
// subscription seeds neither, so every agent you add makes you re-tune your own preferences from
// platform defaults. Neither is a property of an agent; both are properties of the person.
//
// PURE — no D1, no Env. The whole precedence chain and every clamp live here so they can be tested
// without a database, and so the account route and the instance-override route enforce the SAME
// rules. Before this the clamps existed only inside the instance PUT handler, which is why an
// account-level store could not have reused them.
//
// Precedence:
//
//   platform defaults
//     └─ users.preferences.voice                       (your account default)
//          └─ agent_instances.config.voiceSettings     (PRESENT = "customised for this agent")
//               └─ a declared `voiceLanguage` setting  (language only, resolved live)
//
// Presence is the override flag. That is why `undefined` and `{}` mean different things here, and
// why migration 0071 renames the pre-existing per-instance copies out of the way instead of leaving
// them: otherwise every agent would read as "customised" on day one, which is the sprawl this
// removes.

// Lenient on READ, strict on WRITE. The sanitizers below coerce anything unknown to a safe value,
// because they also parse rows that were stored years ago by older code — but an explicit save must
// REJECT a value it doesn't recognise rather than quietly substitute one, or a caller asking for
// "gemini-live" and getting "browser" has no way to tell. Routes validate against these lists first.
/** TTS transports the platform knows. */
export const VOICE_PROVIDERS = ["browser", "openai-realtime", "gemini-live"] as const;
/** Whisper transcription models. `sttModel` was read by the SDK but never persisted (#211/T3). */
export const STT_MODELS = ["gpt-4o-transcribe", "gpt-4o-mini-transcribe", "whisper-1"] as const;

/** Reject an explicitly-supplied value the platform doesn't know. Absent is always fine. */
export function unknownVoiceField(body: Record<string, unknown>): string | null {
	if (body.provider !== undefined && !VOICE_PROVIDERS.includes(body.provider as never)) {
		return `provider must be ${VOICE_PROVIDERS.join(", ")}`;
	}
	if (body.sttModel !== undefined && !STT_MODELS.includes(body.sttModel as never)) {
		return `sttModel must be ${STT_MODELS.join(", ")}`;
	}
	if (body.sttMode !== undefined && body.sttMode !== "browser" && body.sttMode !== "openai") {
		return "sttMode must be browser or openai";
	}
	return null;
}
const FONT_SIZES = ["small", "medium", "large"] as const;

export interface VoiceSettings {
	provider: string;
	speed: number;
	silenceMs: number;
	maxDictationMs: number;
	/** How much of a reply is read aloud, in characters (#179). Bounded 200–4096: below ~200 the
	 *  cap truncates an ordinary reply mid-thought, and OpenAI TTS rejects input over 4096, so
	 *  "unlimited" is not an offerable value. Mirrors the SDK clamp in `voice/tts.ts`. */
	ttsMaxChars: number;
	sttMode: "browser" | "openai";
	sttModel: string;
	sensitivity: number;
	openai?: Record<string, unknown>;
	gemini?: Record<string, unknown>;
	language: string;
	commandsEnabled: boolean;
	keepAwake: boolean;
	repeatWords: string[];
	muteWords: string[];
	/** Phrases that re-open the mic while muted (#152). */
	unmuteWords: string[];
	/** Phrases that leave voice mode entirely (#165). */
	exitWords: string[];
	stopWords: string[];
	stopSpeechKeyword: string;
	confirmLanguage: boolean;
}

export interface TranslationSettings {
	enabled: boolean;
	target: string;
	transliterate: boolean;
	wordTap: boolean;
	fontSize: "small" | "medium" | "large";
}

export interface AccountPreferences {
	voice?: VoiceSettings;
	translation?: TranslationSettings;
}

const num = (v: unknown, lo: number, hi: number, dflt: number): number =>
	typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : dflt;

/**
 * Normalize a keywords field (array OR comma-separated string) → a clean short list.
 *
 * Split on comma / newline / semicolon — NOT space, because a phrase can be multi-word ("mute mic").
 * Mirrors `parseWords` in `packages/sdk/src/voice/config.ts`, which parses the same field on the
 * client; the two must agree or a saved keyword stops matching.
 */
export function parseVoiceWords(v: unknown): string[] {
	const list = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,\n;]/) : [];
	return list.filter((x): x is string => typeof x === "string").map((s) => s.trim().slice(0, 40)).filter(Boolean).slice(0, 20);
}

/** Platform defaults — what you get having configured nothing, anywhere. */
export function defaultVoiceSettings(): VoiceSettings {
	return {
		provider: "browser",
		speed: 100,
		silenceMs: 1500,
		maxDictationMs: 60000,
		ttsMaxChars: 1500,
		sttMode: "browser",
		sttModel: STT_MODELS[0],
		// Conservative (0.8): lower means background noise is less likely to read as speech.
		sensitivity: 0.8,
		language: "en-US",
		commandsEnabled: true,
		keepAwake: true,
		repeatWords: [],
		muteWords: [],
		unmuteWords: [],
		exitWords: [],
		stopWords: [],
		stopSpeechKeyword: "",
		confirmLanguage: true,
	};
}

export function defaultTranslationSettings(): TranslationSettings {
	return { enabled: false, target: "", transliterate: false, wordTap: true, fontSize: "medium" };
}

/**
 * Clamp an arbitrary object into a valid VoiceSettings, filling from `base`.
 *
 * `base` is what an unspecified field falls back to — the platform defaults for an account save,
 * and the resolved account value when seeding an override, so "customise this agent" starts from
 * what the user was already hearing rather than snapping back to browser TTS.
 */
export function sanitizeVoiceSettings(raw: unknown, base: VoiceSettings = defaultVoiceSettings()): VoiceSettings {
	const o = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
	const has = (k: string) => o[k] !== undefined;
	return {
		provider: VOICE_PROVIDERS.includes(o.provider as never) ? String(o.provider) : base.provider,
		speed: has("speed") ? num(o.speed, 50, 200, base.speed) : base.speed,
		silenceMs: has("silenceMs") ? num(o.silenceMs, 500, 6000, base.silenceMs) : base.silenceMs,
		maxDictationMs: has("maxDictationMs") ? num(o.maxDictationMs, 10000, 300000, base.maxDictationMs) : base.maxDictationMs,
		ttsMaxChars: has("ttsMaxChars") ? num(o.ttsMaxChars, 200, 4096, base.ttsMaxChars) : base.ttsMaxChars,
		sttMode: o.sttMode === "openai" ? "openai" : o.sttMode === "browser" ? "browser" : base.sttMode,
		sttModel: STT_MODELS.includes(o.sttModel as never) ? String(o.sttModel) : base.sttModel,
		// Not rounded — sensitivity is fractional (0.4–2), so `num`'s Math.round would collapse it.
		sensitivity: typeof o.sensitivity === "number" && Number.isFinite(o.sensitivity)
			? Math.max(0.4, Math.min(2, o.sensitivity))
			: base.sensitivity,
		openai: o.openai && typeof o.openai === "object" ? (o.openai as Record<string, unknown>) : base.openai,
		gemini: o.gemini && typeof o.gemini === "object" ? (o.gemini as Record<string, unknown>) : base.gemini,
		language: typeof o.language === "string" && o.language.trim() ? o.language.trim().slice(0, 10) : base.language,
		// A boolean flag defaults ON unless EXPLICITLY false, matching every existing voice flag:
		// silently disabling a feature because a field was malformed is the failure mode to avoid.
		commandsEnabled: has("commandsEnabled") ? o.commandsEnabled !== false : base.commandsEnabled,
		keepAwake: has("keepAwake") ? o.keepAwake !== false : base.keepAwake,
		repeatWords: has("repeatWords") ? parseVoiceWords(o.repeatWords) : base.repeatWords,
		muteWords: has("muteWords") ? parseVoiceWords(o.muteWords) : base.muteWords,
		unmuteWords: has("unmuteWords") ? parseVoiceWords(o.unmuteWords) : base.unmuteWords,
		exitWords: has("exitWords") ? parseVoiceWords(o.exitWords) : base.exitWords,
		stopWords: has("stopWords") ? parseVoiceWords(o.stopWords) : base.stopWords,
		stopSpeechKeyword: typeof o.stopSpeechKeyword === "string" ? o.stopSpeechKeyword.trim().slice(0, 40) : base.stopSpeechKeyword,
		confirmLanguage: has("confirmLanguage") ? o.confirmLanguage !== false : base.confirmLanguage,
	};
}

export function sanitizeTranslationSettings(
	raw: unknown,
	base: TranslationSettings = defaultTranslationSettings(),
): TranslationSettings {
	const o = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
	const has = (k: string) => o[k] !== undefined;
	return {
		enabled: has("enabled") ? o.enabled === true : base.enabled,
		// The target is validated against the language table by the caller (`languageByName`),
		// which owns that list — this only bounds it.
		target: typeof o.target === "string" ? o.target.slice(0, 40) : base.target,
		transliterate: has("transliterate") ? o.transliterate === true : base.transliterate,
		wordTap: has("wordTap") ? o.wordTap !== false : base.wordTap,
		fontSize: FONT_SIZES.includes(o.fontSize as never) ? (o.fontSize as TranslationSettings["fontSize"]) : base.fontSize,
	};
}

/** Parse a stored `users.preferences` blob. Junk yields no preferences, never a broken shape. */
export function parseAccountPreferences(raw: string | null | undefined): AccountPreferences {
	if (!raw) return {};
	try {
		const o = JSON.parse(raw) as Record<string, unknown>;
		if (!o || typeof o !== "object" || Array.isArray(o)) return {};
		return {
			voice: o.voice ? sanitizeVoiceSettings(o.voice) : undefined,
			translation: o.translation ? sanitizeTranslationSettings(o.translation) : undefined,
		};
	} catch {
		return {};
	}
}

/**
 * The effective voice settings for one agent.
 *
 * `override === undefined` means "use my defaults" — NOT the same as `{}`, which is a real override
 * that resets every unspecified field to the platform default. Conflating the two is how a
 * "customise" toggle silently ignores itself.
 *
 * `declaredLanguage` comes from an agent whose `settingsSchema` marks a field `voiceLanguage: true`
 * (Language Buddy's `target_language`). It wins on `language` and NOTHING else, and it is resolved
 * live rather than copied into storage — previously the settings route wrote it INTO voiceSettings,
 * so changing the declared setting left a stale language behind until something re-saved.
 */
export function resolveVoice(
	account: VoiceSettings | undefined,
	override: unknown | undefined,
	declaredLanguage?: string,
): VoiceSettings {
	const base = account ? sanitizeVoiceSettings(account) : defaultVoiceSettings();
	const effective = override === undefined || override === null ? base : sanitizeVoiceSettings(override, base);
	const lang = typeof declaredLanguage === "string" ? declaredLanguage.trim() : "";
	return lang ? { ...effective, language: lang.slice(0, 10) } : effective;
}

export function resolveTranslation(
	account: TranslationSettings | undefined,
	override: unknown | undefined,
): TranslationSettings {
	const base = account ? sanitizeTranslationSettings(account) : defaultTranslationSettings();
	return override === undefined || override === null ? base : sanitizeTranslationSettings(override, base);
}
