/**
 * The voice orchestrator: one mic, one recognizer, one TTS, driven by a set of interlocking
 * guards. This file is deliberately ONE hook — please read this before splitting it (#138).
 *
 * ── Where the logic actually lives ──
 *
 * Every DECISION this hook makes is already a pure, unit-tested function somewhere else:
 *
 *   machine.ts   may the mic open? is this result echo, a real turn, or a late one to
 *                recover? what phase are we in?        (canOpenMic/classifyResult/derivePhase)
 *   convo.ts     is this utterance a command? a stop-word? a restart loop? a wrong language?
 *                may a transcript of THIS kind be judged for a destructive one?
 *   turn.ts      what IS this finished turn — scrap, repeat, a message with a command on the
 *                end? and may this transcript be released as a message at all?
 *                                                  (planFinalizedTurn/planSend/utteranceSoFar)
 *   vad.ts       has the user stopped talking?
 *   audio.ts     mic level; is this transcript noise/hallucination?
 *   gate.ts      did real speech happen this turn?
 *   config.ts    settings → an STT/TTS pair
 *   stt.ts/tts.ts  the recognizer + synthesiser themselves
 *   cues.ts      chimes + the iOS speech unlock
 *   voice-audio.ts  saving a turn's recording for replay
 *
 * What is LEFT here is the imperative remainder those modules deliberately do not own:
 * sequencing side effects in the right order, over mutable state that several of them read
 * at once. That is one responsibility, not five.
 *
 * ── Why it is not split into sub-hooks ──
 *
 * The obvious seams (useStt / useTts / useVoiceCommands / useTurnTimers) all fail the test
 * that matters — that an extracted hook OWNS its refs and exposes a narrow surface:
 *
 *   - `ttsRef` is touched at ~20 sites across the whole file. "Is the agent speaking" is an
 *     INPUT to the guard model (see readGuard), so the mic path, the command path, teardown
 *     and mode-switching all need it. A `useTts` would have to hand `ttsRef` straight back
 *     out, plus `speakEndedAtRef` (written from six places) and `setSpeaking`.
 *   - `startAudioMonitor` reads ~24 refs, including the command effects — the gate's
 *     onInterim is where a "mute" said mid-recording is caught (#228).
 *   - The timers' callbacks close over `finalize`, which is built inside handleResult.
 *
 * So a split would thread twenty-odd refs through parameter bags, which does not remove the
 * coupling — it hides it, and the sequencing here is exactly what the bugs were made of.
 * The comments below are load-bearing: several record why an obvious simplification is
 * wrong. Read them before "cleaning up" the thing they describe.
 */
import { useState, useRef, useCallback, useEffect } from "react";
import { flushSync } from "react-dom";
import { createStt, createTts, getVoiceConfig, type VoiceConfig } from "./config.js";
import { isConnectivityError, reportClientError } from "../client.js";
import { initVad, shouldAutoDetectEndOfTurn, vadStep } from "./vad.js";
import { computeRmsLevel } from "./audio.js";
import { createSpeechGate, speechGateAvailable, type SpeechGate } from "./gate.js";
import { canOpenMic, classifyResult, derivePhase, dictationDiverged, endOfTurnAction, isEchoing, planMuteTeardown, prepareConversationSwitch, reduceDictation, resolveToggleAction, shouldIgnoreResult, type Dictation, type DictationEvent, type VoiceGuardState } from "./machine.js";
import { classifyVoiceError, commandStateFor, decideRestart, isMicPermissionDenied, isReportableMicError, isRetryableVoiceError, matchesStopSpeech, matchVoiceCommand, micUnavailableMessage, normalizeMediaError, planRestartBail, resolveVoiceMode, shouldRunControlListener, shouldScanGateTranscript, stripStopWord, type VoiceMode } from "./convo.js";
import { extendTranscribePrompt } from "./prompt.js";
import { planFinalizedTurn, planNoiseRejection, planSend, utteranceSoFar } from "./turn.js";
import { getAudioCtx, playListeningChime, playStartCue, playThinkingChime, unlockSpeechSynthesis } from "./cues.js";
import { uploadVoiceAudio } from "./voice-audio.js";
import { TRANSCRIBE_STREAM_MS, TRANSCRIBE_TIMEOUT_MESSAGE, VoiceStt } from "./stt.js";
import type { VoiceTts } from "./tts.js";

// ── Tunables (named, not scattered literals) ─────────────────────────────────
/** Throttle mic-level React updates to ~15fps — 60fps re-renders the chat + lags. */
const LEVEL_THROTTLE_MS = 66;
/** Pause before reopening the mic between conversation turns. */
const RESTART_DELAY_MS = 350;
/** How long a turn may sit on "Transcribing…" before the UI gives up on it (#421). Deliberately
 *  LONGER than `stt.ts`'s two network deadlines, so the specific message wins the race and this
 *  only fires for a stall the network layer could not see. */
const TRANSCRIBE_WATCHDOG_MS = TRANSCRIBE_STREAM_MS + 5_000;
// ECHO_GUARD_MS + all input guards now live in ./machine.ts (the pure, tested interaction
// model) so the decisions are made ONE way instead of re-derived inline at every call site.

// Single hands-free session across the ENTIRE app. Every view (InstanceDetail, CopilotView,
// ReposList, …) has its own useVoice instance; this module-level slot is the shared coordinator
// so starting hands-free anywhere stops any other hands-free already running. Holds the current
// session's teardown callback, keyed by a stable per-hook token so a hook never stops itself.
let activeHandsFree: { token: object; stop: () => void } | null = null;

/**
 * Voice hook for chat — three modes:
 *
 * Push-to-talk (🎤): live transcript in input → auto-sends on pause.
 * Auto-speak (🔊): reads every assistant response aloud.
 * Conversation (🎙️): continuous hands-free loop:
 *   1. Chime → you talk → words appear live in input
 *   2. You pause → chime → message sends, mic pauses
 *   3. Agent responds → response spoken aloud
 *   4. TTS finishes → chime → mic re-opens → step 1
 */

export type { VoiceMode };

export function useVoice(instanceId: string | undefined, opts: {
	/** Send a transcript. `meta.audioKey` is set for voice turns whose audio was saved;
	 *  `meta.dictation` is what the live recognizer heard, when that differs from the
	 *  transcript (#319) — persist it beside the message so the two can be compared. */
	onSend: (text: string, meta?: { audioKey?: string; dictation?: string }) => void;
	/**
	 * A turn the user really spoke, transcribed too late to send (#175) — the agent replied (or
	 * the mode changed) while they were still talking. Hand it back instead of dropping it: put
	 * it in the composer so they can see it survived, edit it, and send it. NOT auto-sent — the
	 * conversation has moved on since they said it. Without a handler the text is discarded, i.e.
	 * exactly the old behaviour.
	 */
	onRecoveredText?: (text: string) => void;
	/**
	 * The user said "next" (#277) — move them to the agent that is asking for them.
	 *
	 * Passing a handler is what ENABLES the command: this hook knows nothing about agent
	 * rosters, so on a surface with no switcher (the Coder's Co-pilot) "next" stays an
	 * ordinary word and reaches the agent as speech. `carryMode` is the voice mode to resume
	 * on the other side, so hands-free survives the move rather than dumping the user on a
	 * silent screen they then have to touch — which would defeat the whole point.
	 *
	 * The session is already torn down when this fires: TTS cut, the pending utterance
	 * resolved (recovered via `onRecoveredText` if it held real words). See
	 * {@link prepareConversationSwitch} and {@link leaveForSwitch} — the same teardown #279's
	 * agent-mediated transfer takes, so the three triggers can never disagree about the mic.
	 */
	onNext?: (carry: { carryMode: VoiceMode | null }) => void;
	/**
	 * The user said "go back" (#279) — return them to the agent they were with before this one.
	 *
	 * The reversal of an agent-mediated transfer, and the reason the transfer is not a one-way
	 * door: an agent hands you over, and without this the only way back in hands-free is the
	 * screen. Enabled by passing a handler, exactly as `onNext` is, and torn down identically —
	 * these are two destinations for one move, not two moves.
	 *
	 * It is NOT `next` with a different resolver: `next` returns you to the previous agent only
	 * when that agent has an unread notification, and being transferred away does not raise one.
	 */
	onBack?: (carry: { carryMode: VoiceMode | null }) => void;
	/**
	 * The user said "scrap that" (#342) — they want the last turn gone.
	 *
	 * Passing a handler is what ENABLES the command, exactly as `onNext` does, and for one extra
	 * reason: this is the first DESTRUCTIVE word in the vocabulary. Everything else here is
	 * recoverable — mute, unmute, repeat, switch agent — so a false positive costs a moment. This
	 * one removes a message, and nothing errors afterwards, which is precisely the shape #328 gave
	 * a confirmation to.
	 *
	 * So the hook does NOT delete anything, and the name says so: it STAGES. The consumer is
	 * expected to raise a confirmation naming the turn, not to act. An "undo" toast would be the
	 * wrong safety net here — the hands-free user this command exists for is not looking at the
	 * screen, so a thing that expires in ten seconds protects nobody. The gate belongs BEFORE.
	 *
	 * Fired only on a FINAL utterance and only when the whole utterance is the phrase: an interim
	 * transcript of "scrap that idea and let's move on" is momentarily exactly "scrap that", so the
	 * live-partial paths deliberately withhold the flag that turns the word on.
	 */
	onScrap?: () => void;
	/** Vocabulary-bias prompt for transcription (see voice/prompt.ts) so domain words
	 *  aren't mis-heard (a developer's "bugs" shouldn't transcribe as "bars"). */
	transcribePrompt?: string;
	/** Technical agent (code explainer / coding): keep identifiers + file basenames in
	 *  SPOKEN output instead of stripping them to "a file". Default false. */
	technical?: boolean;
}) {
	const [micOn, setMicOn] = useState(false);
	const [speakOn, setSpeakOn] = useState(false);
	const [convoOn, setConvoOn] = useState(false);
	const [muted, setMuted] = useState(false);
	const mutedRef = useRef(false);
	mutedRef.current = muted;
	// True while the agent is talking aloud (TTS) — drives the "Speaking…" status pill and
	// tells the user the mic is NOT listening to them right now.
	const [speaking, setSpeaking] = useState(false);
	// Push-to-talk WITHIN hands-free: the user is holding the floor via a manual tap, so
	// the automatic end-of-turn VAD is suppressed and only their tap-off sends the turn.
	const [talking, setTalking] = useState(false);
	const manualTalkRef = useRef(false);
	// The transient NOTICE line (mic errors, the wrong-language nudge). It was called `interim`
	// until #364, three releases after #281 moved the user's actual words out of it and into
	// `dictation` below: both consumers still had it bound to their composer's `value`, so the
	// input lit up as "you are speaking" ONLY on a mic error and showed nothing at all while
	// someone spoke. A name that lies is how a dead binding survives a review — this one is now
	// called what it carries, and it is rendered BESIDE the composer, never inside it.
	const [notice, setNotice] = useState("");
	// The utterance in flight, as a real object with a lifecycle instead of a string that had to
	// be destroyed to change its status (#281). Rendered by the consumer as a pending bubble IN
	// THE THREAD, so speech is visible from the moment it starts, through transcription, until
	// the sent message replaces it. The ref mirrors it because the reducer needs the current
	// value from callbacks that close over a stale render.
	const [dictation, setDictation] = useState<Dictation | null>(null);
	const dictationRef = useRef<Dictation | null>(null);
	/** What the LIVE recognizer had at end-of-turn, kept for the divergence check in emitSend. */
	const lastHeardRef = useRef("");
	/** The ONLY way the pending utterance moves — every transition goes through the pure
	 *  reducer, so "does this event cost the user their words?" is answered in one tested place. */
	const dictate = useCallback((ev: DictationEvent) => {
		const next = reduceDictation(dictationRef.current, ev);
		// Stash what was heard LIVE at end-of-turn. It has to outlive the bubble: the send path
		// clears the utterance and only then emits, so by the time the final transcript is in
		// hand there is nothing left to compare it against (#281's capture-loss half).
		if (ev.type === "endOfTurn" && next) lastHeardRef.current = next.heard;
		if (next === dictationRef.current) return;
		dictationRef.current = next;
		setDictation(next);
	}, []);
	/** Clear the notice AND end the pending utterance — the pairing that every former
	 *  `setInterim("")` site meant, now impossible to do by halves. */
	const clearVoiceText = useCallback(() => {
		setNotice("");
		dictate({ type: "clear" });
	}, [dictate]);
	// True while a voice session is opening the mic (#284). Set SYNCHRONOUSLY on the tap, before
	// the config read and getUserMedia, so the control can acknowledge the press on the same
	// frame instead of looking untouched for the whole startup.
	const [starting, setStarting] = useState(false);
	const startingRef = useRef(false);
	/** 0-1 audio level from mic — drives the waveform visualizer */
	const [audioLevel, setAudioLevel] = useState(0);
	const sttRef = useRef<VoiceStt | null>(null);
	const ttsRef = useRef<VoiceTts | null>(null);
	// Always-on background control-word recognizer (#153) — declared here so startListening can
	// yield the mic to the main recorder synchronously. Wired below (ensureControlStt + effect).
	const ctrlSttRef = useRef<VoiceStt | null>(null);
	const ctrlWantRef = useRef(false);
	// Browser-dictation SPEECH GATE (Whisper mode only). Runs alongside the recorder to
	// (a) show live words as you speak and (b) confirm real speech happened this turn — so
	// silence / keyboard clicks / background noise never get uploaded to Whisper (which
	// would hallucinate a phrase and send a phantom turn). Null on iOS Safari (no Web Speech).
	const gateRef = useRef<SpeechGate | null>(null);
	// The configured STT language (Settings → Voice → Language). The gate recognizer must
	// hear the SAME language as the transcriber — an en-US gate listening to Chinese sees
	// "no real words" and discards the turn before Whisper ever gets it.
	const voiceLangRef = useRef("en-US");
	const gateLangRef = useRef<string | null>(null);
	const analyserRef = useRef<{ ctx: AudioContext; analyser: AnalyserNode; source: MediaStreamAudioSourceNode; stream: MediaStream; ownsStream: boolean; raf: number } | null>(null);

	// Flag: true while the agent is processing (mic should stay off)
	const pausedForThinkingRef = useRef(false);
	// WHEN the current pause began (#175). `paused` alone cannot tell the user's own turn from
	// echo: a reply that lands mid-dictation pauses the mic, the clip still transcribes, and the
	// guard then dropped it as if the user had abandoned it. The timestamp is the missing half —
	// speech captured BEFORE this moment is theirs. Reset to 0 on unpause, and stamped only on
	// the false→true EDGE, so the boundary is the START of the pause, not its latest re-assert.
	const pausedAtRef = useRef(0);
	/** The ONLY way to move the paused flag — so the timestamp can never drift out of sync. */
	const setPaused = useCallback((v: boolean) => {
		if (v) {
			if (!pausedForThinkingRef.current) pausedAtRef.current = Date.now();
		} else {
			pausedAtRef.current = 0;
		}
		pausedForThinkingRef.current = v;
	}, []);
	// When the agent last finished speaking — used to ignore the speaker echo tail.
	const speakEndedAtRef = useRef(0);
	// WHEN a standalone mute closed the mic (#420). The mute counterpart of `pausedAtRef`, and a
	// separate timestamp for the reason `isMutedTurn` records: `paused` also gates whether the mic
	// may reopen, so muting through it would make unmute reopen the mic mid-reply. Cleared on every
	// fresh capture (`startListening`) so it can never judge a later turn, and consumed by the
	// `recover` branch of `handleResult`.
	const mutedAtRef = useRef(0);

	// Assemble the guard snapshot ONE way from its live sources — the agent's TTS-speaking
	// flag, the echo-tail timestamp, the paused-for-reply flag, and mute — so every decision
	// (open the mic? ignore this result? was that echo?) is fed IDENTICAL inputs. This is the
	// state half of the interaction model: Phase 1 made the verdicts pure + single (machine.ts);
	// this makes the inputs single, killing the drift risk of the three duplicated inline
	// literals it replaces (add a guard input here and every decision picks it up at once).
	const readGuard = useCallback((): VoiceGuardState => ({
		ttsSpeaking: !!ttsRef.current?.speaking,
		speakEndedAt: speakEndedAtRef.current,
		paused: pausedForThinkingRef.current,
		muted: mutedRef.current,
	}), []);
	/** The same idea for the dictation gate: its two flags read TOGETHER, at the moment of the
	 *  decision, in the shape the pure verdicts take (`endOfTurnAction`, `planNoiseRejection`).
	 *  Both of them ask "did real words happen this turn?" and both must answer it the same way —
	 *  a gate that never ran vouches for nothing, wherever the question is asked from. */
	const gateSnapshot = useCallback(() => {
		const g = gateRef.current;
		return g ? { isAlive: g.isAlive(), heardSpeech: g.heardSpeech() } : null;
	}, []);

	const stopAudioMonitor = useCallback(() => {
		gateRef.current?.stop();
		if (analyserRef.current) {
			cancelAnimationFrame(analyserRef.current.raf);
			analyserRef.current.source.disconnect();
			// Stop the mic tracks only if WE opened the stream. In Whisper mode we reuse
			// the recorder's stream — stopping it here would kill the recording.
			if (analyserRef.current.ownsStream) {
				for (const t of analyserRef.current.stream.getTracks()) t.stop();
			}
			analyserRef.current.ctx.close().catch(() => {});
			analyserRef.current = null;
		}
		setAudioLevel(0);
	}, []);

	// Start audio level monitoring from mic stream
	const startAudioMonitor = useCallback(async () => {
		// Tear down any prior monitor FIRST. In conversation mode the mic restarts
		// every turn (and on each silence timeout), so without this each start would
		// leak an AudioContext + mic stream + requestAnimationFrame loop — and after
		// ~6 contexts the browser throws and the meter dies. Left on long enough, a
		// real, growing leak.
		stopAudioMonitor();
		vadStateRef.current = initVad(); // fresh turn — don't carry a stale peak over
		// Start the dictation gate for THIS turn (Whisper "Smart AI" mode + Web Speech
		// available). It shows live words as you speak and — at end-of-turn — tells us
		// whether real speech actually happened, so silence/keyboard/noise never uploads.
		if (sttIsWhisperRef.current && speechGateAvailable()) {
			// Rebuild the gate when the configured language changed — SpeechRecognition's
			// lang is fixed at construction, and a stale-language gate mis-hears (or
			// discards) every turn in the new language.
			if (gateRef.current && gateLangRef.current !== voiceLangRef.current) {
				gateRef.current.stop();
				gateRef.current = null;
			}
			if (!gateRef.current) {
				gateLangRef.current = voiceLangRef.current;
				gateRef.current = createSpeechGate({
					lang: voiceLangRef.current,
					// The same predicate the live-transcript path below applies — so the gate cannot
					// vouch for a turn made of the agent's own TTS (#332). Without it a silent turn
					// after a spoken reply was uploaded and came back as a vocabulary term.
					acceptSpeech: () => !mutedRef.current && !shouldIgnoreResult(readGuard(), Date.now()),
					// A denied gate is not a no-op: `planNoiseRejection` treats a dead gate as
					// "cannot vouch for this turn", so it quietly changes which marginal turns
					// survive — and until #425 it produced no evidence of itself at all.
					onDenied: (code) => reportClientError("voice-gate", `speech gate refused the microphone: ${code}`, { code }),
					onInterim: (text) => {
						// Control words during CAPTURE (#228). In Whisper/OpenAI mode the main path
						// records with MediaRecorder and produces nothing until the clip uploads, and
						// the background control listener has yielded because the mic is open — so for
						// the whole recording window nobody was checking, and "mute" said mid-turn did
						// nothing. This gate is already running a recognizer over the same audio for
						// noise filtering and already has the words; scanning them here is what closes
						// that window. Guarded so browser-dictation mode (which checks its own interim)
						// can't fire the same command twice.
						const now = Date.now();
						if (
							shouldScanGateTranscript({
								commandsEnabled: commandsEnabledRef.current,
								mainUsesBrowserSpeech: !sttIsWhisperRef.current,
								paused: pausedForThinkingRef.current,
								echoing: isEchoing(readGuard(), now),
							})
						) {
							// "partial": the gate's transcript is a LIVE running capture, so mid-sentence
							// it is momentarily exactly "scrap that" on the way to "scrap that idea and
							// let's move on". commandStateFor drops the destructive flag (#342).
							const cmd = matchVoiceCommand(
								text,
								{ repeat: repeatWordsRef.current, mute: muteWordsRef.current, unmute: unmuteWordsRef.current, exit: exitWordsRef.current, next: nextWordsRef.current, scrap: scrapWordsRef.current, stopSpeech: stopSpeechKeywordRef.current },
								voiceLangRef.current,
								commandStateFor("partial", { muted: mutedRef.current, canSwitch: canSwitchRef.current, canScrap: canScrapRef.current, canBack: canBackRef.current }),
							);
							if (cmd) {
								// Act NOW — the user asked for silence and should get it immediately,
								// not at end-of-turn. But do NOT latch handledUtterance: the audio
								// already captured is still transcribed and sent, with the command
								// word stripped by finalize (splitTrailingCommand). Latching here
								// discarded the turn, so "run the tests, mute" muted and threw the
								// request away — the user's words vanished with their own command.
								//
								// muteFromCommand stops the recorder with stop(), not stopDiscard(),
								// so the clip still uploads and comes back through the normal path.
								// "send" is what keeps that true: this is mute arriving mid-request,
								// so the arriving transcript must reach the agent rather than the
								// composer (#420's carve-out for #228).
								if (cmd === "mute") muteFromCommandRef.current("send");
								else if (cmd === "unmute") unmuteFromCommandRef.current();
								else if (cmd === "exit") exitFromCommandRef.current();
								// "next" LEAVES this agent, so — unlike mute — the clip still recording
								// must not go on to be transcribed and sent here. Latch the utterance and
								// let nextFromCommand decide what happens to the words already heard
								// (recovered to the composer, never fired at the agent being left).
								else if (cmd === "next") { handledUtteranceRef.current = true; nextFromCommandRef.current(); }
								else if (cmd === "repeat") { handledUtteranceRef.current = true; flushSync(() => clearVoiceText()); repeatLastRef.current(); }
								return;
							}
						}
						// Ignore the agent's own voice (echo tail), and paused/muted windows.
						if (mutedRef.current || shouldIgnoreResult(readGuard(), now)) return;
						// The gate is the ONLY live view of a Whisper turn (the recorder produces
						// nothing until upload), so these words are what the thread shows while
						// the user is still speaking.
						dictate({ type: "speech", text, at: now });
					},
				});
			}
			gateRef.current?.reset();
			gateRef.current?.start();
		}
		try {
			// Reuse the recognizer's existing mic stream if it has one (Whisper records
			// via getUserMedia). Opening a SECOND getUserMedia mutes the recorder on iOS
			// Safari → silent audio → empty transcription. Browser dictation exposes no
			// stream, so we open our own there.
			const shared = sttRef.current?.stream ?? null;
			const ownsStream = !shared;
			const stream = shared ?? (await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false } }));
			const ctx = new AudioContext();
			const source = ctx.createMediaStreamSource(stream);
			const analyser = ctx.createAnalyser();
			analyser.fftSize = 256;
			source.connect(analyser);
			const data = new Uint8Array(analyser.frequencyBinCount);
			const tick = () => {
				if (!analyserRef.current) return; // monitor was stopped between frames
				analyser.getByteFrequencyData(data);
				const level = computeRmsLevel(data);
				const now = Date.now();
				// Feed the recorder's speech gate EVERY frame, before any mode gate below: the
				// auto-VAD is off in tap-to-talk by design, so that mode had no speech gate and a
				// silent recording still reached Whisper (which invents a sentence from its
				// vocabulary prompt rather than returning nothing).
				sttRef.current?.noteLevel(level);
				// Throttle the React state update — 60fps re-renders the whole chat and lags.
				if (now - lastLevelSetRef.current > LEVEL_THROTTLE_MS) { lastLevelSetRef.current = now; setAudioLevel(level); }
				// Never let the mic-level VAD end (and transcribe) a turn while the agent is
				// talking OR during the ~0.8s echo tail after — otherwise the recorder would
				// capture the agent's own TTS and transcribe it. Belt-and-braces with the
				// echo guard in handleResult (which drops the result if one slips through).
				const echoing = isEchoing(readGuard(), Date.now());
				// Whisper VAD: Whisper has no streaming results, so we detect end-of-turn
				// from the mic level (pure logic + tests in ./vad.ts). On a real pause it
				// stops recording → transcribe → send.
				if (!echoing && shouldAutoDetectEndOfTurn({ isWhisper: sttIsWhisperRef.current, paused: pausedForThinkingRef.current, muted: mutedRef.current, manualTalk: manualTalkRef.current })) {
					const decision = vadStep(vadStateRef.current, level, now, { silenceMs: silenceMsRef.current, sensitivity: vadSensitivityRef.current });
					if (decision === "end") {
						vadStateRef.current = initVad();
						// DICTATION GATE: if a live browser-dictation gate is running and heard
						// NO real words this turn, the "end" was silence / keyboard / background
						// noise (the amplitude VAD can't tell). Discard it — never upload to
						// Whisper (which would hallucinate a phrase), no "Transcribing/Working".
						// Only trust a gate that's proven alive, so a dead recognizer can't
						// black-hole real speech (then we fall back to sending + the noise filter).
						if (endOfTurnAction(gateSnapshot()) === "discard") {
							idleRecycleRef.current = true;
							clearVoiceText();
							sttRef.current?.stopDiscard();
						} else {
							// Whisper has no streaming results, so nothing shows between your pause
							// and the transcript landing (~1-2s). This used to write the literal
							// "Transcribing…" over the composer — which ERASED the words the user
							// had just spoken for the whole upload round trip (#281). The status
							// now moves on the pending bubble and the speech stays put.
							dictate({ type: "endOfTurn", at: now });
							sttRef.current?.stop();
						}
					} else if (decision === "idle") {
						// Mic sat open with nothing said — recycle the silent recording (no
						// Whisper upload, no buffer growth). Reopens via onEnd; skip the chime.
						vadStateRef.current = initVad();
						idleRecycleRef.current = true;
						clearVoiceText();
						sttRef.current?.stopDiscard();
					}
				}
				analyserRef.current.raf = requestAnimationFrame(tick);
			};
			analyserRef.current = { ctx, analyser, source, stream, ownsStream, raf: requestAnimationFrame(tick) };
		} catch {}
	}, [stopAudioMonitor, readGuard, gateSnapshot, dictate, clearVoiceText]);

	const onSendRef = useRef(opts.onSend);
	onSendRef.current = opts.onSend;
	const onRecoveredTextRef = useRef(opts.onRecoveredText);
	onRecoveredTextRef.current = opts.onRecoveredText;
	const onNextRef = useRef(opts.onNext);
	onNextRef.current = opts.onNext;
	/** "next" is only a COMMAND where something can act on it (#277) — see the option's doc.
	 *  A ref so the matchers read it live rather than closing over the mount-time value. */
	const canSwitchRef = useRef(false);
	canSwitchRef.current = !!opts.onNext;
	/** Declared up top (like ctrlSttRef) because the four command call sites are defined ABOVE
	 *  the teardown this needs — see `nextFromCommand`, assigned far below. */
	const nextFromCommandRef = useRef<() => void>(() => {});
	const onBackRef = useRef(opts.onBack);
	onBackRef.current = opts.onBack;
	/** "back" is only a COMMAND where something can act on it (#279) — same gate as canSwitch.
	 *  Separate from it on purpose: a surface may be able to go forward and not back. */
	const canBackRef = useRef(false);
	canBackRef.current = !!opts.onBack;
	/** The `back` twin of `nextFromCommandRef`, and declared here for the same reason. */
	const backFromCommandRef = useRef<() => void>(() => {});
	const onScrapRef = useRef(opts.onScrap);
	onScrapRef.current = opts.onScrap;
	/** "scrap" is only a COMMAND where something can act on it (#342). Same gate as canSwitch,
	 *  and it is ALSO how the live-partial paths withhold a destructive command from an interim
	 *  transcript — they simply don't pass it. */
	const canScrapRef = useRef(false);
	canScrapRef.current = !!opts.onScrap;
	// Ref so a changing prompt (e.g. repos attach later) is picked up on the next mic start.
	const transcribePromptRef = useRef(opts.transcribePrompt);
	transcribePromptRef.current = opts.transcribePrompt;
	/** The user's vocabulary UNIONed with what the platform derived (#372/#373), refreshed with
	 *  the voice config on every mic start — so attaching a repo changes the NEXT turn's bias. */
	const vocabularyRef = useRef<string[]>([]);
	/**
	 * The prompt ACTUALLY sent, and the same string the echo guard reads back.
	 *
	 * Two sources arrive at two times: the consumer knows the agent's capabilities at render, the
	 * vocabulary arrives with the voice config on every mic start. Joined here in ONE place because
	 * `isTranscribeBiasEcho` compares against the list that was SENT (#332) — a second, shorter copy
	 * of it would silently stop catching echoes.
	 */
	const biasPrompt = useCallback(() => extendTranscribePrompt(transcribePromptRef.current || "", vocabularyRef.current), []);
	// Ref so the technical flag is read lazily at TTS-create time (surfaces can resolve
	// after mount) — the TTS is created once, so re-create it if the flag flips.
	const technicalRef = useRef(opts.technical);
	technicalRef.current = opts.technical;
	// Send a transcript, attaching a saved-audio turn id when this turn had recorded
	// audio (Whisper). The upload is fire-and-forget; the message sends immediately.
	const emitSend = (text: string) => {
		// Did the final transcript drop most of what the live recognizer heard (#281)? A lost
		// tail used to be invisible — the partials were overwritten and only the final was ever
		// recorded, so "it isn't capturing everything I say" could not be told apart from a
		// mis-hearing. Now the two strings are compared and the discrepancy is reported, which
		// is what makes the cause (VAD cutting early / Whisper dropping the tail) identifiable
		// rather than guessed at. Off the durable log unless explicitly enabled — this is a
		// diagnostic, not a platform failure, and it must not flood the error log.
		const heard = lastHeardRef.current;
		lastHeardRef.current = "";
		if (heard && dictationDiverged(heard, text)) {
			console.warn("[voice] transcript lost content", { heard, final: text });
			let debug = false;
			try { debug = typeof localStorage !== "undefined" && !!localStorage.getItem("pags:voice-debug"); } catch {}
			if (debug) reportClientError("voice-transcript", "final transcript dropped content heard live", { heard, final: text });
		}
		// The two gates a transcript must clear (noise, then language) and whether this turn has a
		// recording worth an audio key — decided together, in order, by `planSend`.
		const blob = lastAudioBlobRef.current;
		lastAudioBlobRef.current = null;
		const plan = planSend(text, {
			heard,
			transcribePrompt: biasPrompt(),
			vocabulary: vocabularyRef.current,
			confirmLanguage: confirmLanguageRef.current,
			lang: voiceLangRef.current,
			audioBytes: blob?.size ?? 0,
			instanceId,
		});
		if (plan.action === "drop") {
			// The user "didn't say anything", or said it in a language we can't be sure we heard.
			// Ditch the recording and let the mic recycle instead of sending a phantom turn.
			setPaused(false);
			// The bubble was cleared by `finalize` before we got here, so a drop at this point is
			// invisible from every side — which is precisely why #377 could not be confirmed from the
			// data. Fixed message (de-duped per 30s), evidence in the context.
			reportClientError("voice", `voice turn dropped before sending — ${plan.reason}`, { transcript: text.slice(0, 200), path: "send" });
			// The language nudge asks them to repeat — never an automatic language switch. Noise
			// gets no notice at all: there is nothing for the user to do about a turn they didn't
			// take, and telling them there was one is the confusing part.
			if (plan.reason === "language") {
				flushSync(() => setNotice("Didn't catch your language — please say that again."));
				setTimeout(() => setNotice((s) => (s.startsWith("Didn't catch your language") ? "" : s)), 2800);
			}
			return;
		}
		if (plan.attachAudio && blob && instanceId) {
			const turnId = crypto.randomUUID();
			onSendRef.current(plan.text, { audioKey: turnId, dictation: plan.dictation });
			void uploadVoiceAudio(instanceId, turnId, blob);
		} else {
			// No saved audio (browser dictation, an empty clip, or no instance) — send the raw text.
			// NOTE: must be onSendRef, NOT emitSendRef — the latter is THIS function and
			// would recurse forever (stack overflow) on every dictation send.
			onSendRef.current(plan.text, plan.dictation ? { dictation: plan.dictation } : undefined);
		}
	};
	const emitSendRef = useRef(emitSend);
	emitSendRef.current = emitSend;
	const speakOnRef = useRef(speakOn);
	speakOnRef.current = speakOn;
	const convoOnRef = useRef(convoOn);
	convoOnRef.current = convoOn;
	// Freeze guard: if the recognizer keeps ending instantly, a convo-mode restart
	// loop can peg the CPU and hang the page. Track the last start + rapid-end count.
	const lastListenStartRef = useRef(0);
	const rapidEndsRef = useRef(0);
	// Conversation mode: buffer speech and only send after `silenceMs` of quiet, so a
	// mid-sentence pause doesn't cut you off. Configurable via voice settings.
	const pendingTextRef = useRef("");
	const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const silenceMsRef = useRef(1500);
	// Hands-free max recording duration: force-end the turn after this long regardless, so an
	// open/runaway mic can't record forever (configurable in Settings → Voice).
	const maxDictationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const maxDictationMsRef = useRef(60000);
	// The current handleResult's `finalize`, stashed so the max-duration timer can end the turn
	// the same way the silence timer does (honor command/stop-word, else send the pending text).
	const finalizeRef = useRef<(msg: string) => void>(() => {});
	// Whisper (AI) STT has no streaming results, so in conversation mode we detect the
	// end of a turn from the mic level ourselves (VAD), then stop → transcribe → send.
	const sttIsWhisperRef = useRef(false);
	// Adaptive end-of-turn detection (pure logic in ./vad.ts — unit-tested there).
	const vadStateRef = useRef(initVad());
	const vadSensitivityRef = useRef(1);
	// Whether hands-free voice commands (e.g. "repeat") are honored (from settings).
	const commandsEnabledRef = useRef(true);
	// Latch: a command/stop-word fired from an INTERIM transcript, so the trailing FINAL of
	// the same utterance must be swallowed (not re-fired / re-sent). Reset on that final, and
	// on each new STT session (in case the mic stopped before a final arrived).
	const handledUtteranceRef = useRef(false);
	// Settings → Voice toggle: hold a screen wake lock during hands-free (default on).
	const keepAwakeRef = useRef(true);
	// Settings → Voice: custom hands-free command keywords (empty ⇒ built-in defaults;
	// stopWords off unless set). Read live so a settings change applies mid-session.
	const repeatWordsRef = useRef<string[]>([]);
	const muteWordsRef = useRef<string[]>([]);
	const unmuteWordsRef = useRef<string[]>([]);
	const exitWordsRef = useRef<string[]>([]);
	const nextWordsRef = useRef<string[]>([]);
	const scrapWordsRef = useRef<string[]>([]);
	const stopWordsRef = useRef<string[]>([]);
	// Say this (normalized) word/phrase while the agent is speaking to halt playback. Empty ⇒
	// off; when set, the recognizer is kept alive through TTS so it can hear it.
	const stopSpeechKeywordRef = useRef("");
	// Lock STT to the configured language (#126): drop a transcript detected as another language
	// rather than sending it (which made the agent reply in the wrong language). Default on.
	const confirmLanguageRef = useRef(true);
	// True while reopening the mic after an idle recycle — suppresses the "your turn"
	// chime (there was no agent turn, so a chime every idle window would be confusing).
	const idleRecycleRef = useRef(false);
	const lastLevelSetRef = useRef(0);
	// The agent's last reply text — re-spoken by the "repeat" voice command.
	const lastSpokenTextRef = useRef("");
	// The raw audio of the just-transcribed Whisper turn — saved for replay on send.
	const lastAudioBlobRef = useRef<Blob | null>(null);

	/**
	 * Copy a resolved config into the refs the live loop reads. The ONE place this mapping
	 * exists: it is applied both on mount (below) and on every mic start (makeStt re-reads
	 * settings so a change in Settings → Voice takes effect without a page reload), and the
	 * two copies had to be kept identical by hand. A setting added to only one of them
	 * behaved differently depending on whether you had opened the mic yet.
	 *
	 * Stable (no deps) — it only writes refs, so it never needs to be rebuilt.
	 */
	const applyConfig = useCallback((c: VoiceConfig) => {
		silenceMsRef.current = c.silenceMs;
		maxDictationMsRef.current = c.maxDictationMs;
		sttIsWhisperRef.current = c.sttProvider === "openai";
		vadSensitivityRef.current = c.sensitivity;
		commandsEnabledRef.current = c.commandsEnabled;
		keepAwakeRef.current = c.keepAwake;
		repeatWordsRef.current = c.repeatWords;
		muteWordsRef.current = c.muteWords;
		unmuteWordsRef.current = c.unmuteWords;
		exitWordsRef.current = c.exitWords;
		nextWordsRef.current = c.nextWords;
		scrapWordsRef.current = c.scrapWords;
		stopWordsRef.current = c.stopWords;
		stopSpeechKeywordRef.current = c.stopSpeechKeyword;
		confirmLanguageRef.current = c.confirmLanguage;
		voiceLangRef.current = c.language;
		vocabularyRef.current = c.vocabulary;
	}, []);

	useEffect(() => {
		getVoiceConfig(instanceId).then(applyConfig).catch(() => {});
	}, [instanceId, applyConfig]);

	const ensureTts = useCallback(async () => {
		if (!ttsRef.current) {
			ttsRef.current = await createTts(instanceId, { technical: technicalRef.current });
		} else {
			// The single TTS instance lives for the whole page session — keep it in sync
			// with current settings (provider/voice/speed/language/length can all change in
			// Settings mid-session; getVoiceConfig is cached so this is cheap).
			const cfg = await getVoiceConfig(instanceId);
			ttsRef.current.provider = cfg.ttsProvider;
			ttsRef.current.voice = cfg.voice;
			ttsRef.current.speed = cfg.speed;
			ttsRef.current.language = cfg.language;
			ttsRef.current.maxChars = cfg.ttsMaxChars;
			ttsRef.current.technical = technicalRef.current === true;
		}
		return ttsRef.current;
	}, [instanceId]);

	// Open mic with chime
	const startListening = useCallback(async () => {
		if (!sttRef.current || !canOpenMic(readGuard())) return;
		// Yield the mic: stop the background control listener BEFORE the main recorder opens so
		// two recognizers never capture at once (#153). ctrlWantRef=false first, so its onEnd
		// doesn't auto-restart it into the main capture; the reconcile effect re-arms it when the
		// main mic later idles.
		ctrlWantRef.current = false;
		if (ctrlSttRef.current?.listening) { try { ctrlSttRef.current.stop(); } catch { /* already stopped */ } }
		try {
			await sttRef.current.start();
			lastListenStartRef.current = Date.now();
			// A fresh capture is not the turn the last mute interrupted (#420). Cleared HERE rather
			// than in unmute so the stamp survives an unmute that does not reopen the mic (muted
			// while the agent was thinking), which is exactly when the interrupted clip is still in
			// flight — and so it can never judge a turn recorded after it.
			mutedAtRef.current = 0;
			startAudioMonitor();
			setMicOn(true);
			if (convoOnRef.current && !idleRecycleRef.current) playListeningChime();
			idleRecycleRef.current = false;
			// Arm the hands-free max-duration cap: force-end the turn after maxDictationMs so an
			// open mic can't record forever. Re-armed each time the mic opens; cleared when a
			// turn finalizes. Whisper: stop the recorder (→ transcribe buffered audio → normal
			// send). Browser dictation: finalize the pending text (or just stop if none).
			if (maxDictationTimerRef.current) { clearTimeout(maxDictationTimerRef.current); maxDictationTimerRef.current = null; }
			if (convoOnRef.current) {
				maxDictationTimerRef.current = setTimeout(() => {
					maxDictationTimerRef.current = null;
					if (sttIsWhisperRef.current) {
						if (sttRef.current?.listening) sttRef.current.stop();
					} else {
						const msg = pendingTextRef.current.trim();
						if (msg) finalizeRef.current(msg);
						else flushSync(() => { clearVoiceText(); stopAudioMonitor(); if (sttRef.current?.listening) sttRef.current.stop(); setMicOn(false); });
					}
				}, maxDictationMsRef.current);
			}
		} catch {}
	}, [startAudioMonitor, stopAudioMonitor, readGuard, clearVoiceText]);

	// Speak text on demand (e.g. tap a message/translation to hear it), regardless of
	// whether an auto-speak/hands-free mode is active. maybeSpeakResponse is gated on
	// speakOn/convoOn — the wrong tool for a manual replay, which is why double-tap was
	// silent outside a voice mode. Unlock inside the caller's gesture so iOS plays it.
	// Manual-speak bookkeeping: a NEWER tap supersedes the current one (cancel, don't
	// queue), and the mic-resume intent must survive superseding taps — the FIRST tap
	// stopped the mic, so later taps see listening=false.
	const speakGenRef = useRef(0);
	const speakResumeRef = useRef(false);
	const speak = useCallback(async (text: string, lang?: string) => {
		if (!text?.trim()) return;
		unlockSpeechSynthesis();
		const myGen = ++speakGenRef.current;
		// Same mic protection as speakAndResume: a manual tap-to-hear can happen while
		// hands-free is LISTENING — without pausing, the recorder captures the TTS voice
		// (plus its echo tail) and sends the agent's own words back as a phantom turn.
		if (convoOnRef.current && sttRef.current?.listening) speakResumeRef.current = true;
		setPaused(true);
		if (sttRef.current?.listening) sttRef.current.stopDiscard(); // drop the partial capture
		setMicOn(false);
		setSpeaking(true);
		try {
			const tts = await ensureTts();
			// A tap means "say THIS, now" — cut off whatever is playing/queued instead of
			// queueing behind it (rapid word taps used to play back-to-back in a line).
			tts.cancel();
			await tts.unlock();
			// Optional per-utterance language (e.g. a translation spoken in ITS language).
			await tts.speak(text, lang ? { lang } : {});
		} catch {}
		if (speakGenRef.current !== myGen) return; // superseded — the newer tap owns the state
		setSpeaking(false);
		speakEndedAtRef.current = Date.now(); // arm the echo-tail guard, like speakAndResume
		setPaused(false);
		if (speakResumeRef.current) {
			speakResumeRef.current = false;
			await startListening();
		}
	}, [ensureTts, startListening, setPaused]);

	// Speak response, then re-open mic
	const speakAndResume = useCallback(async (text: string) => {
		// Hard-STOP the recognizer while the agent talks so it can never transcribe its
		// own voice. Critical for push-to-talk + auto-speak, where the recognizer keeps
		// running (it only flips micOn) and would otherwise hear the agent and reply to
		// itself. In conversation mode it's already paused; this just double-ensures it.
		// NOTE: we ALWAYS stop here — a previous experiment kept the recognizer alive through
		// TTS (for the stop-speech keyword) and left the mic effectively never stopping. The
		// stop-keyword now just fires on the first transcript after playback instead.
		setPaused(true);
		if (sttRef.current?.listening) sttRef.current.stop();
		setMicOn(false);
		setSpeaking(true);
		try {
			const tts = await ensureTts();
			await tts.speak(text);
		} catch {}
		setSpeaking(false);
		speakEndedAtRef.current = Date.now();
		// Now the agent is done — allow the mic to reopen. Only auto-resume in
		// conversation mode; push-to-talk waits for the next tap (so it can't self-trigger).
		setPaused(false);
		if (convoOnRef.current) {
			await startListening();
		}
	}, [ensureTts, startListening, setPaused]);

	const maybeSpeakResponse = useCallback((text: string) => {
		// Remember the last reply so a spoken "repeat" can re-speak it (even if we didn't
		// auto-speak this time — the user may enable voice then ask to repeat).
		if (text?.trim()) lastSpokenTextRef.current = text;
		// ADR 0001 M2 — "muting an agent that keeps talking is not mute". Mute cancelled only the
		// utterance in flight at that instant; it was not a STATE that suppressed speech starting
		// afterwards, so a reply arriving after the press was read aloud while the pill said
		// "Muted" (#420 leg 3). Nothing is lost: `lastSpokenTextRef` is set above, so "repeat"
		// re-speaks it after unmute.
		if (mutedRef.current) { setPaused(false); return; }
		if (speakOnRef.current || convoOnRef.current) {
			speakAndResume(text);
		} else {
			// Not speaking — allow mic restart for next convo turn
			setPaused(false);
		}
	}, [speakAndResume, setPaused]);

	// "repeat" voice command → re-speak the agent's last reply (and, in hands-free,
	// reopen the mic afterwards, same as a normal turn). Ref-backed so the STT result
	// handler can call it without widening its dependency list.
	const repeatLast = useCallback(() => {
		const last = lastSpokenTextRef.current;
		if (last) {
			speakAndResume(last);
		} else {
			setPaused(false);
			if (convoOnRef.current) startListening();
		}
	}, [speakAndResume, startListening, setPaused]);
	const repeatLastRef = useRef(repeatLast);
	repeatLastRef.current = repeatLast;

	// "mute" voice command → mute the mic until the user unmutes in the app (same as the
	// Mute button). Flip the ref synchronously so in-flight results stop being processed.
	// "mute" means "be quiet": it silences the AGENT too (cancel any in-flight/queued TTS),
	// not just the user's mic — so it works as an interrupt while the agent is speaking (#153).
	//
	// It also must not cost the user the sentence they had already finished saying (#420). What
	// happens to that turn is decided by `planMuteTeardown`, not by the arrival time of the
	// transcript: `pendingTurn: "send"` is the #228 case where mute rides on the end of a request
	// and the request must still go; everywhere else the words go to the composer, either from
	// here or — when a clip is still uploading — via `classifyResult`'s `recover` when it lands.
	const muteFromCommand = useCallback((pendingTurn: "send" | "recover" = "recover") => {
		const plan = planMuteTeardown({
			ttsSpeaking: !!ttsRef.current?.speaking, // read BEFORE cancel() — after it, always false
			pendingTurn,
			isWhisper: sttIsWhisperRef.current,
			dictation: dictationRef.current,
		});
		mutedRef.current = true;
		setMuted(true);
		sttRef.current?.stop(); // stop(), never stopDiscard() — #228: the clip must still upload
		ttsRef.current?.cancel(); // stop the agent mid-sentence + drop the queue
		setSpeaking(false);
		if (plan.armEchoTail) speakEndedAtRef.current = Date.now();
		stopAudioMonitor();
		setMicOn(false);
		if (pendingTurn === "recover") mutedAtRef.current = Date.now();
		if (plan.keepPending) return; // the transcript is coming; the bubble stays to receive it
		if (plan.recoverText) {
			// Same treatment `leaveForSwitch` gives a destroyed utterance: the noise filter keeps a
			// pure-echo "turn" out of the composer, and a rejection is LOGGED rather than vanishing.
			const noise = planNoiseRejection(plan.recoverText, { gate: gateSnapshot() });
			if (noise.action === "discard") reportClientError("voice", noise.report, { transcript: plan.recoverText.slice(0, 200), path: "mute" });
			else onRecoveredTextRef.current?.(plan.recoverText);
		}
		clearVoiceText();
	}, [stopAudioMonitor, clearVoiceText, gateSnapshot]);
	const muteFromCommandRef = useRef(muteFromCommand);
	muteFromCommandRef.current = muteFromCommand;

	// "unmute" voice command → re-open the mic (#152). The SINGLE unmute implementation:
	// toggleMute delegates here rather than repeating it, because this is where the
	// stale-ref trap lives — startListening bails on `mutedRef.current`, which React only
	// refreshes on the next render, so a version that set state alone left the mic shut and
	// looked exactly like the bug this command exists to fix.
	const unmuteFromCommand = useCallback(() => {
		mutedRef.current = false;
		setMuted(false);
		playStartCue();
		if (convoOnRef.current && !pausedForThinkingRef.current) startListening();
	}, [startListening]);
	const unmuteFromCommandRef = useRef(unmuteFromCommand);
	unmuteFromCommandRef.current = unmuteFromCommand;

	// "exit voice" voice command (#165) → leave voice entirely and go back to typing.
	// setVoiceMode is defined far below (it depends on toggleConvo), so it is reached through
	// a ref rather than hoisted — the control listener has to be able to call it from here.
	const setVoiceModeRef = useRef<((m: VoiceMode) => Promise<void>) | null>(null);
	const exitFromCommand = useCallback(() => {
		mutedRef.current = false; // don't leave a muted flag behind for the next voice session
		setMuted(false);
		// Silence the agent NOW, the way "mute" does. setVoiceMode cancels TTS too, but only after
		// awaiting the hands-free teardown — and a user who has just said "stop" (#331) is listening
		// for whether anything stopped, not for a reply that keeps talking over the answer.
		ttsRef.current?.cancel();
		setSpeaking(false);
		speakEndedAtRef.current = Date.now();
		void setVoiceModeRef.current?.("text");
	}, []);
	const exitFromCommandRef = useRef(exitFromCommand);
	exitFromCommandRef.current = exitFromCommand;

	// ── Always-on background control-word listener (#153) ──────────────────────────────────
	// The mute (and stop-speech) commands used to be reachable ONLY inside the main
	// transcription paths — i.e. only while the mic was actively recording a user turn. So
	// while the agent was SPEAKING or PROCESSING (mic closed), "mute" could never fire. This is
	// a lightweight, SEPARATE browser-dictation loop whose ONLY job is to catch a control word at
	// ANY moment. It runs whenever voice is engaged but the main recorder is idle (see
	// shouldRunControlListener), so it never fights the main pipeline. Null on browsers without
	// Web Speech (e.g. iOS Safari) — the feature degrades to the existing in-turn detection.
	// (ctrlSttRef / ctrlWantRef are declared up top so startListening can yield the mic.)

	const handleControlResult = useCallback((text: string, isFinal: boolean) => {
		if (!text?.trim() || !commandsEnabledRef.current) return;
		// Stop-speech keyword: interrupt the agent's TTS the instant it's heard. Deliberately left
		// OUTSIDE the echo hardening below: it is gated on the agent SPEAKING, which is what contains
		// its loose substring matcher, and interrupting playback is the one command whose entire
		// purpose is to fire while the agent talks. The worst a self-match can do is end the agent's
		// own sentence early.
		if (matchesStopSpeech({ keyword: stopSpeechKeywordRef.current, text, ttsSpeaking: !!ttsRef.current?.speaking })) {
			ttsRef.current?.cancel();
			setSpeaking(false);
			speakEndedAtRef.current = Date.now();
			return;
		}
		// Control words — honored at ANY time. `muted` is passed so unmute is matched ONLY while
		// muted (and mute/repeat are inert there); see matchVoiceCommand.
		//
		// ECHO (#386) — and READ docs/adr/0001-mute-is-always-available.md (M3) before changing it.
		// This is the ONLY listener running while the agent speaks, so it is also the only one that
		// cannot answer speaker→mic bleed by dropping the result: that would delete mute-during-TTS,
		// the capability #153 built it for. `echoing` raises the bar inside that window instead (no
		// partials, whole-utterance only), which separates a deliberate "mute mute" from the agent
		// saying "Stop me if this is wrong". The rule is in commandStateFor, with what it costs.
		//
		// `canScrap` is deliberately NOT passed. This listener has no scrap dispatch, and now that it
		// states the REAL transcript kind, passing the flag would quietly enable a destructive command
		// on a path that cannot act on it (and would let it mask a command below it in the order).
		const cmd = matchVoiceCommand(
			text,
			{ mute: muteWordsRef.current, unmute: unmuteWordsRef.current, exit: exitWordsRef.current, next: nextWordsRef.current, scrap: scrapWordsRef.current, stopSpeech: stopSpeechKeywordRef.current },
			voiceLangRef.current,
			commandStateFor(isFinal ? "final" : "partial", {
				muted: mutedRef.current,
				canSwitch: canSwitchRef.current,
				// #279: this listener is live exactly when the mic is closed — the agent talking or
				// thinking — which is the moment a user realises they were handed somewhere they did
				// not want. commandStateFor drops the flag on a partial, so only a finished "go back"
				// can reach it here.
				canBack: canBackRef.current,
				echoing: isEchoing(readGuard(), Date.now()),
			}),
		);
		if (cmd === "mute") muteFromCommandRef.current();
		else if (cmd === "unmute") unmuteFromCommandRef.current();
		else if (cmd === "exit") exitFromCommandRef.current();
		// This listener is the ONLY one running while the agent speaks or thinks and the mic is
		// closed — i.e. exactly when a hands-free user has nothing to look at and most wants out.
		else if (cmd === "next") nextFromCommandRef.current();
		else if (cmd === "back") backFromCommandRef.current();
	}, [readGuard]);
	const handleControlResultRef = useRef(handleControlResult);
	handleControlResultRef.current = handleControlResult;

	/** Lazily build the dedicated control-word recognizer (browser Web Speech only — it must
	 *  run alongside a Whisper main pipeline without a getUserMedia conflict, and yields to the
	 *  main recognizer when the main path is browser dictation). Returns null when unsupported. */
	const ensureControlStt = useCallback((): VoiceStt | null => {
		if (typeof window === "undefined") return null;
		if (!(window.SpeechRecognition || window.webkitSpeechRecognition)) return null;
		if (!ctrlSttRef.current) {
			ctrlSttRef.current = new VoiceStt("browser", {
				language: voiceLangRef.current,
				// Interim AND final both reach the handler; which one this is now MATTERS (#386), so it
				// is passed through rather than discarded at the boundary.
				onResult: (text, isFinal) => handleControlResultRef.current(text, isFinal),
				/**
				 * This handler used to be empty, with a comment naming "mic denied" as an expected
				 * case (#425). It is the listener that carries ADR 0001 M1 in every phase where the
				 * mic is closed — the agent speaking or thinking — so a denial here DELETES
				 * mute-by-voice, and it did so with no error row, no notice and no state change.
				 * An ADR 0001 violation was unobservable in production by construction.
				 *
				 * Two different verdicts, deliberately:
				 *  - REPORT covers a missing device too, because that is diagnostic.
				 *  - STOP RE-ARMING is narrower, and only for the two codes the browser can only
				 *    produce by refusing. `onEnd` re-starts on every end, Chrome ends a continuous
				 *    recognizer after a short silence, and Chrome activates the mic on every
				 *    `start()` — so against a non-persistent grant this loop IS the "asks me all the
				 *    time" report. But `audio-capture` can come from two recognizers contending for
				 *    one device, and latching on that would silently disable mute for the rest of
				 *    the session, i.e. cause the exact failure this ticket exists to expose.
				 */
				onError: (err) => {
					const code = String(err ?? "");
					if (!isReportableMicError(code)) return; // no-speech / aborted: ordinary churn
					reportClientError("voice-control", `control listener refused the microphone: ${code}`, { code });
					if (!isMicPermissionDenied(code)) return;
					ctrlWantRef.current = false;
					// Said ONCE, not once per restart. ADR 0001's known hole, reached the other way:
					// with no control listener the on-screen mute is the whole invariant, so the
					// user has to be told which channel they have left.
					setNotice("⚠ Voice commands are off — the microphone is blocked for this site.");
				},
				onEnd: () => { if (ctrlWantRef.current) { try { ctrlSttRef.current?.start(); } catch { /* SR busy */ } } },
			});
		} else {
			ctrlSttRef.current.language = voiceLangRef.current;
		}
		return ctrlSttRef.current;
	}, []);

	const handleResult = useCallback((text: string, isFinal: boolean) => {
		// Stop-speech keyword: checked FIRST, BEFORE the echo/paused guard below — because while
		// the agent is speaking that guard would otherwise drop every result as echo. If the
		// configured keyword appears (case-insensitive substring) while TTS is playing, halt
		// playback + clear the queue immediately. Only acts when the agent is actually speaking,
		// so a false match just ends the agent's own turn early (contained). Opt-in per instance.
		if (matchesStopSpeech({ keyword: stopSpeechKeywordRef.current, text, ttsSpeaking: !!ttsRef.current?.speaking })) {
			ttsRef.current?.cancel(); // cancel current + any queued utterances
			setSpeaking(false);
			speakEndedAtRef.current = Date.now();
			flushSync(() => clearVoiceText());
			return;
		}
		// Ignore results the interaction model says we can't act on right now:
		//  - ECHO (ALL MODES): while the agent speaks OR within its ~0.8s echo tail — it's
		//    the agent's own voice, not you (the "it transcribes what it's saying" fix). A
		//    manual tap-to-talk clears speakEndedAtRef in beginTalk, so it isn't blocked.
		//  - PAUSED: a late result (e.g. a Whisper transcript that lands after the mode was
		//    turned off) must not fall through and send a turn the user already abandoned.
		//
		// …but "paused" covered a THIRD case it had no business dropping (#175): speech captured
		// BEFORE the pause began — the user was still talking when the agent's reply arrived. That
		// audio is theirs, it transcribed fine, and it died here silently. classifyResult splits
		// that out by capture time: it is RECOVERED into the composer (visible + sendable) rather
		// than sent blind into a conversation that has since moved on.
		const verdict = classifyResult(
			{ ...readGuard(), captureStartedAt: lastListenStartRef.current, pausedAt: pausedAtRef.current, mutedAt: mutedAtRef.current },
			Date.now(),
		);
		if (verdict === "ignore") {
			// This was the ONE drop path in the whole voice pipeline with no report (#420) — compare
			// every sibling below and in `onError`. A turn that dies here leaves no message, no
			// bubble and no error row, so "my words disappeared" was unanswerable from the data. It
			// is usually the agent's own voice tail, which is why it is a debug-level count rather
			// than a notice; the transcript rides along because it is the only evidence of what came
			// back. `reportClientError` de-dups per message per 30s, so an echo-heavy room cannot
			// flood the log (#423).
			if (isFinal && text?.trim()) reportClientError("voice", "result ignored (echo tail or a turn already abandoned)", { transcript: text.trim().slice(0, 200), path: "ignore" });
			return;
		}
		if (verdict === "recover") {
			// Only a FINAL transcript is a turn — a streaming partial would hand back a fragment
			// and then hand back the same words again when the final lands.
			if (!isFinal) return;
			// A command already consumed this utterance — its words ARE the command, so recovering
			// them would drop the literal word "mute" into the composer. The latch is normally read
			// below; a muted turn reaches this branch first, so it has to be honoured here too.
			if (handledUtteranceRef.current) { handledUtteranceRef.current = false; return; }
			// Browser dictation accumulates across results, so the recovered turn is everything
			// said this capture, not just the last fragment.
			const soFar = utteranceSoFar({ pending: pendingTextRef.current, text, handsFree: convoOnRef.current, isWhisper: sttIsWhisperRef.current });
			pendingTextRef.current = "";
			if (silenceTimerRef.current) { clearTimeout(silenceTimerRef.current); silenceTimerRef.current = null; }
			lastAudioBlobRef.current = null; // nothing is being sent, so no replay clip to attach
			const recovered = stripStopWord(soFar, stopWordsRef.current).text.trim();
			flushSync(() => clearVoiceText());
			// The echo tail can still put a word of the agent's own voice in front of a real turn;
			// the same noise filter emitSend uses keeps a pure-noise "turn" out of the composer. A
			// rejection HERE is the #377 shape too — the bubble is already gone one line above, so a
			// dropped recovery leaves nothing anywhere. When the gate vouched for the speech it goes
			// to the composer anyway: that is visible and editable, never auto-sent, which is the
			// whole recover contract (#175) and costs a line the user can clear if we were wrong.
			if (recovered) {
				const noise = planNoiseRejection(recovered, { gate: gateSnapshot() });
				if (noise.action === "discard") reportClientError("voice", noise.report, { transcript: recovered.slice(0, 200), path: "recover" });
				else onRecoveredTextRef.current?.(recovered);
			}
			return;
		}

		// A command already fired from an interim this utterance — swallow the trailing final
		// (and any interims between) so it can't double-fire or send the command as a message.
		// The FINAL closes the utterance and re-arms detection for the next one.
		if (handledUtteranceRef.current) {
			if (isFinal) handledUtteranceRef.current = false;
			return;
		}

		// Real-time keyword detection: fire a repeat/mute command the INSTANT a partial
		// transcript is the command, instead of waiting for the final result or the silence
		// timer. Matching is whole-utterance (matchVoiceCommand) against the turn-so-far
		// (accumulated finals in browser-dictation + this partial), so precision is preserved —
		// a normal sentence that merely contains the word is never hijacked. Works for every
		// configured command keyword (built-in repeat/mute per language + user overrides) and in
		// both conversation and push-to-talk. A final-only result (no interim) still falls
		// through to the existing final-path handling below.
		//
		// "partial" by definition (#342), so commandStateFor drops the destructive flag: the
		// sentence "scrap that idea and let's move on" passes through the partial "scrap that" on
		// its way to being said. Scrap is handled on the FINAL, in `planFinalizedTurn` and in the
		// push-to-talk final below.
		if (!isFinal && commandsEnabledRef.current) {
			const combined = utteranceSoFar({ pending: pendingTextRef.current, text, handsFree: convoOnRef.current, isWhisper: sttIsWhisperRef.current });
			const cmd = combined
				? matchVoiceCommand(
						combined,
						{ repeat: repeatWordsRef.current, mute: muteWordsRef.current, unmute: unmuteWordsRef.current, exit: exitWordsRef.current, next: nextWordsRef.current, scrap: scrapWordsRef.current, stopSpeech: stopSpeechKeywordRef.current },
						voiceLangRef.current,
						commandStateFor("partial", { muted: mutedRef.current, canSwitch: canSwitchRef.current, canScrap: canScrapRef.current, canBack: canBackRef.current }),
					)
				: null;
			if (cmd) {
				handledUtteranceRef.current = true;
				if (silenceTimerRef.current) { clearTimeout(silenceTimerRef.current); silenceTimerRef.current = null; }
				pendingTextRef.current = "";
				if (cmd === "repeat") {
					flushSync(() => { clearVoiceText(); stopAudioMonitor(); if (sttRef.current?.listening) sttRef.current.stop(); setMicOn(false); });
					repeatLastRef.current();
				} else if (cmd === "next") {
					// The utterance WAS the command, so clear it first: nextFromCommand would
					// otherwise "recover" the word "next" into the composer of the agent we land on.
					flushSync(() => { clearVoiceText(); stopAudioMonitor(); if (sttRef.current?.listening) sttRef.current.stop(); setMicOn(false); });
					nextFromCommandRef.current();
				} else {
					flushSync(() => clearVoiceText());
					if (cmd === "mute") muteFromCommandRef.current();
					else if (cmd === "unmute") unmuteFromCommandRef.current();
					else exitFromCommandRef.current();
				}
				return;
			}
		}

		// Conversation mode.
		if (convoOnRef.current) {
			// Finalize a hands-free turn. WHAT the turn is — scrap / repeat / a message with a
			// trailing command / nothing but a command — is decided by `planFinalizedTurn`, on a
			// "final" transcript, so the ordering that makes it safe is unit-tested rather than
			// read. What is left here is the sequencing that ordering demands. Shared by the
			// Whisper path, the silence timer, and the stop-word early-flush so all three behave
			// identically.
			const finalize = (msg: string) => {
				if (silenceTimerRef.current) { clearTimeout(silenceTimerRef.current); silenceTimerRef.current = null; }
				if (maxDictationTimerRef.current) { clearTimeout(maxDictationTimerRef.current); maxDictationTimerRef.current = null; }
				pendingTextRef.current = "";
				const plan = planFinalizedTurn(msg, {
					commandsEnabled: commandsEnabledRef.current,
					canScrap: canScrapRef.current,
					canSwitch: canSwitchRef.current,
					canBack: canBackRef.current,
					muted: mutedRef.current,
					words: { repeat: repeatWordsRef.current, mute: muteWordsRef.current, unmute: unmuteWordsRef.current, exit: exitWordsRef.current, next: nextWordsRef.current, scrap: scrapWordsRef.current, stopSpeech: stopSpeechKeywordRef.current },
					lang: voiceLangRef.current,
					stopWords: stopWordsRef.current,
				});
				// `onScrap` only STAGES a delete for the consumer to confirm; nothing is removed on
				// the strength of one transcript.
				if (plan.action === "scrap") {
					flushSync(() => clearVoiceText());
					onScrapRef.current?.();
					return;
				}
				// "go back" consumes the turn: the words would otherwise be fired at the agent being
				// LEFT, which is the one the user just said they were done with. Cleared first, so the
				// teardown has no pending utterance to "recover" the command itself into the composer
				// of wherever we land.
				if (plan.action === "back") {
					flushSync(() => { clearVoiceText(); stopAudioMonitor(); if (sttRef.current?.listening) sttRef.current.stop(); setMicOn(false); });
					backFromCommandRef.current();
					return;
				}
				if (plan.action === "repeat") {
					// "repeat" asks to hear the LAST reply — sending a new message first would replace it.
					flushSync(() => { clearVoiceText(); stopAudioMonitor(); if (sttRef.current?.listening) sttRef.current.stop(); setMicOn(false); });
					repeatLastRef.current();
					return;
				}
				// The trailing command applies FIRST — the user asked for silence in the same breath
				// as the request, and getting it after the send is getting it late. "send", because
				// the transcript is already in hand here and `plan.text` is emitted below: this path
				// never consults `classifyResult`, and clearing the bubble is finalize's own job.
				if (plan.command === "mute") muteFromCommandRef.current("send");
				else if (plan.command === "unmute") unmuteFromCommandRef.current();
				else if (plan.command === "exit") exitFromCommandRef.current();
				if (plan.action === "none") {
					// Nothing to send — the turn was the command. Leave now rather than sitting on
					// a mic the user has already walked away from.
					flushSync(() => clearVoiceText());
					if (plan.switchAfter) nextFromCommandRef.current();
					return;
				}
				flushSync(() => {
					clearVoiceText();
					stopAudioMonitor();
					setPaused(true);
					if (sttRef.current?.listening) sttRef.current.stop();
					setMicOn(false);
					playThinkingChime();
				});
				emitSendRef.current(plan.text);
				// "…, next" is a message AND a departure, and the ORDER is the point: the message
				// belongs to the agent being LEFT, so it is sent from here before the switch tears
				// the session down. Switching first would fire it at whoever we land on. The reply
				// lands in that agent's own transcript and outlives the tab (#252) — the #278
				// indicator is what makes that visible from wherever we go next.
				if (plan.switchAfter) nextFromCommandRef.current();
			};
			finalizeRef.current = finalize; // so the max-duration timer can end the turn identically
			// Whisper: `text` is the full transcribed turn (our VAD already detected the
			// pause). Send it straight away — no interim accumulation or debounce.
			if (sttIsWhisperRef.current) {
				if (isFinal && text.trim()) {
					const t = text.trim();
					// Silence/echo hallucination ("you", ".", "\"") — you weren't talking. Don't
					// send, don't chime; let the mic keep listening (onEnd reopens it). This is the
					// "I'm not talking, don't submit" fix, and it is unchanged. What changed (#377) is
					// what the rejection COSTS: it used to clear the turn outright, so a user who HAD
					// spoken watched their words appear and then vanish with nothing written anywhere.
					// `planNoiseRejection` asks the gate which of the two happened.
					const noise = planNoiseRejection(t, { transcribePrompt: biasPrompt(), gate: gateSnapshot() });
					if (noise.action !== "pass") {
						// Logged either way. A discard is the case that could not be confirmed from the
						// data at all — no message, no trace event, no error row — and the transcript
						// rides in the context because it is the only evidence of what came back.
						reportClientError("voice", noise.report, { transcript: t.slice(0, 200), path: "handsFree" });
						// `failed` keeps the live capture on the bubble with a reason and the existing
						// Dismiss, instead of erasing the words the user just watched appear.
						flushSync(() => { if (noise.action === "keep") dictate({ type: "failed", note: noise.note, at: Date.now() }); else clearVoiceText(); });
						return;
					}
					finalize(t);
				} else if (!isFinal && text.trim()) {
					// Streaming partial (gpt-4o-transcribe) — the words land live in the pending
					// bubble. The reducer holds the status at `transcribing` through these, since
					// they are the transcription arriving, not the mic reopening.
					flushSync(() => dictate({ type: "speech", text, at: Date.now() }));
				}
				return;
			}
			// Browser dictation: accumulate speech and only SEND after the user has been
			// quiet for `silenceMs` — UNLESS a stop-word ("...copy") ends the turn now. Every
			// result resets the timer, so a short mid-sentence pause no longer cuts them off.
			if (isFinal && text.trim()) {
				pendingTextRef.current = `${pendingTextRef.current} ${text}`.trim();
				if (stopWordsRef.current.length && stripStopWord(pendingTextRef.current, stopWordsRef.current).ended) {
					finalize(pendingTextRef.current.trim());
					return;
				}
			}
			// Real-time stop-word: end the turn the moment "…copy" appears in a PARTIAL, without
			// waiting for its final. Latch so the trailing final is swallowed; finalize strips the
			// stop-word and sends what came before (or nothing if the stop-word was said alone).
			if (!isFinal && text.trim() && stopWordsRef.current.length) {
				const combinedNow = utteranceSoFar({ pending: pendingTextRef.current, text, handsFree: true, isWhisper: false });
				if (stripStopWord(combinedNow, stopWordsRef.current).ended) {
					handledUtteranceRef.current = true;
					finalize(combinedNow);
					return;
				}
			}
			flushSync(() => dictate({ type: "speech", text: `${pendingTextRef.current}${isFinal ? "" : ` ${text}`}`.trim(), at: Date.now() }));
			if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
			silenceTimerRef.current = setTimeout(() => {
				const msg = pendingTextRef.current.trim();
				if (msg) finalize(msg);
			}, silenceMsRef.current);
			return;
		}

		// Push-to-talk: send immediately on the recognizer's final result.
		if (isFinal) {
			flushSync(() => {
				clearVoiceText();
				stopAudioMonitor();
				setMicOn(false);
			});
			if (commandsEnabledRef.current) {
				const cmd = matchVoiceCommand(
					text.trim(),
					{ repeat: repeatWordsRef.current, mute: muteWordsRef.current, unmute: unmuteWordsRef.current, exit: exitWordsRef.current, next: nextWordsRef.current, scrap: scrapWordsRef.current, stopSpeech: stopSpeechKeywordRef.current },
					voiceLangRef.current,
					// "final" — one of only two sites where a destructive command may be judged
					// (#342). Tap-to-talk is also where the auto-VAD is off, so this really is the
					// whole utterance the user chose to send, not a guess at where they stopped.
					commandStateFor("final", { muted: mutedRef.current, canSwitch: canSwitchRef.current, canScrap: canScrapRef.current, canBack: canBackRef.current }),
				);
				if (cmd === "repeat") { repeatLastRef.current(); return; }
				if (cmd === "mute") { muteFromCommandRef.current(); return; }
				if (cmd === "scrap") { onScrapRef.current?.(); return; }
				// clearVoiceText already ran in the flushSync above, so there is no pending
				// utterance for the switch to mistake for words worth recovering.
				if (cmd === "next") { nextFromCommandRef.current(); return; }
				if (cmd === "back") { backFromCommandRef.current(); return; }
			}
			const sent = stripStopWord(text.trim(), stopWordsRef.current).text.trim();
			if (sent) emitSendRef.current(sent);
		} else {
			// Push-to-talk partial — same treatment as every other live word: into the thread,
			// not the composer.
			flushSync(() => dictate({ type: "speech", text, at: Date.now() }));
		}
	}, [stopAudioMonitor, readGuard, gateSnapshot, setPaused, dictate, clearVoiceText, biasPrompt]);

	const makeStt = useCallback(async () => {
		// Pick up voice-settings changes (recognition mode / pause) WITHOUT a page reload, and
		// refresh the refs the VAD and debounce use. makeStt runs on every mic/conversation
		// start, so this used to invalidate + re-fetch on the hot path: a full round trip (two,
		// when an OpenAI provider forces the /v1/keys/status check) standing between the tap and
		// getUserMedia, which measurement made the dominant await in #284. Serving the cached
		// config and revalidating behind it removes that wait outright; the settings change lands
		// on the next start instead of this one, which is the right way round — nobody is on the
		// settings screen at the moment they tap the mic.
		try {
			applyConfig(await getVoiceConfig(instanceId, { refresh: "background" }));
		} catch {}
		// Fresh session — re-arm interim keyword detection (covers the case where a command
		// muted/stopped the mic before its final result ever arrived to reset the latch).
		handledUtteranceRef.current = false;
		const stt = await createStt(instanceId, {
			transcribePrompt: biasPrompt(),
			onResult: handleResult,
			// Stash the turn's recorded audio so emitSend can save it for replay.
			onAudio: (blob) => { lastAudioBlobRef.current = blob; },
			onError: (err) => {
				console.warn("[voice] STT error:", err);
				// Soft "no-speech" = empty transcription (silence, echo, or the agent's own
				// voice tail). NOT an error: clear the "Transcribing…" placeholder so it
				// doesn't hang, unpause, and let the mic recycle (hands-free reopens via
				// onEnd; other modes just go idle). No scary message, no durable-log entry.
				const kind = classifyVoiceError(err ? String(err) : null);
				if (kind === "soft") {
					// Nothing was said — the turn is genuinely empty, so retiring the bubble
					// loses nothing. (This used to reach into the composer and match the
					// "Transcribing…" sentinel by string; the state is explicit now.)
					flushSync(() => clearVoiceText());
					setPaused(false);
					if (!convoOnRef.current) setMicOn(false);
					return;
				}
				if (kind === "mic-unavailable") {
					// User-environment (mic blocked / no device), NOT a platform bug. Stop the
					// loop so we don't retry into a dead mic and flood the durable log; show a
					// clear one-time hint. No reportClientError.
					const msg = `⚠ ${micUnavailableMessage(String(err))}`;
					// Real speech may already be on screen — mark the bubble failed rather than
					// clearing it, so the words (and the saved recording) survive the failure.
					dictate({ type: "failed", note: micUnavailableMessage(String(err)), at: Date.now() });
					flushSync(() => setNotice(msg));
					setPaused(false);
					setConvoOn(false);
					setMicOn(false);
					setTimeout(() => setNotice((cur) => (cur === msg ? "" : cur)), 6000);
					return;
				}
				if (err) {
					// Surface into the durable log so voice failures (Whisper 400 etc.) are
					// visible server-side — EXCEPT transient connectivity ("Whisper failed:
					// Load failed"), which floods the log on every mobile network blip and is
					// not a platform bug (same class api() already skips).
					//
					// A transcription DEADLINE is exempted from that skip (#421). `isConnectivityError`
					// matches /timed? ?out|aborted/, so the one failure this ticket exists to make
					// countable would have been filtered out by the helper that hides network noise —
					// and a stall is not a blip: it is the thing we need rows for before the 20s
					// first-byte deadline can safely be tightened.
					if (!isConnectivityError(String(err)) || String(err) === TRANSCRIBE_TIMEOUT_MESSAGE) {
						reportClientError("voice", String(err), { sttWhisper: sttIsWhisperRef.current });
					}
					// Surface real errors (Whisper 401/400, mic denied) as a notice —
					// otherwise a swallowed failure is indistinguishable from "nothing
					// happened", which is exactly how Whisper looked broken.
					const msg = `⚠ ${err}`;
					// The transcription failed, so the ONLY surviving record of the turn is what
					// the live gate heard plus the saved recording. Keep the bubble and say it
					// failed — "a failed transcription leaves the bubble with its partials and
					// the recording, not an empty gap" (#281).
					dictate({ type: "failed", note: String(err), at: Date.now() });
					flushSync(() => setNotice(msg));
					setPaused(false);
					// Auto-clear so a stale error isn't still on screen next turn. (It no longer
					// locks the input — a notice is not voice owning the turn, #364.) Only clears
					// if it's still showing this same error.
					setTimeout(() => setNotice((cur) => (cur === msg ? "" : cur)), 4500);
				}
				if (!convoOnRef.current) setMicOn(false);
			},
			onEnd: () => {
				if (convoOnRef.current && !pausedForThinkingRef.current) {
					// Recognizer ended mid-conversation. If it keeps ending instantly we're in
					// a failing restart loop (mic blocked / abort) — decideRestart counts those
					// and bails after a few so the page never freezes. (Pure + unit-tested.)
					const { bail, nextRapidEnds, rapidEnds } = decideRestart(Date.now() - lastListenStartRef.current, rapidEndsRef.current);
					rapidEndsRef.current = nextRapidEnds;
					if (bail) {
						// Giving up is a RESULT, and it used to be the only path here that produced no
						// evidence of itself (#387) — the toggle flipped back and nothing said why, which
						// reads as a crash. Both halves, because they answer different questions: the
						// notice is the only thing that helps the user (every cause is theirs to fix and
						// only if named), the durable row is the only thing that makes "it keeps dropping
						// out on my phone" countable. planRestartBail holds both, and the reason the
						// notice is NOT auto-cleared like the error notices above it.
						const plan = planRestartBail({ rapidEnds, sttWhisper: sttIsWhisperRef.current });
						reportClientError("voice", plan.report, plan.context);
						flushSync(() => setNotice(plan.notice));
						setConvoOn(false);
						setMicOn(false);
						return;
					}
					setTimeout(() => {
						if (convoOnRef.current && !pausedForThinkingRef.current) startListening();
					}, RESTART_DELAY_MS);
				} else if (!convoOnRef.current) {
					setMicOn(false);
				}
			},
		});
		return stt;
	}, [instanceId, handleResult, startListening, setPaused, applyConfig, clearVoiceText, dictate, biasPrompt]);

	const toggleMic = useCallback(async () => {
		if (micOn) {
			sttRef.current?.stop();
			stopAudioMonitor();
			setMicOn(false);
			clearVoiceText();
			return;
		}
		try {
			setPaused(false);
			sttRef.current = await makeStt();
			await sttRef.current.start();
			startAudioMonitor();
			setMicOn(true);
		} catch { setMicOn(false); }
	}, [micOn, makeStt, startAudioMonitor, stopAudioMonitor, setPaused, clearVoiceText]);

	const toggleSpeak = useCallback(() => {
		// Prime TTS on this tap so a later async reply can actually speak (iOS/Safari):
		// unlock synchronously, and warm the TTS audio context (the OpenAI-voice path
		// needs a running AudioContext created inside the gesture, not lazily later).
		setSpeakOn((v) => {
			if (!v) { unlockSpeechSynthesis(); void ensureTts().then((t) => t.unlock()).catch(() => {}); }
			return !v;
		});
	}, [ensureTts]);

	// ── Screen Wake Lock (hands-free) ────────────────────────────────────────────
	// The one thing iOS actually lets a PWA do to "keep talking": hold a screen wake
	// lock so the display doesn't dim/lock mid-conversation and suspend the page + mic.
	// It CANNOT keep listening once you switch apps or lock manually — WebKit suspends
	// the web context and revokes the mic; there is no background audio-input API on the
	// web. The best we can do on returning to the app is re-acquire the lock and restart
	// the mic (below), since iOS killed it while we were away.
	const wakeLockRef = useRef<{ release: () => Promise<void> } | null>(null);
	const acquireWakeLock = useCallback(async () => {
		if (!keepAwakeRef.current || wakeLockRef.current) return; // off in Settings → screen may sleep
		const nav = navigator as Navigator & { wakeLock?: { request: (t: "screen") => Promise<{ release: () => Promise<void> }> } };
		try { if (nav.wakeLock?.request) wakeLockRef.current = await nav.wakeLock.request("screen"); }
		catch { /* unsupported / denied — hands-free still works while the app is foreground */ }
	}, []);
	const releaseWakeLock = useCallback(() => {
		try { void wakeLockRef.current?.release(); } catch { /* already gone */ }
		wakeLockRef.current = null;
	}, []);

	// Full hands-free teardown — flip the ref FIRST (so any in-flight onEnd handler or queued
	// restart timer sees convo is off and does NOT re-open the mic; state updates the ref only
	// on the next render — too late), then stop the mic, TTS, timers, wake lock, and state.
	// Extracted so the single-hands-free coordinator can call it to stop another view's session.
	const stopConvo = useCallback(() => {
		convoOnRef.current = false;
		manualTalkRef.current = false;
		setPaused(true);
		if (silenceTimerRef.current) { clearTimeout(silenceTimerRef.current); silenceTimerRef.current = null; }
		if (maxDictationTimerRef.current) { clearTimeout(maxDictationTimerRef.current); maxDictationTimerRef.current = null; }
		pendingTextRef.current = "";
		sttRef.current?.stop();
		ttsRef.current?.cancel();
		setSpeaking(false);
		stopAudioMonitor();
		releaseWakeLock();
		setConvoOn(false);
		setTalking(false);
		setMicOn(false);
		clearVoiceText();
	}, [stopAudioMonitor, releaseWakeLock, setPaused, clearVoiceText]);
	const stopConvoRef = useRef(stopConvo);
	stopConvoRef.current = stopConvo;

	/**
	 * END this agent's voice session because the conversation is moving, and answer with the mode
	 * to reopen in on the far side.
	 *
	 * THREE triggers share this and must never disagree about the mic: "next" (#277 — the user
	 * picks), "go back" (#279 — the user reverses a transfer), and an agent-mediated TRANSFER
	 * (#279 — the destination arrives on the chat response, so there is no command at all and the
	 * consumer calls this directly). They differ only in who chose the destination.
	 *
	 * Unlike every other command this does not change a setting: it ends the session here and lets
	 * the consumer open another. The order is the whole reason the decision is a pure function
	 * (`prepareConversationSwitch`) rather than four lines repeated at each call site:
	 *
	 *   1. resolve what the switch would destroy, from ONE snapshot;
	 *   2. hand back any real words it would have destroyed (the #175 contract);
	 *   3. cut the outgoing agent's TTS — it must not talk over the agent you arrive at;
	 *   4. stop the mic here, and return which mode to REOPEN it in over there.
	 *
	 * `stopConvo` also releases the app-wide hands-free slot, so the session started on the other
	 * agent claims it cleanly rather than racing a recognizer on its way out. The consumer then
	 * navigates, which unmounts this hook — nothing after this call may assume otherwise.
	 */
	const leaveForSwitch = useCallback((): VoiceMode | null => {
		const prep = prepareConversationSwitch({
			mode: resolveVoiceMode(convoOnRef.current, speakOnRef.current),
			ttsSpeaking: !!ttsRef.current?.speaking,
			dictation: dictationRef.current,
		});
		// Same rule as the recover path above: the switch is about to destroy this utterance, so a
		// rejection is only silent where nothing vouches for the speech — and even then it leaves a
		// breadcrumb rather than the turn evaporating on the way to another agent (#377).
		if (prep.recoverText) {
			const noise = planNoiseRejection(prep.recoverText, { gate: gateSnapshot() });
			if (noise.action === "discard") reportClientError("voice", noise.report, { transcript: prep.recoverText.slice(0, 200), path: "switch" });
			else onRecoveredTextRef.current?.(prep.recoverText);
		}
		if (prep.cancelSpeech) ttsRef.current?.cancel();
		setSpeaking(false);
		speakEndedAtRef.current = Date.now();
		mutedRef.current = false;
		setMuted(false);
		stopConvoRef.current();
		clearVoiceText();
		return prep.carryMode;
	}, [clearVoiceText, gateSnapshot]);
	const leaveForSwitchRef = useRef(leaveForSwitch);
	leaveForSwitchRef.current = leaveForSwitch;

	/** "next" (#277) — hand the conversation to the agent that is asking for you. */
	const nextFromCommand = useCallback(() => {
		onNextRef.current?.({ carryMode: leaveForSwitchRef.current() });
	}, []);
	nextFromCommandRef.current = nextFromCommand;

	/** "go back" (#279) — return to the agent you were with before this one. Same teardown, a
	 *  different destination; the consumer resolves which agent that is. */
	const backFromCommand = useCallback(() => {
		onBackRef.current?.({ carryMode: leaveForSwitchRef.current() });
	}, []);
	backFromCommandRef.current = backFromCommand;

	// One hands-free session app-wide: entering hands-free stops any OTHER active session first,
	// then claims the shared slot; leaving it (or unmounting) releases the slot. Keyed on convoOn
	// so it fires for EVERY entry path (toggleConvo, setVoiceMode, unmount) across all views.
	const selfTokenRef = useRef({});
	// Deps are `[convoOn]` ON PURPOSE: selfTokenRef/stopConvoRef are stable refs and activeHandsFree is module state, so only convoOn may retrigger this. (Biome agrees today — no suppression needed. If it ever disagrees, suppress it; do NOT widen the deps.)
	useEffect(() => {
		if (!convoOn) return;
		if (activeHandsFree && activeHandsFree.token !== selfTokenRef.current) activeHandsFree.stop();
		activeHandsFree = { token: selfTokenRef.current, stop: () => stopConvoRef.current() };
		return () => { if (activeHandsFree?.token === selfTokenRef.current) activeHandsFree = null; };
	}, [convoOn]);

	const toggleConvo = useCallback(async () => {
		const action = resolveToggleAction({ starting: startingRef.current, active: convoOn });
		if (action === "ignore") return; // a start is already opening the device — never twice (#284)
		if (action === "stop") {
			stopConvo();
			return;
		}
		// Visible on THIS frame. Everything below flips only after two awaits (the config read
		// and getUserMedia, which opens a hardware device and may prompt for permission), so
		// until #284 the control looked untouched for the whole startup and the press read as
		// "nothing happened". flushSync because the awaits follow immediately — a batched update
		// would not paint until after the very wait it exists to cover.
		startingRef.current = true;
		flushSync(() => setStarting(true));
		// These three MUST stay here, synchronously inside the user gesture: iOS/Safari only
		// grants audio output from a gesture, and an AudioContext that is "suspended" OR
		// "interrupted" (Siri, a call, another app) has to be resumed before it will play.
		try { getAudioCtx().resume(); } catch {}
		unlockSpeechSynthesis(); // prime TTS on this tap so replies can speak (iOS/Safari)
		// Warm the TTS audio context inside the gesture too — the OpenAI-voice path
		// needs a running AudioContext, else the reply is silent (hands-free "no sound").
		void ensureTts().then((t) => t.unlock()).catch(() => {});
		try {
			setPaused(false);
			sttRef.current = await makeStt();
			await sttRef.current.start();
			startAudioMonitor();
			setConvoOn(true);
			setSpeakOn(true);
			setMicOn(true);
			void acquireWakeLock(); // keep the screen awake so hands-free doesn't get suspended
			// The chime confirms READY, not PRESSED — two different events, which is why the
			// spinner covers the gap before it rather than replacing it.
			playListeningChime();
		} catch (err) {
			setConvoOn(false);
			// This catch used to swallow the error whole. A user whose mic is denied, missing, or
			// held by another tab tapped, waited, and watched the control quietly go back to off —
			// indistinguishable from "you didn't press it" (#284). getUserMedia speaks a different
			// error dialect than Web Speech, so normalize it first and the existing classifier
			// gives the right hint.
			const code = normalizeMediaError(err);
			const msg = classifyVoiceError(code) === "mic-unavailable"
				? micUnavailableMessage(code)
				: "Couldn't start voice — please try again.";
			flushSync(() => setNotice(`⚠ ${msg}`));
			setTimeout(() => setNotice((cur) => (cur === `⚠ ${msg}` ? "" : cur)), 6000);
		} finally {
			// In a `finally` so a thrown start can never strand the spinner on forever.
			startingRef.current = false;
			setStarting(false);
		}
	}, [convoOn, stopConvo, makeStt, startAudioMonitor, ensureTts, acquireWakeLock, setPaused]);

	/** Stop speaking immediately (tap a message to interrupt). */
	const cancelSpeak = useCallback(() => {
		ttsRef.current?.cancel();
		speakResumeRef.current = false; // we reopen the mic ourselves below
		setSpeaking(false);
		// If in convo mode and not muted, re-open mic so user can talk
		setPaused(false);
		if (convoOnRef.current && !mutedRef.current) {
			startListening();
		}
	}, [startListening, setPaused]);

	// ── Push-to-talk within hands-free (tap the chat to talk, tap again to send) ──
	// The automatic VAD guesses when you've stopped — and gets it wrong (it once sent a
	// half-formed "Debugging the function."). This gives you the turn boundary: tap to
	// interrupt the agent + open the mic, tap again to transcribe + send.
	const beginTalk = useCallback(async () => {
		manualTalkRef.current = true;
		setTalking(true);
		ttsRef.current?.cancel();               // stop the agent mid-sentence
		setSpeaking(false);
		setPaused(false);
		mutedRef.current = false;               // a manual talk implies "listen to me now"
		if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
		pendingTextRef.current = "";
		vadStateRef.current = initVad();
		// We just cancelled TTS, so there's no speaker echo to guard against — clearing
		// this stops the echo guard from swallowing the START of the user's turn.
		speakEndedAtRef.current = 0;
		mutedAtRef.current = 0; // a manual talk revokes an earlier mute, and its verdict with it
		try {
			if (!sttRef.current) sttRef.current = await makeStt();
			if (!sttRef.current.listening) await sttRef.current.start();
			lastListenStartRef.current = Date.now();
			await startAudioMonitor();
			setMicOn(true);
			setMuted(false);
		} catch { manualTalkRef.current = false; setTalking(false); }
	}, [makeStt, startAudioMonitor, setPaused]);

	const endTalk = useCallback(() => {
		if (!manualTalkRef.current) return;
		manualTalkRef.current = false;
		setTalking(false);
		if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
		if (sttIsWhisperRef.current) {
			// Whisper: stop → onstop transcribes → handleResult (convo path) emits the send
			// and sets pausedForThinking, so the mic won't reopen until the reply returns.
			vadStateRef.current = initVad();
			// Same as the VAD end-of-turn above: the status moves, the words stay (#281).
			dictate({ type: "endOfTurn", at: Date.now() });
			sttRef.current?.stop();
			return;
		}
		// Browser dictation: the transcript is already accumulated — flush + send it now
		// instead of waiting on the silence debounce.
		const msg = pendingTextRef.current.trim();
		pendingTextRef.current = "";
		setPaused(true);
		flushSync(() => { clearVoiceText(); stopAudioMonitor(); setMicOn(false); });
		if (sttRef.current?.listening) sttRef.current.stop();
		if (msg) emitSendRef.current(msg);
		else setPaused(false);
	}, [stopAudioMonitor, setPaused, dictate, clearVoiceText]);

	/** One tap toggles a manual talk turn (start listening ↔ stop + send). */
	const toggleTalk = useCallback(() => {
		if (manualTalkRef.current) endTalk();
		else void beginTalk();
	}, [beginTalk, endTalk]);

	// Esc stops speech immediately, anywhere in the app.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") cancelSpeak(); };
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [cancelSpeak]);

	/**
	 * The WATCHDOG (#421) — belt-and-braces behind `stt.ts`'s two deadlines.
	 *
	 * Those cover the network. This covers everything else that can leave a turn stuck on
	 * "Transcribing…": a response that resolves but dispatches nothing, a handler that throws
	 * before it reports, a browser that never settles the promise at all. `transcribingAt` exists
	 * for exactly this and, before #421, `Dictation` carried a timestamp that NOTHING in the
	 * codebase ever compared to now — the field that makes a deadline trivial was already there and
	 * unused.
	 *
	 * Longer than both network deadlines on purpose, so the specific message wins the race and this
	 * only fires when the specific one did not happen. The outcome is the ordinary `failed` bubble:
	 * the words the live gate heard survive, the recording survives, Dismiss and Retry appear.
	 */
	useEffect(() => {
		if (dictation?.status !== "transcribing" || !dictation.transcribingAt) return;
		const timer = setTimeout(() => {
			if (dictationRef.current?.status !== "transcribing") return;
			reportClientError("voice", `${TRANSCRIBE_TIMEOUT_MESSAGE} (watchdog)`, { sttWhisper: sttIsWhisperRef.current });
			flushSync(() => dictate({ type: "failed", note: TRANSCRIBE_TIMEOUT_MESSAGE, at: Date.now() }));
			setPaused(false);
			if (!convoOnRef.current) setMicOn(false);
		}, Math.max(0, TRANSCRIBE_WATCHDOG_MS - (Date.now() - dictation.transcribingAt)));
		return () => clearTimeout(timer);
	}, [dictation, dictate, setPaused]);

	/**
	 * Re-send the SAME clip (#421). The audio is still in hand after any failure, so the answer to
	 * a timeout is a button rather than "say that again" — which matters most for the failure this
	 * was written for, where the user has already waited twenty seconds.
	 *
	 * Deliberately manual: an automatic retry doubles the wait before the user learns anything, and
	 * transcription is billed to their own OpenAI key.
	 */
	const retryDictation = useCallback(() => {
		const stt = sttRef.current;
		if (!stt?.canRetryTranscription()) return;
		setNotice("");
		flushSync(() => dictate({ type: "retry", at: Date.now() })); // re-arms the watchdog too
		void stt.retryTranscription();
	}, [dictate]);
	/** Is Retry worth offering on the failed bubble? Only for a failure a second attempt could
	 *  actually change — see `isRetryableVoiceError` for why a 400/401 gets no button. */
	const canRetryDictation = dictation?.status === "failed" && isRetryableVoiceError(dictation.note) && !!sttRef.current?.canRetryTranscription();

	// Returning to the app after a background trip: the browser auto-releases the wake
	// lock when hidden, and iOS suspends the page + revokes the mic. So on becoming
	// visible again during hands-free, re-acquire the lock and restart listening — the
	// loop was killed while we were away. (There is no way to keep it running in the
	// background; this just recovers cleanly instead of wedging silent.)
	useEffect(() => {
		const onVisible = () => {
			if (document.visibilityState !== "visible" || !convoOnRef.current) return;
			void acquireWakeLock();
			if (!mutedRef.current && !pausedForThinkingRef.current) void startListening();
		};
		document.addEventListener("visibilitychange", onVisible);
		return () => document.removeEventListener("visibilitychange", onVisible);
	}, [acquireWakeLock, startListening]);

	// Reconcile the always-on control-word listener (#153) whenever voice-engagement or the main
	// mic state changes. Engaged = ANY voice mode (hands-free continuous OR ptt); resolveVoiceMode
	// maps convoOn→handsfree and speakOn→ptt, so `convoOn || speakOn` is exactly "not text". It
	// runs while the agent speaks / thinks / is muted (mic closed) and yields to the main
	// recognizer while the main path is actively capturing a turn (micOn). This is what makes the
	// mute command interceptable at ANY moment, not just during active recording.
	useEffect(() => {
		const want = shouldRunControlListener({ engaged: convoOn || speakOn, mainRecording: micOn });
		ctrlWantRef.current = want;
		if (want) {
			const stt = ensureControlStt();
			if (stt && !stt.listening) { try { stt.start(); } catch { /* SR busy — onEnd re-arms */ } }
		} else {
			if (ctrlSttRef.current?.listening) { try { ctrlSttRef.current.stop(); } catch { /* already stopped */ } }
		}
	}, [convoOn, speakOn, micOn, ensureControlStt]);

	// Tear everything down on unmount — otherwise leaving the page mid-conversation
	// keeps the recognizer listening, the TTS speaking, and the mic stream + rAF loop alive.
	useEffect(() => () => {
		// Mark convo off + paused so no onEnd/resume path reopens the mic after we're
		// gone (would leak a getUserMedia stream + rAF loop on a dead component).
		convoOnRef.current = false;
		setPaused(true);
		if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
		sttRef.current?.stop();
		gateRef.current?.stop();
		ctrlWantRef.current = false;
		ctrlSttRef.current?.stop(); // stop the background control listener too
		ttsRef.current?.dispose(); // close the TTS AudioContext, not just cancel — else it leaks
		stopAudioMonitor();
		releaseWakeLock();
	}, [stopAudioMonitor, releaseWakeLock, setPaused]);

	// The on-screen control, and the SAME two implementations the voice commands use — see
	// docs/adr/0001-mute-is-always-available.md. M1 requires two channels, and M2 requires each of
	// them to silence BOTH directions. Until #388 only the unmute half delegated: the mute branch
	// was written out here again, one line short of `muteFromCommand`, and the missing line was
	// `tts.cancel()`. So pressing Mute while the agent talked closed the microphone and left it
	// talking — which is not mute, and which was invisible because every label, state and status
	// said "Muted". On a browser with no Web Speech API this button is the ONLY channel, so that
	// was the whole feature, gone, in the phase it exists for.
	const toggleMute = useCallback(() => {
		// Both directions delegate. `muteFromCommand` cancels in-flight + queued speech (M2) and
		// `unmuteFromCommand` reopens the mic rather than only clearing the flag (M4, the stale-ref
		// trap) — neither is safe to restate here, and a copy is how this one drifted.
		if (muted) unmuteFromCommandRef.current();
		else muteFromCommandRef.current();
	}, [muted]);

	// The three modes are derived from the primitives so there's ONE source of truth:
	// hands-free ⇒ continuous convo; ptt ⇒ replies aloud but no continuous listen; text
	// ⇒ silent. setVoiceMode is the only thing the UI needs to call.
	const mode = resolveVoiceMode(convoOn, speakOn);
	// The voice hook's own interaction phase (single model in machine.ts). `thinking`
	// (the agent generating a reply) is the CONSUMER's concern, so it's false here — the
	// consumer folds it in via resolveVoiceStatus. Exposed for debugging/telemetry/tests.
	// `transcribing` is now READ FROM STATE. It used to be `interim === "Transcribing…"` — the
	// phase model string-matching a sentinel in the composer, which is why signalling the status
	// required destroying the user's words, and why two consumers had to duplicate the same
	// literal to agree with it (#281).
	const transcribing = dictation?.status === "transcribing";
	const phase = derivePhase({ mode, thinking: false, speaking, transcribing, micOn, muted, starting });
	const setVoiceMode = useCallback(async (next: VoiceMode) => {
		const cur = resolveVoiceMode(convoOnRef.current, speakOnRef.current);
		if (next === cur) return;
		// ABANDON any in-flight turn cleanly BEFORE switching. Two bugs this prevents:
		//  - a phantom send: a recording left mid-turn would transcribe → the push-to-talk
		//    path would send a message the user never meant to send;
		//  - a leaked mic stream: on ptt→handsfree, toggleConvo opens a SECOND getUserMedia
		//    while the old recorder's stream is still live.
		// stopDiscard drops the audio (no transcription, no send) and stops the tracks;
		// paused swallows any late browser-dictation result.
		manualTalkRef.current = false;
		setTalking(false);
		if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
		pendingTextRef.current = "";
		setPaused(true);
		if (sttRef.current?.listening) sttRef.current.stopDiscard();
		if (next === "handsfree") {
			// toggleConvo does the full hands-free setup (mic + VAD + TTS unlock, in-gesture)
			// and resets pausedForThinking as it starts listening.
			setSpeakOn(true);
			if (!convoOnRef.current) await toggleConvo();
			return;
		}
		// Leaving hands-free (if we were in it) tears the continuous loop down cleanly.
		if (convoOnRef.current) await toggleConvo();
		ttsRef.current?.cancel();
		stopAudioMonitor();
		setMicOn(false);
		clearVoiceText();
		if (next === "text") {
			setSpeakOn(false);
		} else {
			// ptt: replies read aloud; each turn starts on a tap (beginTalk). Prime TTS in
			// this gesture so the first reply can actually speak on iOS/Safari.
			setSpeakOn(true);
			unlockSpeechSynthesis();
			void ensureTts().then((t) => t.unlock()).catch(() => {});
		}
	}, [toggleConvo, ensureTts, stopAudioMonitor, setPaused, clearVoiceText]);
	// Reachable from the control listener, which is declared far above this (see exitFromCommand).
	setVoiceModeRef.current = setVoiceMode;

	return {
		/** The active interaction mode + the ONLY setter the UI needs. */
		mode, setVoiceMode,
		/** The voice interaction phase (idle/starting/listening/transcribing/speaking/muted). */
		phase,
		micOn, speakOn, convoOn, muted,
		/** Transient NOTICE only (mic errors, the wrong-language nudge) — the user's words live in
		 *  `dictation`, not here (#281). Render it as its own banner: putting it in the composer's
		 *  `value` is what left the input claiming to be the live-speech surface (#364). Bind it
		 *  through `resolveComposer` and the shape is decided in one tested place. */
		notice,
		/**
		 * The utterance in flight: `{ text, status, startedAt, heard, note }`, or null between
		 * turns. Render it as a PENDING message in the thread — it appears the moment speech
		 * starts, carries a transcribing status while the clip uploads, and survives a failure
		 * with its words intact. The final transcript arrives separately via `onSend`, which is
		 * what replaces it.
		 */
		dictation,
		/** The clip is being transcribed (was a string-compare against a composer sentinel). */
		transcribing,
		/** A voice session is opening the mic — bind a spinner to acknowledge the press (#284). */
		starting,
		/** Dismiss a failed utterance the user has finished reading. */
		clearDictation: clearVoiceText,
		/** Re-send the same clip after a failure that a second attempt could change (#421). Render
		 *  the button only when `canRetryDictation` — a 400/401 will fail identically and the
		 *  attempt costs the user's own credit. */
		retryDictation, canRetryDictation,
		/** 0-1 audio level from mic — use to render waveform */
		audioLevel,
		/** True while the agent is talking aloud (TTS) — drives the "Speaking…" status. */
		speaking,
		/** True while a manual push-to-talk turn is open (hands-free tap-to-talk). */
		talking,
		toggleMic, toggleSpeak, toggleConvo, toggleMute, cancelSpeak,
		/** Push-to-talk within hands-free: start/stop a manual turn, or toggle it. */
		beginTalk, endTalk, toggleTalk,
		maybeSpeakResponse,
		/** Speak text on demand (message replay), independent of auto-speak mode. */
		speak,
		/**
		 * End this voice session because the conversation is moving, and get back the mode to
		 * reopen in on the other side (#279). For the AGENT-MEDIATED transfer, which arrives on a
		 * chat response rather than as a spoken command — so the consumer, not this hook, is what
		 * knows a move is happening. Identical teardown to "next" and "go back": the same TTS cut,
		 * the same #175 recovery of a half-spoken turn, the same release of the hands-free slot.
		 */
		leaveForSwitch,
	};
}
