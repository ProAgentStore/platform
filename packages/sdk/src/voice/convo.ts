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
