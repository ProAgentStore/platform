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
	if (speaking) return { label: "Speaking…", tone: "speak", spin: false, tap: false, icon: "speak" };
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
export type VoiceCommand = "repeat";

/**
 * "Repeat" phrasings in the languages the platform's voice stack supports (the
 * voice-settings Language list). Whole-utterance matches only — high precision,
 * so a real sentence containing the word is never hijacked. Kept as plain lists
 * (not regex) so adding a language is data, not syntax.
 */
const REPEAT_PHRASES = new Set([
	// English
	"repeat", "repeat that", "repeat it", "repeat again", "repeat please",
	"say again", "say that again", "say it again", "again please", "come again",
	"pardon", "what did you say",
	// Chinese (Mandarin)
	"再说一遍", "再说一次", "重复一遍", "再来一遍",
	// Spanish (¿? stripped below)
	"repite", "repítelo", "otra vez", "qué dijiste",
	// French
	"répète", "répétez", "encore une fois",
	// German
	"wiederhole", "nochmal", "wie bitte",
	// Italian
	"ripeti", "un'altra volta",
	// Portuguese
	"repita", "de novo",
	// Japanese
	"もう一度", "もう一回",
	// Korean
	"다시", "다시 말해줘", "다시 말해 줘",
	// Hindi
	"फिर से कहो", "दोबारा कहो",
]);

/**
 * Detect a hands-free voice COMMAND in a finished transcript. Right now just
 * "repeat" (+ common phrasings, in every supported voice language) → re-speak the
 * agent's last reply. Matches only when the whole utterance IS the command
 * (punctuation ignored), so a normal sentence that merely contains it isn't hijacked.
 */
export function matchVoiceCommand(text: string): VoiceCommand | null {
	// Whisper punctuates transcripts, so strip punctuation (Latin + CJK + inverted
	// Spanish marks) + collapse spaces before matching ("Repeat, please." / "再说一遍。").
	const t = text
		.toLowerCase()
		.replace(/[.,!?¿¡。，！？、]/g, "")
		.replace(/\s+/g, " ")
		.trim();
	return REPEAT_PHRASES.has(t) ? "repeat" : null;
}
