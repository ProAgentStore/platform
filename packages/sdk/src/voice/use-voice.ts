import { useState, useRef, useCallback, useEffect } from "react";
import { flushSync } from "react-dom";
import { createStt, createTts, getVoiceConfig, invalidateVoiceConfig } from "./config.js";
import { API, getToken, isConnectivityError, reportClientError } from "../client.js";
import { initVad, shouldAutoDetectEndOfTurn, vadStep } from "./vad.js";
import { computeRmsLevel, isNoiseTranscript } from "./audio.js";
import { decideRestart, matchVoiceCommand, resolveVoiceMode, type VoiceMode } from "./convo.js";
import type { VoiceStt } from "./stt.js";
import type { VoiceTts } from "./tts.js";

// ── Tunables (named, not scattered literals) ─────────────────────────────────
/** Throttle mic-level React updates to ~15fps — 60fps re-renders the chat + lags. */
const LEVEL_THROTTLE_MS = 66;
/** Pause before reopening the mic between conversation turns. */
const RESTART_DELAY_MS = 350;
/** Ignore the mic for this long after TTS ends — the speaker echo/reverb tail. */
const ECHO_GUARD_MS = 800;

/**
 * Unlock browser Text-to-Speech synchronously inside a user gesture. iOS/Safari
 * won't speak an utterance that's queued LATER (e.g. an async agent reply) unless
 * SpeechSynthesis was first invoked during a real tap — this is the "replied in text
 * but not voice" cause. Speaking an empty utterance on the toggle primes it.
 */
function unlockSpeechSynthesis() {
	try {
		if (typeof window !== "undefined" && window.speechSynthesis) {
			window.speechSynthesis.resume();
			// A volume-0 space (not an empty string): some engines ignore an empty
			// utterance, so it never counts as the gesture-initiated first speak that
			// iOS requires before a LATER async reply is allowed to speak.
			const u = new SpeechSynthesisUtterance(" ");
			u.volume = 0;
			window.speechSynthesis.speak(u);
		}
	} catch {}
}

// Short tones via Web Audio — no external files
let _audioCtx: AudioContext | null = null;
function getAudioCtx(): AudioContext {
	if (!_audioCtx) _audioCtx = new AudioContext();
	return _audioCtx;
}

function playTone(freq: number, dur: number, volume = 0.15) {
	try {
		const ctx = getAudioCtx();
		if (ctx.state === "suspended") ctx.resume();
		const osc = ctx.createOscillator();
		const gain = ctx.createGain();
		osc.type = "sine";
		osc.frequency.value = freq;
		gain.gain.value = volume;
		gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
		osc.connect(gain).connect(ctx.destination);
		osc.start();
		osc.stop(ctx.currentTime + dur);
	} catch {}
}

function playListeningChime() {
	playTone(600, 0.08);
	setTimeout(() => playTone(900, 0.1), 100);
}

function playThinkingChime() {
	playTone(500, 0.12);
	setTimeout(() => playTone(350, 0.15), 120);
}

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
/** Save a voice turn's audio to R2 so it can be replayed (double-tap the message).
 *  Fire-and-forget; a failure just means that turn has no replay, not a broken send. */
async function uploadVoiceAudio(instanceId: string, turnId: string, blob: Blob): Promise<void> {
	// NOTE: no `keepalive` — it caps the body at 64KB, but a voice recording is far
	// bigger, so keepalive made the PUT fail outright. Retry a few times so a transient
	// connection drop (common on mobile) doesn't lose the recording.
	const url = `${API}/v1/instances/${instanceId}/voice-audio/${turnId}`;
	let lastErr = "";
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			const res = await fetch(url, {
				method: "PUT",
				headers: { Authorization: `Bearer ${getToken() ?? ""}`, "Content-Type": blob.type || "audio/webm" },
				body: blob,
			});
			if (res.ok) return;
			lastErr = `HTTP ${res.status}`;
			if (res.status < 500) break; // 4xx won't succeed on retry
		} catch (e) {
			lastErr = e instanceof Error ? e.message : String(e);
		}
		await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
	}
	reportClientError("voice-audio", `save failed after retries: ${lastErr}`);
}

export type { VoiceMode };

export function useVoice(instanceId: string | undefined, opts: {
	/** Send a transcript. `meta.audioKey` is set for voice turns whose audio was saved. */
	onSend: (text: string, meta?: { audioKey?: string }) => void;
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
	const [interim, setInterim] = useState("");
	/** 0-1 audio level from mic — drives the waveform visualizer */
	const [audioLevel, setAudioLevel] = useState(0);
	const sttRef = useRef<VoiceStt | null>(null);
	const ttsRef = useRef<VoiceTts | null>(null);
	const analyserRef = useRef<{ ctx: AudioContext; analyser: AnalyserNode; source: MediaStreamAudioSourceNode; stream: MediaStream; ownsStream: boolean; raf: number } | null>(null);

	// Flag: true while the agent is processing (mic should stay off)
	const pausedForThinkingRef = useRef(false);

	const stopAudioMonitor = useCallback(() => {
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
				// Throttle the React state update — 60fps re-renders the whole chat and lags.
				if (now - lastLevelSetRef.current > LEVEL_THROTTLE_MS) { lastLevelSetRef.current = now; setAudioLevel(level); }
				// Never let the mic-level VAD end (and transcribe) a turn while the agent is
				// talking OR during the ~0.8s echo tail after — otherwise the recorder would
				// capture the agent's own TTS and transcribe it. Belt-and-braces with the
				// echo guard in handleResult (which drops the result if one slips through).
				const echoing = !!ttsRef.current?.speaking || Date.now() - speakEndedAtRef.current < ECHO_GUARD_MS;
				// Whisper VAD: Whisper has no streaming results, so we detect end-of-turn
				// from the mic level (pure logic + tests in ./vad.ts). On a real pause it
				// stops recording → transcribe → send.
				if (!echoing && shouldAutoDetectEndOfTurn({ isWhisper: sttIsWhisperRef.current, paused: pausedForThinkingRef.current, muted: mutedRef.current, manualTalk: manualTalkRef.current })) {
					const decision = vadStep(vadStateRef.current, level, now, { silenceMs: silenceMsRef.current, sensitivity: vadSensitivityRef.current });
					if (decision === "end") {
						vadStateRef.current = initVad();
						// Whisper has no streaming results, so nothing shows between your pause
						// and the transcript landing (~1-2s). Fill that gap so it's clearly
						// working, not stuck. Cleared when the result/onError arrives.
						setInterim("Transcribing…");
						sttRef.current?.stop();
					} else if (decision === "idle") {
						// Mic sat open with nothing said — recycle the silent recording (no
						// Whisper upload, no buffer growth). Reopens via onEnd; skip the chime.
						vadStateRef.current = initVad();
						idleRecycleRef.current = true;
						sttRef.current?.stopDiscard();
					}
				}
				analyserRef.current.raf = requestAnimationFrame(tick);
			};
			analyserRef.current = { ctx, analyser, source, stream, ownsStream, raf: requestAnimationFrame(tick) };
		} catch {}
	}, [stopAudioMonitor]);

	const onSendRef = useRef(opts.onSend);
	onSendRef.current = opts.onSend;
	// Ref so a changing prompt (e.g. repos attach later) is picked up on the next mic start.
	const transcribePromptRef = useRef(opts.transcribePrompt);
	transcribePromptRef.current = opts.transcribePrompt;
	// Ref so the technical flag is read lazily at TTS-create time (surfaces can resolve
	// after mount) — the TTS is created once, so re-create it if the flag flips.
	const technicalRef = useRef(opts.technical);
	technicalRef.current = opts.technical;
	// Send a transcript, attaching a saved-audio turn id when this turn had recorded
	// audio (Whisper). The upload is fire-and-forget; the message sends immediately.
	const emitSend = (text: string) => {
		// Universal gate: never submit a noise/hallucination transcript ("you", ".", "\"",
		// "Thank you." on silence/echo). The user "didn't say anything" — drop it, ditch the
		// recording, and let the mic recycle instead of sending a phantom turn.
		if (isNoiseTranscript(text)) {
			lastAudioBlobRef.current = null;
			pausedForThinkingRef.current = false;
			return;
		}
		const blob = lastAudioBlobRef.current;
		lastAudioBlobRef.current = null;
		if (blob && instanceId) {
			const turnId = crypto.randomUUID();
			onSendRef.current(text, { audioKey: turnId });
			void uploadVoiceAudio(instanceId, turnId, blob);
		} else {
			// No saved audio (browser dictation, or no instance) — send the raw text.
			// NOTE: must be onSendRef, NOT emitSendRef — the latter is THIS function and
			// would recurse forever (stack overflow) on every dictation send.
			onSendRef.current(text);
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
	// Whisper (AI) STT has no streaming results, so in conversation mode we detect the
	// end of a turn from the mic level ourselves (VAD), then stop → transcribe → send.
	const sttIsWhisperRef = useRef(false);
	// Adaptive end-of-turn detection (pure logic in ./vad.ts — unit-tested there).
	const vadStateRef = useRef(initVad());
	const vadSensitivityRef = useRef(1);
	// Whether hands-free voice commands (e.g. "repeat") are honored (from settings).
	const commandsEnabledRef = useRef(true);
	// True while reopening the mic after an idle recycle — suppresses the "your turn"
	// chime (there was no agent turn, so a chime every idle window would be confusing).
	const idleRecycleRef = useRef(false);
	const lastLevelSetRef = useRef(0);
	// When the agent last finished speaking — used to ignore the speaker echo tail.
	const speakEndedAtRef = useRef(0);
	// The agent's last reply text — re-spoken by the "repeat" voice command.
	const lastSpokenTextRef = useRef("");
	// The raw audio of the just-transcribed Whisper turn — saved for replay on send.
	const lastAudioBlobRef = useRef<Blob | null>(null);
	useEffect(() => {
		getVoiceConfig(instanceId).then((c) => {
			silenceMsRef.current = c.silenceMs;
			sttIsWhisperRef.current = c.sttProvider === "openai";
			vadSensitivityRef.current = c.sensitivity;
			commandsEnabledRef.current = c.commandsEnabled;
		}).catch(() => {});
	}, [instanceId]);

	const ensureTts = useCallback(async () => {
		if (!ttsRef.current) ttsRef.current = await createTts(instanceId, { technical: technicalRef.current });
		// Keep in sync if surfaces resolved after the TTS was created (single instance reused).
		else ttsRef.current.technical = technicalRef.current === true;
		return ttsRef.current;
	}, [instanceId]);

	// Speak text on demand (e.g. double-tap a message to replay it), regardless of
	// whether an auto-speak/hands-free mode is active. maybeSpeakResponse is gated on
	// speakOn/convoOn — the wrong tool for a manual replay, which is why double-tap was
	// silent outside a voice mode. Unlock inside the caller's gesture so iOS plays it.
	const speak = useCallback(async (text: string) => {
		if (!text?.trim()) return;
		unlockSpeechSynthesis();
		setSpeaking(true);
		try {
			const tts = await ensureTts();
			await tts.unlock();
			await tts.speak(text);
		} catch {}
		setSpeaking(false);
	}, [ensureTts]);

	// Open mic with chime
	const startListening = useCallback(async () => {
		if (!sttRef.current || pausedForThinkingRef.current || mutedRef.current) return;
		try {
			await sttRef.current.start();
			lastListenStartRef.current = Date.now();
			startAudioMonitor();
			setMicOn(true);
			if (convoOnRef.current && !idleRecycleRef.current) playListeningChime();
			idleRecycleRef.current = false;
		} catch {}
	}, [startAudioMonitor]);

	// Speak response, then re-open mic
	const speakAndResume = useCallback(async (text: string) => {
		// Hard-STOP the recognizer while the agent talks so it can never transcribe its
		// own voice. Critical for push-to-talk + auto-speak, where the recognizer keeps
		// running (it only flips micOn) and would otherwise hear the agent and reply to
		// itself. In conversation mode it's already paused; this just double-ensures it.
		pausedForThinkingRef.current = true;
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
		pausedForThinkingRef.current = false;
		if (convoOnRef.current) {
			await startListening();
		}
	}, [ensureTts, startListening]);

	const maybeSpeakResponse = useCallback((text: string) => {
		// Remember the last reply so a spoken "repeat" can re-speak it (even if we didn't
		// auto-speak this time — the user may enable voice then ask to repeat).
		if (text?.trim()) lastSpokenTextRef.current = text;
		if (speakOnRef.current || convoOnRef.current) {
			speakAndResume(text);
		} else {
			// Not speaking — allow mic restart for next convo turn
			pausedForThinkingRef.current = false;
		}
	}, [speakAndResume]);

	// "repeat" voice command → re-speak the agent's last reply (and, in hands-free,
	// reopen the mic afterwards, same as a normal turn). Ref-backed so the STT result
	// handler can call it without widening its dependency list.
	const repeatLast = useCallback(() => {
		const last = lastSpokenTextRef.current;
		if (last) {
			speakAndResume(last);
		} else {
			pausedForThinkingRef.current = false;
			if (convoOnRef.current) startListening();
		}
	}, [speakAndResume, startListening]);
	const repeatLastRef = useRef(repeatLast);
	repeatLastRef.current = repeatLast;

	const handleResult = useCallback((text: string, isFinal: boolean) => {
		// Echo guard (ALL MODES): ignore anything captured while the agent is speaking OR
		// within ~0.8s after (the speaker echo/reverb tail) — it's the agent's own voice,
		// not you. This is the fix for "it starts transcribing what it's saying": the mic
		// must never turn the agent's TTS into a transcript (and reply to itself). A manual
		// tap-to-talk clears speakEndedAtRef in beginTalk, so it isn't blocked by this.
		if (ttsRef.current?.speaking || Date.now() - speakEndedAtRef.current < ECHO_GUARD_MS) return;
		// Swallow late results while paused — e.g. a Whisper transcription that lands
		// AFTER conversation mode was turned off would otherwise fall through to the
		// push-to-talk path and send the turn the user just abandoned. (Cleared whenever
		// a fresh mic session starts via toggleMic/toggleConvo.)
		if (pausedForThinkingRef.current) return;

		// Conversation mode.
		if (convoOnRef.current) {
			// Whisper: `text` is the full transcribed turn (our VAD already detected the
			// pause). Send it straight away — no interim accumulation or debounce.
			if (sttIsWhisperRef.current) {
				if (isFinal && text.trim()) {
					const t = text.trim();
					// Silence/echo hallucination ("you", ".", "\"") — you weren't talking. Don't
					// send, don't chime; clear the placeholder and let the mic keep listening
					// (onEnd reopens it). This is the "I'm not talking, don't submit" fix.
					if (isNoiseTranscript(t)) { flushSync(() => setInterim("")); return; }
					if (commandsEnabledRef.current && matchVoiceCommand(t) === "repeat") {
						flushSync(() => { setInterim(""); stopAudioMonitor(); setMicOn(false); });
						repeatLastRef.current();
						return;
					}
					pausedForThinkingRef.current = true;
					flushSync(() => { setInterim(""); stopAudioMonitor(); setMicOn(false); playThinkingChime(); });
					emitSendRef.current(t);
				} else if (!isFinal && text.trim()) {
					// Streaming partial (gpt-4o-transcribe) — show the words landing live in
					// place of the static "Transcribing…" the VAD set on end-of-turn.
					flushSync(() => setInterim(text));
				}
				return;
			}
			// Browser dictation: accumulate speech and only SEND after the user has been
			// quiet for `silenceMs`. Every result resets the timer, so a short mid-sentence
			// pause no longer cuts them off — only a real pause sends.
			if (isFinal && text.trim()) {
				pendingTextRef.current = `${pendingTextRef.current} ${text}`.trim();
			}
			flushSync(() => setInterim(`${pendingTextRef.current}${isFinal ? "" : ` ${text}`}`.trim()));
			if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
			silenceTimerRef.current = setTimeout(() => {
				const msg = pendingTextRef.current.trim();
				pendingTextRef.current = "";
				if (!msg) return;
				if (commandsEnabledRef.current && matchVoiceCommand(msg) === "repeat") {
					flushSync(() => { setInterim(""); stopAudioMonitor(); if (sttRef.current?.listening) sttRef.current.stop(); setMicOn(false); });
					repeatLastRef.current();
					return;
				}
				flushSync(() => {
					setInterim("");
					stopAudioMonitor();
					pausedForThinkingRef.current = true;
					if (sttRef.current?.listening) sttRef.current.stop();
					setMicOn(false);
					playThinkingChime();
				});
				emitSendRef.current(msg);
			}, silenceMsRef.current);
			return;
		}

		// Push-to-talk: send immediately on the recognizer's final result.
		if (isFinal) {
			flushSync(() => {
				setInterim("");
				stopAudioMonitor();
				setMicOn(false);
			});
			if (commandsEnabledRef.current && matchVoiceCommand(text.trim()) === "repeat") { repeatLastRef.current(); return; }
			emitSendRef.current(text);
		} else {
			flushSync(() => setInterim(text));
		}
	}, [stopAudioMonitor]);

	const makeStt = useCallback(async () => {
		// Pick up voice-settings changes (recognition mode / pause) WITHOUT a page
		// reload: invalidate the SDK cache, re-read, and refresh the refs the VAD and
		// debounce use. makeStt runs on every mic/conversation start.
		invalidateVoiceConfig();
		try {
			const c = await getVoiceConfig(instanceId);
			silenceMsRef.current = c.silenceMs;
			sttIsWhisperRef.current = c.sttProvider === "openai";
			vadSensitivityRef.current = c.sensitivity;
			commandsEnabledRef.current = c.commandsEnabled;
		} catch {}
		const stt = await createStt(instanceId, {
			transcribePrompt: transcribePromptRef.current,
			onResult: handleResult,
			// Stash the turn's recorded audio so emitSend can save it for replay.
			onAudio: (blob) => { lastAudioBlobRef.current = blob; },
			onError: (err) => {
				console.warn("[voice] STT error:", err);
				// Soft "no-speech" = empty transcription (silence, echo, or the agent's own
				// voice tail). NOT an error: clear the "Transcribing…" placeholder so it
				// doesn't hang, unpause, and let the mic recycle (hands-free reopens via
				// onEnd; other modes just go idle). No scary message, no durable-log entry.
				if (!err || err === "no-speech") {
					flushSync(() => setInterim((cur) => (cur === "Transcribing…" ? "" : cur)));
					pausedForThinkingRef.current = false;
					if (!convoOnRef.current) setMicOn(false);
					return;
				}
				if (err) {
					// Surface into the durable log so voice failures (Whisper 400 etc.) are
					// visible server-side — EXCEPT transient connectivity ("Whisper failed:
					// Load failed"), which floods the log on every mobile network blip and is
					// not a platform bug (same class api() already skips).
					if (!isConnectivityError(String(err))) {
						reportClientError("voice", String(err), { sttWhisper: sttIsWhisperRef.current });
					}
					// Surface real errors (Whisper 401/400, mic denied) in the input —
					// otherwise a swallowed failure is indistinguishable from "nothing
					// happened", which is exactly how Whisper looked broken.
					const msg = `⚠ ${err}`;
					flushSync(() => setInterim(msg));
					pausedForThinkingRef.current = false;
					// Auto-clear so the error doesn't lock the input (readOnly while interim
					// is set). Only clears if it's still showing this same error.
					setTimeout(() => setInterim((cur) => (cur === msg ? "" : cur)), 4500);
				}
				if (!convoOnRef.current) setMicOn(false);
			},
			onEnd: () => {
				if (convoOnRef.current && !pausedForThinkingRef.current) {
					// Recognizer ended mid-conversation. If it keeps ending instantly we're in
					// a failing restart loop (mic blocked / abort) — decideRestart counts those
					// and bails after a few so the page never freezes. (Pure + unit-tested.)
					const { bail, nextRapidEnds } = decideRestart(Date.now() - lastListenStartRef.current, rapidEndsRef.current);
					rapidEndsRef.current = nextRapidEnds;
					if (bail) { setConvoOn(false); setMicOn(false); return; }
					setTimeout(() => {
						if (convoOnRef.current && !pausedForThinkingRef.current) startListening();
					}, RESTART_DELAY_MS);
				} else if (!convoOnRef.current) {
					setMicOn(false);
				}
			},
		});
		return stt;
	}, [instanceId, handleResult, startListening]);

	const toggleMic = useCallback(async () => {
		if (micOn) {
			sttRef.current?.stop();
			stopAudioMonitor();
			setMicOn(false);
			setInterim("");
			return;
		}
		try {
			pausedForThinkingRef.current = false;
			sttRef.current = await makeStt();
			await sttRef.current.start();
			startAudioMonitor();
			setMicOn(true);
		} catch { setMicOn(false); }
	}, [micOn, makeStt, startAudioMonitor, stopAudioMonitor]);

	const toggleSpeak = useCallback(() => {
		// Prime TTS on this tap so a later async reply can actually speak (iOS/Safari):
		// unlock synchronously, and warm the TTS audio context (the OpenAI-voice path
		// needs a running AudioContext created inside the gesture, not lazily later).
		setSpeakOn((v) => {
			if (!v) { unlockSpeechSynthesis(); void ensureTts().then((t) => t.unlock()).catch(() => {}); }
			return !v;
		});
	}, [ensureTts]);

	const toggleConvo = useCallback(async () => {
		if (convoOn) {
			// Turn OFF synchronously: flip the ref NOW so any in-flight onEnd handler or
			// queued restart timer sees convo is off and does NOT re-open the mic. (State
			// updates the ref only on the next render — too late, the mic restarts.)
			convoOnRef.current = false;
			manualTalkRef.current = false;
			pausedForThinkingRef.current = true;
			if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
			pendingTextRef.current = "";
			sttRef.current?.stop();
			ttsRef.current?.cancel();
			setSpeaking(false);
			stopAudioMonitor();
			setConvoOn(false);
			setTalking(false);
			setMicOn(false);
			setInterim("");
			return;
		}
		try { getAudioCtx().resume(); } catch {}
		unlockSpeechSynthesis(); // prime TTS on this tap so replies can speak (iOS/Safari)
		// Warm the TTS audio context inside the gesture too — the OpenAI-voice path
		// needs a running AudioContext, else the reply is silent (hands-free "no sound").
		void ensureTts().then((t) => t.unlock()).catch(() => {});
		try {
			pausedForThinkingRef.current = false;
			sttRef.current = await makeStt();
			await sttRef.current.start();
			startAudioMonitor();
			setConvoOn(true);
			setSpeakOn(true);
			setMicOn(true);
			playListeningChime();
		} catch { setConvoOn(false); }
	}, [convoOn, makeStt, startAudioMonitor, stopAudioMonitor, ensureTts]);

	/** Stop speaking immediately (tap a message to interrupt). */
	const cancelSpeak = useCallback(() => {
		ttsRef.current?.cancel();
		setSpeaking(false);
		// If in convo mode and not muted, re-open mic so user can talk
		pausedForThinkingRef.current = false;
		if (convoOnRef.current && !mutedRef.current) {
			startListening();
		}
	}, [startListening]);

	// ── Push-to-talk within hands-free (tap the chat to talk, tap again to send) ──
	// The automatic VAD guesses when you've stopped — and gets it wrong (it once sent a
	// half-formed "Debugging the function."). This gives you the turn boundary: tap to
	// interrupt the agent + open the mic, tap again to transcribe + send.
	const beginTalk = useCallback(async () => {
		manualTalkRef.current = true;
		setTalking(true);
		ttsRef.current?.cancel();               // stop the agent mid-sentence
		setSpeaking(false);
		pausedForThinkingRef.current = false;
		mutedRef.current = false;               // a manual talk implies "listen to me now"
		if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
		pendingTextRef.current = "";
		vadStateRef.current = initVad();
		// We just cancelled TTS, so there's no speaker echo to guard against — clearing
		// this stops the echo guard from swallowing the START of the user's turn.
		speakEndedAtRef.current = 0;
		try {
			if (!sttRef.current) sttRef.current = await makeStt();
			if (!sttRef.current.listening) await sttRef.current.start();
			lastListenStartRef.current = Date.now();
			await startAudioMonitor();
			setMicOn(true);
			setMuted(false);
		} catch { manualTalkRef.current = false; setTalking(false); }
	}, [makeStt, startAudioMonitor]);

	const endTalk = useCallback(() => {
		if (!manualTalkRef.current) return;
		manualTalkRef.current = false;
		setTalking(false);
		if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
		if (sttIsWhisperRef.current) {
			// Whisper: stop → onstop transcribes → handleResult (convo path) emits the send
			// and sets pausedForThinking, so the mic won't reopen until the reply returns.
			vadStateRef.current = initVad();
			setInterim("Transcribing…");
			sttRef.current?.stop();
			return;
		}
		// Browser dictation: the transcript is already accumulated — flush + send it now
		// instead of waiting on the silence debounce.
		const msg = pendingTextRef.current.trim();
		pendingTextRef.current = "";
		pausedForThinkingRef.current = true;
		flushSync(() => { setInterim(""); stopAudioMonitor(); setMicOn(false); });
		if (sttRef.current?.listening) sttRef.current.stop();
		if (msg) emitSendRef.current(msg);
		else pausedForThinkingRef.current = false;
	}, [stopAudioMonitor]);

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

	// Tear everything down on unmount — otherwise leaving the page mid-conversation
	// keeps the recognizer listening, the TTS speaking, and the mic stream + rAF loop alive.
	useEffect(() => () => {
		// Mark convo off + paused so no onEnd/resume path reopens the mic after we're
		// gone (would leak a getUserMedia stream + rAF loop on a dead component).
		convoOnRef.current = false;
		pausedForThinkingRef.current = true;
		if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
		sttRef.current?.stop();
		ttsRef.current?.dispose(); // close the TTS AudioContext, not just cancel — else it leaks
		stopAudioMonitor();
	}, [stopAudioMonitor]);

	const toggleMute = useCallback(() => {
		if (muted) {
			// Unmute: resume listening. Flip the REF now, not just the state — startListening
			// bails on `mutedRef.current`, which React only refreshes on the next render. So
			// calling it synchronously here read the stale `true` and the mic never reopened
			// (unmute did nothing). beginTalk sets the ref directly for the same reason.
			mutedRef.current = false;
			setMuted(false);
			if (convoOnRef.current && !pausedForThinkingRef.current) {
				startListening();
			}
		} else {
			// Mute: stop mic but keep convo mode on
			setMuted(true);
			sttRef.current?.stop();
			stopAudioMonitor();
			setMicOn(false);
			setInterim("");
		}
	}, [muted, startListening, stopAudioMonitor]);

	// The three modes are derived from the primitives so there's ONE source of truth:
	// hands-free ⇒ continuous convo; ptt ⇒ replies aloud but no continuous listen; text
	// ⇒ silent. setVoiceMode is the only thing the UI needs to call.
	const mode = resolveVoiceMode(convoOn, speakOn);
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
		pausedForThinkingRef.current = true;
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
		setInterim("");
		if (next === "text") {
			setSpeakOn(false);
		} else {
			// ptt: replies read aloud; each turn starts on a tap (beginTalk). Prime TTS in
			// this gesture so the first reply can actually speak on iOS/Safari.
			setSpeakOn(true);
			unlockSpeechSynthesis();
			void ensureTts().then((t) => t.unlock()).catch(() => {});
		}
	}, [toggleConvo, ensureTts, stopAudioMonitor]);

	return {
		/** The active interaction mode + the ONLY setter the UI needs. */
		mode, setVoiceMode,
		micOn, speakOn, convoOn, muted, interim,
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
	};
}
