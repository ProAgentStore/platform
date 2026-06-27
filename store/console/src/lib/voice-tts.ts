/** Text-to-Speech abstraction — browser SpeechSynthesis or OpenAI TTS */

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

	constructor(provider: string, opts: TtsOptions = {}) {
		this.provider = provider;
		this.apiKey = opts.apiKey || "";
		this.voice = opts.voice || "alloy";
		this.speed = opts.speed || 100;
	}

	async speak(text: string) {
		if (!text?.trim()) return;
		const clean = String(text)
			.replace(/[*_`#>]/g, "")
			.replace(/\s+/g, " ")
			.trim()
			.slice(0, 2000);
		if (!clean) return;
		this.speaking = true;
		try {
			if (this.provider === "openai" && this.apiKey)
				return await this._speakOpenAI(clean);
			return await this._speakBrowser(clean);
		} finally {
			this.speaking = false;
		}
	}

	cancel() {
		this.speaking = false;
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
				u.onend = () => resolve();
				u.onerror = () => resolve();
				speechSynthesis.speak(u);
			} catch {
				resolve();
			}
		});
	}

	private async _speakOpenAI(text: string) {
		try {
			const res = await fetch("https://api.openai.com/v1/audio/speech", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${this.apiKey}`,
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
			const source = this._audioCtx.createBufferSource();
			source.buffer = audioBuf;
			source.connect(this._audioCtx.destination);
			await new Promise<void>((resolve) => {
				source.onended = () => resolve();
				source.start();
			});
		} catch {
			return this._speakBrowser(text);
		}
	}
}
