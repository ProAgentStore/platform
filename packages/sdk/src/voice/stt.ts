/** Speech-to-Text abstraction — browser Web Speech API or OpenAI Whisper */

import { API, getToken } from "../client.js";
import { parseUpstreamErrorDetail, pickRecorderMimeType, whisperFilename } from "./audio.js";

// Minimal typings for the (non-standard) Web Speech API — enough for our use, so we
// avoid `any`. The DOM lib doesn't ship these.
interface SpeechRecognitionAlternative {
	readonly transcript: string;
}
interface SpeechRecognitionResultLike {
	readonly isFinal: boolean;
	readonly length: number;
	readonly [index: number]: SpeechRecognitionAlternative;
}
interface SpeechRecognitionEventLike {
	readonly resultIndex: number;
	readonly results: { readonly length: number; readonly [index: number]: SpeechRecognitionResultLike };
}
interface SpeechRecognitionErrorEventLike {
	readonly error: string;
}
interface SpeechRecognitionLike {
	continuous: boolean;
	interimResults: boolean;
	lang: string;
	onresult: ((e: SpeechRecognitionEventLike) => void) | null;
	onerror: ((e: SpeechRecognitionErrorEventLike) => void) | null;
	onend: (() => void) | null;
	start(): void;
	stop(): void;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

declare global {
	interface Window {
		SpeechRecognition?: SpeechRecognitionCtor;
		webkitSpeechRecognition?: SpeechRecognitionCtor;
	}
}

export interface SttOptions {
	apiKey?: string;
	language?: string;
	onResult?: (text: string, isFinal: boolean) => void;
	onError?: (error: string) => void;
	onEnd?: () => void;
	/** Fired with the raw recorded audio for a transcribed turn (Whisper only) so the
	 *  caller can save it for replay. Browser dictation has no blob → never fires. */
	onAudio?: (blob: Blob) => void;
}

export class VoiceStt {
	provider: string;
	apiKey: string;
	language: string;
	onResult: (text: string, isFinal: boolean) => void;
	onError: (error: string) => void;
	onEnd: () => void;
	onAudio: (blob: Blob) => void;
	listening = false;

	private _rec: SpeechRecognitionLike | null = null;
	private _mediaRec: MediaRecorder | null = null;
	private _stream: MediaStream | null = null;
	/** Set by stopDiscard(): the pending recording is dropped instead of transcribed. */
	private _discard = false;

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
		this.onAudio = opts.onAudio || (() => {});
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

	/** Stop the Whisper recorder but DROP the audio (no transcription). Used to
	 *  recycle a silent recording when the mic has sat open with no speech — avoids
	 *  uploading a long, mostly-silent blob to Whisper. Still fires onEnd so
	 *  conversation mode reopens the mic. No-op for browser dictation. */
	stopDiscard() {
		if (this.provider === "browser") return this.stop();
		this._discard = true;
		this.stop();
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
		rec.onresult = (e: SpeechRecognitionEventLike) => {
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
		rec.onerror = (e: SpeechRecognitionErrorEventLike) => {
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
		this._discard = false;
		try {
			this._stream = await navigator.mediaDevices.getUserMedia({
				// noiseSuppression keeps the silence floor low (so the VAD can detect a
				// pause) and autoGainControl:false avoids boosting that floor between words.
				audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false },
			});
			const chunks: Blob[] = [];
			const mimeType = pickRecorderMimeType((t) => MediaRecorder.isTypeSupported(t));
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
				// Idle recycle (stopDiscard) or an empty capture → drop it, don't transcribe.
				if (this._discard || !chunks.length) {
					this._discard = false;
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
		// Whisper infers the format from the filename extension, so it MUST match the
		// recorded container (Safari records mp4 — see whisperFilename).
		form.append("file", blob, whisperFilename(blob.type));
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
				// Surface OpenAI's actual reason (e.g. "audio file is too short") — never
				// throw it away behind a bare status.
				const detail = parseUpstreamErrorDetail(await res.text().catch(() => ""));
				this.onError(`Whisper error ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`);
				return;
			}
			const data = await res.json();
			if (data.text?.trim()) {
				// Hand the raw audio to the caller (to save for replay) BEFORE the result,
				// so the turn id can be minted + uploaded alongside the sent message.
				this.onAudio(blob);
				this.onResult(data.text.trim(), true);
			}
		} catch (e) {
			this.onError(
				"Whisper failed: " +
					(e instanceof Error ? e.message : String(e)),
			);
		}
	}
}
