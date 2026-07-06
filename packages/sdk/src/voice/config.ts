import { api } from "../client.js";
import { DEFAULT_STT_MODEL, VoiceStt, type SttOptions } from "./stt.js";
import { VoiceTts } from "./tts.js";

interface VoiceConfig {
	sttProvider: string;
	/** Transcription model for the OpenAI provider (real-time gpt-4o-transcribe by default). */
	sttModel: string;
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
	/** Whether hands-free voice commands (e.g. "repeat") are honored. Default true. */
	commandsEnabled: boolean;
}

let _cache: VoiceConfig | null = null;
let _cacheInstanceId: string | null = null;

const clamp = (v: unknown, lo: number, hi: number, dflt: number): number =>
	Math.max(lo, Math.min(hi, typeof v === "number" && Number.isFinite(v) ? v : dflt));

/** True if the saved settings want an OpenAI-backed provider (Whisper STT or OpenAI
 *  TTS) — the only case where we need to check whether the key is present. */
export function voiceWantsOpenAi(vs: Record<string, unknown>): boolean {
	return String(vs.provider || "").includes("openai") || String(vs.sttMode || "") === "openai";
}

/**
 * Resolve raw voice settings + key presence into a concrete {@link VoiceConfig}.
 * Pure (no I/O) so the provider fallback + numeric clamping is unit-tested. An
 * OpenAI-backed provider is only chosen when the key is actually present — otherwise
 * we fall back to the browser voice rather than fail.
 */
export function resolveVoiceConfig(vs: Record<string, unknown>, hasOpenAiKey: boolean): VoiceConfig {
	const wantsOpenAiTts = String(vs.provider || "").includes("openai");
	const wantsWhisperStt = String(vs.sttMode || "") === "openai";
	return {
		// Dictation (browser Web Speech) is real-time but error-prone with accents;
		// "openai" records and transcribes with Whisper — far more accurate, but needs
		// the user's OpenAI key (falls back to browser if it's missing).
		sttProvider: wantsWhisperStt && hasOpenAiKey ? "openai" : "browser",
		// Real-time model by default; a saved sttModel (e.g. gpt-4o-mini-transcribe for
		// lower cost/latency) overrides it. Legacy whisper-1 is still selectable.
		sttModel: (typeof vs.sttModel === "string" && vs.sttModel) || DEFAULT_STT_MODEL,
		ttsProvider: wantsOpenAiTts && hasOpenAiKey ? "openai" : "browser",
		// The key never reaches the browser — the proxy injects it server-side.
		apiKey: "",
		voice: ((vs.openai as Record<string, unknown>)?.voice as string) || "alloy",
		speed: clamp(vs.speed, 25, 400, 100),
		language: (vs.language as string) || "en-US",
		silenceMs: clamp(vs.silenceMs, 500, 6000, 1500),
		sensitivity: clamp(vs.sensitivity, 0.4, 2, 1),
		commandsEnabled: vs.commandsEnabled !== false,
	};
}

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

	// We only need to know the key EXISTS — the actual requests go through the key
	// proxy, which injects it server-side. So check presence via /status instead of
	// revealing the raw key to the browser (which would be an exfiltration target).
	let hasOpenAiKey = false;
	if (voiceWantsOpenAi(vs)) {
		try {
			const d = await api<{ providers?: Array<{ id: string; hasKey: boolean }> }>("/v1/keys/status");
			hasOpenAiKey = !!d.providers?.find((p) => p.id === "openai")?.hasKey;
		} catch {}
	}

	_cache = resolveVoiceConfig(vs, hasOpenAiKey);
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
		model: cfg.sttModel,
		...opts,
	});
}
