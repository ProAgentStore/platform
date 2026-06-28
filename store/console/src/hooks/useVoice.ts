import { useState, useRef, useCallback } from "react";
import { createStt, createTts } from "../lib/voice-config";
import type { VoiceStt } from "../lib/voice-stt";
import type { VoiceTts } from "../lib/voice-tts";

/**
 * Voice hook for chat surfaces.
 * - mic: push-to-talk — auto-sends the final transcript
 * - autoSpeak: reads every assistant response aloud
 * - convo: continuous conversation mode (listen → send → speak → re-listen)
 */
export function useVoice(instanceId: string | undefined, opts: {
	onSend: (text: string) => void;
}) {
	const [micOn, setMicOn] = useState(false);
	const [speakOn, setSpeakOn] = useState(false);
	const [convoOn, setConvoOn] = useState(false);
	const sttRef = useRef<VoiceStt | null>(null);
	const ttsRef = useRef<VoiceTts | null>(null);

	// Use refs to avoid stale closures in STT callbacks
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

	const speak = useCallback(async (text: string) => {
		const tts = await ensureTts();
		await tts.speak(text);
	}, [ensureTts]);

	// Called after receiving an assistant response
	const maybeSpeakResponse = useCallback(async (text: string) => {
		if (speakOnRef.current || convoOnRef.current) await speak(text);
		// In convo mode, re-listen after speaking
		if (convoOnRef.current && sttRef.current) {
			try { await sttRef.current.start(); } catch {}
		}
	}, [speak]);

	// Push-to-talk: listen, then auto-send the final transcript
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
						onSendRef.current(text);
						setMicOn(false);
					}
				},
				onError: () => setMicOn(false),
				onEnd: () => setMicOn(false),
			});
			sttRef.current = stt;
			await stt.start();
			setMicOn(true);
		} catch { setMicOn(false); }
	}, [micOn, instanceId]);

	const toggleSpeak = useCallback(() => setSpeakOn((v) => !v), []);

	// Conversation mode: continuous listen → auto-send → TTS → re-listen
	const toggleConvo = useCallback(async () => {
		if (convoOn) {
			sttRef.current?.stop();
			ttsRef.current?.cancel();
			setConvoOn(false);
			setMicOn(false);
			return;
		}
		// Unlock audio context on gesture
		try {
			const ctx = new AudioContext();
			if (ctx.state === "suspended") await ctx.resume();
			ctx.close();
		} catch {}
		try {
			const stt = await createStt(instanceId, {
				onResult: (text, isFinal) => {
					if (isFinal) onSendRef.current(text);
				},
				onError: (err) => console.warn("convo STT:", err),
				onEnd: () => {},
			});
			sttRef.current = stt;
			await stt.start();
			setConvoOn(true);
			setMicOn(true);
		} catch { setConvoOn(false); }
	}, [convoOn, instanceId]);

	return { micOn, speakOn, convoOn, toggleMic, toggleSpeak, toggleConvo, maybeSpeakResponse };
}
