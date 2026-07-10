/** Text-to-Speech abstraction — browser SpeechSynthesis or OpenAI TTS */

import { API, getToken, reportClientError } from "../client.js";

/**
 * Prepare text for TTS. Two modes:
 *
 * - **consumer** (default): strip ALL technical noise — paths, URLs, filenames, code,
 *   hashes — so a plain-speech agent reads a clean human summary.
 * - **technical** (`opts.technical`): a code explainer's answer is ABOUT the code, so
 *   gutting it to "a file … a file" makes the spoken reply useless. Keep identifiers and
 *   file basenames (drop only the long directory chain), and condense only what is
 *   genuinely unspeakable aloud (fenced code, URLs, git hashes).
 */
export function cleanForSpeech(raw: string, opts: { technical?: boolean } = {}): string {
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
	return s.slice(0, 1500);
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
}

export class VoiceTts {
	provider: string;
	apiKey: string;
	voice: string;
	speed: number;
	language: string;
	technical: boolean;
	speaking = false;
	private _audioCtx: AudioContext | null = null;
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
	}

	/**
	 * Queue a message to speak. A message that arrives while one is already
	 * playing WAITS its turn — speech never overlaps. cancel() stops the current
	 * utterance and drops anything queued behind it.
	 */
	async speak(text: string, opts: { lang?: string } = {}) {
		if (!text?.trim()) return;
		const clean = cleanForSpeech(String(text), { technical: this.technical });
		if (!clean) return;
		this._queue.push({ text: clean, lang: opts.lang });
		if (this._processing) return; // a turn is already draining the queue
		this._processing = true;
		this.speaking = true;
		try {
			while (this._processing && this._queue.length) {
				const next = this._queue.shift() as { text: string; lang?: string };
				if (this.provider === "openai") await this._speakOpenAI(next.text);
				else await this._speakBrowser(next.text, next.lang);
			}
		} finally {
			this._processing = false;
			this.speaking = false;
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
				if (!this._audioCtx) this._audioCtx = new AudioContext();
				if (this._audioCtx.state !== "running") await this._audioCtx.resume();
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

	/** Release the Web Audio context — call on teardown (unmount). Without this, each
	 *  mounted VoiceTts leaks an AudioContext, and browsers cap how many can exist
	 *  before `new AudioContext()` throws and TTS stops working entirely. */
	dispose() {
		this.cancel();
		if (this._audioCtx) {
			this._audioCtx.close().catch(() => {});
			this._audioCtx = null;
		}
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
			if (!this._audioCtx) this._audioCtx = new AudioContext();
			// iOS/Safari parks the context in "suspended" (no gesture yet) or "interrupted"
			// (Siri, a call, or another app grabbed the audio session). BOTH can be revived
			// with resume() — the old code only tried "suspended", so a transient iOS
			// interruption dropped every reply to the browser voice AND logged a false error.
			if (this._audioCtx.state !== "running") {
				try { await this._audioCtx.resume(); } catch { /* recovers below, or falls back */ }
			}
			// Still not running (needs a fresh user gesture): playing OpenAI TTS would produce
			// NO sound, silently. Fall back to the browser voice (needs no AudioContext) and
			// surface it — but only now that resume() genuinely failed, not on every blip.
			if (this._audioCtx.state !== "running") {
				reportClientError("voice-tts", `AudioContext is "${this._audioCtx.state}" (Web Audio blocked) — using browser voice`);
				return this._speakBrowser(text);
			}
			const audioBuf = await this._audioCtx.decodeAudioData(
				arrayBuf.slice(0),
			);
			// cancel() bumped the generation while we were fetching/decoding — abort so
			// we don't start playing audio the user already tried to stop (tap/Esc).
			if (gen !== this._gen) return;
			const source = this._audioCtx.createBufferSource();
			source.buffer = audioBuf;
			source.connect(this._audioCtx.destination);
			this._currentSource = source;
			await new Promise<void>((resolve) => {
				source.onended = () => resolve();
				source.start();
			});
			this._currentSource = null;
		} catch (e) {
			reportClientError("voice-tts", `OpenAI TTS failed: ${e instanceof Error ? e.message : String(e)} — using browser voice`);
			return this._speakBrowser(text);
		}
	}
}
