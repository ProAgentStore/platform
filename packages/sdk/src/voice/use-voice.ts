import { useState, useRef, useCallback } from "react";
import { flushSync } from "react-dom";
import { createStt, createTts } from "./config.js";
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
	const analyserRef = useRef<{ ctx: AudioContext; analyser: AnalyserNode; source: MediaStreamAudioSourceNode; raf: number } | null>(null);

	// Flag: true while the agent is processing (mic should stay off)
	const pausedForThinkingRef = useRef(false);

	// Start audio level monitoring from mic stream
	const startAudioMonitor = useCallback(async () => {
		try {
			const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
			const ctx = new AudioContext();
			const source = ctx.createMediaStreamSource(stream);
			const analyser = ctx.createAnalyser();
			analyser.fftSize = 256;
			source.connect(analyser);
			const data = new Uint8Array(analyser.frequencyBinCount);
			const tick = () => {
				analyser.getByteFrequencyData(data);
				// RMS level normalized to 0-1
				let sum = 0;
				for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
				setAudioLevel(Math.min(1, Math.sqrt(sum / data.length) / 128));
				analyserRef.current!.raf = requestAnimationFrame(tick);
			};
			analyserRef.current = { ctx, analyser, source, raf: requestAnimationFrame(tick) };
		} catch {}
	}, []);

	const stopAudioMonitor = useCallback(() => {
		if (analyserRef.current) {
			cancelAnimationFrame(analyserRef.current.raf);
			analyserRef.current.source.disconnect();
			analyserRef.current.ctx.close().catch(() => {});
			analyserRef.current = null;
		}
		setAudioLevel(0);
	}, []);

	const onSendRef = useRef(opts.onSend);
	onSendRef.current = opts.onSend;
	const speakOnRef = useRef(speakOn);
	speakOnRef.current = speakOn;
	const convoOnRef = useRef(convoOn);
	convoOnRef.current = convoOn;

	const ensureTts = useCallback(async () => {
		if (!ttsRef.current) ttsRef.current = await createTts(instanceId);
		return ttsRef.current;
	}, [instanceId]);

	// Open mic with chime
	const startListening = useCallback(async () => {
		if (!sttRef.current || pausedForThinkingRef.current || mutedRef.current) return;
		try {
			await sttRef.current.start();
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
		console.log("[voice]", isFinal ? "FINAL:" : "interim:", text);
		if (isFinal) {
			// flushSync forces React to render immediately — the user sees
			// interim text clear and the message appear without waiting
			flushSync(() => {
				setInterim("");
				stopAudioMonitor();
				if (convoOnRef.current) {
					pausedForThinkingRef.current = true;
					if (sttRef.current?.listening) sttRef.current.stop();
					setMicOn(false);
					playThinkingChime();
				} else {
					setMicOn(false);
				}
			});
			console.log("[voice] sending to agent...");
			onSendRef.current(text);
		} else {
			// flushSync so interim text appears in the input IMMEDIATELY,
			// not batched with other state updates
			flushSync(() => setInterim(text));
		}
	}, [stopAudioMonitor]);

	const makeStt = useCallback(async () => {
		console.log("[voice] creating STT, provider will be resolved...");
		const stt = await createStt(instanceId, {
			onResult: handleResult,
			onError: (err) => {
				console.warn("[voice] STT error:", err);
				if (!convoOnRef.current) { setMicOn(false); setInterim(""); }
			},
			onEnd: () => {
				console.log("[voice] STT onEnd, convo:", convoOnRef.current, "paused:", pausedForThinkingRef.current);
				if (convoOnRef.current && !pausedForThinkingRef.current) {
					startListening();
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
			pausedForThinkingRef.current = false;
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
