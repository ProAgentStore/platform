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
import { nearWord } from "./vocabulary.js";

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
	/**
	 * Epoch ms a STANDALONE mute closed the mic over a turn already spoken (0 = none).
	 *
	 * Stamped only where mute is the whole instruction — the button, the control listener, a
	 * mute-only utterance — and deliberately NOT where mute rides on the end of a request
	 * ("run the tests, mute"), which #228 requires to still send.
	 */
	mutedAt: number;
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
export function isLateTurn(s: Pick<CaptureTiming, "captureStartedAt" | "pausedAt">): boolean {
	return s.captureStartedAt > 0 && s.pausedAt > 0 && s.captureStartedAt < s.pausedAt;
}

/**
 * Was this speech captured BEFORE the user asked for quiet (#420)?
 *
 * The same question `isLateTurn` asks, about the other boundary. It exists because the answer to
 * "what happens to a turn interrupted by mute?" was, until #420, decided by `ECHO_GUARD_MS`: a
 * transcript landing <800ms after the press was dropped in the pipeline's one silent branch, and
 * one landing later was SENT to the agent — with nothing on screen either way. Whisper latency runs
 * 0-2s, so which of those a user got depended on how promptly they pressed the button, and pressing
 * promptly (the natural action) was the branch that lost the words outright.
 *
 * `recover` was structurally unreachable here: it is gated on `pausedAt`, which mute never sets.
 * That is why this is a second timestamp rather than a reuse — mute could stamp `pausedAt`, but
 * `paused` also means "the mic may not reopen", and unmute reads it (`canOpenMic`), so a mute that
 * paused would have to unpause on unmute and would then reopen the mic in the middle of a reply
 * that was still being generated. Two meanings, one flag, is the drift this module exists to stop.
 */
export function isMutedTurn(s: Pick<CaptureTiming, "captureStartedAt" | "mutedAt">): boolean {
	return s.captureStartedAt > 0 && s.mutedAt > 0 && s.captureStartedAt < s.mutedAt;
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
	// FIRST, above the accept: a turn the user muted over must not be sent, and mute leaves the
	// guard in a state that otherwise reads as a perfectly ordinary accept once the echo tail
	// lapses (#420). Ordering matters more than the predicate here — putting this below would
	// reproduce the 800ms lottery exactly.
	if (isMutedTurn(s)) return "recover";
	if (!shouldIgnoreResult(s, now, echoMs)) return "accept";
	return isLateTurn(s) ? "recover" : "ignore";
}

/** May the mic (re)open right now? No while a reply is in flight or the user muted. */
export function canOpenMic(s: Pick<VoiceGuardState, "paused" | "muted">): boolean {
	return !s.paused && !s.muted;
}

/**
 * What the browser-dictation gate knows about the turn in front of it — and, load-bearingly, WHEN
 * it knew it.
 *
 * Four fields rather than two, because the two it had answered different questions than the ones
 * asked of them (#535). `isAlive` is a SESSION-lifetime fact: "this recognizer produced an event at
 * some point". A recognizer that was refused the microphone still fires `onend`, and `onend` set
 * it — so a gate that had never received one audio frame reported alive permanently, and that was
 * read as authority to condemn ten consecutive turns the mic had measured at 0.664 against a 0.1
 * floor. Every verdict now asks {@link GateReading.isHearing}, which is per-TURN: cleared by
 * `reset()` at each turn boundary, set only by evidence the device is actually open, and cleared
 * again by any device or permission failure.
 */
export interface GateReading {
	/** Session lifetime: has this recognizer ever produced any event at all? **Diagnostic only** —
	 *  no verdict may read it, for the reason above. It stays because it is the fact that separates
	 *  "the browser exposes SpeechRecognition but never ran it" from "it ran and then went deaf". */
	isAlive: boolean;
	/** THIS turn: the recognizer reported audio capture (or delivered a result), and has not since
	 *  failed on the device. The only liveness a verdict is allowed to trust. */
	isHearing: boolean;
	/** THIS turn: real words, from someone who is not the agent (`acceptSpeech`, #332). */
	heardSpeech: boolean;
	/** THIS turn: ANY transcript arrived, accepted or not. **Diagnostic only.** It is what separates
	 *  "the gate had no device" from "the gate had words and declined them" — the one question #535
	 *  could not settle from the log, and could otherwise only be settled by a human watching the
	 *  screen at the moment it happened. */
	sawWords?: boolean;
}

/** A gate reading, or its absence: `null`/`undefined` where there is no gate at all (browser
 *  dictation mode, iOS Safari). Absence is a distinct answer, not a false. */
export type GateEvidence = GateReading | null | undefined;

/**
 * What the gate is ENTITLED to claim about this turn.
 *
 * `abstains` covers both "there is no gate" and "there is a gate and it did not have the
 * microphone" — deliberately the same verdict, because they carry the same amount of information
 * about whether the user spoke: none. That equivalence is the whole of #535's first criterion.
 */
export function gateEvidence(gate: GateEvidence): "vouches" | "condemns" | "abstains" {
	if (!gate?.isHearing) return "abstains";
	return gate.heardSpeech ? "vouches" : "condemns";
}

/**
 * What the ENERGY detector concluded about the same turn.
 *
 * `unmeasured` is not `silence` and never collapses into it (#510): `noteLevel`'s only caller is a
 * `requestAnimationFrame` tick, and rAF does not run for a hidden document, so a minimised console
 * delivers zero frames for a clip full of speech.
 */
export type EnergyVerdict = "speech" | "silence" | "unmeasured";

/**
 * **The one precedence rule over speech evidence.** Three call sites consulted three different
 * ones, and the harshest ran first (#535 criterion 3).
 *
 * Before this, the same body of evidence produced opposite verdicts depending on which path a turn
 * happened to take: `planClipGate` (tap-to-talk, and every clip at `onstop`) consulted the gate's
 * condemnation ONLY when there were no frames, falling through to the measured peak otherwise —
 * and would have transcribed all ten of #535's lost turns. `planTurnClose`'s end-of-turn branch ran
 * first, asked the gate alone, and destroyed them, with `peakLevel` and `voiceFloor` sitting unused
 * in its own scope. The forgiving rule was unreachable from the path that mattered.
 *
 * The rule adopted is `planClipGate`'s, generalised — so this function is byte-for-byte the verdict
 * that path already produced, and the change lands on the two paths that disagreed with it:
 *
 *  1. **A vouching gate outranks the energy heuristic** (#511 criterion 4). Web Speech returning
 *     real text is direct evidence of speech; a peak under a floor is an inference about it. The
 *     0.15–0.18 band `ONSET_FLOOR_CEILING` documents as unresolvable by energy alone is resolved
 *     here, in the direction of the user's words surviving.
 *  2. **A measurement of speech outranks gate silence** (#535 criterion 2). This is the direction
 *     that was missing. A gate that hears nothing is evidence only about the gate; where the
 *     detector has actually measured speech-level energy, the gate's silence describes a recognizer
 *     problem, not the user's mouth.
 *  3. **A measurement of silence discards**, whatever the gate says — unchanged, and the reason the
 *     hallucination protection (#490, #332) is still standing.
 *  4. **With no measurement, only a HEARING gate may condemn.** A gate that abstains cannot save a
 *     clip and cannot destroy one, so an unknown clip is uploaded — the pre-#490 behaviour, which
 *     fails toward the words surviving.
 *
 * What this deliberately gives up: on the hands-free end-of-turn path, a loud non-speech transient
 * (a door slam clearing the adaptive onset floor) is now uploaded instead of vetoed by the gate.
 * That was the one place the veto still bit, and keeping it would mean keeping a veto that fires on
 * a gate whose own liveness we have just established we cannot fully trust. The same transient has
 * always been uploaded in tap-to-talk, which runs `planClipGate` — so this equalises the two modes
 * at the level the system already accepts, behind the same downstream defences
 * (`planNoiseRejection`, `isNoiseTranscript` against the bias prompt, `isRepetitionLoop`).
 */
export function speechVerdict(s: { gate: GateEvidence; energy: EnergyVerdict }): "transcribe" | "discard" {
	const claim = gateEvidence(s.gate);
	if (claim === "vouches") return "transcribe";
	if (s.energy === "speech") return "transcribe";
	if (s.energy === "silence") return "discard";
	return claim === "condemns" ? "discard" : "transcribe";
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

// ── Switching which agent you are talking to (#277, #278, #279) ──────────────

/**
 * What the voice session must do before the conversation moves to another agent.
 *
 * There is exactly ONE way to change who you are talking to, and this is its guard. #277
 * ("next" — the user picks) and #279 (an agent hands you over) are two triggers for the same
 * move; building them separately would produce two teardown paths that disagree about the mic,
 * which is how the #175 loss class happens — an utterance captured for agent A being sent to,
 * or dropped by, agent B.
 *
 * The rule the shape encodes: a switch NEVER silently discards speech, and never leaves the
 * previous agent talking over the new one. It is a decision, not an action, so the two triggers
 * can share it and it can be tested without a browser.
 */
export interface SwitchPrep {
	/** Cut the outgoing agent's TTS — it is answering a question you have left. */
	cancelSpeech: boolean;
	/** Drop the pending utterance. Only ever true when there is nothing to lose. */
	clearDictation: boolean;
	/** The words the user had already spoken and which the switch would destroy — hand them
	 *  back to the composer (the #175 "recover" contract) instead of dropping them silently. */
	recoverText: string;
	/** The voice mode to resume on the OTHER side, so hands-free stays hands-free across the
	 *  move. `null` = the user was typing; arriving in a live mic they did not ask for would be
	 *  the privacy surprise #278 warns about. */
	carryMode: VoiceMode | null;
}

/**
 * Resolve the teardown + carry-over for a conversation switch.
 *
 * `dictation` is the utterance the switch is about to destroy — so a caller whose utterance WAS
 * the command ("next", nothing else) passes `null`, having already cleared it. What is left is
 * the case that matters: a control word caught mid-capture, over words the user meant for the
 * agent they are leaving. A `transcribing` utterance is the sharpest form of it — they finished
 * speaking and the clip is mid-upload, so the speech exists but its text does not yet. That is
 * recovered to the composer rather than sent, because by the time it lands, the thread it was
 * meant for is not the one on screen (the #175 contract).
 */
export function prepareConversationSwitch(s: {
	mode: VoiceMode;
	ttsSpeaking: boolean;
	dictation: Dictation | null;
}): SwitchPrep {
	return {
		cancelSpeech: s.ttsSpeaking,
		clearDictation: !!s.dictation,
		recoverText: pendingUtterance(s.dictation),
		carryMode: s.mode === "text" ? null : s.mode,
	};
}

/**
 * The words a pending utterance is holding — everything that would be lost if it were cleared now.
 *
 * A dictation whose words ARE a command ("next") has nothing worth keeping; one with real content
 * spoken before it does. `heard` covers the `transcribing` case, where `text` may already be a
 * streaming transcript and `heard` is what the live gate captured at end-of-turn.
 *
 * Extracted out of {@link prepareConversationSwitch} for #420: mute needs the same derivation and
 * calling a function named "switch" to get it is how the two paths drift. `prepareConversationSwitch`
 * recovered a transcribing utterance and `muteFromCommand` destroyed one, from the same commit.
 */
export function pendingUtterance(d: Dictation | null | undefined): string {
	return ((d?.status === "transcribing" ? d.heard || d.text : d?.text) ?? "").trim();
}

/** What a mute must do about the turn it is interrupting. */
export interface MuteTeardown {
	/** Stamp the echo-tail guard? Only when there was speech whose tail the mic could hear. */
	armEchoTail: boolean;
	/** Leave the pending bubble in place — a transcript is still coming and will resolve it. */
	keepPending: boolean;
	/** Words to hand back to the composer NOW, because nothing else will deliver them. */
	recoverText: string;
}

/**
 * Resolve what mute does with the utterance already in flight (#420).
 *
 * Mute is what a user reaches for when something has gone wrong, so firing the interrupted turn at
 * the agent — with spend, and a spoken reply — is acting on an instruction they withdrew. But
 * deleting it is worse, and that is what shipped: `muteFromCommand` cleared the bubble, and the
 * clip that was still uploading then took whichever branch an unrelated 800ms timer put it in.
 *
 * Three decisions, each with a reason the call site cannot see:
 *
 *  - **`armEchoTail`** — the stamp was added by #153 to cover a CANCELLED TTS tail, which is real.
 *    But mute also closes the mic, so when nothing was playing there is no tail to guard and the
 *    line's only remaining effect is to start the 800ms lottery above. Conditional, so a genuine
 *    cancelled utterance keeps its guard and the control listener keeps its raised bar (ADR 0001 M3).
 *  - **`pendingTurn: "send"`** — mute arriving on the END of a request ("run the tests, mute") is a
 *    request PLUS a request for quiet. #228 exists because latching there threw the request away.
 *    Those sites keep the old behaviour exactly: clear, and let the clip land and send.
 *  - **`keepPending` vs `recoverText`** — exactly one, never both, because the acceptance test is
 *    that a muted turn lands in ONE place. Whisper transcribes AFTER `stop()`, so the words are
 *    still coming and the bubble must stay to receive them (`classifyResult` then routes them to
 *    the composer). Browser dictation has no upload: `stop()` ends the recognizer and the
 *    accumulated speech would simply cease to exist, so it is handed back here.
 */
export function planMuteTeardown(s: {
	/** Was the agent's TTS actually playing at the moment of the press? */
	ttsSpeaking: boolean;
	/** Is mute the whole instruction, or the tail of one? */
	pendingTurn: "send" | "recover";
	/** Whisper/gpt-4o-transcribe (a clip is transcribed after stop) vs browser dictation (not). */
	isWhisper: boolean;
	dictation: Dictation | null;
}): MuteTeardown {
	const armEchoTail = s.ttsSpeaking;
	if (s.pendingTurn === "send") return { armEchoTail, keepPending: false, recoverText: "" };
	const d = s.dictation;
	// A `failed` turn has already resolved — its words are on screen with a Dismiss, and nothing
	// further is coming for it either way.
	const stillComing = !!d && d.status !== "failed" && s.isWhisper;
	if (stillComing) return { armEchoTail, keepPending: true, recoverText: "" };
	return { armEchoTail, keepPending: false, recoverText: d?.status === "failed" ? "" : pendingUtterance(d) };
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
	/**
	 * Epoch ms the clip was handed to transcription; 0 while the words are still landing (#421).
	 *
	 * A SECOND clock, because `startedAt` is the utterance's and a watchdog hung off it would fire
	 * on any turn longer than its own timeout — the mic can legitimately stay open for
	 * `maxDictationMs`. This is the moment after which nothing further is expected from the user
	 * and everything is expected from the network, which is the only interval a deadline can be
	 * stated over. Re-stamped by `retry`, so a second attempt gets a full deadline of its own.
	 */
	transcribingAt: number;
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
	/** The user asked to send the same clip again (#421) — back to `transcribing`, note cleared. */
	| { type: "retry"; at: number }
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
			if (!cur || cur.status === "failed") return { text: ev.text, status: "dictating", startedAt: ev.at, heard: "", transcribingAt: 0 };
			// Streaming transcripts (gpt-4o-transcribe) keep arriving AFTER end-of-turn. They are
			// the transcription landing, not new speech, so the status must hold at `transcribing`
			// until the final result clears the turn — otherwise the bubble flips back to
			// "dictating" and claims the mic is hot when it is closed.
			return { ...cur, text: ev.text };
		}
		case "endOfTurn":
			// THE #281 FIX: status moves, text does NOT. The old code assigned "Transcribing…"
			// over the words here.
			//
			// A failed turn is finished — the same rule the `speech` branch above states, applied at
			// the other entry point (#455). Without it a rejected turn is revived as the NEXT turn's
			// live bubble: its words reappear as though they were what the user just said, its `note`
			// outlives it, and `heard` is seeded with the old words, which makes
			// {@link dictationDiverged} accuse turn 2 of a lost tail that never happened.
			if (!cur || cur.status === "failed") return { text: "", status: "transcribing", startedAt: ev.at, heard: "", transcribingAt: ev.at };
			return { ...cur, status: "transcribing", heard: cur.text, transcribingAt: ev.at };
		case "failed":
			if (!cur) return { text: "", status: "failed", startedAt: ev.at, heard: "", transcribingAt: 0, note: ev.note };
			// The deadline is over either way — a failed turn is waiting on nobody, so leaving the
			// clock running would let the watchdog fire again on a turn that has already resolved.
			return { ...cur, status: "failed", transcribingAt: 0, note: ev.note };
		case "retry":
			// Only a turn that FAILED can be retried — there is no clip to re-send otherwise, and
			// re-stamping a live one would hand it a deadline it has not earned.
			if (cur?.status !== "failed") return cur;
			return { ...cur, status: "transcribing", transcribingAt: ev.at, note: undefined };
		case "clear":
			return null;
	}
}

/**
 * ── THE UTTERANCE THE LIVE RECOGNIZER HAS HEARD SO FAR (#458)
 *
 * {@link reduceDictation} REPLACES its text, and that is right for its other caller: streaming
 * `gpt-4o-transcribe` partials are cumulative by construction (each partial is the whole
 * transcript so far), so appending them would duplicate every word. The reducer is not the bug.
 *
 * The bug is that the speech GATE fed it a fragment. Web Speech reports per PHRASE, and its
 * `resultIndex` is the first CHANGED result — so the text arriving at each event is the phrase
 * being recognised right now, not the turn. Every pause finalised a phrase, the next event
 * started a new one, and the bubble was overwritten: "part by part", with the earlier words
 * gone. The recogniser also restarts itself on `onend`, which resets `results` entirely, so the
 * loss happened at phrase boundaries AND at restarts.
 *
 * That cost more than the display. `heard` is stamped from the bubble at end-of-turn and fed to
 * {@link dictationDiverged} — the "did the final transcript lose a clause?" guard (#281, #371) —
 * so a systematically truncated `heard` made `final.length < heard.length * 0.6` unsatisfiable
 * and the guard silently stopped working for any turn containing a pause. Which is most of them.
 *
 * The fold is four rules with an ordering dependency (append finals, hold the interim apart,
 * survive a restart, reset per turn), and Web Speech re-emits a phrase as interim and THEN as
 * final — so a naive append doubles it. That is exactly the shape this module exists for, so it
 * is a pure reducer beside {@link reduceDictation} rather than closure state in the adapter.
 *
 * THE RULE THAT MAKES IT SAFE: a `results` event carries the WHOLE current session (its caller
 * scans `results` from 0, not from `resultIndex`), so the session halves are RECOMPUTED rather
 * than accumulated. Re-delivering a phrase as final after delivering it as interim therefore
 * cannot double it — the second event overwrites the first's reading of the same array. Only
 * what a restart is about to destroy is ever accumulated, and that happens once, at `sessionEnd`.
 */
export interface HeardState {
	/** Text from recogniser sessions that have already ENDED — the only accumulated part. */
	committed: string;
	/** The finalised text of the CURRENT session, recomputed from its results on every event. */
	sessionFinal: string;
	/** The live, not-yet-final tail of the current session. */
	sessionInterim: string;
}

export type HeardEvent =
	/** One `onresult`, carrying the whole current session split into final and not-yet-final. */
	| { type: "results"; final: string; interim: string }
	/** The recogniser ended (it restarts itself) — its `results` are about to be thrown away. */
	| { type: "sessionEnd" }
	/** A new turn begins. The ONLY thing that forgets an utterance. */
	| { type: "reset" };

export const EMPTY_HEARD: HeardState = { committed: "", sessionFinal: "", sessionInterim: "" };

/** Join transcript fragments with single spaces, ignoring the empty ones. */
function joinHeard(...parts: string[]): string {
	return parts.join(" ").replace(/\s+/g, " ").trim();
}

export function reduceHeard(cur: HeardState, ev: HeardEvent): HeardState {
	switch (ev.type) {
		case "results":
			return { ...cur, sessionFinal: joinHeard(ev.final), sessionInterim: joinHeard(ev.interim) };
		case "sessionEnd": {
			// The interim is carried too, not just the final. A recogniser that ends mid-phrase has
			// not always promoted its last words to final first, and losing them is the very defect
			// this reducer exists to fix — whereas carrying them cannot duplicate, because the
			// session halves are cleared in the same step.
			const carried = joinHeard(cur.sessionFinal, cur.sessionInterim);
			return { committed: joinHeard(cur.committed, carried), sessionFinal: "", sessionInterim: "" };
		}
		case "reset":
			return EMPTY_HEARD;
	}
}

/** Everything heard this turn, in speaking order — what the bubble shows. */
export function heardText(s: HeardState): string {
	return joinHeard(s.committed, s.sessionFinal, s.sessionInterim);
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
 * Conservative on purpose: a loss of more than ~40% of the utterance, so ordinary engine
 * disagreement never fires it.
 *
 * ── TWO tests, because a short utterance has no volume to measure (#371)
 *
 * The volume test used to be the only one and it was switched off below four heard words — "too
 * little signal to accuse anything". The observed consequence: the two turns in the reported
 * thread that came back as pure nonsense are the two turns the guard was contractually forbidden
 * to comment on.
 *
 *     heard "Do it"  → transcribed "Duet"      2 words → silent
 *     heard "Send"   → transcribed "context:"  1 word  → silent
 *
 * Both were sent to the agent as the user's own words, and the second broke the conversation: the
 * agent could not resolve "Duet" and re-listed what it had already listed twice. Short utterances
 * are the MOST likely to be mistranscribed (there is no surrounding context to constrain the
 * decoder) and they were the only ones with no check at all.
 *
 * So below four words the question changes from "how much is left?" to "is any of it the same?":
 * if the final shares NO word with what the gate heard, the two engines did not hear the same
 * utterance, regardless of length. `Do it`/`Duet` and `Send`/`context:` trip that; `colour`/
 * `color` and every other ordinary spelling disagreement do not, because {@link nearWord} counts
 * a spelling variant as the same word. The volume test is left exactly as it was above four
 * words, where it is the better question — a long turn that lost its tail still overlaps.
 */
export function dictationDiverged(heard: string, final: string): boolean {
	const h = words(heard);
	if (!h.length) return false; // nothing was heard live — there is no second reading to compare
	const f = words(final);
	if (h.length < 4) {
		if (!f.length) return true; // heard something, transcribed nothing
		return !f.some((w) => h.some((x) => nearWord(w, x)));
	}
	return f.length < Math.ceil(h.length * 0.6);
}

/**
 * How many words the live recognizer heard that the final transcript does not account for
 * (#319) — the "count of dropped words" the divergence flag reports.
 *
 * A multiset difference, not a diff: the two strings come from different engines, so their
 * WORD ORDER is not evidence of anything, but a word heard three times and transcribed once
 * is two words missing. Punctuation and case are normalized away for the same reason.
 *
 * This is deliberately a weaker claim than {@link dictationDiverged}: a loss of one word is
 * worth showing next to the toggle, and nowhere near enough to accuse the pipeline of eating
 * the user's speech. The flag decides whether to accuse; this decides what number to print.
 */
export function dictationLoss(heard: string, final: string): number {
	const have = new Map<string, number>();
	for (const w of words(final)) have.set(w, (have.get(w) ?? 0) + 1);
	let lost = 0;
	for (const w of words(heard)) {
		const n = have.get(w) ?? 0;
		if (n > 0) have.set(w, n - 1);
		else lost++;
	}
	return lost;
}

/** A trailing clause this long, heard live and absent from the transcript, is reported (#512).
 *  Four words is a clause with an instruction in it; one or two is an ordinary mishearing of the
 *  last word, and reporting those would bury the log in the normal disagreement between two
 *  recognizers. */
export const LOST_TAIL_WORDS = 4;

/**
 * How many words at the END of the live capture the transcript does not account for (#512).
 *
 * A different question from {@link dictationDiverged}, which asks about VOLUME — for a long turn
 * it fires only when the transcript is more than 40% shorter, so a clause lost off the end of a
 * paragraph does not register at all. And it is a different failure with a different cost: a
 * dropped clip is visible, because the user says it again, while a silently TRUNCATED one is not.
 * The agent receives a grammatical, plausible instruction that is missing its operative half. The
 * recorded case:
 *
 *     sent   "…and file issues that come out of it."
 *     heard  "…file issues that come out of it don't wait for the night rebuild we have to run"
 *
 * Counted from the end and stopping at the first word the transcript does have, so this measures a
 * lost TAIL rather than general disagreement — words dropped from the middle are mishearing, which
 * `dictationLoss` already counts. `nearWord` so a spelling variant is not mistaken for a loss.
 *
 * It is therefore a FLOOR on the loss, not an exact count: a common word inside the lost clause
 * ("the", "to") ends the walk early, and the case above scores 6 for 10 lost words. Undercounting
 * is the right direction for something whose only job is to decide whether a row is worth writing.
 */
export function lostTail(heard: string, final: string): number {
	const h = words(heard);
	const f = words(final);
	let n = 0;
	for (let i = h.length - 1; i >= 0; i--) {
		if (f.some((w) => nearWord(w, h[i]))) break;
		n++;
	}
	return n;
}

/** Cap on a stored dictation. An utterance is one breath; this is far past any of them. */
export const DICTATION_MAX = 4000;

/**
 * What to PERSIST beside the transcript for this turn, or `null` for "store nothing" (#319).
 *
 * The platform keeps exactly two artefacts of a voice turn today — the final transcript (the
 * message) and the recording (`audioKey` → R2) — and could therefore never answer "is anything
 * missing from what I said?", because the live capture was overwritten at end-of-turn. This is
 * the third artefact, and the rules below exist so it is the LAST one: it is stored only where
 * it says something the transcript does not.
 *
 * `null` in three cases, each of which would otherwise put a dead affordance on a bubble:
 *
 *  - **Nothing was heard live.** A typed turn, or Whisper on iOS where there is no browser
 *    dictation gate at all. There is no second reading, so there is nothing to compare.
 *  - **The two agree.** Word-for-word after normalization, the dictation is a second copy of
 *    the sentence already on screen. Storing it would be a duplicate record of one fact.
 *  - **The turn was `recover`ed** — not enforced here, but by construction: a recovered turn
 *    goes to the composer rather than the thread ({@link classifyResult}), so it never reaches
 *    the send path at all. If the human then sends what is in the composer, the transcript IS
 *    the live capture, and the second rule above would drop it anyway.
 */
export function storedDictation(heard: string, final: string): string | null {
	const h = heard.trim();
	if (!h) return null;
	if (words(h).join(" ") === words(final).join(" ")) return null;
	return h.slice(0, DICTATION_MAX);
}
