/** Speech-to-Text abstraction — browser Web Speech API or OpenAI Whisper */

/* eslint-disable @typescript-eslint/no-explicit-any */
declare global {
	interface Window {
		SpeechRecognition: any;
		webkitSpeechRecognition: any;
	}
}

export interface SttOptions {
	apiKey?: string;
	language?: string;
	onResult?: (text: string, isFinal: boolean) => void;
	onError?: (error: string) => void;
	onEnd?: () => void;
}

export class VoiceStt {
	provider: string;
	apiKey: string;
	language: string;
	onResult: (text: string, isFinal: boolean) => void;
	onError: (error: string) => void;
	onEnd: () => void;
	listening = false;

	private _rec: any = null;
	private _mediaRec: MediaRecorder | null = null;
	private _stream: MediaStream | null = null;

	constructor(provider: string, opts: SttOptions = {}) {
		this.provider = provider;
		this.apiKey = opts.apiKey || "";
		this.language = opts.language || "en-US";
		this.onResult = opts.onResult || (() => {});
		this.onError = opts.onError || (() => {});
		this.onEnd = opts.onEnd || (() => {});
	}

	async start() {
		if (this.listening) return;
		this.listening = true;
		if (this.provider === "browser") return this._startBrowser();
		return this._startRecording();
	}

	stop() {
		this.listening = false;
		if (this._rec) {
			try {
				this._rec.stop();
			} catch {}
			this._rec = null;
		}
		if (this._mediaRec) {
			try {
				this._mediaRec.stop();
			} catch {}
		}
		if (this._stream) {
			this._stream.getTracks().forEach((t) => t.stop());
			this._stream = null;
		}
	}

	private _startBrowser() {
		const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
		if (!SR) {
			this.onError("Speech recognition not supported");
			this.listening = false;
			return;
		}
		const rec = new SR();
		rec.continuous = true;
		rec.interimResults = true;
		rec.lang = this.language;
		rec.onresult = (e: any) => {
			let interim = "",
				final = "";
			for (let i = e.resultIndex; i < e.results.length; i++) {
				const t = e.results[i][0].transcript;
				if (e.results[i].isFinal) final += t;
				else interim += t;
			}
			if (final) this.onResult(final.trim(), true);
			else if (interim) this.onResult(interim.trim(), false);
		};
		rec.onerror = (e: any) => {
			if (e.error !== "no-speech") this.onError(e.error);
		};
		let restartFails = 0;
		rec.onend = () => {
			if (this.listening) {
				try {
					rec.start();
					restartFails = 0;
				} catch {
					restartFails++;
					if (restartFails > 3) {
						this.listening = false;
						this.onError("mic restart failed");
						this.onEnd();
					}
				}
			} else this.onEnd();
		};
		this._rec = rec;
		try {
			rec.start();
		} catch (e) {
			this.onError(e instanceof Error ? e.message : String(e));
			this.listening = false;
		}
	}

	private async _startRecording() {
		try {
			this._stream = await navigator.mediaDevices.getUserMedia({
				audio: true,
			});
			const chunks: Blob[] = [];
			const mimeType =
				[
					"audio/webm;codecs=opus",
					"audio/webm",
					"audio/mp4",
					"audio/ogg",
				].find((t) => MediaRecorder.isTypeSupported(t)) || "";
			const mediaRec = new MediaRecorder(
				this._stream,
				mimeType ? { mimeType } : undefined,
			);
			mediaRec.ondataavailable = (e) => {
				if (e.data.size > 0) chunks.push(e.data);
			};
			mediaRec.onstop = async () => {
				this._stream?.getTracks().forEach((t) => t.stop());
				this._stream = null;
				if (!chunks.length) {
					this.onEnd();
					return;
				}
				const blob = new Blob(chunks, {
					type: mimeType || "audio/webm",
				});
				await this._transcribeWhisper(blob);
				this.onEnd();
			};
			this._mediaRec = mediaRec;
			mediaRec.start();
		} catch (e) {
			this.onError(
				"Mic access denied: " +
					(e instanceof Error ? e.message : String(e)),
			);
			this.listening = false;
		}
	}

	private async _transcribeWhisper(blob: Blob) {
		if (!this.apiKey) {
			this.onError("OpenAI API key required for Whisper STT");
			return;
		}
		const form = new FormData();
		form.append("file", blob, "audio.webm");
		form.append("model", "whisper-1");
		form.append("language", this.language.slice(0, 2));
		try {
			const res = await fetch(
				"https://api.openai.com/v1/audio/transcriptions",
				{
					method: "POST",
					headers: { Authorization: `Bearer ${this.apiKey}` },
					body: form,
				},
			);
			if (!res.ok) {
				this.onError(`Whisper error: ${res.status}`);
				return;
			}
			const data = await res.json();
			if (data.text?.trim()) this.onResult(data.text.trim(), true);
		} catch (e) {
			this.onError(
				"Whisper failed: " +
					(e instanceof Error ? e.message : String(e)),
			);
		}
	}
}
