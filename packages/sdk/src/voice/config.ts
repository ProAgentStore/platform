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
	/** Hands-free max recording duration (ms): stop listening + submit after this long
	 *  regardless, so a runaway/open mic can't record forever. Default 60000 (60s). */
	maxDictationMs: number;
	/** Mic sensitivity for silence detection (0.4–2): higher = more sensitive
	 *  (needs a smaller gap above the noise floor to count as speech). Default 1. */
	sensitivity: number;
	/** Whether hands-free voice commands (e.g. "repeat") are honored. Default true. */
	commandsEnabled: boolean;
	/** Hold a screen wake lock during hands-free so the display doesn't sleep and
	 *  suspend the mic. Default true; users on iOS can disable it in Settings → Voice. */
	keepAwake: boolean;
	/** Custom hands-free command keywords (Settings → Voice). Empty ⇒ built-in defaults
	 *  for repeat/mute; stopWords is off unless set. */
	repeatWords: string[];
	muteWords: string[];
	stopWords: string[];
	/** Say this word/phrase while the agent is speaking to immediately halt playback
	 *  (e.g. "stop stop"). Empty ⇒ off. Per-instance. Case-insensitive substring match. */
	stopSpeechKeyword: string;
	/** Lock STT to the configured language (#126): a transcript detected as a DIFFERENT
	 *  language is treated as a mis-detection and NOT sent — the user is asked to repeat,
	 *  instead of the agent responding in the wrong language. Default on. */
	confirmLanguage: boolean;
}

/** Parse a keywords setting stored as an array OR a delimited string into a clean list
 *  (trimmed, de-blanked). Split on comma / newline / semicolon — NOT space, because a
 *  valid phrase can be multi-word ("mute mic", "stop listening"). Tolerant so the UI can
 *  send either shape and a stray newline/semicolon (or pasted list) still parses. */
function parseWords(v: unknown): string[] {
	const list = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,\n;]/) : [];
	return list.filter((x): x is string => typeof x === "string").map((s) => s.trim()).filter(Boolean).slice(0, 20);
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
		maxDictationMs: clamp(vs.maxDictationMs, 10000, 300000, 60000),
		// Conservative default (0.8, was 1): lower = needs a clearer gap above the noise floor,
		// so background noise is less likely to be treated as speech. Raise it for a soft voice.
		sensitivity: clamp(vs.sensitivity, 0.4, 2, 0.8),
		commandsEnabled: vs.commandsEnabled !== false,
		keepAwake: vs.keepAwake !== false,
		repeatWords: parseWords(vs.repeatWords),
		muteWords: parseWords(vs.muteWords),
		stopWords: parseWords(vs.stopWords),
		stopSpeechKeyword: typeof vs.stopSpeechKeyword === "string" ? vs.stopSpeechKeyword.trim().slice(0, 40) : "",
		confirmLanguage: vs.confirmLanguage !== false, // default ON
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

	// Hands-free control words live in the GLOBAL user profile so they apply across every
	// agent/repo. Use them as the default; a per-instance value (already in `vs`) still wins.
	try {
		const p = await api<{ profile?: Record<string, string> }>("/v1/profile");
		const prof = p.profile || {};
		const fromProfile: Array<[string, string]> = [
			["repeatWords", "voiceRepeatWords"],
			["muteWords", "voiceMuteWords"],
			["stopWords", "voiceStopWords"],
			["stopSpeechKeyword", "voiceStopSpeechKeyword"],
		];
		for (const [vsKey, profKey] of fromProfile) {
			const inst = vs[vsKey];
			const instSet = Array.isArray(inst) ? inst.length > 0 : typeof inst === "string" ? inst.trim() !== "" : inst != null;
			if (!instSet && prof[profKey]) vs[vsKey] = prof[profKey]; // profile default (parseWords accepts the string)
		}
	} catch {}

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

export async function createTts(
	instanceId?: string,
	opts: { technical?: boolean } = {},
): Promise<VoiceTts> {
	const cfg = await getVoiceConfig(instanceId);
	return new VoiceTts(cfg.ttsProvider, {
		apiKey: cfg.apiKey,
		voice: cfg.voice,
		speed: cfg.speed,
		language: cfg.language,
		technical: opts.technical,
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
