/**
 * The voice interaction as an EXPLICIT model — the pure, testable core that `use-voice.ts`
 * (the browser/React glue) drives. Every voice bug we've hit — self-transcription, phantom
 * sends on silence, "Working" with no input, a mic that reopened mid-reply — was the same
 * class: one of the cross-cutting guards (echo tail, paused-for-reply, muted, the dictation
 * gate) getting out of sync because the decision was re-derived inline in 4–5 different
 * places from ~200 scattered `ref.current` reads.
 *
 * This module makes those decisions ONE way, from ONE explicit state snapshot, so a fix (or
 * a test) lives in a single place and the call sites can't drift. It has no React and no
 * browser dependency, so it's exhaustively unit-tested (see machine.test.ts).
 */

import type { VoiceMode } from "./convo.js";

/** How long after the agent stops speaking the mic still ignores input (speaker echo/reverb). */
export const ECHO_GUARD_MS = 800;

/**
 * What the interaction is doing right now — the single enum that replaces the tangle of
 * booleans (micOn/talking/convoOn/speakOn/muted/paused/speaking). `processing` = a turn was
 * sent and we're awaiting the agent's reply.
 */
export type VoicePhase = "idle" | "listening" | "transcribing" | "processing" | "speaking" | "muted";

/** The guard-relevant runtime state, assembled once per decision (not re-read piecemeal). */
export interface VoiceGuardState {
	/** The agent's TTS is playing right now. */
	ttsSpeaking: boolean;
	/** Epoch ms when the agent last STOPPED speaking — origin of the echo-tail window. */
	speakEndedAt: number;
	/** A turn was sent (or teardown is in progress) → the mic must not act on input. */
	paused: boolean;
	/** Hands-free mic paused by the user. */
	muted: boolean;
}

/**
 * Inside the agent's speech OR its ~0.8s echo tail? While true the mic must NOT end a turn
 * (the amplitude VAD) or act on a result — it would be capturing the agent's own voice.
 */
export function isEchoing(s: Pick<VoiceGuardState, "ttsSpeaking" | "speakEndedAt">, now: number, echoMs = ECHO_GUARD_MS): boolean {
	return s.ttsSpeaking || now - s.speakEndedAt < echoMs;
}

/**
 * Should a speech RESULT (from STT) be ignored right now? Yes while echoing (the agent's own
 * voice) or while paused (a turn is already in flight / teardown). This is the guard that,
 * duplicated inline, let the agent transcribe itself and reply to nothing.
 */
export function shouldIgnoreResult(s: VoiceGuardState, now: number, echoMs = ECHO_GUARD_MS): boolean {
	return isEchoing(s, now, echoMs) || s.paused;
}

/**
 * WHEN the audio behind a result was captured, relative to the pause that is currently
 * swallowing it. `shouldIgnoreResult` alone cannot tell the user's real turn from echo /
 * an abandoned turn, because `paused` means both "a reply is in flight" and "that reply
 * started while you were still talking" — same flag, two meanings (#175).
 */
export interface CaptureTiming {
	/** Epoch ms the capture that produced this result STARTED (0 = unknown). */
	captureStartedAt: number;
	/** Epoch ms the CURRENT pause began (0 = not paused / unknown). */
	pausedAt: number;
}

/**
 * What to do with an STT result: send it as a turn, hand it back to the user (their words,
 * but the conversation has moved on), or drop it.
 */
export type ResultVerdict = "accept" | "recover" | "ignore";

/**
 * Was this speech captured BEFORE the current pause began? Then it is the user talking —
 * an agent reply (or a mode switch) simply landed on top of it. Echo is the opposite shape:
 * its capture starts DURING the pause, because the agent was already speaking.
 *
 * Unknown timings (0) mean "can't prove it came first" → not recoverable, i.e. the guard's
 * existing behaviour. Under-stamping is therefore always safe.
 */
export function isLateTurn(s: CaptureTiming): boolean {
	return s.captureStartedAt > 0 && s.pausedAt > 0 && s.captureStartedAt < s.pausedAt;
}

/**
 * The one verdict for an incoming STT result (#175). `shouldIgnoreResult` used to be the
 * whole answer, and a turn transcribed while the agent started replying was dropped one line
 * before it would have been sent — the user's words vanished with nothing logged.
 *
 * "recover" is deliberately NOT "accept": the turn is real, but the conversation has moved on,
 * so it belongs in the composer (visible, editable, sendable by the human) rather than fired
 * blind into a thread that has changed since they spoke.
 */
export function classifyResult(s: VoiceGuardState & CaptureTiming, now: number, echoMs = ECHO_GUARD_MS): ResultVerdict {
	if (!shouldIgnoreResult(s, now, echoMs)) return "accept";
	return isLateTurn(s) ? "recover" : "ignore";
}

/** May the mic (re)open right now? No while a reply is in flight or the user muted. */
export function canOpenMic(s: Pick<VoiceGuardState, "paused" | "muted">): boolean {
	return !s.paused && !s.muted;
}

/**
 * At an amplitude-VAD end-of-turn: transcribe the clip, or discard it? Discard only when a
 * PROVEN-ALIVE browser-dictation gate heard no real words this turn (→ it was silence /
 * keyboard / background noise; uploading it makes Whisper hallucinate a phantom turn). A
 * gate that isn't alive (iOS, or a stalled recognizer) can never veto real speech.
 */
export function endOfTurnAction(gate: { isAlive: boolean; heardSpeech: boolean } | null | undefined): "transcribe" | "discard" {
	if (gate?.isAlive && !gate.heardSpeech) return "discard";
	return "transcribe";
}

/**
 * Derive the interaction phase from the observable signals, priority-ordered so the higher
 * ("busier") state always wins. `thinking` is owned by the consumer (the agent is
 * generating); everything else is owned by the voice hook. Kept consistent with the status
 * pill in convo.ts (resolveVoiceStatus is the *presentation* of this phase).
 */
export function derivePhase(s: {
	mode: VoiceMode;
	thinking: boolean;
	speaking: boolean;
	transcribing: boolean;
	micOn: boolean;
	muted: boolean;
}): VoicePhase {
	if (s.thinking) return "processing";
	if (s.speaking) return "speaking";
	if (s.mode === "text") return "idle";
	if (s.transcribing) return "transcribing";
	// Muted is reported in ANY voice mode, not just hands-free (#228). The mute VOICE command
	// is reachable in tap-to-talk too (the control listener runs whenever `speakOn`), but the
	// Mute button is rendered only in hands-free — so a ptt user who said "mute" saw the pill
	// read "idle" with no muted state anywhere. The next tap clears it (beginTalk), so nothing
	// is stuck; the only feedback the user got was simply wrong.
	if (s.muted) return "muted";
	return s.micOn ? "listening" : "idle";
}
