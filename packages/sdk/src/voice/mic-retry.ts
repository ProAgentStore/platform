/**
 * What a background recognizer should do after the browser ended its session (#425).
 *
 * PAGS runs THREE consumers over one microphone — the main recognizer, the dictation gate, and
 * the always-on control listener — and two of them re-arm themselves on every `onend`. Chrome
 * ends a continuous recognizer after a short silence, so "re-arm on end" is the correct and
 * necessary behaviour for the ordinary case: without it the control listener would stop watching
 * and mute-by-voice would not exist while the agent speaks (#153, ADR 0001 M1).
 *
 * The defect is what happens when the restart CANNOT succeed. Both loops restarted at the
 * browser's own cycle rate with no delay and no memory, so a device that refuses produces
 * `error → end → start → error` as fast as Chrome will cycle it — and Chrome activates the
 * microphone on every `start()`. That is a hot loop against a device another consumer of the same
 * page is in the middle of releasing, and against a non-persistent permission grant it is one
 * prompt per restart.
 *
 * Production, 2026-08-08 → 08-11: 20 `client:voice-control` rows reading
 * `control listener refused the microphone: audio-capture`, ten of them inside one 94-minute
 * window. `reportClientError` de-dups an identical message to one row per 30s, so those rows are
 * a floor on the number of failures, not a count of them — which is why {@link MicErrorDetail}
 * exists: the counter is the measurement that says whether a row is a spin or a scatter.
 *
 * ## Why backoff, and not a latch
 *
 * Latching the control listener off on `audio-capture` would delete mute-by-voice for the rest of
 * the session, which is the exact ADR 0001 M1 failure #425 was opened to EXPOSE. `audio-capture`
 * is not a verdict; it is "the audio did not arrive", which two recognizers contending for one
 * device produce routinely at a turn boundary. So the answer is neither "stop" nor "spin": keep
 * trying, and slow down. The first retry is 400ms — under the time it takes a MediaRecorder's
 * tracks to be released, so the common transient is invisible — doubling to an 8s ceiling, which
 * is one probe per 8s for a genuinely absent device instead of a continuous mic activation.
 *
 * A PERMISSION verdict is different in kind: it will not resolve by trying again, and the caller
 * has a notice to show. That one is terminal.
 */

import { isMicPermissionDenied } from "./convo.js";

/** First retry delay. Chosen under the release latency of a MediaRecorder's tracks, so a
 *  turn-boundary contention costs one silent retry rather than a visible gap in the control
 *  channel. */
export const MIC_RETRY_BASE_MS = 400;
/** Ceiling. A device that is simply not there gets probed this often — enough to recover within
 *  seconds of it coming back, rare enough that it is not a mic activation storm. */
export const MIC_RETRY_MAX_MS = 8_000;
/**
 * Consecutive failures before the user is told the control channel is down.
 *
 * At the delays above the 4th failure is ~6s into a burst, so a turn-boundary transient (one or
 * two) never nags, and a real outage is named while the user is still wondering why nothing
 * happened. Deliberately an equality test at the call site rather than `>=`: the counter resets
 * on recovery, so this fires once per burst instead of once per retry.
 */
export const MIC_CONTENTION_NOTICE_AFTER = 4;

/**
 * What the caller learns alongside the error code.
 *
 * `fails` is the consecutive-failure counter and is the number the durable log was missing: with
 * de-dup at one row per 30s, `fails: 2` and `fails: 240` are the same single row and mean
 * completely different things about the user's machine.
 */
export interface MicErrorDetail {
	/** Consecutive non-benign errors over the device, reset by proof of capture. */
	fails: number;
	/** Milliseconds since the first failure of this burst (0 on the first). */
	burstMs: number;
}

/**
 * How long a quiet gap has to be before the next failure counts as a NEW burst rather than a
 * continuation of the last one.
 *
 * Without a gap rule a run only ever grows, so the fourth failure of a session shows the
 * contention notice even if the three before it were hours ago and the device has worked since.
 * 30s is the durable log's own de-dup window, which makes `fails` and the row count answer the
 * same question over the same period.
 */
export const MIC_BURST_GAP_MS = 30_000;

/**
 * The failure run over the DEVICE — the state {@link planMicRestart} escalates and the durable row
 * reports.
 *
 * It is a value rather than a pair of counters in a recognizer's closure because of what shipping
 * it the other way cost. Both re-arming loops held their own `micFails` and cleared it on
 * {@link isBenignRecognizerEnd} — which includes `aborted`, the code a DELIBERATE `stop()` raises.
 * Every turn boundary stops both background recognizers, and turn boundaries are exactly where the
 * contention lives, so the run was zeroed by the very event that preceded the failure. Production
 * after the backoff shipped: eleven `client:voice-gate` rows over eleven minutes, then a separate
 * `not-allowed` row one second after the last of them — and every one of them, including the
 * standalone row that cannot have been collapsed with anything, reads `fails: 1, burstMs: 0`. The
 * backoff was real code that could never leave its 400ms floor.
 *
 * So the two questions are now separate, and only one of them reads the error code:
 *
 *  - **How long to wait before re-arming?** {@link planMicRestart}, from the code. Unchanged, and
 *    still instant for `no-speech`/`aborted` — a delay there is a gap in mute-by-voice (ADR 0001
 *    M1).
 *  - **Is the run over?** Only PROOF OF CAPTURE answers that: the UA reporting `audiostart`, or a
 *    transcript arriving. A code is not evidence about a device; `aborted` in particular is
 *    evidence about nothing at all, because we are the ones who raised it.
 */
export interface MicFailureRun {
	/** Consecutive failures since the last proof of capture (or the last {@link MIC_BURST_GAP_MS}
	 *  of quiet). */
	fails: number;
	/** When the run began — epoch ms, 0 when there is no run. */
	startedAt: number;
	/** The most recent failure — epoch ms, 0 when there is no run. */
	lastAt: number;
}

/** No failures: what a fresh consumer starts with, and what proof of capture returns it to. */
export const NO_MIC_FAILURES: MicFailureRun = { fails: 0, startedAt: 0, lastAt: 0 };

/** Fold one more failure into the run, starting a fresh burst after a long enough gap. */
export function noteMicFailure(run: MicFailureRun, now: number): MicFailureRun {
	if (run.fails === 0 || now - run.lastAt > MIC_BURST_GAP_MS) return { fails: 1, startedAt: now, lastAt: now };
	return { fails: run.fails + 1, startedAt: run.startedAt, lastAt: now };
}

/** The run in the shape the durable row carries. */
export function micErrorDetail(run: MicFailureRun, now: number): MicErrorDetail {
	return { fails: run.fails, burstMs: run.startedAt ? now - run.startedAt : 0 };
}

export interface MicRestartPlan {
	/** Re-arm the recognizer at all? False only for a permission verdict. */
	restart: boolean;
	/** How long to wait first. 0 for the ordinary silence-ended cycle — that path must stay
	 *  instant, because a gap there is a gap in mute-by-voice. */
	delayMs: number;
	/** The recognizer is done until the user changes something; hand control back to the owner
	 *  (its `onEnd`) so the latch and the notice can run. */
	terminal: boolean;
}

/**
 * Is this the ordinary churn a continuous background recognizer produces, rather than a failure?
 *
 * `no-speech` is Chrome saying the silence timer elapsed — the single most common event in the
 * control listener's life. `aborted` is what a deliberate `stop()`/`abort()` raises. Neither says
 * anything about the device, so neither may slow the re-arm down or count toward the notice.
 */
export function isBenignRecognizerEnd(code: string | null | undefined): boolean {
	return !code || code === "no-speech" || code === "aborted";
}

/** Backoff for the nth consecutive failure (1-based): 400, 800, 1600, 3200, 6400, then 8000. */
export function micRetryDelayMs(consecutiveFailures: number): number {
	if (consecutiveFailures <= 0) return 0;
	return Math.min(MIC_RETRY_BASE_MS * 2 ** (consecutiveFailures - 1), MIC_RETRY_MAX_MS);
}

/** Should the user be told the control channel is down, on this failure? */
export function shouldAnnounceMicContention(consecutiveFailures: number): boolean {
	return consecutiveFailures === MIC_CONTENTION_NOTICE_AFTER;
}

/**
 * The verdict, given the code that ended the session and how many times in a row it has failed.
 *
 * Pure and shared by both re-arming loops (`VoiceStt`'s browser recognizer and the speech gate),
 * because they had drifted: the gate reported nothing for `audio-capture` while the control
 * listener did, and both spun at the same rate for the same reason. One planner is what keeps a
 * later change to either one from re-opening the other.
 */
export function planMicRestart(s: { code: string | null | undefined; consecutiveFailures: number }): MicRestartPlan {
	if (isMicPermissionDenied(s.code)) return { restart: false, delayMs: 0, terminal: true };
	if (isBenignRecognizerEnd(s.code)) return { restart: true, delayMs: 0, terminal: false };
	return { restart: true, delayMs: micRetryDelayMs(s.consecutiveFailures), terminal: false };
}
