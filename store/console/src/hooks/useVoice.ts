import { useState, useRef, useCallback } from "react";
import { createStt, createTts } from "../lib/voice-config";
import type { VoiceStt } from "../lib/voice-stt";
import type { VoiceTts } from "../lib/voice-tts";

// Short tones via Web Audio — no external files
let _audioCtx: AudioContext | null = null;
function getAudioCtx(): AudioContext {
	if (!_audioCtx) _audioCtx = new AudioContext();
	return _audioCtx;
}

/** Play a short tone. `freq` in Hz, `dur` in seconds. */
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

/** Ascending double-beep: "I'm listening" */
function playListeningChime() {
	playTone(600, 0.08);
	setTimeout(() => playTone(900, 0.1), 100);
}

/** Descending beep: "processing your message" */
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
 *   1. Chime: "listening" → you talk → words appear live in input
 *   2. You pause → chime: "thinking" → message sends, mic pauses
 *   3. Agent responds → response spoken aloud
 *   4. TTS finishes → chime: "listening" → mic re-opens → step 1
 */
export function useVoice(instanceId: string | undefined, opts: {
	onSend: (text: string) => void;
}) {
	const [micOn, setMicOn] = useState(false);
	const [speakOn, setSpeakOn] = useState(false);
	const [convoOn, setConvoOn] = useState(false);
	const [interim, setInterim] = useState("");
	const sttRef = useRef<VoiceStt | null>(null);
	const ttsRef = useRef<VoiceTts | null>(null);

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

	// (Re-)open the mic with a listening chime
	const startListening = useCallback(async () => {
		if (sttRef.current) {
			try {
				await sttRef.current.start();
				setMicOn(true);
				if (convoOnRef.current) playListeningChime();
			} catch {}
		}
	}, []);

	// Speak response, then re-open mic in convo mode
	const speakAndResume = useCallback(async (text: string) => {
		// Stop STT while speaking (prevent echo pickup)
		if (sttRef.current?.listening) sttRef.current.stop();
		setMicOn(false);
		try {
			const tts = await ensureTts();
			await tts.speak(text);
		} catch {}
		if (convoOnRef.current) {
			await startListening();
		}
	}, [ensureTts, startListening]);

	// Called by chat after receiving assistant response
	const maybeSpeakResponse = useCallback((text: string) => {
		if (speakOnRef.current || convoOnRef.current) {
			speakAndResume(text);
		}
	}, [speakAndResume]);

	// STT result handler
	const handleResult = useCallback((text: string, isFinal: boolean) => {
		if (isFinal) {
			setInterim("");
			// In convo mode: pause mic + play thinking chime while agent works
			if (convoOnRef.current) {
				if (sttRef.current?.listening) sttRef.current.stop();
				setMicOn(false);
				playThinkingChime();
			} else {
				// Push-to-talk: stop after one utterance
				setMicOn(false);
			}
			onSendRef.current(text);
		} else {
			setInterim(text);
		}
	}, []);

	const makeStt = useCallback(async () => {
		return createStt(instanceId, {
			onResult: handleResult,
			onError: (err) => {
				console.warn("STT error:", err);
				if (!convoOnRef.current) { setMicOn(false); setInterim(""); }
			},
			onEnd: () => {
				// Browser STT fires onEnd periodically — restart in convo mode
				if (convoOnRef.current) {
					startListening();
				} else {
					setMicOn(false);
				}
			},
		});
	}, [instanceId, handleResult, startListening]);

	const toggleMic = useCallback(async () => {
		if (micOn) {
			sttRef.current?.stop();
			setMicOn(false);
			setInterim("");
			return;
		}
		try {
			sttRef.current = await makeStt();
			await sttRef.current.start();
			setMicOn(true);
		} catch { setMicOn(false); }
	}, [micOn, makeStt]);

	const toggleSpeak = useCallback(() => setSpeakOn((v) => !v), []);

	const toggleConvo = useCallback(async () => {
		if (convoOn) {
			sttRef.current?.stop();
			ttsRef.current?.cancel();
			setConvoOn(false);
			setMicOn(false);
			setInterim("");
			return;
		}
		// Unlock audio on gesture
		try { getAudioCtx().resume(); } catch {}
		try {
			sttRef.current = await makeStt();
			await sttRef.current.start();
			setConvoOn(true);
			setSpeakOn(true);
			setMicOn(true);
			playListeningChime();
		} catch { setConvoOn(false); }
	}, [convoOn, makeStt]);

	return {
		micOn, speakOn, convoOn, interim,
		toggleMic, toggleSpeak, toggleConvo,
		maybeSpeakResponse,
	};
}
