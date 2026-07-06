import { api } from "../client.js";
import { VoiceStt, type SttOptions } from "./stt.js";
import { VoiceTts } from "./tts.js";

interface VoiceConfig {
	sttProvider: string;
	ttsProvider: string;
	apiKey: string;
	voice: string;
	speed: number;
	language: string;
	/** Conversation mode: how long (ms) to wait after you stop talking before
	 *  sending — higher = more tolerant of mid-sentence pauses. */
	silenceMs: number;
	/** Mic sensitivity for silence detection (0.4–2): higher = more sensitive
	 *  (needs a smaller gap above the noise floor to count as speech). Default 1. */
	sensitivity: number;
}

let _cache: VoiceConfig | null = null;
let _cacheInstanceId: string | null = null;

export async function getVoiceConfig(
	instanceId?: string,
): Promise<VoiceConfig> {
	if (_cache && _cacheInstanceId === (instanceId || null)) return _cache;

	let vs: Record<string, unknown> = {};
	if (instanceId) {
		try {
			const d = await api<{ voiceSettings?: Record<string, unknown> }>(
				`/v1/instances/${instanceId}/voice-settings`,
			);
			vs = d.voiceSettings || {};
		} catch {}
	}

	const wantsOpenAiTts = String(vs.provider || "").includes("openai");
	const wantsWhisperStt = String(vs.sttMode || "") === "openai";
	// We only need to know the key EXISTS — the actual requests go through the key
	// proxy, which injects it server-side. So check presence via /status instead of
	// revealing the raw key to the browser (which would be an exfiltration target).
	let hasOpenAiKey = false;
	if (wantsOpenAiTts || wantsWhisperStt) {
		try {
			const d = await api<{ providers?: Array<{ id: string; hasKey: boolean }> }>("/v1/keys/status");
			hasOpenAiKey = !!d.providers?.find((p) => p.id === "openai")?.hasKey;
		} catch {}
	}

	_cache = {
		// Dictation (browser Web Speech) is real-time but error-prone with accents;
		// "openai" records and transcribes with Whisper — far more accurate, but needs
		// the user's OpenAI key (falls back to browser if it's missing).
		sttProvider: wantsWhisperStt && hasOpenAiKey ? "openai" : "browser",
		ttsProvider: wantsOpenAiTts && hasOpenAiKey ? "openai" : "browser",
		// The key never reaches the browser now — the proxy injects it server-side.
		apiKey: "",
		voice: (vs.openai as Record<string, unknown>)?.voice as string || "alloy",
		speed: (vs.speed as number) || 100,
		language: (vs.language as string) || "en-US",
		silenceMs: Math.max(500, Math.min(6000, (vs.silenceMs as number) || 1500)),
		sensitivity: Math.max(0.4, Math.min(2, (vs.sensitivity as number) || 1)),
	};
	_cacheInstanceId = instanceId || null;
	return _cache;
}

export function invalidateVoiceConfig() {
	_cache = null;
}

export async function createTts(instanceId?: string): Promise<VoiceTts> {
	const cfg = await getVoiceConfig(instanceId);
	return new VoiceTts(cfg.ttsProvider, {
		apiKey: cfg.apiKey,
		voice: cfg.voice,
		speed: cfg.speed,
	});
}

export async function createStt(
	instanceId?: string,
	opts: Partial<SttOptions> = {},
): Promise<VoiceStt> {
	const cfg = await getVoiceConfig(instanceId);
	return new VoiceStt(cfg.sttProvider, {
		apiKey: cfg.apiKey,
		language: cfg.language,
		...opts,
	});
}
