/**
 * Pure hands-free-conversation control logic, split out of the React hook so the
 * delicate "when the recognizer ends, should we reopen the mic or bail?" decision is
 * unit-tested without a browser.
 */

/** Tunables for the restart/freeze guard. */
export interface RestartConfig {
	/** A recognizer end sooner than this after start counts as a "rapid" (failing) end. */
	rapidMs?: number;
	/** After this many consecutive rapid ends, bail out of conversation mode (a mic-blocked
	 *  / instant-abort loop would otherwise peg the CPU and freeze the page). */
	maxRapid?: number;
}

export interface RestartDecision {
	/** Give up on conversation mode — the recognizer keeps dying instantly. */
	bail: boolean;
	/** The updated consecutive-rapid-end counter to carry forward. */
	nextRapidEnds: number;
}

/**
 * Decide what to do when the recognizer ends mid-conversation. If it ended almost
 * immediately after starting we're likely in a failing restart loop — count it, and
 * after `maxRapid` consecutive rapid ends, bail. A healthy (long-enough) turn resets
 * the counter and we reopen the mic.
 *
 * @param elapsedMs  time since the last listen START
 * @param rapidEnds  the current consecutive-rapid-end count
 */
export function decideRestart(elapsedMs: number, rapidEnds: number, cfg: RestartConfig = {}): RestartDecision {
	const rapidMs = cfg.rapidMs ?? 800;
	const maxRapid = cfg.maxRapid ?? 4;
	if (elapsedMs < rapidMs) {
		const next = rapidEnds + 1;
		return next >= maxRapid ? { bail: true, nextRapidEnds: 0 } : { bail: false, nextRapidEnds: next };
	}
	return { bail: false, nextRapidEnds: 0 };
}

/**
 * The active interaction mode, derived from the two primitives so there is ONE source
 * of truth (no contradictory Talk+Speak+Hands-free combos): continuous conversation ⇒
 * `"handsfree"`; replies-aloud without continuous listen ⇒ `"ptt"` (push-to-talk);
 * neither ⇒ `"text"`.
 */
export type VoiceMode = "text" | "ptt" | "handsfree";
export function resolveVoiceMode(convoOn: boolean, speakOn: boolean): VoiceMode {
	if (convoOn) return "handsfree";
	if (speakOn) return "ptt";
	return "text";
}

/** Presentational state for the single "voice status" pill in the chat UI. */
export interface VoiceStatus {
	label: string;
	/** `work` = transcribing/generating (accent, spinner); `live` = mic hot (green);
	 *  `speak` = agent talking back (accent); `idle` = waiting for the user (neutral). */
	tone: "work" | "live" | "idle" | "speak";
	/** Show a spinner (vs a mic glyph). */
	spin: boolean;
	/** Tappable — toggles a manual talk turn (Tap-to-talk). */
	tap: boolean;
	/** Which glyph the pill shows, so both call sites render consistently. */
	icon: "mic" | "spin" | "speak";
}

/**
 * Resolve the single, always-visible voice-status pill so the user ALWAYS knows what's
 * happening — Listening → Transcribing → Working → Speaking — instead of silence until
 * the reply lands. Pure so this branchy presentation logic is tested. `null` means show
 * nothing (idle text chat). `thinking` (agent generating) wins in every mode, then
 * `speaking` (agent talking aloud) — both show even in text chat (e.g. a manual replay).
 */
export function resolveVoiceStatus(input: {
	mode: VoiceMode;
	thinking: boolean;
	transcribing: boolean;
	talking: boolean;
	listening: boolean;
	/** The agent is talking aloud (TTS). Shown in every mode so the mic clearly isn't hot. */
	speaking?: boolean;
	/** Hands-free mic paused via Mute — the pill must not claim it's listening. */
	muted?: boolean;
}): VoiceStatus | null {
	const { mode, thinking, transcribing, talking, listening, speaking, muted } = input;
	if (thinking) return { label: "Working on it…", tone: "work", spin: true, tap: false, icon: "spin" };
	// Agent talking back — surface in EVERY mode (incl. a manual replay in text chat) so
	// it's obvious the mic is not listening to you right now (the self-transcription worry).
	// Tappable so the user can cut the reply off (the pill's onClick routes a `speak`-tone tap
	// to cancelSpeak, not toggleTalk).
	if (speaking) return { label: "Speaking · tap to stop", tone: "speak", spin: false, tap: true, icon: "speak" };
	if (mode === "text") return null;
	if (transcribing) return { label: "Transcribing…", tone: "work", spin: true, tap: false, icon: "spin" };
	if (talking) return { label: "Listening — tap to send", tone: "live", spin: false, tap: true, icon: "mic" };
	if (mode === "ptt") return { label: "Tap to talk", tone: "idle", spin: false, tap: true, icon: "mic" };
	// hands-free
	if (muted) return { label: "Muted", tone: "idle", spin: false, tap: false, icon: "mic" };
	return listening
		? { label: "Listening…", tone: "live", spin: false, tap: false, icon: "mic" }
		: { label: "Hands-free — just talk", tone: "idle", spin: false, tap: false, icon: "mic" };
}

/** A spoken command the hook acts on locally instead of sending as a chat message. */
export type VoiceCommand = "repeat" | "mute";

/** Per-instance overrides for the command keywords (Settings → Voice). Empty/absent =
 *  use the built-in defaults for repeat + mute; stop-words are OFF unless configured. */
export interface VoiceCommandWords {
	/** Phrases that re-speak the last reply. Overrides the built-in multilingual set. */
	repeat?: string[];
	/** Phrases that mute the mic until the user unmutes in the app. */
	mute?: string[];
}

/** "Mute" phrasings per language (2-letter code). Whole-utterance only. English is the
 *  built-in baseline; other-language users add their own words in Settings → Voice. */
const MUTE_BY_LANG: Record<string, string[]> = {
	en: ["mute", "mute mic", "mute the mic", "mute microphone", "mute yourself", "stop listening"],
	es: ["silencio", "silenciar", "cállate"],
	fr: ["muet", "coupe le micro", "silence"],
	de: ["stumm", "stummschalten", "sei still"],
	it: ["muto", "silenzia"],
	pt: ["mudo", "silenciar"],
	zh: ["静音", "闭麦", "别听了"],
	ja: ["ミュート", "消音"],
	ko: ["음소거"],
	hi: ["म्यूट", "चुप"],
};

/** The 2-letter language key for the command maps, defaulting to English. */
function langKey(lang?: string): string {
	return (lang || "en").slice(0, 2).toLowerCase();
}

/** The script a configured language is written in — for language-confirmation (#126). A
 *  configured language pins its script; a transcript in a different script is a mis-detection,
 *  not a real language switch. Languages we can't map return null (never flagged). */
const SCRIPT_BY_LANG: Record<string, RegExp> = {
	en: /\p{Script=Latin}/u,
	es: /\p{Script=Latin}/u,
	fr: /\p{Script=Latin}/u,
	de: /\p{Script=Latin}/u,
	it: /\p{Script=Latin}/u,
	pt: /\p{Script=Latin}/u,
	zh: /\p{Script=Han}/u,
	ja: /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}/u,
	ko: /\p{Script=Hangul}/u,
	hi: /\p{Script=Devanagari}/u,
};

/**
 * Does a transcript look like a DIFFERENT language than the configured one (#126)? Judged by
 * script, not content: if the configured language expects Latin but the transcript is mostly
 * Hangul/Kana/Han, the STT mis-detected the language — the app should ask rather than respond
 * in it. Conservative: returns false for an unknown configured language, empty/too-short text,
 * or when at most half the letters are foreign (so a stray glyph never trips it). Pure + tested.
 */
export function transcriptLanguageMismatch(text: string, lang?: string): boolean {
	const expected = SCRIPT_BY_LANG[langKey(lang)];
	if (!expected) return false; // language we don't map → never flag
	const letters = (text || "").replace(/[^\p{L}]/gu, ""); // drop spaces/digits/punct/emoji
	if (letters.length < 2) return false; // too little signal to judge
	let foreign = 0;
	for (const ch of letters) if (!expected.test(ch)) foreign++;
	return foreign > letters.length / 2; // majority in another script → mis-detection
}

/** Normalize a transcript for matching: lowercase, strip punctuation (Latin + CJK +
 *  inverted Spanish), collapse whitespace. Shared by every matcher so they agree. */
function normalizeTranscript(text: string): string {
	return text
		.toLowerCase()
		.replace(/[.,!?¿¡。，！？、]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * "Repeat" phrasings per language (2-letter code) — ONLY the agent's configured
 * language matches, so an English agent never triggers on a Chinese phrase and vice
 * versa. Whole-utterance matches only (high precision). Data, not regex, so adding a
 * language is a list edit.
 */
const REPEAT_BY_LANG: Record<string, string[]> = {
	en: ["repeat", "repeat that", "repeat it", "repeat again", "repeat please", "say again", "say that again", "say it again", "again please", "come again", "pardon", "what did you say"],
	zh: ["再说一遍", "再说一次", "重复一遍", "再来一遍"],
	es: ["repite", "repítelo", "otra vez", "qué dijiste"],
	fr: ["répète", "répétez", "encore une fois"],
	de: ["wiederhole", "nochmal", "wie bitte"],
	it: ["ripeti", "un'altra volta"],
	pt: ["repita", "de novo"],
	ja: ["もう一度", "もう一回"],
	ko: ["다시", "다시 말해줘", "다시 말해 줘"],
	hi: ["फिर से कहो", "दोबारा कहो"],
};

/**
 * Detect a hands-free voice COMMAND ("repeat" / "mute") in a finished transcript.
 * Matches only when the whole utterance IS the command (punctuation ignored), so a
 * normal sentence containing the word isn't hijacked. Built-in phrasings are scoped to
 * the agent's `lang` (the configured voice language) — an English agent won't trigger on
 * a Chinese phrase. Custom `words` from Settings REPLACE the built-ins and apply in any
 * language (the user chose them explicitly).
 */
export function matchVoiceCommand(text: string, words?: VoiceCommandWords, lang?: string): VoiceCommand | null {
	const t = normalizeTranscript(text);
	const l = langKey(lang);
	const repeat = words?.repeat?.length ? words.repeat : (REPEAT_BY_LANG[l] ?? REPEAT_BY_LANG.en);
	const mute = words?.mute?.length ? words.mute : (MUTE_BY_LANG[l] ?? MUTE_BY_LANG.en);
	if (new Set(repeat.map(normalizeTranscript)).has(t)) return "repeat";
	if (new Set(mute.map(normalizeTranscript)).has(t)) return "mute";
	return null;
}

/**
 * Detect a trailing STOP-WORD ("...do the thing, copy") — the user's spoken "I'm done,
 * process it now" marker. Returns `ended` (a stop-word closed the turn) and `text` with
 * the stop-word removed. A stop-word ALONE ("copy") → `{ ended: true, text: "" }` (end
 * the turn, nothing to send). Off unless `stopWords` is configured — the word is usually
 * a normal word, so it must be opt-in to avoid hijacking ordinary speech.
 */
export function stripStopWord(text: string, stopWords?: string[]): { ended: boolean; text: string } {
	if (!stopWords?.length) return { ended: false, text };
	// Compare on a normalized copy but slice the ORIGINAL so casing/spacing is preserved.
	const cleaned = text.replace(/[.,!?¿¡。，！？、]+\s*$/, "").trimEnd();
	const norm = normalizeTranscript(cleaned);
	for (const raw of stopWords) {
		const w = normalizeTranscript(raw);
		if (!w) continue;
		if (norm === w) return { ended: true, text: "" };
		if (norm.endsWith(` ${w}`)) {
			// Drop the last N words (the stop-word may be multi-word) off the original.
			const wordCount = w.split(" ").length;
			const kept = cleaned.split(/\s+/).slice(0, -wordCount).join(" ").replace(/[\s,]+$/, "").trim();
			return { ended: true, text: kept };
		}
	}
	return { ended: false, text };
}

/**
 * Classify a browser SpeechRecognition / STT error (issue: voice error-log spam).
 * - "soft"           → no-speech / empty: not an error, just recycle the mic.
 * - "mic-unavailable"→ permission denied or no capture device. A user-ENVIRONMENT
 *   state, not a platform bug: stop the loop (don't retry into a dead mic) and show a
 *   clear hint — do NOT flood the durable error log.
 * - "error"          → a genuine failure (Whisper 400/401, etc.) worth reporting.
 */
export type VoiceErrorKind = "soft" | "mic-unavailable" | "error";
const MIC_UNAVAILABLE = new Set(["not-allowed", "service-not-allowed", "audio-capture"]);
export function classifyVoiceError(err: string | null | undefined): VoiceErrorKind {
	if (!err || err === "no-speech") return "soft";
	if (MIC_UNAVAILABLE.has(err)) return "mic-unavailable";
	return "error";
}
/** Human hint for a mic-unavailable error code. */
export function micUnavailableMessage(err: string): string {
	return err === "audio-capture"
		? "No microphone found — check your device."
		: "Microphone blocked — allow mic access in your browser settings.";
}
