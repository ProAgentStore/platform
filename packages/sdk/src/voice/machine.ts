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
	if (s.mode === "handsfree" && s.muted) return "muted";
	return s.micOn ? "listening" : "idle";
}
