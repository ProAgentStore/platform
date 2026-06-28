import { useState, useRef, useCallback } from "react";
import { createStt, createTts } from "../lib/voice-config";
import type { VoiceStt } from "../lib/voice-stt";
import type { VoiceTts } from "../lib/voice-tts";

/**
 * Voice hook for chat — three modes:
 *
 * Push-to-talk (🎤): live transcript in input → auto-sends on pause.
 * Auto-speak (🔊): reads every assistant response aloud.
 * Conversation (🎙️): continuous hands-free loop:
 *   1. You talk → words appear live in the input
 *   2. You pause → message sends automatically
 *   3. Agent responds → response spoken aloud
 *   4. TTS finishes → mic re-opens, back to step 1
 *   Toggle off to stop. No manual interaction needed.
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

	// Stable refs for callbacks
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

	// Start listening (used by convo mode to re-open mic after TTS)
	const startListening = useCallback(async () => {
		if (sttRef.current) {
			try { await sttRef.current.start(); setMicOn(true); } catch {}
		}
	}, []);

	// Speak text, then re-listen in convo mode
	const speakAndResume = useCallback(async (text: string) => {
		try {
			const tts = await ensureTts();
			await tts.speak(text);
		} catch {}
		// Re-open mic after TTS finishes (convo mode only)
		if (convoOnRef.current) {
			await startListening();
		}
	}, [ensureTts, startListening]);

	// Called by the chat after receiving an assistant response
	const maybeSpeakResponse = useCallback((text: string) => {
		if (speakOnRef.current || convoOnRef.current) {
			// Fire-and-forget — speakAndResume handles re-listen
			speakAndResume(text);
		}
	}, [speakAndResume]);

	// STT result handler: show live text, auto-send on final
	const handleResult = useCallback((text: string, isFinal: boolean) => {
		if (isFinal) {
			setInterim("");
			onSendRef.current(text);
			// In convo mode, mic will re-open after TTS via speakAndResume
			// For push-to-talk, we stop after one utterance
			if (!convoOnRef.current) {
				setMicOn(false);
			}
		} else {
			setInterim(text);
		}
	}, []);

	// Create a fresh STT recognizer
	const makeStt = useCallback(async () => {
		return createStt(instanceId, {
			onResult: handleResult,
			onError: (err) => {
				console.warn("STT error:", err);
				if (!convoOnRef.current) { setMicOn(false); setInterim(""); }
			},
			onEnd: () => {
				// Browser STT ends periodically — restart in convo mode
				if (convoOnRef.current) {
					startListening();
				} else {
					setMicOn(false);
				}
			},
		});
	}, [instanceId, handleResult, startListening]);

	// Push-to-talk
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

	// Conversation mode
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
		try {
			const ctx = new AudioContext();
			if (ctx.state === "suspended") await ctx.resume();
			ctx.close();
		} catch {}
		try {
			sttRef.current = await makeStt();
			await sttRef.current.start();
			setConvoOn(true);
			setSpeakOn(true);
			setMicOn(true);
		} catch { setConvoOn(false); }
	}, [convoOn, makeStt]);

	return {
		micOn, speakOn, convoOn, interim,
		toggleMic, toggleSpeak, toggleConvo,
		maybeSpeakResponse,
	};
}
