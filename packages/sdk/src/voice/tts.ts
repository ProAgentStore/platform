/** Text-to-Speech abstraction — browser SpeechSynthesis or OpenAI TTS */

import { API, getToken, reportClientError } from "../client.js";

/**
 * How much of a reply is spoken aloud (#179). Was a bare `1500` inside `cleanForSpeech`,
 * so a user who wanted the whole of a long answer read out had no way to ask for it, and
 * a user who only ever wants the gist had no way to cut it short.
 *
 * The bounds are not taste, they're physics:
 * - **Floor 200.** Below roughly two sentences the cap truncates a normal reply mid-thought,
 *   which reads as "the voice is broken" rather than "I chose a short cap". Anyone wanting
 *   less than that wants TTS off, not a 20-character cap.
 * - **Ceiling 4096.** OpenAI's `/v1/audio/speech` REJECTS input longer than 4096 characters,
 *   so a higher setting would silently 400 the request (or, on the browser voice, queue
 *   minutes of speech nobody listens to). Uncapped is the one value that must not exist.
 */
export const DEFAULT_TTS_MAX_CHARS = 1500;
export const MIN_TTS_MAX_CHARS = 200;
export const MAX_TTS_MAX_CHARS = 4096;

/**
 * Prepare text for TTS. Two modes:
 *
 * - **consumer** (default): strip ALL technical noise — paths, URLs, filenames, code,
 *   hashes — so a plain-speech agent reads a clean human summary.
 * - **technical** (`opts.technical`): a code explainer's answer is ABOUT the code, so
 *   gutting it to "a file … a file" makes the spoken reply useless. Keep identifiers and
 *   file basenames (drop only the long directory chain), and condense only what is
 *   genuinely unspeakable aloud (fenced code, URLs, git hashes).
 *
 * `opts.maxChars` caps the spoken length (default {@link DEFAULT_TTS_MAX_CHARS}); it is
 * clamped here as well as server-side, because this is the last line before the text
 * reaches a provider that will reject an over-long body.
 */
export function cleanForSpeech(raw: string, opts: { technical?: boolean; maxChars?: number } = {}): string {
	let s = raw;
	// Fenced code blocks are noise read aloud in either mode — summarize.
	s = s.replace(/```[\s\S]*?```/g, " (code) ");
	// URLs are unspeakable in either mode — condense BEFORE path handling so the path
	// rules don't chew a URL into "a file".
	s = s.replace(/https?:\/\/[^\s)]+/g, " a link ");

	if (opts.technical) {
		// Inline `code` → spoken as its contents (usually an identifier the dev wants).
		s = s.replace(/`([^`]+)`/g, " $1 ");
		// Long file paths → just the basename: say "agent-think.ts", not the slash chain.
		// Requires an extension so ordinary "read/write" prose isn't mangled.
		s = s.replace(/(?:[~.]?\/)?(?:[\w.-]+\/)+([\w.-]+\.\w+)/g, " $1 ");
		s = s.replace(/[A-Za-z]:\\(?:[\w.-]+\\)*([\w.-]+\.\w+)/g, " $1 ");
	} else {
		// Inline code: keep short human words, strip paths/technical tokens.
		s = s.replace(/`[^`]+`/g, (m) => {
			const inner = m.slice(1, -1);
			if (inner.length < 20 && /^[a-zA-Z ]+$/.test(inner)) return inner;
			return "";
		});
		// File paths + bare filenames → "a file".
		s = s.replace(/[~.]?\/[\w./-]+/g, " a file ");
		s = s.replace(/[A-Z]:\\[\w.\\-]+/g, " a file ");
		s = s.replace(/\b[\w.-]+\.(ts|tsx|js|jsx|json|css|html|md|yml|yaml|toml|py|rs|go|sh|sql|env|lock|txt|csv|xml|svg|png|jpg|wasm)\b/gi, " a file ");
	}

	// Both modes: git hashes are unspeakable; drop markdown + emoji.
	s = s.replace(/\b[0-9a-f]{7,40}\b/g, "");
	s = s.replace(/[*_#>]/g, "");
	s = s.replace(/[\u{1F000}-\u{1FFFF}]|[\u{2600}-\u{27BF}]|[\u{FE00}-\u{FEFF}]/gu, "");
	// Collapse whitespace + cap length.
	s = s.replace(/\s+/g, " ").trim();
	const cap = typeof opts.maxChars === "number" && Number.isFinite(opts.maxChars)
		? Math.max(MIN_TTS_MAX_CHARS, Math.min(MAX_TTS_MAX_CHARS, Math.round(opts.maxChars)))
		: DEFAULT_TTS_MAX_CHARS;
	return s.slice(0, cap);
}

export interface TtsOptions {
	apiKey?: string;
	voice?: string;
	speed?: number;
	/** BCP-47 language for the browser voice (Settings → Voice → Language). Without it
	 *  SpeechSynthesis picks the system-default (usually English) voice, which mangles
	 *  replies in any other language. OpenAI TTS is multilingual and ignores it. */
	language?: string;
	/** Technical agent (code explainer / coding): keep identifiers + file basenames in
	 *  spoken output instead of gutting them to "a file". Default false (plain speech). */
	technical?: boolean;
	/** How much of a reply to speak, in characters (#179). Default
	 *  {@link DEFAULT_TTS_MAX_CHARS}; clamped to 200–4096 by `cleanForSpeech`. */
	maxChars?: number;
}

/**
 * Every live VoiceTts registers here so speech can be made globally exclusive (#127).
 * Two mounted hooks — e.g. the Assistant chat and the coding Co-pilot — each own a
 * separate queue AND (for OpenAI) a separate AudioContext, so without a cross-instance
 * guard they speak over each other ("two simultaneous voices"). Whichever instance
 * starts speaking silences the others first, so only ONE voice is ever audible.
 */
const liveTts = new Set<VoiceTts>();

/**
 * ONE Web Audio context for OpenAI TTS, page-wide (#278).
 *
 * It used to be per-instance, created lazily and `close()`d on dispose, which was right about
 * the leak (browsers cap how many contexts a page may open) and wrong about the gesture. iOS
 * and Safari only let a context start from a real user tap, and every `useVoice` primes one on
 * the mode-switch tap. That priming is a property of the CONTEXT, so a route change — which
 * unmounts the page, disposes its VoiceTts and closes its context — threw the permission away:
 * the next agent built a fresh, suspended context outside any gesture and silently degraded to
 * the browser voice. Switching agents by voice (#277) makes that a routine event rather than a
 * rare one.
 *
 * A single shared context answers both: one per page can't leak, and once a tap has started it
 * the whole app keeps speaking across navigations. Instances still own their own queue and
 * source node, so `cancel()` remains per-instance and speech stays globally exclusive.
 */
let _sharedCtx: AudioContext | null = null;
function sharedAudioCtx(): AudioContext {
	if (!_sharedCtx || _sharedCtx.state === "closed") _sharedCtx = new AudioContext();
	return _sharedCtx;
}

/**
 * Exported for unit tests only — do not call from outside tts.ts.
 *
 * Wraps an `AudioBufferSourceNode` playback in a promise that ALWAYS resolves, even when:
 * - `onerror` fires instead of `onended` (the node failed to play back the audio), or
 * - the node stalls and neither callback ever fires (the "speaking · tap to stop" hang).
 *
 * The watchdog fires after `audioDurationS * 1000 + PLAYBACK_WATCHDOG_SLACK_MS`, which gives a
 * generous buffer beyond the clip's own duration without letting a stalled node wedge hands-free
 * indefinitely.
 *
 * `AudioBufferSourceNode.onerror` is not in the TypeScript DOM types (it is a runtime-only
 * property on some implementations), so the parameter is typed as a minimal interface rather
 * than `Pick<AudioBufferSourceNode, …>`.
 */
export const PLAYBACK_WATCHDOG_SLACK_MS = 5_000;

export interface AudioSourceLike {
	onended: ((ev: Event) => void) | null;
	// `onerror` is absent from TypeScript's AudioScheduledSourceNode types but exists at runtime
	// on some browsers (iOS Safari). We wire it here to avoid the silent hang described above.
	onerror: ((ev: Event) => void) | null;
	start(): void;
}

export function playAudioBufferSource(source: AudioSourceLike, audioDurationS: number): Promise<void> {
	return new Promise<void>((resolve) => {
		let done = false;
		const finish = (_ev?: Event) => { if (!done) { done = true; clearTimeout(id); resolve(); } };

		// Normal path: the node finished playing.
		source.onended = finish;
		// Error path: the node failed (e.g. AudioBufferSourceNode.onerror on iOS, or a
		// decoding glitch) — resolving (not rejecting) lets the caller decide what to do
		// (fall back to the browser voice, log, etc.).
		source.onerror = finish;
		// Watchdog: if neither callback ever fires (the stall that wedges hands-free on
		// "Speaking · tap to stop"), resolve after the clip's expected duration plus slack.
		const watchdogMs = Math.ceil(audioDurationS * 1_000) + PLAYBACK_WATCHDOG_SLACK_MS;
		const id = setTimeout(finish, watchdogMs);

		source.start();
	});
}

export class VoiceTts {
	provider: string;
	apiKey: string;
	voice: string;
	speed: number;
	language: string;
	technical: boolean;
	maxChars: number;
	speaking = false;
	private _queue: Array<{ text: string; lang?: string }> = [];
	private _processing = false;
	private _currentSource: AudioBufferSourceNode | null = null;
	private _gen = 0;

	constructor(provider: string, opts: TtsOptions = {}) {
		this.provider = provider;
		this.apiKey = opts.apiKey || "";
		this.voice = opts.voice || "alloy";
		this.speed = opts.speed || 100;
		this.language = opts.language || "en-US";
		this.technical = opts.technical === true;
		this.maxChars = opts.maxChars ?? DEFAULT_TTS_MAX_CHARS;
		liveTts.add(this);
	}

	/** Stop every OTHER live instance so this one is the single audible voice (#127). */
	private _silenceOthers() {
		for (const t of liveTts) if (t !== this && (t.speaking || t._processing)) t.cancel();
	}

	/**
	 * Queue a message to speak. A message that arrives while one is already
	 * playing WAITS its turn — speech never overlaps. cancel() stops the current
	 * utterance and drops anything queued behind it.
	 */
	async speak(text: string, opts: { lang?: string } = {}) {
		if (!text?.trim()) return;
		const clean = cleanForSpeech(String(text), { technical: this.technical, maxChars: this.maxChars });
		if (!clean) return;
		// Claim the floor: cut off any other instance mid-utterance BEFORE we queue ours,
		// so the Assistant and the Co-pilot never talk over each other (#127).
		this._silenceOthers();
		this._queue.push({ text: clean, lang: opts.lang });
		if (this._processing) return; // a turn is already draining the queue
		this._processing = true;
		this.speaking = true;
		// cancel() bumps _gen: a canceled drain loop must NOT clobber the state a
		// newer speak() now owns (rapid tap-to-pronounce cancels + restarts).
		const gen = this._gen;
		try {
			while (this._processing && this._queue.length) {
				const next = this._queue.shift() as { text: string; lang?: string };
				if (this.provider === "openai") await this._speakOpenAI(next.text);
				else await this._speakBrowser(next.text, next.lang);
			}
		} finally {
			if (gen === this._gen) {
				this._processing = false;
				this.speaking = false;
			}
		}
	}

	/**
	 * Prime audio output from INSIDE a user gesture (mic toggle, double-tap) so a
	 * LATER async reply can actually play. iOS/Safari refuse to start a Web Audio
	 * context or the SpeechSynthesis queue outside a gesture — without this the
	 * OpenAI TTS context stays "suspended" (silent) and the browser voice never
	 * un-pauses, which is the "hands-free makes no sound" symptom. Best-effort.
	 */
	async unlock() {
		if (this.provider === "openai") {
			try {
				const ctx = sharedAudioCtx();
				if (ctx.state !== "running") await ctx.resume();
			} catch { /* falls back to browser voice at speak time */ }
		}
		try {
			if (typeof window !== "undefined" && window.speechSynthesis) {
				speechSynthesis.resume();
				// A volume-0 (not empty-string) utterance: some engines ignore an empty
				// utterance so it never counts as the gesture-initiated first speak that
				// iOS requires. A silent space does, without an audible artifact.
				const u = new SpeechSynthesisUtterance(" ");
				u.volume = 0;
				speechSynthesis.speak(u);
			}
		} catch { /* no synth in this browser */ }
	}

	cancel() {
		this._gen++; // invalidate any in-flight fetch/decode in _speakOpenAI
		this._queue = [];
		this._processing = false;
		this.speaking = false;
		if (this._currentSource) {
			try { this._currentSource.stop(); } catch { /* already stopped */ }
			this._currentSource = null;
		}
		if (window.speechSynthesis) speechSynthesis.cancel();
	}

	/** Teardown (unmount): stop this instance's speech and leave the roster. The Web Audio
	 *  context is deliberately NOT closed — it is shared page-wide (see sharedAudioCtx), so
	 *  there is nothing per-instance left to leak, and closing it here is what used to throw
	 *  away the iOS gesture priming on every navigation. */
	dispose() {
		this.cancel();
		liveTts.delete(this);
	}

	private _speakBrowser(text: string, langOverride?: string): Promise<void> {
		return new Promise((resolve) => {
			if (!window.speechSynthesis) {
				// No TTS at all in this browser — surface it so a silent "no voice reply"
				// is visible in the log rather than a mystery.
				reportClientError("voice-tts", "no speech synthesis available in this browser");
				resolve();
				return;
			}
			try {
				speechSynthesis.cancel();
				// iOS/Safari silently PAUSES the synth queue (esp. after a prior utterance or
				// when not driven by a fresh tap), so a queued reply never speaks and the user
				// thinks they must tap to "unmute". resume() before speaking un-pauses it.
				speechSynthesis.resume();
				const u = new SpeechSynthesisUtterance(text);
				// Speak in the configured language — without lang (and ideally a matching
				// voice) the engine uses the system-default voice, which reads e.g. a
				// Chinese reply as garbled English. Exact tag match first (zh-CN), then any
				// voice of the same language (zh-*).
				// Per-utterance override (e.g. speaking a translation in ITS language while
				// the conversation voice stays in the practice language).
				const lang = langOverride || this.language;
				u.lang = lang;
				// getVoices is missing on some minimal implementations — lang alone still
				// steers engines that support it.
				const voices = typeof speechSynthesis.getVoices === "function" ? speechSynthesis.getVoices() : [];
				const primary = lang.split("-")[0].toLowerCase();
				const match =
					voices.find((v) => v.lang === lang) ||
					voices.find((v) => v.lang.toLowerCase().startsWith(`${primary}-`) || v.lang.toLowerCase() === primary);
				if (match) u.voice = match;
				u.rate = Math.max(0.5, Math.min(3, this.speed / 100));
				// Some browsers (Chrome, intermittently) never fire onend — without a
				// fallback the promise hangs, `speaking` stays true forever, and the
				// conversation-mode echo guard would wedge the mic. Resolve no matter what.
				let done = false;
				const finish = () => { if (!done) { done = true; resolve(); } };
				u.onend = finish;
				u.onerror = finish;
				setTimeout(finish, Math.min(60000, 3000 + text.length * 80));
				speechSynthesis.speak(u);
			} catch {
				resolve();
			}
		});
	}

	private async _speakOpenAI(text: string) {
		const gen = this._gen;
		try {
			// Route via the platform proxy (injects the key server-side); a direct
			// browser call to api.openai.com is blocked by CORS, so OpenAI TTS was
			// silently failing and falling back to the browser voice.
			const res = await fetch(`${API}/v1/keys/proxy/api.openai.com/v1/audio/speech`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${getToken() ?? ""}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					model: "tts-1",
					input: text,
					voice: this.voice,
					speed: Math.max(0.25, Math.min(4, this.speed / 100)),
					response_format: "wav",
				}),
			});
			if (!res.ok) {
				// Log WHY OpenAI TTS failed before degrading to the browser voice —
				// don't silently swallow it (now to the durable log, not just console).
				const detail = await res.text().catch(() => "");
				reportClientError("voice-tts", `OpenAI TTS ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""} — using browser voice`, {}, res.status);
				return this._speakBrowser(text);
			}
			const arrayBuf = await res.arrayBuffer();
			if (!arrayBuf.byteLength) {
				reportClientError("voice-tts", "OpenAI TTS returned an empty audio body — using browser voice");
				return this._speakBrowser(text);
			}
			const ctx = sharedAudioCtx();
			// iOS/Safari parks the context in "suspended" (no gesture yet) or "interrupted"
			// (Siri, a call, or another app grabbed the audio session). BOTH can be revived
			// with resume() — the old code only tried "suspended", so a transient iOS
			// interruption dropped every reply to the browser voice AND logged a false error.
			if (ctx.state !== "running") {
				try { await ctx.resume(); } catch { /* recovers below, or falls back */ }
			}
			// Still not running (needs a fresh user gesture): playing OpenAI TTS would produce
			// NO sound, silently. Fall back to the browser voice (needs no AudioContext) and
			// surface it — but only now that resume() genuinely failed, not on every blip.
			if (ctx.state !== "running") {
				reportClientError("voice-tts", `AudioContext is "${ctx.state}" (Web Audio blocked) — using browser voice`);
				return this._speakBrowser(text);
			}
			const audioBuf = await ctx.decodeAudioData(
				arrayBuf.slice(0),
			);
			// cancel() bumped the generation while we were fetching/decoding — abort so
			// we don't start playing audio the user already tried to stop (tap/Esc).
			if (gen !== this._gen) return;
			const source = ctx.createBufferSource();
			source.buffer = audioBuf;
			source.connect(ctx.destination);
			this._currentSource = source;
			// AudioBufferSourceNode.onerror is absent from the TS DOM types but exists at
			// runtime on iOS Safari. The cast lets us wire it in playAudioBufferSource.
			await playAudioBufferSource(source as unknown as AudioSourceLike, audioBuf.duration);
			this._currentSource = null;
		} catch (e) {
			reportClientError("voice-tts", `OpenAI TTS failed: ${e instanceof Error ? e.message : String(e)} — using browser voice`);
			return this._speakBrowser(text);
		}
	}
}
