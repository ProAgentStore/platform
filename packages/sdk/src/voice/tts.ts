/** Text-to-Speech abstraction — browser SpeechSynthesis or OpenAI TTS */

import { API, getToken } from "../client.js";

/**
 * Strip technical noise so TTS reads a clean, human summary.
 * Paths, URLs, filenames, code blocks, hashes, stack traces — all removed.
 * This is a vibecoding platform: speak the intent, not the internals.
 */
function cleanForSpeech(raw: string): string {
	let s = raw;
	// Remove fenced code blocks entirely
	s = s.replace(/```[\s\S]*?```/g, " (code) ");
	// Remove inline code
	s = s.replace(/`[^`]+`/g, (m) => {
		// Keep short human words, strip paths/technical tokens
		const inner = m.slice(1, -1);
		if (inner.length < 20 && /^[a-zA-Z ]+$/.test(inner)) return inner;
		return "";
	});
	// Remove URLs
	s = s.replace(/https?:\/\/[^\s)]+/g, " a link ");
	// Remove file paths (~/..., /..., ./..., C:\...)
	s = s.replace(/[~.]?\/[\w./-]+/g, " a file ");
	s = s.replace(/[A-Z]:\\[\w.\\-]+/g, " a file ");
	// Remove filenames with extensions (foo.ts, bar.json, etc.)
	s = s.replace(/\b[\w.-]+\.(ts|tsx|js|jsx|json|css|html|md|yml|yaml|toml|py|rs|go|sh|sql|env|lock|txt|csv|xml|svg|png|jpg|wasm)\b/gi, " a file ");
	// Remove git hashes
	s = s.replace(/\b[0-9a-f]{7,40}\b/g, "");
	// Remove markdown formatting
	s = s.replace(/[*_#>]/g, "");
	// Remove emoji
	s = s.replace(/[\u{1F000}-\u{1FFFF}]|[\u{2600}-\u{27BF}]|[\u{FE00}-\u{FEFF}]/gu, "");
	// Collapse whitespace
	s = s.replace(/\s+/g, " ").trim();
	// Limit length
	return s.slice(0, 1500);
}

export interface TtsOptions {
	apiKey?: string;
	voice?: string;
	speed?: number;
}

export class VoiceTts {
	provider: string;
	apiKey: string;
	voice: string;
	speed: number;
	speaking = false;
	private _audioCtx: AudioContext | null = null;
	private _queue: string[] = [];
	private _processing = false;
	private _currentSource: AudioBufferSourceNode | null = null;
	private _gen = 0;

	constructor(provider: string, opts: TtsOptions = {}) {
		this.provider = provider;
		this.apiKey = opts.apiKey || "";
		this.voice = opts.voice || "alloy";
		this.speed = opts.speed || 100;
	}

	/**
	 * Queue a message to speak. A message that arrives while one is already
	 * playing WAITS its turn — speech never overlaps. cancel() stops the current
	 * utterance and drops anything queued behind it.
	 */
	async speak(text: string) {
		if (!text?.trim()) return;
		const clean = cleanForSpeech(String(text));
		if (!clean) return;
		this._queue.push(clean);
		if (this._processing) return; // a turn is already draining the queue
		this._processing = true;
		this.speaking = true;
		try {
			while (this._processing && this._queue.length) {
				const next = this._queue.shift() as string;
				if (this.provider === "openai" && this.apiKey) await this._speakOpenAI(next);
				else await this._speakBrowser(next);
			}
		} finally {
			this._processing = false;
			this.speaking = false;
		}
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

	private _speakBrowser(text: string): Promise<void> {
		return new Promise((resolve) => {
			if (!window.speechSynthesis) {
				resolve();
				return;
			}
			try {
				speechSynthesis.cancel();
				const u = new SpeechSynthesisUtterance(text);
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
			if (!res.ok) return this._speakBrowser(text);
			const arrayBuf = await res.arrayBuffer();
			if (!arrayBuf.byteLength) return this._speakBrowser(text);
			if (!this._audioCtx) this._audioCtx = new AudioContext();
			if (this._audioCtx.state === "suspended")
				await this._audioCtx.resume();
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
		} catch {
			return this._speakBrowser(text);
		}
	}
}
