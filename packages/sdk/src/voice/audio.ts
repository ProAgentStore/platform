/**
 * Pure audio/codec helpers, split out of the browser-heavy STT + mic-monitor code
 * so the fiddly bits (level maths, codec/filename selection, upstream error parsing)
 * are unit-tested without a real AudioContext, MediaRecorder, or network.
 */

import { normalizeSpeech } from "./normalize.js";
import { isTranscribeBiasEcho } from "./prompt.js";

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
 * That whole-utterance rule is also what makes a WIDER list cheap: adding a sign-off cannot
 * eat a sentence that merely contains it, so the cost of another entry is close to zero.
 *
 * EVERY ENTRY MUST ALREADY BE IN NORMALISED FORM, because the lookup is
 * `SILENCE_HALLUCINATIONS.has(normalizeSpeech(text))` — the raw transcript is normalised, the
 * entry is not. An entry carrying anything `normalizeSpeech` removes can therefore never match,
 * and looks exactly like an entry that works. `"thanks for watching!"` sat here doing nothing
 * (#400): punctuation is stripped before the lookup, so the `!` copy was unreachable while the
 * copy without it did all the work. An apostrophe is the same trap in reverse — elision marks are
 * DELETED, so the spoken "don't forget to subscribe" arrives as `dont forget to subscribe`.
 *
 * `silence-hallucinations.test.ts` asserts `normalizeSpeech(entry) === entry` for every entry, so
 * a dead one fails the suite instead of quietly widening nothing.
 */
const SILENCE_HALLUCINATIONS = new Set([
	"you",
	"thank you",
	"thanks for watching",
	// The `thank you` half of the same corpus artefact. #400: Whisper emitted "Thank you for
	// watching!" on near-silence, it normalised to a phrase this set did not carry, and the agent
	// answered a turn the owner never took — earnestly, in their transcript, indistinguishable
	// from something they said.
	"thank you for watching",
	"thank you so much for watching",
	"please subscribe",
	"subscribe to my channel",
	"dont forget to subscribe",
	"see you in the next video",
	"bye",
	"so",
	"uh",
	"um",
	// Whisper's classic Chinese silence hallucinations (subtitle-corpus artifacts).
	// NOT "谢谢" (thank you) — that's a real thing a language learner says.
	"谢谢观看",
	"请订阅",
]);

/**
 * The phrase set, for the guard that keeps it matchable. Exported for tests only — callers judge
 * a transcript with `isNoiseTranscript`, which is the function that knows about normalisation,
 * bias echo and glyph counting. Handing the bare set to a caller would invite a second, wrong
 * lookup against un-normalised text, which is the defect this export exists to prevent.
 */
export const SILENCE_HALLUCINATION_PHRASES: ReadonlySet<string> = SILENCE_HALLUCINATIONS;
export function isNoiseTranscript(text: string, biasPrompt?: string): boolean {
	if (!text) return true;
	// Strip punctuation + collapse whitespace, then judge. The normaliser is SHARED with the
	// command matcher (#334) — this filter's wider punctuation set was the correct one, and
	// keeping two of them is what let a hyphen decide whether a stop-word matched.
	const t = normalizeSpeech(text);
	if (!t) return true; // was only punctuation/whitespace (".", "…", "\"", …)
	// Our own vocabulary bias read back verbatim on silence (#332) — see isTranscribeBiasEcho.
	if (biasPrompt && isTranscribeBiasEcho(t, biasPrompt)) return true;
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
 * Pull a human reason out of an error body from either side of the proxy. Never throws.
 *
 * TWO envelopes reach this, and until #421 it only knew one. OpenAI returns
 * `{ error: { message } }`; **PAGS's own API returns `{ error: "…" }`, where `error` is a STRING** —
 * so `?.error?.message` was `undefined` and it fell through to `|| rawBody`. During a deploy the
 * platform's deliberately reassuring 503 ("The service is updating — please try again in a moment.",
 * `workers/api/src/index.ts`) therefore reached the user as raw JSON.
 */
export function parseUpstreamErrorDetail(rawBody: string): string {
	if (!rawBody) return "";
	try {
		const err = (JSON.parse(rawBody) as { error?: unknown })?.error;
		if (typeof err === "string") return err || rawBody;
		const message = (err as { message?: unknown } | undefined)?.message;
		return typeof message === "string" && message ? message : rawBody;
	} catch {
		return rawBody;
	}
}

/** Did this error body come from PAGS itself rather than from OpenAI? See above — the string-vs-
 *  object shape of `error` is the discriminator, and it is the only one available at the boundary. */
export function isPlatformErrorBody(rawBody: string): boolean {
	if (!rawBody) return false;
	try {
		return typeof (JSON.parse(rawBody) as { error?: unknown })?.error === "string";
	} catch {
		return false;
	}
}

/**
 * The message a user sees when a transcription request comes back not-OK (#421).
 *
 * Two things it must not do, both of which it did. It must not print raw JSON — the one message the
 * platform writes specifically to be calming was delivered in the least calming form available. And
 * it must not say **"Whisper"** about a failure that never reached OpenAI: a PAGS redeploy blamed on
 * the user's AI vendor sends them to look at the wrong thing, and a 503 from our own proxy is
 * distinguishable right here.
 */
export function describeTranscribeHttpError(status: number, rawBody: string): string {
	const detail = parseUpstreamErrorDetail(rawBody);
	if (isPlatformErrorBody(rawBody)) {
		// 503 is the deploy window specifically; anything else from us keeps its own wording, which
		// is already written for a person.
		return status === 503 ? "ProAgentStore is updating — try that again in a moment." : detail;
	}
	return `Whisper error ${status}${detail ? `: ${detail.slice(0, 300)}` : ""}`;
}
