import { useState, useRef, useCallback } from "react";
import { createStt, createTts } from "../lib/voice-config";
import type { VoiceStt } from "../lib/voice-stt";
import type { VoiceTts } from "../lib/voice-tts";

/**
 * Voice hook for chat.
 *
 * Push-to-talk (🎤): shows live transcript in input → auto-sends on final.
 * Auto-speak (🔊): reads every assistant response aloud.
 * Conversation mode (🎙️): continuous loop — live transcript in input →
 *   auto-send on final → TTS speaks response → re-listens automatically.
 *   User just talks; messages appear in the input as they speak, then send.
 */
export function useVoice(instanceId: string | undefined, opts: {
	onSend: (text: string) => void;
}) {
	const [micOn, setMicOn] = useState(false);
	const [speakOn, setSpeakOn] = useState(false);
	const [convoOn, setConvoOn] = useState(false);
	// Live transcript shown in the input box while the user speaks
	const [interim, setInterim] = useState("");
	const sttRef = useRef<VoiceStt | null>(null);
	const ttsRef = useRef<VoiceTts | null>(null);

	// Refs to avoid stale closures inside STT callbacks
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

	// Shared STT result handler: show interim text live, auto-send on final
	const handleResult = useCallback((text: string, isFinal: boolean) => {
		if (isFinal) {
			setInterim("");
			onSendRef.current(text);
		} else {
			setInterim(text);
		}
	}, []);

	// Push-to-talk: click to start, speaks into input, auto-sends when done
	const toggleMic = useCallback(async () => {
		if (micOn) {
			sttRef.current?.stop();
			setMicOn(false);
			setInterim("");
			return;
		}
		try {
			const stt = await createStt(instanceId, {
				onResult: handleResult,
				onError: () => { setMicOn(false); setInterim(""); },
				onEnd: () => { setMicOn(false); },
			});
			sttRef.current = stt;
			await stt.start();
			setMicOn(true);
		} catch { setMicOn(false); }
	}, [micOn, instanceId, handleResult]);

	const toggleSpeak = useCallback(() => setSpeakOn((v) => !v), []);

	// Conversation mode: continuous listen → live transcript → auto-send →
	// TTS speaks response → re-listens. Just toggle on and talk.
	const toggleConvo = useCallback(async () => {
		if (convoOn) {
			sttRef.current?.stop();
			ttsRef.current?.cancel();
			setConvoOn(false);
			setMicOn(false);
			setInterim("");
			return;
		}
		// Unlock audio context on user gesture
		try {
			const ctx = new AudioContext();
			if (ctx.state === "suspended") await ctx.resume();
			ctx.close();
		} catch {}
		try {
			const stt = await createStt(instanceId, {
				onResult: handleResult,
				onError: (err) => console.warn("convo STT:", err),
				onEnd: () => {},
			});
			sttRef.current = stt;
			await stt.start();
			setConvoOn(true);
			setSpeakOn(true); // auto-speak is implied in conversation mode
			setMicOn(true);
		} catch { setConvoOn(false); }
	}, [convoOn, instanceId, handleResult]);

	return {
		micOn, speakOn, convoOn,
		/** Live transcript while the user is speaking — show in input box */
		interim,
		toggleMic, toggleSpeak, toggleConvo,
		maybeSpeakResponse,
	};
}
