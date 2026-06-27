import { api } from "./api";
import { VoiceStt, type SttOptions } from "./voice-stt";
import { VoiceTts } from "./voice-tts";

interface VoiceConfig {
	sttProvider: string;
	ttsProvider: string;
	apiKey: string;
	voice: string;
	speed: number;
	language: string;
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

	const isApi = String(vs.provider || "").includes("openai");
	let apiKey = "";
	if (isApi) {
		try {
			const d = await api<{ key?: string }>("/v1/keys/openai/reveal");
			apiKey = d.key || "";
		} catch {}
	}
	const useApi = isApi && !!apiKey;

	_cache = {
		sttProvider: useApi ? "openai" : "browser",
		ttsProvider: useApi ? "openai" : "browser",
		apiKey,
		voice: (vs.openai as Record<string, unknown>)?.voice as string || "alloy",
		speed: (vs.speed as number) || 100,
		language: (vs.language as string) || "en-US",
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
