/** Speech-to-Text abstraction — browser Web Speech API or OpenAI Whisper */

import { API, getToken } from "../client.js";
import { describeTranscribeHttpError, drainSseData, isTooShortToTranscribe, pickRecorderMimeType, whisperFilename } from "./audio.js";
import { finalizeTranscript, initialTranscriptState, reduceTranscriptPayload } from "./transcript.js";
import { type ClipVerdict, hadSpeech, type LevelSnapshot, onsetFloorFor, planClipGate } from "./vad.js";

/** OpenAI's real-time transcription model — replaces the legacy batch `whisper-1`.
 *  Same upload endpoint, far better accuracy/latency, no verbose_json (we use json). */
export const DEFAULT_STT_MODEL = "gpt-4o-transcribe";

/**
 * `no_speech_prob` threshold for discarding a whisper-1 transcription as silence.
 * OpenAI's documented threshold for "probably no speech" is 0.6. When the model
 * returns a value above this, it has low confidence that real speech was present —
 * treat the transcript as a hallucination and emit "no-speech" instead.
 * Only applies to the non-streaming path (whisper-1 with response_format=verbose_json).
 */
export const NO_SPEECH_PROB_THRESHOLD = 0.6;

/**
 * Can this model tell us it heard no speech? (#511 criterion 1.)
 *
 * Only `whisper-1`. `no_speech_prob` rides on `response_format=verbose_json`, which the
 * `gpt-4o-transcribe` family does not support — they take `json`, and we stream them. #490 shipped
 * this layer as one of three defences against phantom turns and it landed in the `else` of a
 * `const streaming = this.model !== "whisper-1"`, forty lines from the decision, where it reads as
 * a streaming-transport detail rather than what it is: **a capability only the legacy model has.**
 * The consequence went unnoticed for a day — the default model is `gpt-4o-transcribe`, so the
 * model-side gate protected nobody, and phantoms were still reaching Whisper 13 hours after #490
 * deployed. Naming the capability is what stops "we have a confidence gate" being said of a
 * request that cannot carry one.
 *
 * The streaming model's phantom defence is therefore entirely ours, in three layers that DO run on
 * it: the adaptive energy gate before upload (`planClipGate`), `isNoiseTranscript` on the way to
 * the agent, and the low-energy suppression of the vocabulary bias prompt — without which silence
 * does not come back empty but comes back as a fluent sentence assembled from our own term list.
 * Both phantoms dated in #511 were caught by the second of those; neither became a user turn.
 *
 * NOT added here: `include[]=logprobs`, which is the one model-side confidence signal
 * `gpt-4o-transcribe` does expose. It would be a new, blind discard layer on the ONLY transcription
 * path anyone uses, tuned against no data, deployed on push — while the live complaint being worked
 * is speech going MISSING. Wrong direction to guess in. It is worth doing against the peakLevel /
 * onsetFloor rows #510 now writes, not before them.
 */
export function supportsNoSpeechProb(model: string): boolean {
	return model === "whisper-1";
}

/**
 * Deadlines on a transcription request (#421).
 *
 * There were none — no `signal`, no `AbortController` anywhere in `voice/`, and none on the server
 * proxy either — so a request that stalled produced neither a `catch` nor a `!res.ok`, and the
 * whole failure apparatus in `use-voice.ts` hangs off `onError`. A promise that never settles
 * reaches none of it: the bubble sat on "Transcribing…" indefinitely and, until this change, held
 * the composer with it. Reload was the only escape.
 *
 * Two deadlines because there are two ways to stall. `FIRST_BYTE` covers a request that never
 * answers; `STREAM` covers one that answers and then stops mid-SSE, which the first cannot see.
 * Both start generous on purpose — a slow mobile network that is genuinely working must not be
 * failed, and a retry spends the user's own OpenAI credit. Tighten only against timeout rows in the
 * durable log.
 */
export const TRANSCRIBE_FIRST_BYTE_MS = 20_000;
export const TRANSCRIBE_STREAM_MS = 45_000;
/** The note a deadline puts on the bubble. A distinct wording, because "Whisper failed" reads as
 *  the user's key or their audio being wrong, and neither is the case here. */
export const TRANSCRIBE_TIMEOUT_MESSAGE = "Transcription timed out — the audio never came back.";

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
	/** Standard on the real API; optional here because a stub may not have it. `stop()` asks for
	 *  a final result, `abort()` ends capture immediately — the fallback when `stop()` throws. */
	abort?(): void;
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
	/** Transcription model for the OpenAI provider. Defaults to {@link DEFAULT_STT_MODEL}. */
	model?: string;
	/** Vocabulary-bias prompt (see ./prompt.ts) so domain words aren't mis-heard. */
	transcribePrompt?: string;
	onResult?: (text: string, isFinal: boolean) => void;
	onError?: (error: string) => void;
	onEnd?: () => void;
	/** Fired with the raw recorded audio for a transcribed turn (Whisper only) so the
	 *  caller can save it for replay. Browser dictation has no blob → never fires. */
	onAudio?: (blob: Blob) => void;
	/**
	 * The live browser-dictation gate's reading, read AT THE MOMENT the clip is judged.
	 *
	 * A function rather than a value because both flags change during the recording, and the
	 * question ("did real words happen this turn?") is only meaningful at the decision. The same
	 * snapshot `use-voice` hands to `endOfTurnAction` and `planNoiseRejection`, so all three
	 * answer it identically.
	 */
	gate?: () => { isAlive: boolean; heardSpeech: boolean } | null;
	/** The speech gate's verdict on a finished clip, with the numbers behind it — so a discard
	 *  before upload can leave a durable row instead of nothing at all (#510 criterion 2). */
	onClipGate?: (verdict: ClipVerdict, snapshot: LevelSnapshot) => void;
}

export class VoiceStt {
	provider: string;
	apiKey: string;
	language: string;
	model: string;
	transcribePrompt: string;
	onResult: (text: string, isFinal: boolean) => void;
	onError: (error: string) => void;
	onEnd: () => void;
	onAudio: (blob: Blob) => void;
	gate: (() => { isAlive: boolean; heardSpeech: boolean } | null) | undefined;
	onClipGate: (verdict: ClipVerdict, snapshot: LevelSnapshot) => void;
	listening = false;

	private _rec: SpeechRecognitionLike | null = null;
	private _mediaRec: MediaRecorder | null = null;
	private _stream: MediaStream | null = null;
	/** Set by stopDiscard(): the pending recording is dropped instead of transcribed. */
	private _discard = false;
	/** When the current recording started — used to drop sub-threshold captures. */
	private _recStartedAt = 0;
	/** Loudest mic level seen during the current recording, fed by noteLevel(). */
	private _peakLevel = 0;
	/**
	 * How many levels `noteLevel` was given for the current recording.
	 *
	 * The distinction `_peakLevel` alone cannot make, and the one #490 got wrong: **0 frames is no
	 * measurement, not a measurement of silence.** `noteLevel`'s only caller is a
	 * `requestAnimationFrame` tick, and rAF does not run for a hidden document — so a backgrounded
	 * console produces 0 frames for a clip full of speech, and reading that as "no speech" discards
	 * every clip the user records while looking at something else. See `planClipGate`.
	 */
	private _levelFrames = 0;
	/** The last clip handed to transcription, kept so a failed attempt can be RETRIED with the same
	 *  audio (#421) instead of asking the user to say it again. Cleared on a fresh recording. */
	private _lastBlob: Blob | null = null;
	/**
	 * Per-turn adaptive ambient noise floor from the VAD (`VadState.noiseFloor`).
	 * Set by the audio monitor loop once the noise-sampling window closes
	 * (`vadStateRef.current.noiseFloor`). `-1` = not yet available, fall back to the fixed
	 * `VOICE_FLOOR`. Used by the `onstop` speech gate to raise the `hadSpeech` threshold when
	 * the room is noisy, so steady ambient sound never registers as a real clip.
	 */
	_noiseFloor = -1;

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
		this.model = opts.model || DEFAULT_STT_MODEL;
		this.transcribePrompt = opts.transcribePrompt || "";
		this.onResult = opts.onResult || (() => {});
		this.onError = opts.onError || (() => {});
		this.onEnd = opts.onEnd || (() => {});
		this.onAudio = opts.onAudio || (() => {});
		this.gate = opts.gate;
		this.onClipGate = opts.onClipGate || (() => {});
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
			} catch {
				// The dictation half of the same privacy bug #291 fixed for the Whisper recorder:
				// a swallowed `stop()` left the recognizer RUNNING, so Web Speech kept streaming
				// the mic after the user turned voice off — and `listening = false` above means
				// nothing was left to notice, since the restart guard only reads that flag when
				// `onend` fires, which a failed stop never reaches. `abort()` ends capture at once
				// (it forfeits a final result, which a stop that threw was never going to deliver).
				try {
					this._rec.abort?.();
				} catch {
					// Nothing further to try — but the recognizer is unusable now, so drop it so the
					// next start() builds a fresh one instead of reusing a wedged mic.
					this._rec = null;
				}
			}
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
			} catch {
				// …but if `stop()` THREW, `onstop` will never fire, so nothing is left to release
				// the tracks: the mic stayed open and the browser's recording indicator stayed lit
				// after the user turned voice off. The race the branch above avoids cannot happen
				// on this path (there is no pending `dataavailable`), so release them here. A
				// swallowed failure that leaves the microphone live is not a degraded state.
				this._releaseStream();
			}
		} else if (this._stream) {
			this._releaseStream();
		}
	}

	/** Stop every mic track and drop the stream. Safe to call twice. */
	private _releaseStream() {
		if (!this._stream) return;
		for (const t of this._stream.getTracks()) {
			try {
				t.stop();
			} catch {
				// One wedged track must not strand the others — the same reason `closeAll` isolates
				// its sessions. Any track left running keeps the mic indicator on.
			}
		}
		this._stream = null;
	}

	/** Stop the Whisper recorder but DROP the audio (no transcription). Used to
	 *  recycle a silent recording when the mic has sat open with no speech — avoids
	 *  uploading a long, mostly-silent blob to Whisper. Still fires onEnd so
	 *  conversation mode reopens the mic. No-op for browser dictation. */
	/**
	 * Feed the current mic level (0–1) from the caller's analyser loop.
	 *
	 * Deliberately not gated on listening mode: the auto-VAD runs only in hands-free, so gating
	 * this the same way would leave tap-to-talk — the mode where a stray double-tap records pure
	 * silence — with no speech gate at all.
	 */
	noteLevel(level: number) {
		this._levelFrames++;
		if (level > this._peakLevel) this._peakLevel = level;
	}

	/**
	 * What the analyser measured for the clip in hand — the numbers a drop has to be diagnosed
	 * with (#510 criterion 5). Before this the durable log carried only `{code}` / `{transcript}`,
	 * so "it didn't hear me" was answerable only by reading the source and guessing at the inputs.
	 */
	levelSnapshot(): LevelSnapshot {
		return {
			peakLevel: this._peakLevel,
			noiseFloor: this._noiseFloor,
			onsetFloor: onsetFloorFor(this._noiseFloor),
			frames: this._levelFrames,
		};
	}

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
				// Re-apply the configured language before EVERY start — never leave it at the
				// browser/OS-locale default (which auto-detects and can transcribe/translate to
				// the wrong language).
				this._rec.lang = this.language;
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
					// continuous mode ends and we auto-restart — re-apply the language each time
					// so a restart never reverts to the browser's default/auto-detect locale.
					rec.lang = this.language;
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

	/**
	 * Is there a clip a failed transcription could be retried with (#421)? The blob is still in
	 * hand after any failure, so Retry is a re-POST rather than "say that again" — which matters
	 * most for the failure this was written for, a timeout, where the user has already waited.
	 */
	canRetryTranscription(): boolean {
		return this.provider !== "browser" && !!this._lastBlob;
	}

	/** Re-send the last clip. The caller owns the UI state; this only redoes the request. */
	async retryTranscription(): Promise<void> {
		const blob = this._lastBlob;
		if (!blob) return;
		await this._transcribeWhisper(blob);
	}

	private async _startRecording() {
		this._discard = false;
		this._peakLevel = 0;
		this._levelFrames = 0;
		this._noiseFloor = -1; // reset per-turn adaptive floor; VAD will populate it via the monitor loop
		this._lastBlob = null; // a new turn — the previous clip is no longer what Retry means
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
				// Via `_releaseStream`: one throwing track used to strand every later track AND skip
				// `_stream = null`, so the reference was lost and nothing could ever release them.
				this._releaseStream();
				const durationMs = this._recStartedAt ? Date.now() - this._recStartedAt : 0;
				const blob = new Blob(chunks, { type: mimeType || "audio/webm" });
				// Drop when: idle-recycled (stopDiscard), empty, OR too short to be real
				// speech. Uploading a sub-0.1s clip only ever returns a 400 `audio_too_short`
				// — the dominant Whisper error in the log — so never send it.
				if (this._discard || !chunks.length || isTooShortToTranscribe(blob.size, durationMs)) {
					this._discard = false;
					this.onEnd();
					return;
				}
				// SPEECH GATE. Silence sent to Whisper does not come back empty — with a
				// vocabulary prompt attached it continues the prompt and returns a fluent
				// sentence built from those terms, which is then attributed to the user and (in
				// hands-free) auto-sent. See hadSpeech() for the real transcript this produced.
				//
				// Every input and every rule is in `planClipGate` — including the gate check this
				// comment used to DESCRIBE while the code below it did something else (#510
				// criterion 3): it claimed the zero-energy discard happened only when there was
				// "no Web Speech gate available to vouch for the turn", and there was no gate
				// check in the branch at all.
				const snapshot = this.levelSnapshot();
				const verdict = planClipGate({ ...snapshot, gate: this.gate?.() });
				this.onClipGate(verdict, snapshot);
				if (verdict.action === "discard") {
					this.onEnd();
					return;
				}
				await this._transcribeWhisper(blob);
				this.onEnd();
			};
			this._mediaRec = mediaRec;
			this._recStartedAt = Date.now();
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
		this._lastBlob = blob;
		// No apiKey check — the request goes through the platform proxy, which injects
		// the key server-side; the browser never holds it. (provider==="openai" is only
		// chosen when the key is confirmed present via /status.)
		const form = new FormData();
		// Whisper infers the format from the filename extension, so it MUST match the
		// recorded container (Safari records mp4 — see whisperFilename).
		form.append("file", blob, whisperFilename(blob.type));
		form.append("model", this.model);
		form.append("language", this.language.slice(0, 2));
		// Stream the transcript for a "live" feel — words land as they're recognised instead of one
		// blob after a pause. whisper-1 ignores streaming, so only the gpt-4o-transcribe models get
		// it. Declared up here because the decoding options below now differ by model family too.
		const streaming = this.model !== "whisper-1";
		// TEMPERATURE — whisper-1 only (#512).
		//
		// #490 sent `temperature=0` on every request to suppress the random sampling behind
		// fluent-but-wrong hallucinations on silence. For whisper-1 that reasoning holds and is
		// kept: OpenAI documents 0 on this endpoint as "the model will use log probability to
		// automatically increase the temperature until certain thresholds are hit" — i.e. for the
		// Whisper decoder, 0 SELECTS the fallback ladder rather than removing it. #512 reads it the
		// other way round, and for whisper-1 the issue's stated mechanism is inverted.
		//
		// It is dropped for the streaming gpt-4o-transcribe family, which is a different
		// architecture the ladder wording does not describe: there, 0 is plain greedy decoding, and
		// greedy autoregressive decoding is the regime that produces repetition loops — two of
		// which were recorded on 2026-08-11, one sent to an agent as a real user turn. It was never
		// shown to help on this model (the phantom problem it was added for is handled here by the
		// energy gate and the noise filter), so the model's own default is the better default.
		//
		// HONEST LIMIT: if that default is itself 0, this change is inert and the loops have
		// another cause. The client cannot observe it, and #512 names the experiment — count
		// repetition rows over a comparable window. That is why the client-side detector
		// (`isRepetitionLoop`), not this line, is the deliverable: it holds whichever way the
		// experiment lands.
		if (!streaming) form.append("temperature", "0");
		// Vocabulary bias — nudges the model toward domain words (a developer's "bugs"
		// isn't "bars"). Suppressed when the clip is low-energy (peak barely cleared the
		// speech floor) so the model has no list to "continue" on near-silence — one of
		// the two preconditions for the hallucination pattern in #490.
		// Only sent for English: the term list is English, and Whisper's prompt hints its
		// OUTPUT language — pairing it with e.g. language=zh pulls Chinese words to English.
		const lowEnergy = !hadSpeech(this._peakLevel, this._noiseFloor);
		if (!lowEnergy && this.transcribePrompt && this.language.toLowerCase().startsWith("en"))
			form.append("prompt", this.transcribePrompt);
		// The transport and the confidence gate are asked SEPARATELY on purpose (#511). They were
		// one flag, and the model-side gate was a passenger on the transport choice — so "does this
		// model stream?" silently decided "is this turn checked for silence?", and the answer for
		// the default model was no. See `supportsNoSpeechProb`.
		if (streaming) form.append("stream", "true");
		// verbose_json is what carries `no_speech_prob`, and only whisper-1 accepts it.
		if (supportsNoSpeechProb(this.model)) form.append("response_format", "verbose_json");
		// The deadline. An AbortController rather than `AbortSignal.timeout` because the second
		// deadline has to REPLACE the first once headers arrive — a stream is allowed to take
		// longer than a first byte — and because `timedOut` has to be readable from the catch, so a
		// deliberate abort is not reported as "Whisper failed: aborted".
		const ctrl = new AbortController();
		let timedOut = false;
		const arm = (ms: number) => setTimeout(() => { timedOut = true; try { ctrl.abort(); } catch { /* already settled */ } }, ms);
		let deadline = arm(TRANSCRIBE_FIRST_BYTE_MS);
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
					signal: ctrl.signal,
				},
			);
			if (!res.ok) {
				// Surface the actual reason — OpenAI's ("audio file is too short") or the
				// platform's own ("ProAgentStore is updating…"), which are different envelopes and
				// used to be run through one parser that only understood the first (#421).
				this.onError(describeTranscribeHttpError(res.status, await res.text().catch(() => "")));
				return;
			}
			if (streaming && res.body) {
				// Headers are in; the first-byte deadline has done its job. Aborting the controller
				// after this point still terminates the body stream, so the read below is covered.
				clearTimeout(deadline);
				deadline = arm(TRANSCRIBE_STREAM_MS);
				await this._readTranscriptionStream(res.body, blob, () => timedOut);
				return;
			}
			const data = await res.json();
			// verbose_json (whisper-1) includes `no_speech_prob` at the top level and/or
			// per segment. When the model signals low confidence that real speech was present,
			// discard the transcript — it is almost certainly a hallucination.
			const noSpeechProb: number | undefined =
				typeof data.no_speech_prob === "number" ? data.no_speech_prob
				: Array.isArray(data.segments) && data.segments.length > 0
					? (data.segments as Array<{ no_speech_prob?: number }>).reduce(
						(acc, seg) => Math.max(acc, typeof seg.no_speech_prob === "number" ? seg.no_speech_prob : 0),
						0,
					)
					: undefined;
			if (noSpeechProb !== undefined && noSpeechProb > NO_SPEECH_PROB_THRESHOLD) {
				this.onError("no-speech");
				return;
			}
			if (data.text?.trim()) {
				// Hand the raw audio to the caller (to save for replay) BEFORE the result,
				// so the turn id can be minted + uploaded alongside the sent message.
				this.onAudio(blob);
				this.onResult(data.text.trim(), true);
			} else {
				// A 200 with no text = silence / echo / the agent's own voice tail. Not an
				// error — emit the soft "no-speech" sentinel so the caller quietly recycles
				// the mic instead of flashing a scary "empty transcription" message.
				this.onError("no-speech");
			}
		} catch (e) {
			this.onError(timedOut ? TRANSCRIBE_TIMEOUT_MESSAGE : "Whisper failed: " + (e instanceof Error ? e.message : String(e)));
		} finally {
			clearTimeout(deadline);
		}
	}

	/**
	 * Read the streaming-transcription SSE: fire interim `onResult(partial, false)` on
	 * each delta (live words in the input) and a single `onResult(final, true)` at the
	 * end. If the stream breaks after some text, we still emit what we have rather than
	 * losing the turn.
	 */
	private async _readTranscriptionStream(body: ReadableStream<Uint8Array>, blob: Blob, timedOut: () => boolean = () => false) {
		const reader = body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		let raw = ""; // every decoded byte, so a non-SSE JSON body can still be salvaged
		let state = initialTranscriptState();
		const handle = (payload: string) => {
			const step = reduceTranscriptPayload(state, payload);
			state = step.state;
			if (step.interim !== null) this.onResult(step.interim, false); // live partial
		};
		try {
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				const chunk = decoder.decode(value, { stream: true });
				raw += chunk;
				buffer += chunk;
				const { data, rest } = drainSseData(buffer);
				buffer = rest;
				for (const payload of data) handle(payload);
			}
			// Flush a trailing line with no final newline (e.g. the done event).
			if (buffer.trim().startsWith("data:")) handle(buffer.trim().slice(5).trim());
			const outcome = finalizeTranscript(state, raw);
			if (outcome.kind === "result") {
				this.onAudio(blob);
				this.onResult(outcome.text, true);
			} else {
				// A real mid-stream error gets surfaced + logged; a plain empty result
				// (silence / echo / the agent's own voice tail) is NOT an error — the soft
				// "no-speech" sentinel lets the caller quietly recycle the mic rather than
				// flashing "No transcription returned" at the user.
				this.onError(outcome.kind === "error" ? outcome.message : "no-speech");
			}
		} catch (e) {
			// Salvage whatever we streamed; only surface a hard error if we got nothing.
			const partial = (state.final || state.acc).trim();
			if (partial) {
				this.onAudio(blob);
				this.onResult(partial, true);
			} else {
				// A stream that answered and then stalled reaches here via the deadline's abort.
				// Reporting that as "stream failed: aborted" would name the symptom we caused
				// rather than the stall we caught, and would not tell the user Retry is worth it.
				this.onError(timedOut() ? TRANSCRIBE_TIMEOUT_MESSAGE : "Transcription stream failed: " + (e instanceof Error ? e.message : String(e)));
			}
		}
	}
}
