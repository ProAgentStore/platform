/**
 * Voice-activity detection (end-of-turn) — extracted as a PURE function so the
 * delicate, frequently-regressed "did the user stop talking?" logic is unit-tested
 * without a real mic / AudioContext.
 *
 * Whisper has no streaming results, so hands-off mode detects the end of a turn
 * from the mic level itself. Silence is judged RELATIVE to how loud YOU were this
 * turn (the peak, no decay) — not an absolute threshold — so it works at any volume
 * or mic noise floor. A too-high fixed threshold left noisy mics "stuck listening".
 */

export interface VadState {
	/** Loudest mic level this turn (0–1), no decay. */
	peak: number;
	/** Timestamp (ms) speech was last heard. */
	lastLoud: number;
	/** Timestamp (ms) the current turn started (first frame). `-1` until set. */
	turnStart: number;
	/** Has genuine speech (not room noise) been heard this turn? */
	seen: boolean;
}

export function initVad(): VadState {
	return { peak: 0, lastLoud: 0, turnStart: -1, seen: false };
}

export interface VadConfig {
	/** Quiet duration (ms) after which the turn ends. */
	silenceMs: number;
	/** Mic sensitivity (0.4–2): higher keeps softer tails / quiet mics; lower cuts
	 *  sooner (noisy rooms). */
	sensitivity: number;
	/** Hard cap (ms) so a spoken turn can never hang forever. Default 25s. */
	maxTurnMs?: number;
	/** No-speech cap (ms): if the mic sits open and NOTHING is said, recycle the
	 *  (silent) recording after this long so its buffer can't grow unbounded while
	 *  you think — otherwise a long pause before replying uploads a huge mostly-silent
	 *  blob to Whisper (slow). Default 15s. */
	idleMs?: number;
}

/** Minimum peak to count as real speech rather than room noise. */
const VOICE_FLOOR = 0.05;

/**
 * Should the automatic end-of-turn VAD run this frame? Only in Whisper hands-free, and
 * NOT while the agent is thinking, the mic is muted, or the user is holding the floor
 * via a manual push-to-talk turn (they control that boundary — the VAD must not cut
 * them off mid-sentence, which is exactly the failure that sent a half-formed turn).
 * Pure so the guard can't silently regress (it gates a delicate, high-blast-radius path).
 */
export function shouldAutoDetectEndOfTurn(f: {
	isWhisper: boolean;
	paused: boolean;
	muted: boolean;
	manualTalk: boolean;
}): boolean {
	return f.isWhisper && !f.paused && !f.muted && !f.manualTalk;
}

/**
 * Advance the VAD by one audio frame (mutates `s`). Returns:
 *  - `"end"`  — real speech finished (→ stop, transcribe, send)
 *  - `"idle"` — mic open but nothing said for `idleMs` (→ discard + recycle)
 *  - `null`   — keep listening
 */
export function vadStep(s: VadState, level: number, now: number, cfg: VadConfig): "end" | "idle" | null {
	if (s.turnStart < 0) s.turnStart = now; // first frame of this listen
	s.peak = Math.max(s.peak, level);
	const heardVoice = s.peak > VOICE_FLOOR;
	// Fraction of your peak that still counts as "speaking" — smaller = more forgiving.
	const speakFrac = 0.35 / Math.max(0.4, cfg.sensitivity);
	const speaking = level > s.peak * speakFrac;
	if (heardVoice && speaking) {
		s.lastLoud = now;
		if (!s.seen) s.seen = true;
	}
	if (!s.seen) {
		// Nothing said yet — recycle the silent recorder after idleMs (no Whisper
		// upload) so a long think before replying can't grow the buffer without bound.
		if (now - s.turnStart > (cfg.idleMs ?? 15_000)) return "idle";
		return null;
	}
	if (now - s.lastLoud > cfg.silenceMs) return "end"; // a real pause
	// Safety cap — applies even while still "speaking", so a stuck-loud mic (or a
	// very long monologue) can never hang the turn forever.
	if (now - s.turnStart > (cfg.maxTurnMs ?? 25_000)) return "end";
	return null;
}
