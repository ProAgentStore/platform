/**
 * Pure audio/codec helpers, split out of the browser-heavy STT + mic-monitor code
 * so the fiddly bits (level maths, codec/filename selection, upstream error parsing)
 * are unit-tested without a real AudioContext, MediaRecorder, or network.
 */

/** Recorder mime types we try, best → worst. Opus in WebM is smallest + best for
 *  Whisper; Safari only does mp4/…; ogg is a last resort. */
export const RECORDER_MIME_CANDIDATES = [
	"audio/webm;codecs=opus",
	"audio/webm",
	"audio/mp4",
	"audio/ogg",
] as const;

/**
 * RMS loudness of one FFT frame, normalised to ~0–1. `128` is the reference level
 * (half of a byte-magnitude bin); the result is clamped so a loud frame can't exceed 1.
 */
export function computeRmsLevel(freq: Uint8Array): number {
	if (freq.length === 0) return 0;
	let sum = 0;
	for (let i = 0; i < freq.length; i++) sum += freq[i] * freq[i];
	return Math.min(1, Math.sqrt(sum / freq.length) / 128);
}

/**
 * Pick the first recorder mime type the browser actually supports. `isSupported` is
 * injected (MediaRecorder.isTypeSupported) so this is pure + testable. Returns `""`
 * when none match — the caller then lets MediaRecorder choose its own default.
 */
export function pickRecorderMimeType(isSupported: (type: string) => boolean): string {
	return RECORDER_MIME_CANDIDATES.find((t) => isSupported(t)) ?? "";
}

/**
 * Whisper infers the audio format from the filename EXTENSION, so it must match the
 * recorded container — Safari records `audio/mp4`, which uploaded as `audio.webm`
 * gets rejected with a 400. Map the blob mime to the right extension.
 */
export function whisperFilename(blobType: string): string {
	const ext = blobType.includes("mp4") ? "mp4" : blobType.includes("ogg") ? "ogg" : "webm";
	return `audio.${ext}`;
}

/**
 * OpenAI rejects clips under 0.1s with a 400 `audio_too_short`, and the VAD can fire
 * on a cough or a click that records almost nothing. Anything below this floor is
 * never real speech — dropping it BEFORE upload stops the error-log spam (and a
 * pointless round-trip). Duration is the reliable signal; the byte floor only catches
 * a header-only capture when the duration is unknown.
 */
export const MIN_TRANSCRIBE_MS = 250;
export const MIN_TRANSCRIBE_BYTES = 512;
export function isTooShortToTranscribe(byteLength: number, durationMs: number): boolean {
	return durationMs < MIN_TRANSCRIBE_MS || byteLength < MIN_TRANSCRIBE_BYTES;
}

/**
 * Pull a human reason out of an upstream (OpenAI) error body. It's usually JSON
 * `{ error: { message } }`; fall back to the raw text when it isn't. Never throws.
 */
export function parseUpstreamErrorDetail(rawBody: string): string {
	if (!rawBody) return "";
	try {
		return (JSON.parse(rawBody) as { error?: { message?: string } })?.error?.message || rawBody;
	} catch {
		return rawBody;
	}
}
