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
	 *  `idle` = waiting for the user (neutral). */
	tone: "work" | "live" | "idle";
	/** Show a spinner (vs a mic glyph). */
	spin: boolean;
	/** Tappable — toggles a manual talk turn (Tap-to-talk). */
	tap: boolean;
}

/**
 * Resolve the single, always-visible voice-status pill so the user ALWAYS knows what's
 * happening after they finish speaking — Listening → Transcribing → Working — instead
 * of silence until the reply lands. Pure so this branchy presentation logic is tested.
 * `null` means show nothing (idle text chat). `thinking` (agent generating) wins in
 * every mode, so even text chat shows "Working on it…".
 */
export function resolveVoiceStatus(input: {
	mode: VoiceMode;
	thinking: boolean;
	transcribing: boolean;
	talking: boolean;
	listening: boolean;
	/** Hands-free mic paused via Mute — the pill must not claim it's listening. */
	muted?: boolean;
}): VoiceStatus | null {
	const { mode, thinking, transcribing, talking, listening, muted } = input;
	if (thinking) return { label: "Working on it…", tone: "work", spin: true, tap: false };
	if (mode === "text") return null;
	if (transcribing) return { label: "Transcribing…", tone: "work", spin: true, tap: false };
	if (talking) return { label: "Listening — tap to send", tone: "live", spin: false, tap: true };
	if (mode === "ptt") return { label: "Tap to talk", tone: "idle", spin: false, tap: true };
	// hands-free
	if (muted) return { label: "Muted", tone: "idle", spin: false, tap: false };
	return listening
		? { label: "Listening…", tone: "live", spin: false, tap: false }
		: { label: "Hands-free — just talk", tone: "idle", spin: false, tap: false };
}

/** A spoken command the hook acts on locally instead of sending as a chat message. */
export type VoiceCommand = "repeat";

/**
 * Detect a hands-free voice COMMAND in a finished transcript. Right now just
 * "repeat" (+ common phrasings) → re-speak the agent's last reply. Matches only when
 * the whole utterance IS the command (trailing punctuation ignored), so a normal
 * sentence that merely contains the word isn't hijacked.
 */
export function matchVoiceCommand(text: string): VoiceCommand | null {
	// Whisper punctuates transcripts, so strip punctuation + collapse spaces before
	// matching (e.g. "Repeat, please." → "repeat please").
	const t = text.toLowerCase().replace(/[.,!?]/g, "").replace(/\s+/g, " ").trim();
	if (/^(repeat|repeat (that|it|again|please)|say (that |it )?again|again please|come again|pardon|what did you say)$/.test(t)) {
		return "repeat";
	}
	return null;
}
