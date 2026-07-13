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
 * Whisper (esp. gpt-4o-transcribe) HALLUCINATES filler on silence, background noise, or
 * the agent's own voice echo — it emits tokens like "you", ".", "…", "Thank you.", or
 * "Thanks for watching." for audio with no real speech. Those got submitted as real chat
 * turns ("I didn't even say anything → it replied to nothing"). This drops a transcript
 * that is only punctuation/whitespace OR a known silence-hallucination phrase.
 *
 * Deliberately NARROW so genuine short commands survive: "yes", "no", "go", "stop",
 * "do it", "next" are NOT in the set and pass through. Whole-utterance match only
 * (punctuation stripped, lower-cased) — a real sentence that merely contains "you" is fine.
 */
const SILENCE_HALLUCINATIONS = new Set([
	"you",
	"thank you",
	"thanks for watching",
	"thanks for watching!",
	"please subscribe",
	"bye",
	"so",
	"uh",
	"um",
	// Whisper's classic Chinese silence hallucinations (subtitle-corpus artifacts).
	// NOT "谢谢" (thank you) — that's a real thing a language learner says.
	"谢谢观看",
	"请订阅",
]);
export function isNoiseTranscript(text: string): boolean {
	if (!text) return true;
	// Strip punctuation (Latin + CJK) + collapse whitespace, then judge.
	const t = text
		.toLowerCase()
		.replace(/[.,!?"'’“”…·•–—:;()。，！？、：；「」『』（）《》-]|\[|\]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (!t) return true; // was only punctuation/whitespace (".", "…", "\"", …)
	// Count letters/digits in ANY script — the old [^a-z0-9] strip deleted every CJK
	// character, so a whole Chinese sentence counted as noise and the turn was
	// silently discarded before it was ever sent.
	const glyphs = t.replace(/[^\p{L}\p{N}]/gu, "");
	if (!glyphs) return true;
	// One Latin letter is a stray glyph; one CJK/Kana/Hangul char is a word ("好" = OK).
	if (
		glyphs.length < 2 &&
		!/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(glyphs)
	)
		return true;
	return SILENCE_HALLUCINATIONS.has(t);
}

/** One decoded event from the streaming-transcription SSE (gpt-4o-transcribe). */
export interface TranscriptionStreamEvent {
	type: string;
	delta?: string;
	text?: string;
}

/**
 * Parse one SSE `data:` payload from a streaming transcription. Returns null for junk,
 * heartbeats, or the `[DONE]` sentinel. Pure so the (fiddly) event handling is tested
 * without a real network stream. Event shapes (per the OpenAI API reference):
 *   { type: "transcript.text.delta", delta: "He" }   — incremental
 *   { type: "transcript.text.done",  text: "Hello" } — final
 */
export function parseTranscriptionEvent(dataPayload: string): TranscriptionStreamEvent | null {
	const s = dataPayload.trim();
	if (!s || s === "[DONE]") return null;
	try {
		const o = JSON.parse(s) as TranscriptionStreamEvent;
		return o && typeof o.type === "string" ? o : null;
	} catch {
		return null;
	}
}

/**
 * Pull complete `data:` payloads out of an SSE text buffer, returning the leftover
 * partial line to carry into the next chunk (SSE events can split across network
 * chunks). Pure so chunk-boundary handling is unit-tested. Only `data:` lines are
 * returned; `event:`/comment/blank lines are dropped.
 */
export function drainSseData(buffer: string): { data: string[]; rest: string } {
	const parts = buffer.split("\n");
	// The final segment may be an incomplete line (no trailing newline yet) — hold it.
	const rest = parts.pop() ?? "";
	const data: string[] = [];
	for (const line of parts) {
		const t = line.trim();
		if (t.startsWith("data:")) data.push(t.slice(5).trim());
	}
	return { data, rest };
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
