/** Speech-to-Text abstraction — browser Web Speech API or OpenAI Whisper */

import { API, getToken } from "../client.js";

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

	/** The recorder's mic stream (Whisper mode) so the audio meter can reuse it
	 *  instead of opening a SECOND getUserMedia — a second capture mutes the recorder
	 *  on iOS Safari, yielding silent audio and empty transcriptions. */
	get stream(): MediaStream | null {
		return this._stream;
	}

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
			// Don't null _rec — keep the reference so start() can reuse it
			// via _startBrowser's internal restart logic, and so the onend
			// handler in the closure still points at the right object.
		}
		if (this._mediaRec && this._mediaRec.state !== "inactive") {
			// Only stop the recorder — its onstop handler stops the tracks AFTER the
			// final `dataavailable` fires. Tearing the tracks down here races that and
			// can drop the recorded audio (→ empty blob → no transcription).
			try {
				this._mediaRec.stop();
			} catch {}
		} else if (this._stream) {
			for (const t of this._stream.getTracks()) t.stop();
			this._stream = null;
		}
	}

	private _startBrowser() {
		// Try reusing existing recognizer (restart after stop).
		// If it throws (InvalidStateError — Chrome does this after abort/end),
		// discard it and create a fresh one.
		if (this._rec) {
			try {
				this._rec.start();
				return;
			} catch {
				this._rec = null;
				// Fall through to create a new one
			}
		}
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
				// noiseSuppression keeps the silence floor low (so the VAD can detect a
				// pause) and autoGainControl:false avoids boosting that floor between words.
				audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false },
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
				for (const t of this._stream?.getTracks() ?? []) t.stop();
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
		// No apiKey check — the request goes through the platform proxy, which injects
		// the key server-side; the browser never holds it. (provider==="openai" is only
		// chosen when the key is confirmed present via /status.)
		const form = new FormData();
		// Whisper picks the format from the filename extension, so it MUST match the
		// recorded mimeType — Safari records audio/mp4, which under "audio.webm" gets
		// rejected with a 400.
		const ext = blob.type.includes("mp4") ? "mp4" : blob.type.includes("ogg") ? "ogg" : "webm";
		form.append("file", blob, `audio.${ext}`);
		form.append("model", "whisper-1");
		form.append("language", this.language.slice(0, 2));
		try {
			// Route via the platform proxy — it injects the user's key server-side.
			// Calling api.openai.com directly from the browser is blocked by CORS (the
			// request fails before reaching OpenAI), which is why a valid key still
			// produced nothing.
			const res = await fetch(
				`${API}/v1/keys/proxy/api.openai.com/v1/audio/transcriptions`,
				{
					method: "POST",
					headers: { Authorization: `Bearer ${getToken() ?? ""}` },
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
