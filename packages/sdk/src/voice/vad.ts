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
	/**
	 * Adaptive per-turn ambient noise floor, estimated from the MINIMUM level across the first
	 * `NOISE_SAMPLE_FRAMES` frames. Speech onset must exceed `NOISE_ONSET_RATIO × noiseFloor`
	 * (floored at `VOICE_FLOOR`) before `seen` is set. This prevents a steady HVAC/fan hum at
	 * 0.10–0.15 RMS from registering as speech — the old fixed `VOICE_FLOOR = 0.1` was reachable
	 * by room tone, setting `seen = true` so a speechless clip reached Whisper.
	 *
	 * Using MINIMUM rather than average: the minimum of N speech-inclusive frames reflects
	 * brief within-speech dips and is typically well above zero, so `VOICE_FLOOR` remains the
	 * effective floor (no regression). The minimum of pure steady ambient noise equals the
	 * ambient level itself — which, when multiplied by `NOISE_ONSET_RATIO`, raises the bar.
	 *
	 * `-1` while still sampling (not yet computed); `VOICE_FLOOR` is the fallback until then.
	 */
	noiseFloor: number;
	/** Running minimum across frames collected so far in the noise-estimation window. */
	noiseMin: number;
	/** Number of frames collected so far into the noise estimate. */
	noiseFrames: number;
}

export function initVad(): VadState {
	return { peak: 0, lastLoud: 0, turnStart: -1, seen: false, noiseFloor: -1, noiseMin: Infinity, noiseFrames: 0 };
}

/**
 * Number of frames sampled to estimate the per-turn ambient noise floor. The MINIMUM level across
 * these frames is used as the floor estimate. The adaptive onset check is withheld until this
 * window closes so ambient frames fill the estimate before onset can fire. During that window,
 * levels at or above `HIGH_SPEECH_THRESHOLD` immediately trigger onset as "user started speaking
 * before the mic fully opened" — no regression for the common pattern where the user speaks within
 * a second or two of the chime.
 *
 * **This window is ~83ms, not the ~330ms this comment used to claim.** It said "at 66ms/frame
 * (LEVEL_THROTTLE_MS in use-voice.ts)", but `LEVEL_THROTTLE_MS` throttles only the React
 * `setAudioLevel` call; `vadStep` is invoked on EVERY `requestAnimationFrame` tick, so five frames
 * is five sixtieths of a second. That matters in one direction: the fewer frames a minimum is
 * taken over, the more likely it lands on a loud one, so a SHORT window is the one that mistakes
 * the leading edge of your own voice for the room. A longer window can only ever lower the
 * estimate. It is left at 5 because {@link ONSET_FLOOR_CEILING} now bounds what a poisoned
 * estimate can cost, and because lengthening it delays onset past the end of a one-word answer.
 */
export const NOISE_SAMPLE_FRAMES = 5;
/** Speech onset must be at least this many times the measured noise floor before the VAD
 *  treats the turn as "real speech started". At ratio 3: ambient at 0.08 → onset
 *  threshold 0.24; quiet room at 0.02 → threshold 0.06, effective floor stays VOICE_FLOOR. */
export const NOISE_ONSET_RATIO = 3;
/**
 * If the noise-floor minimum collected during the sampling window is at or above this
 * level, the input is treated as speech that started before the window closed — the
 * adaptive floor falls back to VOICE_FLOOR and onset fires normally. Without this
 * fallback, a user who starts talking the instant the mic opens would be caught in the
 * sampling window and fail the adaptive onset check (noiseFloor ≈ their own speech
 * level → onset threshold = 3× speech level → speech never clears).
 *
 * 0.2 separates typical unambiguous speech peaks (~0.2–0.5) from ambient noise below
 * VOICE_FLOOR (0.05–0.08) and the ambiguous HVAC/noisy-room zone (0.08–0.18, which the
 * adaptive floor handles). Tuned so: ambient 0.12 → adaptive (fixed), speech 0.3 → VOICE_FLOOR.
 */
export const HIGH_SPEECH_THRESHOLD = 0.2;

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

/** Minimum peak (0–1 RMS) to count as real speech rather than room noise. Conservative on
 *  purpose: typical room/keyboard/fan noise sits around ~0.05–0.08, so a floor below that let
 *  background noise register as speech — which (a) triggered transcription of nothing and
 *  (b) kept steady noise "speaking" so the turn never ended (the mic-never-stops bug). Real
 *  speech peaks well above this (~0.15–0.4). Users who need to pick up a very soft voice raise
 *  Mic sensitivity. */
export const VOICE_FLOOR = 0.1;

/**
 * Did this recording contain actual speech, or only room tone?
 *
 * Load-bearing against a specific, real failure: silence uploaded to Whisper does not come back
 * empty — with a vocabulary `prompt` attached, the decoder CONTINUES THE PROMPT and returns a
 * fluent, domain-plausible sentence. A real conversation logged "I just need to refactor this
 * function before I commit the changes to the repo" as a user message, assembled entirely out of
 * the coding term list. In hands-free that is auto-sent to an agent holding `start_work`, so a
 * hallucination can start real work.
 *
 * `vadStep` already tracks this as `seen`, but it only runs in hands-free — tap-to-talk
 * deliberately disables the auto-VAD so it can't cut you off mid-thought, which left that mode
 * with no speech gate at all. This is the mode-independent check.
 *
 * @param peakLevel   Loudest mic level seen during the recording (0–1).
 * @param noiseFloor  Per-turn adaptive noise floor from `VadState.noiseFloor`, or the fixed
 *                    `VOICE_FLOOR` fallback when the VAD state is not available (e.g. tap-to-talk).
 *                    The speech threshold is `max(VOICE_FLOOR, NOISE_ONSET_RATIO * noiseFloor)`,
 *                    so a noisy room raises the bar while a quiet room still uses the fixed floor.
 */
export function hadSpeech(peakLevel: number, noiseFloor = -1): boolean {
	return peakLevel > onsetFloorFor(noiseFloor);
}

/**
 * THE speech threshold, in one place.
 *
 * `hadSpeech` (the onstop gate) and `vadStep` (the onset gate) both computed this expression
 * inline, and they are required to agree — two gates with two floors is how one mode transcribes
 * what the other discards. It is also the number a dropped turn has to be diagnosed WITH: the
 * durable log recorded neither the peak nor the floor, so "it didn't hear me" could only be
 * answered by reading the source. Exported so the drop rows can carry it (#510 criterion 5).
 *
 * `noiseFloor < 0` = the VAD has not sampled the room yet (tap-to-talk, or the first frames of a
 * turn) → the fixed floor, unchanged.
 */
export function onsetFloorFor(noiseFloor: number): number {
	if (!(noiseFloor >= 0)) return VOICE_FLOOR;
	return Math.min(ONSET_FLOOR_CEILING, Math.max(VOICE_FLOOR, NOISE_ONSET_RATIO * noiseFloor));
}

/**
 * The adaptive floor may never rise above this (#511).
 *
 * `NOISE_ONSET_RATIO * noiseFloor` was unbounded, and the file contradicted itself as a result: at
 * ambient 0.08 — an ordinary room with a fan — the floor became 0.24, while forty lines up this
 * same file defines 0.2–0.5 as "typical unambiguous speech peaks". A shipped, passing test
 * (`vad.test.ts`, before this change) asserted that a clip peaking at 0.2 was thrown away. Quiet
 * speech, a distant mic, or a laptop fan put a real utterance under the bar, and the turn then took
 * the silent idle-recycle path. A gate that discards what its own definition calls speech is not
 * strict, it is wrong.
 *
 * 0.18 is chosen to sit strictly BELOW the bottom of that stated band, with margin, so a peak
 * anywhere in 0.2–0.5 clears the floor in ANY room. The protection #490 was opened for survives
 * intact: steady room tone at 0.12 peaks around 0.13 and is still rejected.
 *
 * The band this knowingly cannot resolve is 0.15–0.18 — the file's other comment puts the bottom
 * of real speech at ~0.15, and room tone reaches ~0.13, so peak energy alone genuinely cannot
 * separate them. That gap is not closed by moving this number; moving it down re-admits the
 * phantoms and moving it up eats speech. It is closed by evidence of a different kind, which is
 * why `planClipGate` lets a proven-alive dictation gate that heard real words overrule this floor
 * outright (#511 criterion 4).
 */
export const ONSET_FLOOR_CEILING = 0.18;

/** What the analyser measured over one recording, as the drop paths report it. */
export interface LevelSnapshot {
	/** Loudest level seen (0–1), or 0 when {@link LevelSnapshot.frames} is 0. */
	peakLevel: number;
	/** The per-turn adaptive floor estimate, `-1` when never sampled. */
	noiseFloor: number;
	/** What {@link onsetFloorFor} made of it — the number the peak was actually judged against. */
	onsetFloor: number;
	/** How many frames the analyser delivered. **0 means no data**, not silence. */
	frames: number;
}

/** The dictation gate's answer to "did real words happen this turn?" — structurally the same
 *  reading `turn.ts` passes to `planNoiseRejection`, declared here so this module stays free of
 *  the transcript/command layer. */
type GateEvidence = { isAlive: boolean; heardSpeech: boolean } | null | undefined;

export type ClipVerdict = {
	action: "transcribe" | "discard";
	/** Why, in a form a log row can carry. */
	reason: "speech" | "gate-vouched" | "no-speech" | "no-data";
};

/**
 * Does this finished recording get uploaded? (#510 criteria 3 + 4, #511 criterion 4.)
 *
 * Three inputs, and the whole point is that they are not interchangeable:
 *
 *  - **`frames === 0` is NOT silence.** It is the absence of a measurement. `noteLevel` has one
 *    caller — a `requestAnimationFrame` tick — and rAF does not run for a document that is not
 *    `visible`. So a minimised console produces zero frames for a clip full of speech. #490 read
 *    zero peak as "no speech" and discarded it, inverting the contract the comment it replaced
 *    stated out loud: *"a caller with no analyser keeps working rather than going silently deaf"*.
 *    With no energy evidence the gate is the only witness, and where there is no witness either,
 *    an unknown clip is uploaded — that is the pre-#490 behaviour, and it fails toward the user's
 *    words surviving rather than toward silence.
 *  - **A proven-alive gate that heard words outranks the energy heuristic.** Web Speech returning
 *    real text is direct evidence of speech; a peak under a floor is an inference about it. This
 *    is the same precedence `planNoiseRejection` already applies at the other end of the turn.
 *  - **A gate that never ran vouches for nothing** — in either direction. It cannot condemn a
 *    clip and it cannot save one.
 */
export function planClipGate(s: { frames: number; peakLevel: number; noiseFloor: number; gate?: GateEvidence }): ClipVerdict {
	const vouched = !!s.gate?.isAlive && s.gate.heardSpeech;
	const condemned = !!s.gate?.isAlive && !s.gate.heardSpeech;
	if (s.frames === 0) {
		// No analyser data. Only the gate can decide, and only when it is alive.
		return condemned ? { action: "discard", reason: "no-speech" } : { action: "transcribe", reason: "no-data" };
	}
	if (vouched) return { action: "transcribe", reason: "gate-vouched" };
	return hadSpeech(s.peakLevel, s.noiseFloor)
		? { action: "transcribe", reason: "speech" }
		: { action: "discard", reason: "no-speech" };
}

/**
 * Which clip-gate verdicts earn a durable row, and what it says (#510 criterion 2).
 *
 * Two of the four, because the other two are the system working. A **discard** is the user's words
 * gone with nothing else on any surface to show a turn was ever taken. A **`no-data` transcribe**
 * is a clip judged with no measurement at all — the backgrounded-tab signature — and it is worth a
 * row precisely BECAUSE it now succeeds: the failure it replaces was invisible, and so is the fix
 * unless it says so. Fixed strings, because `reportClientError` de-dups on source+message.
 */
export function clipGateReport(v: ClipVerdict): string | null {
	if (v.action === "discard") return "clip discarded before upload — the speech gate heard nothing";
	if (v.reason === "no-data") return "clip uploaded unmeasured — the analyser delivered no frames (hidden tab?)";
	return null;
}

/**
 * The context every voice drop row carries (#510 criterion 5).
 *
 * Rows used to carry only `{code}` / `{transcript,path}` / `{sttWhisper}` — enough to know a turn
 * was lost, never enough to know why, so "sometimes it doesn't hear me" was answerable only by
 * reading the source and inventing the inputs. These are the ENTIRE input set of the speech gate:
 * what was measured, what it was measured against, how many frames there were (0 = no analyser
 * data, NOT silence), and whether the recognizer heard words anyway. Null where the recorder or
 * the gate does not exist, which is itself the answer to a different question.
 */
export function captureDiagnostics(snapshot: LevelSnapshot | undefined, gate: GateEvidence): Record<string, unknown> {
	return { ...(snapshot ?? {}), gateAlive: gate?.isAlive ?? null, gateHeardSpeech: gate?.heardSpeech ?? null };
}

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
 *
 * Adaptive onset: the first `NOISE_SAMPLE_FRAMES` frames (before `seen` is ever set) are
 * used to estimate the per-turn ambient noise floor. Speech onset (`seen`) is only
 * triggered when the level exceeds `NOISE_ONSET_RATIO × noiseFloor` AND the peak-relative
 * speaking check, so steady room noise cannot set `seen = true` and trigger a Whisper
 * upload. The adaptive floor only gates ONSET — once speech has started, `lastLoud`
 * updates follow the original peak-relative logic (unchanged behaviour post-onset).
 */
export function vadStep(s: VadState, level: number, now: number, cfg: VadConfig): "end" | "idle" | null {
	if (s.turnStart < 0) s.turnStart = now; // first frame of this listen
	s.peak = Math.max(s.peak, level);

	// ── Adaptive noise-floor estimation (pre-onset window only) ────────────────
	// While speech has not yet been detected, collect ambient levels so we can set
	// a per-turn onset threshold. Once `seen` is true the window is closed (the
	// user is speaking and the floor has already been established).
	if (!s.seen && s.noiseFrames < NOISE_SAMPLE_FRAMES) {
		if (level < s.noiseMin) s.noiseMin = level;
		s.noiseFrames += 1;
		if (s.noiseFrames === NOISE_SAMPLE_FRAMES) {
			// Use the minimum, not the average, so a brief within-speech dip doesn't
			// inflate the floor. The minimum of pure room-tone frames = ambient level.
			s.noiseFloor = s.noiseMin === Infinity ? 0 : s.noiseMin;
		}
	}

	// Fraction of your peak that still counts as "speaking" — smaller = more forgiving.
	const speakFrac = 0.35 / Math.max(0.4, cfg.sensitivity);
	const speaking = level > s.peak * speakFrac;

	if (!s.seen) {
		// ONSET GATE (adaptive): before the first real word is heard, require the
		// instantaneous level to exceed NOISE_ONSET_RATIO × the measured noise floor
		// (or VOICE_FLOOR when the floor hasn't been sampled yet). This prevents steady
		// ambient sound — which CAN pass the peak-relative `speaking` check — from
		// setting `seen = true` and letting a speechless clip reach Whisper.
		//
		// The onset check is withheld during the sampling window (first NOISE_SAMPLE_FRAMES
		// frames) so ambient levels fill the estimate first. Exception: if the minimum
		// collected so far is already at HIGH_SPEECH_THRESHOLD or above, the input is
		// treated as speech that started before the mic was fully open — no regression for
		// users who speak immediately on the listening chime.
		const earlyHigh = s.noiseMin >= HIGH_SPEECH_THRESHOLD; // user was already speaking
		if (s.noiseFrames >= NOISE_SAMPLE_FRAMES || earlyHigh) {
			// When the minimum is high (speech started early), fall back to VOICE_FLOOR so
			// the onset behaves exactly as before this change. Otherwise use the adaptive floor.
			const onsetFloor = earlyHigh ? VOICE_FLOOR : onsetFloorFor(s.noiseFloor);
			if (level > onsetFloor && speaking) {
				s.seen = true;
				s.lastLoud = now;
			}
		}
		// Nothing said yet — recycle the silent recorder after idleMs (no Whisper
		// upload) so a long think before replying can't grow the buffer without bound.
		if (now - s.turnStart > (cfg.idleMs ?? 15_000)) return "idle";
		return null;
	}

	// ── Post-onset: original peak-relative logic (unchanged) ────────────────────
	// heardVoice: is the PEAK above the voice floor? Always true once real speech has
	// been seen (peak ratchets up, never drops). Keeps `lastLoud` updating through the
	// speech tail so sensitivity changes don't truncate turns already in progress.
	const heardVoice = s.peak > VOICE_FLOOR;
	if (heardVoice && speaking) s.lastLoud = now;

	if (now - s.lastLoud > cfg.silenceMs) return "end"; // a real pause
	// Safety cap — applies even while still "speaking", so a stuck-loud mic (or a
	// very long monologue) can never hang the turn forever.
	if (now - s.turnStart > (cfg.maxTurnMs ?? 25_000)) return "end";
	return null;
}
