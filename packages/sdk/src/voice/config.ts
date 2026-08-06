import { api, reportClientError } from "../client.js";
import { DEFAULT_STT_MODEL, VoiceStt, type SttOptions } from "./stt.js";
import { DEFAULT_TTS_MAX_CHARS, MAX_TTS_MAX_CHARS, MIN_TTS_MAX_CHARS, VoiceTts } from "./tts.js";

export interface VoiceConfig {
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
	/** How much of a reply is read aloud, in characters (#179). A long answer is fine to
	 *  read but exhausting to listen to, and OpenAI TTS hard-rejects over 4096 — so this is
	 *  bounded 200–4096 rather than offered as "unlimited". Default 1500. */
	ttsMaxChars: number;
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
	/** Phrases that re-open the mic while muted (#152) — matched ONLY while muted. */
	unmuteWords: string[];
	/** Phrases that leave voice mode entirely and return to typing (#165). */
	exitWords: string[];
	/** Phrases that move you to the agent asking for you (#277). Inert on a surface that
	 *  cannot switch conversations — see `useVoice`'s `onNext`. */
	nextWords: string[];
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
/** De-dupes concurrent loads (a background revalidate racing a cold read) onto one request. */
let _inflight: { key: string | null; p: Promise<VoiceConfig> } | null = null;

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
		ttsMaxChars: clamp(vs.ttsMaxChars, MIN_TTS_MAX_CHARS, MAX_TTS_MAX_CHARS, DEFAULT_TTS_MAX_CHARS),
		// Conservative default (0.8, was 1): lower = needs a clearer gap above the noise floor,
		// so background noise is less likely to be treated as speech. Raise it for a soft voice.
		sensitivity: clamp(vs.sensitivity, 0.4, 2, 0.8),
		commandsEnabled: vs.commandsEnabled !== false,
		keepAwake: vs.keepAwake !== false,
		repeatWords: parseWords(vs.repeatWords),
		muteWords: parseWords(vs.muteWords),
		unmuteWords: parseWords(vs.unmuteWords),
		exitWords: parseWords(vs.exitWords),
		nextWords: parseWords(vs.nextWords),
		stopWords: parseWords(vs.stopWords),
		stopSpeechKeyword: typeof vs.stopSpeechKeyword === "string" ? vs.stopSpeechKeyword.trim().slice(0, 40) : "",
		confirmLanguage: vs.confirmLanguage !== false, // default ON
	};
}

/**
 * The instance's voice config, cached across calls.
 *
 * `refresh: "background"` serves the cached value IMMEDIATELY and revalidates behind it. The
 * hands-free start path used to invalidate the cache and `await` this before touching
 * `getUserMedia`, so every entry paid a network round trip (two, when an OpenAI provider forces
 * the `/v1/keys/status` check) with nothing on screen — measurably the dominant await in #284,
 * and the one worth removing rather than papering over with a spinner.
 *
 * The trade is explicit: a settings change now lands on the NEXT mic start rather than this one.
 * That is the right way round — the user is not on the settings screen at the moment they tap
 * the mic, and the revalidate fired here has normally landed long before they tap it again.
 */
export async function getVoiceConfig(
	instanceId?: string,
	opts: { refresh?: "background" } = {},
): Promise<VoiceConfig> {
	if (_cache && _cacheInstanceId === (instanceId || null)) {
		if (opts.refresh === "background") void loadVoiceConfig(instanceId).catch(() => {});
		return _cache;
	}
	return loadVoiceConfig(instanceId);
}

async function loadVoiceConfig(instanceId?: string): Promise<VoiceConfig> {
	const key = instanceId || null;
	// A background revalidate that overlaps a cold read (or another revalidate) must not fan out
	// into duplicate requests — the start path can trigger both within the same tap.
	if (_inflight && _inflight.key === key) return _inflight.p;
	const p = fetchVoiceConfig(instanceId).finally(() => {
		if (_inflight?.p === p) _inflight = null;
	});
	_inflight = { key, p };
	return p;
}

async function fetchVoiceConfig(instanceId?: string): Promise<VoiceConfig> {
	let vs: Record<string, unknown> = {};
	/**
	 * Did every read that SHAPES the answer succeed? A load that failed still resolves to a
	 * complete-looking config, because `resolveVoiceConfig({}, false)` fills in every field —
	 * which is why the failure has to be carried out of here explicitly. See the caching
	 * decision at the bottom for what it is used for.
	 */
	let complete = true;
	if (instanceId) {
		try {
			const d = await api<{ voiceSettings?: Record<string, unknown> }>(
				`/v1/instances/${instanceId}/voice-settings`,
			);
			vs = d.voiceSettings || {};
		} catch (e) {
			complete = false;
			reportClientError("voice-config", "voice-settings load failed — using defaults for this call", {
				instanceId,
				error: e instanceof Error ? e.message : String(e),
			});
		}
	}

	// Control words used to be read from a SECOND home, the user profile's `voice*` fields —
	// a client-side fallback from before the Preferences page existed. Two UIs then wrote the
	// same global setting through different endpoints and this one silently lost, because
	// `/v1/instances/:id/voice-settings` already merges the account preferences server-side
	// (effectiveVoice). Migration 0075 moved the surviving values into
	// `users.preferences.voice`, so the response above is now the whole answer and the extra
	// round-trip to /v1/profile on every voice-config load is gone with it (#222).

	// We only need to know the key EXISTS — the actual requests go through the key
	// proxy, which injects it server-side. So check presence via /status instead of
	// revealing the raw key to the browser (which would be an exfiltration target).
	let hasOpenAiKey = false;
	if (voiceWantsOpenAi(vs)) {
		try {
			const d = await api<{ providers?: Array<{ id: string; hasKey: boolean }> }>("/v1/keys/status");
			hasOpenAiKey = !!d.providers?.find((p) => p.id === "openai")?.hasKey;
		} catch (e) {
			// The settings SAY OpenAI, so a failed key check downgrades a user who configured
			// Whisper/OpenAI TTS to the browser engines. Same class as above: not what they chose.
			complete = false;
			reportClientError("voice-config", "key-status check failed — falling back to the browser voice", {
				instanceId,
				error: e instanceof Error ? e.message : String(e),
			});
		}
	}

	const resolved = resolveVoiceConfig(vs, hasOpenAiKey);
	/**
	 * A failed load must never BECOME the answer (#325).
	 *
	 * `resolveVoiceConfig({}, false)` is not an error value — it is a full, plausible config:
	 * language `en-US`, `sttProvider: "browser"`, and every control-word list empty. Caching it
	 * meant one network blip silently reconfigured the voice stack for the rest of the session,
	 * and in three ways that are wrong rather than merely degraded: STT/TTS switch to English, so
	 * `confirmLanguage` then rejects the user's real language as a mis-detection and NOTHING they
	 * say is ever sent; Whisper drops to browser dictation; and the hands-free command words —
	 * including "mute" and the exit phrase — become an empty list, so saying "mute" no longer
	 * closes the mic. Worse, `refresh: "background"` revalidates behind a GOOD cache, so a blip
	 * replaced settings that had loaded correctly seconds earlier.
	 *
	 * So: serve defaults for THIS call (voice still works), keep any known-good cache, and cache
	 * nothing — the next call retries instead of inheriting the blip. The failure itself goes to
	 * the durable error log above, where `list_errors` can see it; it is not worth throwing at a
	 * user who is trying to talk.
	 */
	if (!complete) return _cache && _cacheInstanceId === (instanceId || null) ? _cache : resolved;

	_cache = resolved;
	_cacheInstanceId = instanceId || null;
	return _cache;
}

export function invalidateVoiceConfig() {
	_cache = null;
	// Drop the in-flight request too: an explicit invalidate means "the settings I know about are
	// wrong", and joining a load that started before the change would hand back exactly those.
	_inflight = null;
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
		maxChars: cfg.ttsMaxChars,
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
