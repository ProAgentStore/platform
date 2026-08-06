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
export type VoiceCommand = "repeat" | "mute" | "unmute" | "exit";

/** Per-instance overrides for the command keywords (Settings → Voice). Empty/absent =
 *  use the built-in defaults for repeat/mute/unmute/exit; stop-words are OFF unless configured. */
export interface VoiceCommandWords {
	/** Phrases that re-speak the last reply. Overrides the built-in multilingual set. */
	repeat?: string[];
	/** Phrases that mute the mic. */
	mute?: string[];
	/** Phrases that re-open the mic while muted (#152). */
	unmute?: string[];
	/** Phrases that leave voice entirely and return to text mode (#165). */
	exit?: string[];
}

/** "Unmute" phrasings per language. The mirror of MUTE_BY_LANG — matched ONLY while muted
 *  (see matchVoiceCommand), so these words are inert during a normal turn and can't hijack
 *  ordinary speech. */
const UNMUTE_BY_LANG: Record<string, string[]> = {
	en: ["unmute", "unmute mic", "unmute the mic", "unmute microphone", "start listening", "resume listening", "listen up", "wake up"],
	es: ["reactivar", "activar micrófono", "escucha", "vuelve a escuchar"],
	fr: ["réactive le micro", "reprends l'écoute", "écoute moi"],
	de: ["stummschaltung aufheben", "hör wieder zu", "wach auf"],
	it: ["riattiva", "riattiva il microfono", "ascolta"],
	pt: ["reativar", "reativar microfone", "volte a ouvir"],
	zh: ["取消静音", "开麦", "开始听"],
	ja: ["ミュート解除", "聞いて"],
	ko: ["음소거 해제", "들어봐"],
	hi: ["अनम्यूट", "फिर से सुनो"],
};

/** "Exit voice" phrasings per language (#165) — leave voice mode entirely and go back to
 *  typing. Distinct from mute: mute keeps the session live and listening for control words,
 *  exit tears the whole thing down. */
const EXIT_BY_LANG: Record<string, string[]> = {
	en: ["exit voice", "exit voice mode", "stop voice", "stop voice mode", "leave voice", "text mode", "switch to text", "back to text"],
	es: ["salir de voz", "modo texto", "cambiar a texto"],
	fr: ["quitter la voix", "mode texte", "passer au texte"],
	de: ["sprachmodus beenden", "textmodus", "zurück zum text"],
	it: ["esci dalla voce", "modalità testo"],
	pt: ["sair da voz", "modo texto"],
	zh: ["退出语音", "文字模式", "切换到文字"],
	ja: ["音声モード終了", "テキストモード"],
	ko: ["음성 모드 종료", "텍스트 모드"],
	hi: ["वॉइस बंद करो", "टेक्स्ट मोड"],
};

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

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Does an already-normalized transcript match a configured command phrase?
 *  - A SINGLE-word phrase ("mute") must BE the whole utterance — precision, so "mute" never
 *    fires inside "mute the alarm".
 *  - A MULTI-word phrase ("mute mute", "stop listening") matches the whole utterance OR appears
 *    as a contiguous whole-word run inside it ("okay mute mute now" → matches). Multi-word
 *    phrases are distinctive enough that a whole-word substring match won't hijack normal speech,
 *    and it's what makes a two-word wake/mute phrase usable in a longer utterance.
 * "mute mute" is ONE two-word phrase (space-preserved by the delimiter parse), so "mute" alone
 * — only half the phrase — does NOT match.
 */
export function phraseMatchesTranscript(normalizedTranscript: string, phrase: string): boolean {
	const p = normalizeTranscript(phrase);
	if (!p) return false;
	if (normalizedTranscript === p) return true;
	if (!p.includes(" ")) return false; // single word → whole-utterance only
	return new RegExp(`(?:^| )${escapeRegExp(p)}(?: |$)`).test(normalizedTranscript);
}

/**
 * Detect a hands-free voice COMMAND ("repeat" / "mute") in a transcript. A single-word command
 * matches only when the whole utterance IS the command (punctuation ignored), so a normal
 * sentence containing the word isn't hijacked; a multi-word command phrase also matches when it
 * appears as a whole-word run inside the utterance (see {@link phraseMatchesTranscript}). Built-in
 * phrasings are scoped to the agent's `lang` (the configured voice language) — an English agent
 * won't trigger on a Chinese phrase. Custom `words` from Settings/Profile REPLACE the built-ins
 * and apply in any language (the user chose them explicitly).
 */
export function matchVoiceCommand(
	text: string,
	words?: VoiceCommandWords,
	lang?: string,
	state?: { muted?: boolean },
): VoiceCommand | null {
	const t = normalizeTranscript(text);
	const l = langKey(lang);
	const pick = (custom: string[] | undefined, table: Record<string, string[]>) =>
		custom?.length ? custom : (table[l] ?? table.en);
	const hit = (phrases: string[]) => phrases.some((p) => phraseMatchesTranscript(t, p));

	// Order matters. "unmute" is checked FIRST and only while muted: several languages build
	// the unmute phrase out of the mute phrase (de "stummschaltung aufheben" contains "stumm"),
	// so a mute-first order would swallow it. English is safe by whole-utterance matching —
	// other languages are not.
	if (state?.muted) {
		// While muted the ONLY meaningful commands are unmute and exit. Checking mute here
		// would be a no-op at best; checking repeat would speak while the user asked for silence.
		if (hit(pick(words?.unmute, UNMUTE_BY_LANG))) return "unmute";
		if (hit(pick(words?.exit, EXIT_BY_LANG))) return "exit";
		return null;
	}
	// Not muted: unmute is meaningless, and matching it here would fire on someone SAYING the
	// word ("say unmute to turn the mic back on") rather than commanding it.
	if (hit(pick(words?.exit, EXIT_BY_LANG))) return "exit";
	if (hit(pick(words?.repeat, REPEAT_BY_LANG))) return "repeat";
	if (hit(pick(words?.mute, MUTE_BY_LANG))) return "mute";
	return null;
}

/**
 * Should the ALWAYS-ON background control-word listener be running right now (#153)? It's a
 * lightweight dictation loop, SEPARATE from the main recording pipeline, whose only job is to
 * catch a control word (mute / stop) at ANY moment — while TTS plays, while the agent is
 * processing, while the mic is muted. It runs whenever voice is engaged BUT yields while the
 * MAIN recorder is actively capturing a user turn (the main transcription path already checks
 * control words then, and two concurrent recognizers on the same browser API fight). So:
 *   engaged (voice mode, not plain text) AND NOT the main mic actively recording.
 */
export function shouldRunControlListener(s: { engaged: boolean; mainRecording: boolean }): boolean {
	return s.engaged && !s.mainRecording;
}

/**
 * Should a live transcript chunk be scanned for control words (#228)?
 *
 * The control listener above yields whenever the main mic is capturing, which left a hole: it
 * assumed the main path checks control words during capture, and that is only true for browser
 * DICTATION (which emits interim results live). The Whisper/OpenAI path records with
 * MediaRecorder and produces nothing until the clip is uploaded — so for the whole recording
 * window nobody was checking, and "mute" said mid-turn did nothing until end-of-turn (or never,
 * if it wasn't the entire utterance).
 *
 * In that mode the speech GATE is already running a browser recognizer over the same audio for
 * noise filtering, and already has the words. This is the predicate for using them: scan the
 * gate's transcript exactly when the main path can't do it itself.
 *
 * `paused` covers the reply-in-flight window (the gate keeps running across it) and `echoing`
 * the TTS tail, so the agent's own voice can't issue commands to it.
 */
export function shouldScanGateTranscript(s: {
	commandsEnabled: boolean;
	mainUsesBrowserSpeech: boolean;
	paused: boolean;
	echoing: boolean;
}): boolean {
	if (!s.commandsEnabled) return false;
	// Browser dictation already checks control words on its own interim results; scanning the
	// gate too would double-fire the same command from two recognizers on the same audio.
	if (s.mainUsesBrowserSpeech) return false;
	return !s.paused && !s.echoing;
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

/** The phrase list actually in force for one command — custom words if the user set any,
 *  else the built-ins for their language. Exported so callers can strip a spoken command
 *  out of a message without re-deriving the precedence rules. */
export function commandPhrases(command: VoiceCommand, words?: VoiceCommandWords, lang?: string): string[] {
	const l = langKey(lang);
	const table =
		command === "repeat" ? REPEAT_BY_LANG : command === "mute" ? MUTE_BY_LANG : command === "unmute" ? UNMUTE_BY_LANG : EXIT_BY_LANG;
	const custom = words?.[command];
	return custom?.length ? custom : (table[l] ?? table.en);
}

/**
 * Split a spoken turn into "the command at the end" + "what the user actually said".
 *
 * A control word spoken at the END of a turn ("run the tests, mute") is a control word AND a
 * finished message — the same contract stop-words already have. Treating it as command-only
 * threw the message away: the user dictated a request, asked for silence, and the request
 * vanished. Treating it as message-only left them talking to a mic that never muted.
 *
 * Returns the command (if any) and the message with the command phrase removed. A turn that
 * IS the command yields an empty message, so nothing is sent.
 */
export function splitTrailingCommand(
	text: string,
	words?: VoiceCommandWords,
	lang?: string,
	state?: { muted?: boolean },
): { command: VoiceCommand | null; text: string } {
	// Same candidate set and ordering as matchVoiceCommand, so the two can never disagree
	// about what a word means.
	const candidates: VoiceCommand[] = state?.muted ? ["unmute", "exit"] : ["exit", "repeat", "mute"];
	const norm = normalizeTranscript(text);

	// The turn IS the command → nothing to send.
	for (const cmd of candidates) {
		if (commandPhrases(cmd, words, lang).some((p) => normalizeTranscript(p) === norm)) {
			return { command: cmd, text: "" };
		}
	}

	// A command phrase at the END → act on it and keep what came before. Restricted to
	// MULTI-WORD phrases, deliberately: `phraseMatchesTranscript` already refuses to fire a
	// single-word command that isn't the whole utterance, precisely so ordinary speech isn't
	// hijacked, and stripping a trailing bare word would reintroduce that. "don't forget to
	// mute" must stay a message — silently truncating it AND muting is far worse than making
	// the user pause before saying a one-word command.
	for (const cmd of candidates) {
		const multiWord = commandPhrases(cmd, words, lang).filter((p) => normalizeTranscript(p).includes(" "));
		if (!multiWord.length) continue;
		const stripped = stripStopWord(text, multiWord);
		if (stripped.ended && stripped.text.trim()) return { command: cmd, text: stripped.text };
	}
	return { command: null, text };
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
