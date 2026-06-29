import { useState, useRef, useCallback, useEffect } from "react";
import { flushSync } from "react-dom";
import { createStt, createTts, getVoiceConfig, invalidateVoiceConfig } from "./config.js";
import type { VoiceStt } from "./stt.js";
import type { VoiceTts } from "./tts.js";

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
export function useVoice(instanceId: string | undefined, opts: {
	onSend: (text: string) => void;
}) {
	const [micOn, setMicOn] = useState(false);
	const [speakOn, setSpeakOn] = useState(false);
	const [convoOn, setConvoOn] = useState(false);
	const [muted, setMuted] = useState(false);
	const mutedRef = useRef(false);
	mutedRef.current = muted;
	const [interim, setInterim] = useState("");
	/** 0-1 audio level from mic — drives the waveform visualizer */
	const [audioLevel, setAudioLevel] = useState(0);
	const sttRef = useRef<VoiceStt | null>(null);
	const ttsRef = useRef<VoiceTts | null>(null);
	const analyserRef = useRef<{ ctx: AudioContext; analyser: AnalyserNode; source: MediaStreamAudioSourceNode; stream: MediaStream; raf: number } | null>(null);

	// Flag: true while the agent is processing (mic should stay off)
	const pausedForThinkingRef = useRef(false);

	const stopAudioMonitor = useCallback(() => {
		if (analyserRef.current) {
			cancelAnimationFrame(analyserRef.current.raf);
			analyserRef.current.source.disconnect();
			// Stop the mic tracks too — closing the AudioContext alone leaves the
			// MediaStream (and the browser "mic in use" indicator) alive.
			analyserRef.current.stream.getTracks().forEach((t) => t.stop());
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
		try {
			const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
			const ctx = new AudioContext();
			const source = ctx.createMediaStreamSource(stream);
			const analyser = ctx.createAnalyser();
			analyser.fftSize = 256;
			source.connect(analyser);
			const data = new Uint8Array(analyser.frequencyBinCount);
			const tick = () => {
				if (!analyserRef.current) return; // monitor was stopped between frames
				analyser.getByteFrequencyData(data);
				// RMS level normalized to 0-1
				let sum = 0;
				for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
				const level = Math.min(1, Math.sqrt(sum / data.length) / 128);
				setAudioLevel(level);
				// Whisper convo VAD: once we've heard voice, a sustained quiet of silenceMs
				// ends the turn → stop recording → transcribe → send (see handleResult).
				if (sttIsWhisperRef.current && convoOnRef.current && !pausedForThinkingRef.current) {
					const now = Date.now();
					if (level > 0.05) { vadLastLoudRef.current = now; vadVoiceSeenRef.current = true; }
					else if (vadVoiceSeenRef.current && now - vadLastLoudRef.current > silenceMsRef.current) {
						vadVoiceSeenRef.current = false;
						sttRef.current?.stop();
					}
				}
				analyserRef.current.raf = requestAnimationFrame(tick);
			};
			analyserRef.current = { ctx, analyser, source, stream, raf: requestAnimationFrame(tick) };
		} catch {}
	}, [stopAudioMonitor]);

	const onSendRef = useRef(opts.onSend);
	onSendRef.current = opts.onSend;
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
	const vadVoiceSeenRef = useRef(false);
	const vadLastLoudRef = useRef(0);
	useEffect(() => {
		getVoiceConfig(instanceId).then((c) => {
			silenceMsRef.current = c.silenceMs;
			sttIsWhisperRef.current = c.sttProvider === "openai";
		}).catch(() => {});
	}, [instanceId]);

	const ensureTts = useCallback(async () => {
		if (!ttsRef.current) ttsRef.current = await createTts(instanceId);
		return ttsRef.current;
	}, [instanceId]);

	// Open mic with chime
	const startListening = useCallback(async () => {
		if (!sttRef.current || pausedForThinkingRef.current || mutedRef.current) return;
		try {
			await sttRef.current.start();
			lastListenStartRef.current = Date.now();
			startAudioMonitor();
			setMicOn(true);
			if (convoOnRef.current) playListeningChime();
		} catch {}
	}, [startAudioMonitor]);

	// Speak response, then re-open mic
	const speakAndResume = useCallback(async (text: string) => {
		try {
			const tts = await ensureTts();
			await tts.speak(text);
		} catch {}
		// Now agent is done — allow mic to reopen
		pausedForThinkingRef.current = false;
		if (convoOnRef.current) {
			await startListening();
		}
	}, [ensureTts, startListening]);

	const maybeSpeakResponse = useCallback((text: string) => {
		console.log("[voice] maybeSpeakResponse, speakOn:", speakOnRef.current, "convoOn:", convoOnRef.current);
		if (speakOnRef.current || convoOnRef.current) {
			speakAndResume(text);
		} else {
			// Not speaking — allow mic restart for next convo turn
			pausedForThinkingRef.current = false;
		}
	}, [speakAndResume]);

	const handleResult = useCallback((text: string, isFinal: boolean) => {
		// Echo guard (CONVERSATION MODE ONLY): ignore the agent's own voice bleeding
		// into the mic during TTS — stops the self-triggering loop. Scoped to convo so
		// push-to-talk is NEVER blocked by a stuck speaking flag (there you control the
		// mic, so there's no feedback loop to guard against).
		if (convoOnRef.current && ttsRef.current?.speaking) return;
		// Swallow late results while paused — e.g. a Whisper transcription that lands
		// AFTER conversation mode was turned off would otherwise fall through to the
		// push-to-talk path and send the turn the user just abandoned. (Cleared whenever
		// a fresh mic session starts via toggleMic/toggleConvo.)
		if (pausedForThinkingRef.current) return;
		console.log("[voice]", isFinal ? "FINAL:" : "interim:", text);

		// Conversation mode.
		if (convoOnRef.current) {
			// Whisper: `text` is the full transcribed turn (our VAD already detected the
			// pause). Send it straight away — no interim accumulation or debounce.
			if (sttIsWhisperRef.current) {
				if (isFinal && text.trim()) {
					pausedForThinkingRef.current = true;
					flushSync(() => { setInterim(""); stopAudioMonitor(); setMicOn(false); playThinkingChime(); });
					onSendRef.current(text.trim());
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
				flushSync(() => {
					setInterim("");
					stopAudioMonitor();
					pausedForThinkingRef.current = true;
					if (sttRef.current?.listening) sttRef.current.stop();
					setMicOn(false);
					playThinkingChime();
				});
				onSendRef.current(msg);
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
			onSendRef.current(text);
		} else {
			flushSync(() => setInterim(text));
		}
	}, [stopAudioMonitor]);

	const makeStt = useCallback(async () => {
		console.log("[voice] creating STT, provider will be resolved...");
		// Pick up voice-settings changes (recognition mode / pause) WITHOUT a page
		// reload: invalidate the SDK cache, re-read, and refresh the refs the VAD and
		// debounce use. makeStt runs on every mic/conversation start.
		invalidateVoiceConfig();
		try {
			const c = await getVoiceConfig(instanceId);
			silenceMsRef.current = c.silenceMs;
			sttIsWhisperRef.current = c.sttProvider === "openai";
		} catch {}
		const stt = await createStt(instanceId, {
			onResult: handleResult,
			onError: (err) => {
				console.warn("[voice] STT error:", err);
				if (!convoOnRef.current) { setMicOn(false); setInterim(""); }
			},
			onEnd: () => {
				console.log("[voice] STT onEnd, convo:", convoOnRef.current, "paused:", pausedForThinkingRef.current);
				if (convoOnRef.current && !pausedForThinkingRef.current) {
					// If the recognizer just ended almost immediately after starting, we're
					// in a failing restart loop (mic blocked / instant abort). Back off, and
					// after a few rapid ends bail out of convo mode so the page never freezes.
					if (Date.now() - lastListenStartRef.current < 800) {
						rapidEndsRef.current += 1;
						if (rapidEndsRef.current >= 4) {
							rapidEndsRef.current = 0;
							setConvoOn(false);
							setMicOn(false);
							return;
						}
					} else {
						rapidEndsRef.current = 0;
					}
					setTimeout(() => {
						if (convoOnRef.current && !pausedForThinkingRef.current) startListening();
					}, 350);
				} else if (!convoOnRef.current) {
					setMicOn(false);
				}
			},
		});
		console.log("[voice] STT created, provider:", stt.provider);
		return stt;
	}, [instanceId, handleResult, startListening]);

	const toggleMic = useCallback(async () => {
		console.log("[voice] toggleMic, currently:", micOn);
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

	const toggleSpeak = useCallback(() => setSpeakOn((v) => !v), []);

	const toggleConvo = useCallback(async () => {
		console.log("[voice] toggleConvo, currently:", convoOn);
		if (convoOn) {
			// Turn OFF synchronously: flip the ref NOW so any in-flight onEnd handler or
			// queued restart timer sees convo is off and does NOT re-open the mic. (State
			// updates the ref only on the next render — too late, the mic restarts.)
			convoOnRef.current = false;
			pausedForThinkingRef.current = true;
			if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
			pendingTextRef.current = "";
			sttRef.current?.stop();
			ttsRef.current?.cancel();
			stopAudioMonitor();
			setConvoOn(false);
			setMicOn(false);
			setInterim("");
			return;
		}
		try { getAudioCtx().resume(); } catch {}
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
	}, [convoOn, makeStt, startAudioMonitor, stopAudioMonitor]);

	/** Stop speaking immediately (tap a message to interrupt). */
	const cancelSpeak = useCallback(() => {
		ttsRef.current?.cancel();
		// If in convo mode and not muted, re-open mic so user can talk
		pausedForThinkingRef.current = false;
		if (convoOnRef.current && !mutedRef.current) {
			startListening();
		}
	}, [startListening]);

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
		ttsRef.current?.cancel();
		stopAudioMonitor();
	}, [stopAudioMonitor]);

	const toggleMute = useCallback(() => {
		if (muted) {
			// Unmute: resume listening
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

	return {
		micOn, speakOn, convoOn, muted, interim,
		/** 0-1 audio level from mic — use to render waveform */
		audioLevel,
		toggleMic, toggleSpeak, toggleConvo, toggleMute, cancelSpeak,
		maybeSpeakResponse,
	};
}
