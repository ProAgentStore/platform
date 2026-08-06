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
export type VoicePhase = "idle" | "starting" | "listening" | "transcribing" | "processing" | "speaking" | "muted";

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
	/** A voice session is opening the mic right now — see {@link resolveToggleAction} (#284). */
	starting?: boolean;
}): VoicePhase {
	if (s.thinking) return "processing";
	if (s.speaking) return "speaking";
	// BEFORE the text-mode early return, deliberately: during startup `convoOn` has not flipped
	// yet, so `mode` is still "text" — checked after, the phase would be unreachable for its
	// entire lifetime, which is exactly the gap #284 reports (the press had no visible effect
	// until two awaits later). It sits below `speaking` because the agent talking is a real
	// ongoing event, and the mode control carries its own spinner off `starting` regardless.
	if (s.starting) return "starting";
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

// ── Starting a voice session (#284) ──────────────────────────────────────────

/** What a tap on the voice control means right now. */
export type ToggleAction = "start" | "stop" | "ignore";

/**
 * Resolve a tap on the hands-free control. `ignore` is the load-bearing case: opening the mic
 * takes two awaits (config + `getUserMedia`), and until #284 nothing on screen changed in that
 * window — so a user who thought the press missed would tap again and run a SECOND
 * `getUserMedia`, leaking the first stream and racing two recognizers onto one device.
 *
 * A second tap while starting is therefore a no-op, NOT a stop: the session the user asked for
 * is already on its way, and cancelling it would make an impatient tap indistinguishable from
 * a deliberate one.
 */
export function resolveToggleAction(s: { starting: boolean; active: boolean }): ToggleAction {
	if (s.starting) return "ignore";
	return s.active ? "stop" : "start";
}

// ── The pending utterance (#281) ─────────────────────────────────────────────

/**
 * Where the user's current utterance is in its life. `dictating` = words are landing live;
 * `transcribing` = they stopped and the clip is being turned into text; `failed` = it did not
 * come back, and the words we DID hear must survive so nothing is silently lost.
 */
export type DictationStatus = "dictating" | "transcribing" | "failed";

/**
 * The turn the user is speaking right now, as a first-class object rather than a string in the
 * composer (#281).
 *
 * It used to be `interim`, which carried three unrelated things at once — the live words, the
 * literal `"Transcribing…"` sentinel, and error notices — so signalling "transcribing" meant
 * ASSIGNING over the words. That assignment was the disappearance in the report: for the whole
 * upload round trip the user's speech existed nowhere on screen. Worse, both the phase model
 * here and two consumers re-derived "are we transcribing?" by string-comparing that sentinel,
 * the exact re-derived-in-several-places drift this module exists to prevent.
 */
export interface Dictation {
	/** Everything heard this turn so far. Never blanked while the turn is alive. */
	text: string;
	status: DictationStatus;
	/** Epoch ms the utterance began — stable across the turn, so it works as a render key. */
	startedAt: number;
	/** The live transcript AT end-of-turn, kept to compare against the final one
	 *  ({@link dictationDiverged}). Empty when nothing was heard live (iOS: no gate). */
	heard: string;
	/** Why it failed — shown on the bubble instead of a silent gap. */
	note?: string;
}

/** What just happened to the utterance. */
export type DictationEvent =
	/** Live words (a partial, or the accumulated turn so far). */
	| { type: "speech"; text: string; at: number }
	/** The user stopped and the clip is being transcribed. */
	| { type: "endOfTurn"; at: number }
	/** Transcription failed / the mic died — keep the words and say so. */
	| { type: "failed"; note: string; at: number }
	/** The turn is over (sent, abandoned, recovered, or discarded as noise). */
	| { type: "clear" };

/**
 * Advance the pending utterance. Pure, so the one rule that matters is testable and cannot be
 * re-derived differently at the ~20 call sites that used to poke `setInterim` directly: **words
 * are only ever removed by an explicit `clear`.** A status change never costs the user their
 * speech.
 */
export function reduceDictation(cur: Dictation | null, ev: DictationEvent): Dictation | null {
	switch (ev.type) {
		case "speech": {
			// An empty partial must not blank a live bubble — recognizers emit them routinely
			// between phrases, and treating one as "nothing was said" is how the words flicker.
			if (!ev.text.trim()) return cur;
			// A failed turn is finished; new words start a new one rather than reviving it.
			if (!cur || cur.status === "failed") return { text: ev.text, status: "dictating", startedAt: ev.at, heard: "" };
			// Streaming transcripts (gpt-4o-transcribe) keep arriving AFTER end-of-turn. They are
			// the transcription landing, not new speech, so the status must hold at `transcribing`
			// until the final result clears the turn — otherwise the bubble flips back to
			// "dictating" and claims the mic is hot when it is closed.
			return { ...cur, text: ev.text };
		}
		case "endOfTurn":
			// THE #281 FIX: status moves, text does NOT. The old code assigned "Transcribing…"
			// over the words here.
			if (!cur) return { text: "", status: "transcribing", startedAt: ev.at, heard: "" };
			return { ...cur, status: "transcribing", heard: cur.text };
		case "failed":
			if (!cur) return { text: "", status: "failed", startedAt: ev.at, heard: "", note: ev.note };
			return { ...cur, status: "failed", note: ev.note };
		case "clear":
			return null;
	}
}

/** Words of an utterance, normalized for comparison (case/punctuation-insensitive). */
function words(s: string): string[] {
	return s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
}

/**
 * Did the final transcript LOSE material content that the live recognizer heard (#281)?
 *
 * Judged by volume, not wording, because the two are usually different engines: the live gate is
 * browser Web Speech, the final is Whisper, and they legitimately disagree about phrasing all the
 * time. A dropped tail is a different shape — the final is simply much shorter than what was
 * heard, which is what "'this model' has no referent" looks like from the outside.
 *
 * Conservative on purpose: silent below four heard words (too little signal to accuse anything)
 * and only flags a loss of more than ~40% of the utterance, so ordinary engine disagreement
 * never fires it.
 */
export function dictationDiverged(heard: string, final: string): boolean {
	const h = words(heard);
	if (h.length < 4) return false;
	return words(final).length < Math.ceil(h.length * 0.6);
}
