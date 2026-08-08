// Account-level preferences, and how they resolve against a per-agent override (#211).
//
// `isValidTimeZone` is imported rather than re-implemented: triggers have validated timezones since
// #18, and one timezone vocabulary for the whole platform is the point — a zone the cron scheduler
// accepts and the prompt rejects (or vice versa) is a bug waiting for a user to find it.
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

import { isValidTimeZone } from "./cron-time.js";
import { type NotificationPreferences, sanitizeNotificationPreferences } from "./notifications.js";

// Lenient on READ, strict on WRITE. The sanitizers below coerce anything unknown to a safe value,
// because they also parse rows that were stored years ago by older code — but an explicit save must
// REJECT a value it doesn't recognise rather than quietly substitute one, or a caller asking for
// "gemini-live" and getting "browser" has no way to tell. Routes validate against these lists first.
/** TTS transports the platform knows. */
export const VOICE_PROVIDERS = ["browser", "openai-realtime", "gemini-live"] as const;
/** Whisper transcription models. `sttModel` was read by the SDK but never persisted (#211/T3). */
export const STT_MODELS = ["gpt-4o-transcribe", "gpt-4o-mini-transcribe", "whisper-1"] as const;
/** Every voice command that can be switched off (#443). Mirrors the SDK's `ALL_VOICE_COMMANDS`;
 *  the two are asserted equal in preferences.test.ts, because this list gates a WRITE and the
 *  other one gates the match — a name in only one of them is a switch with nothing behind it. */
export const VOICE_COMMANDS = ["repeat", "mute", "unmute", "exit", "next", "back", "scrap"] as const;

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
	// Strict on write for the same reason `provider` is: a caller switching off "mute-mic" and
	// silently getting nothing switched off has no way to tell. The sanitizer below stays lenient,
	// because it also parses rows written by older code.
	if (body.disabledCommands !== undefined) {
		if (!Array.isArray(body.disabledCommands)) return `disabledCommands must be an array of ${VOICE_COMMANDS.join(", ")}`;
		const bad = body.disabledCommands.find((x) => !VOICE_COMMANDS.includes(x as never));
		if (bad !== undefined) return `disabledCommands must contain only ${VOICE_COMMANDS.join(", ")}`;
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
	/** Phrases that move you to the agent asking for you (#277). */
	nextWords: string[];
	/** Phrases that scrap the last turn (#342). Whole-utterance only — a destructive command
	 *  must not be reachable from the middle of a sentence. */
	scrapWords: string[];
	/**
	 * Voice commands the user switched OFF (#443). Empty = everything on, which is what an account
	 * that has never touched the panel stores, so its behaviour is byte-for-byte unchanged.
	 *
	 * A SWITCH rather than a blank words field. The built-in phrasings are language-derived and
	 * resolved at MATCH time in the SDK, so encoding "off" as "blank" would have needed a backfill
	 * that freezes today's English list into every account — permanently, since a populated field
	 * is never resolved again. Two independent facts, two fields.
	 */
	disabledCommands: string[];
	stopWords: string[];
	/**
	 * Words the USER says that a recogniser gets wrong — `tmux`, `HeartFull`, a product name
	 * (#373). Biases the transcriber (which accepts a vocabulary `prompt`) and corrects the
	 * browser engine (which does not — there is no steerable grammar, so the only lever on that
	 * path is a post-hoc pass over the finished transcript).
	 *
	 * **This is the one voice field that UNIONS across scopes instead of overriding.** Every other
	 * setting answers "how should this agent behave", and "customise for this agent" sensibly means
	 * *instead of*. A vocabulary answers "what words do I say", and the answer is cumulative: your
	 * own name belongs to you, this agent's repo names belong to the agent, and an override
	 * contract would make you re-type the first into every one of them. See {@link resolveVoice}.
	 */
	vocabulary: string[];
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
	/**
	 * The user's IANA timezone — the account default for every surface that shows a time (#329).
	 *
	 * It lives here rather than in `user_profile` or a per-agent `settingsSchema` field for the same
	 * reason voice and translation do: a timezone is a property of the PERSON, not of an agent or of
	 * a job application. `user_profile` is the apply pipeline's structured PII (name, phone,
	 * work-auth) and is only maintained by people using that one agent; a typed setting would have to
	 * be declared, and then re-set, per agent. This blob is the one the owner already maintains for
	 * everything else that follows them across agents.
	 *
	 * **`undefined` is a first-class state and must stay one.** An unset zone means "nobody has told
	 * us", and the prompt then names UTC honestly rather than a guessed local time — a confidently
	 * wrong hour is worse than an explicit UTC. So there is no default here, and no fallback to
	 * `"UTC"`: that would be indistinguishable from a user who really is in UTC.
	 */
	timezone?: string;
	/**
	 * Which notification types may interrupt you (#360).
	 *
	 * Account-level for the same reason the rest of this blob is: push subscriptions are
	 * per-user and `sendPushToUser` fans out to every device, so "mute deploys" is not a
	 * property of one agent or one browser. It lives here rather than as a per-instance
	 * setting because a user who finds deploy notifications noisy would otherwise have to
	 * find and mute every agent that can produce one.
	 *
	 * Enforced in `notifyUser`, and NEVER over an `alert` — see `pushAllowedByPreference`.
	 */
	notifications?: NotificationPreferences;
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

/**
 * How many vocabulary terms one SCOPE may hold (#373).
 *
 * Bounded because the OpenAI `prompt` field is finite and its bias quality DEGRADES with length —
 * a 500-word list is worse than a 20-word one, since every term is a candidate the decoder can
 * reach for on a low-information clip (#332). 50 is "the proper nouns one person uses", which is
 * the size the feature is for; the prompt builder caps what it actually sends far lower again.
 */
export const MAX_VOCABULARY_TERMS = 50;

/** Normalize a vocabulary field. Same delimiters as `parseVoiceWords` (a term can be a phrase),
 *  different cap: a vocabulary is a list of nouns, not a handful of command phrasings. */
export function parseVocabularyTerms(v: unknown): string[] {
	const list = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,\n;]/) : [];
	const seen = new Set<string>();
	const out: string[] = [];
	for (const raw of list) {
		if (typeof raw !== "string") continue;
		const term = raw.trim().slice(0, 40);
		if (!term) continue;
		// Case-insensitive dedupe, first spelling wins — the user writes `HeartFull` once and it is
		// the CASING that a correction pass restores, so which copy survives is not arbitrary.
		const key = term.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(term);
		if (out.length >= MAX_VOCABULARY_TERMS) break;
	}
	return out;
}

/**
 * Union two scopes' vocabularies, account first, deduped case-insensitively.
 *
 * Account first because those are the words that follow the user everywhere (their name, their
 * company) and the per-agent list is the narrower addition — and because the prompt builder
 * truncates the TAIL, so ordering decides what survives the cap.
 *
 * The union is capped at the same 50, not 100: the cap exists because a long list biases WORSE,
 * and that is a property of the list the decoder receives, not of how many places it came from.
 */
export function mergeVocabulary(account: string[] | undefined, own: string[] | undefined): string[] {
	return parseVocabularyTerms([...(account || []), ...(own || [])]);
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
		nextWords: [],
		scrapWords: [],
		disabledCommands: [],
		stopWords: [],
		vocabulary: [],
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
		nextWords: has("nextWords") ? parseVoiceWords(o.nextWords) : base.nextWords,
		scrapWords: has("scrapWords") ? parseVoiceWords(o.scrapWords) : base.scrapWords,
		// Filtered against the vocabulary, not passed through: the safe failure for "is this command
		// on" is ON, so an unrecognised name is dropped rather than allowed to disable something.
		disabledCommands: has("disabledCommands")
			? (Array.isArray(o.disabledCommands) ? o.disabledCommands : []).filter(
					(x, i, a): x is string => typeof x === "string" && VOICE_COMMANDS.includes(x as never) && a.indexOf(x) === i,
				)
			: base.disabledCommands,
		stopWords: has("stopWords") ? parseVoiceWords(o.stopWords) : base.stopWords,
		// Patch semantics like every other field — an unspecified vocabulary keeps what this SCOPE
		// already had. What differs is the base a caller hands in: `overrideVoiceBase` below seeds
		// an agent override from the ACCOUNT for everything except this, because a union must never
		// snapshot the list it is unioning with.
		vocabulary: has("vocabulary") ? parseVocabularyTerms(o.vocabulary) : base.vocabulary,
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
			// Validated on READ as well as on write. A zone the runtime cannot resolve would make
			// `Intl.DateTimeFormat` throw on the per-turn prompt path, and a stored value can predate
			// this check (or name a zone this runtime's tz database does not carry). Dropping it back
			// to `undefined` lands on the honest unset branch instead of failing a chat turn.
			timezone: isValidTimeZone(o.timezone) ? o.timezone : undefined,
			notifications: sanitizeNotificationPreferences(o.notifications),
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
 *
 * `vocabulary` is the ONE field that does not follow the override contract: it UNIONS (#373). It
 * is not a behaviour the agent has, it is a list of words the person says, and an override would
 * mean re-typing your own name into every agent you own. The departure is deliberate and is
 * stated in the console beside the field, because "customise for this agent" means *instead of*
 * everywhere else on that panel and *as well as* here.
 */
export function resolveVoice(
	account: VoiceSettings | undefined,
	override: unknown | undefined,
	declaredLanguage?: string,
): VoiceSettings {
	const base = account ? sanitizeVoiceSettings(account) : defaultVoiceSettings();
	const overridden = override === undefined || override === null ? base : sanitizeVoiceSettings(override, base);
	const effective = { ...overridden, vocabulary: mergeVocabulary(base.vocabulary, overridden.vocabulary) };
	const lang = typeof declaredLanguage === "string" ? declaredLanguage.trim() : "";
	return lang ? { ...effective, language: lang.slice(0, 10) } : effective;
}

/**
 * The base an agent OVERRIDE is sanitized against: your account values for every field, except
 * `vocabulary`, which comes from the override's own current value.
 *
 * Without this the seeding rule ("customise starts from what you were already hearing") would copy
 * the account vocabulary INTO the agent — and then the union would be a union with a snapshot.
 * Remove a word from your account list afterwards and it survives on every agent you had ever
 * customised, invisibly, because the agent's own box now contains it too. The list a scope stores
 * is the list that scope ADDS; nothing else.
 */
export function overrideVoiceBase(account: VoiceSettings | undefined, currentOverride: unknown): VoiceSettings {
	const base = account ? sanitizeVoiceSettings(account) : defaultVoiceSettings();
	const own =
		currentOverride && typeof currentOverride === "object" && !Array.isArray(currentOverride)
			? (currentOverride as Record<string, unknown>).vocabulary
			: undefined;
	return { ...base, vocabulary: parseVocabularyTerms(own) };
}

export function resolveTranslation(
	account: TranslationSettings | undefined,
	override: unknown | undefined,
): TranslationSettings {
	const base = account ? sanitizeTranslationSettings(account) : defaultTranslationSettings();
	return override === undefined || override === null ? base : sanitizeTranslationSettings(override, base);
}
