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
	/** Timestamp (ms) the current turn started. */
	turnStart: number;
	/** Has genuine speech (not room noise) been heard this turn? */
	seen: boolean;
}

export function initVad(): VadState {
	return { peak: 0, lastLoud: 0, turnStart: 0, seen: false };
}

export interface VadConfig {
	/** Quiet duration (ms) after which the turn ends. */
	silenceMs: number;
	/** Mic sensitivity (0.4–2): higher keeps softer tails / quiet mics; lower cuts
	 *  sooner (noisy rooms). */
	sensitivity: number;
	/** Hard cap (ms) so a turn can never hang forever. Default 25s. */
	maxTurnMs?: number;
}

/** Minimum peak to count as real speech rather than room noise. */
const VOICE_FLOOR = 0.05;

/**
 * Advance the VAD by one audio frame (mutates `s`). Returns `"end"` when the turn
 * should stop (→ transcribe + send), else `null`.
 */
export function vadStep(s: VadState, level: number, now: number, cfg: VadConfig): "end" | null {
	s.peak = Math.max(s.peak, level);
	const heardVoice = s.peak > VOICE_FLOOR;
	// Fraction of your peak that still counts as "speaking" — smaller = more forgiving.
	const speakFrac = 0.35 / Math.max(0.4, cfg.sensitivity);
	const speaking = level > s.peak * speakFrac;
	if (heardVoice && speaking) {
		s.lastLoud = now;
		if (!s.seen) { s.seen = true; s.turnStart = now; }
	}
	if (!s.seen) return null; // no real speech yet — nothing to end
	if (now - s.lastLoud > cfg.silenceMs) return "end"; // a real pause
	// Safety cap — applies even while still "speaking", so a stuck-loud mic (or a
	// very long monologue) can never hang the turn forever.
	if (now - s.turnStart > (cfg.maxTurnMs ?? 25_000)) return "end";
	return null;
}
