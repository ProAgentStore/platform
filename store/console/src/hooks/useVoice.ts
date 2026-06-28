import { useState, useRef, useCallback } from "react";
import { createStt, createTts } from "../lib/voice-config";
import type { VoiceStt } from "../lib/voice-stt";
import type { VoiceTts } from "../lib/voice-tts";

/**
 * Voice hook for chat surfaces.
 *  - mic: push-to-talk (fills input or auto-sends)
 * - autoSpeak: auto-speak assistant responses
 * - convo: continuous conversation mode (STT → send → TTS → re-listen)
 */
export function useVoice(instanceId: string | undefined, opts: {
	onTranscript: (text: string) => void;
	onAutoSend?: (text: string) => void;
}) {
	const [micOn, setMicOn] = useState(false);
	const [speakOn, setSpeakOn] = useState(false);
	const [convoOn, setConvoOn] = useState(false);
	const sttRef = useRef<VoiceStt | null>(null);
	const ttsRef = useRef<VoiceTts | null>(null);

	const ensureTts = useCallback(async () => {
		if (!ttsRef.current) ttsRef.current = await createTts(instanceId);
		return ttsRef.current;
	}, [instanceId]);

	// Speak text (for auto-speak and conversation mode)
	const speak = useCallback(async (text: string) => {
		const tts = await ensureTts();
		await tts.speak(text);
	}, [ensureTts]);

	// Speak if autoSpeak is on
	const maybeSpeakResponse = useCallback(async (text: string) => {
		if (speakOn || convoOn) await speak(text);
		// In convo mode, re-listen after speaking
		if (convoOn && sttRef.current) {
			try { await sttRef.current.start(); } catch {}
		}
	}, [speakOn, convoOn, speak]);

	// Toggle push-to-talk mic
	const toggleMic = useCallback(async () => {
		if (micOn) {
			sttRef.current?.stop();
			setMicOn(false);
			return;
		}
		try {
			const stt = await createStt(instanceId, {
				onResult: (text, isFinal) => {
					if (isFinal) {
						opts.onTranscript(text);
						setMicOn(false);
					}
				},
				onError: (err) => { console.warn("STT error:", err); setMicOn(false); },
				onEnd: () => setMicOn(false),
			});
			sttRef.current = stt;
			await stt.start();
			setMicOn(true);
		} catch { setMicOn(false); }
	}, [micOn, instanceId, opts]);

	// Toggle auto-speak
	const toggleSpeak = useCallback(() => {
		setSpeakOn((v) => !v);
	}, []);

	// Toggle conversation mode
	const toggleConvo = useCallback(async () => {
		if (convoOn) {
			sttRef.current?.stop();
			ttsRef.current?.cancel();
			setConvoOn(false);
			setMicOn(false);
			return;
		}
		// Unlock audio context on gesture
		try { const ctx = new AudioContext(); if (ctx.state === "suspended") await ctx.resume(); ctx.close(); } catch {}
		try {
			const stt = await createStt(instanceId, {
				onResult: (text, isFinal) => {
					if (isFinal && opts.onAutoSend) {
						opts.onAutoSend(text);
					}
				},
				onError: (err) => console.warn("convo STT:", err),
				onEnd: () => {
					// Will be restarted after TTS finishes in maybeSpeakResponse
				},
			});
			sttRef.current = stt;
			await stt.start();
			setConvoOn(true);
			setMicOn(true);
		} catch { setConvoOn(false); }
	}, [convoOn, instanceId, opts]);

	return {
		micOn,
		speakOn,
		convoOn,
		toggleMic,
		toggleSpeak,
		toggleConvo,
		maybeSpeakResponse,
	};
}
