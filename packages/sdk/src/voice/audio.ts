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

/** A repeated phrase must occur at least this many times CONSECUTIVELY, and cover at least
 *  {@link REPETITION_MIN_COVERAGE} of the words, before the transcript is called a loop. Both
 *  bars are deliberately high: a false positive here DROPS A REAL TURN, which is the exact harm
 *  this is meant to prevent. "no, no, no" (3, short) and "very very good" stay ordinary speech. */
export const REPETITION_MIN_RUN = 4;
export const REPETITION_MIN_COVERAGE = 0.5;
/** Longest phrase considered as the repeating unit under the bars above. Loops observed in the log
 *  are 1–2 words ("chess academy"); 5 is headroom, and a longer "repeat" at only 4 occurrences is
 *  usually a person being emphatic. Above this length the LONG-UNIT rule below takes over. */
const REPETITION_MAX_PHRASE = 5;

/**
 * The second shape, and the bars are the other way round on purpose (#511).
 *
 * A unit of at least {@link REPETITION_LONG_UNIT_MIN_WORDS} words repeated only
 * {@link REPETITION_LONG_UNIT_MIN_RUN} times, covering {@link REPETITION_LONG_UNIT_MIN_COVERAGE} of
 * the transcript, is also a decoder — because verbatim repetition becomes less human the longer the
 * unit is. "no, no, no" is a person insisting; an eleven-word clause reproduced word for word, as
 * essentially the whole turn, is not something people do and is exactly what a stuck decoder emits.
 *
 * This exists because of a phantom that reached an agent as a real user message on 2026-08-10:
 * `"Pottery Barn Please visit www.potterybarn.com for more ideas and inspiration."` — twice. That is
 * Whisper's advertising-boilerplate hallucination, and it is the case #511 was left open for: the
 * `no_speech_prob` gate is a `whisper-1` capability, the default model is `gpt-4o-transcribe`, and
 * `isNoiseTranscript`'s whole-utterance list of known sign-offs can never contain a retailer's ad
 * copy. Widening that list is whack-a-mole against a training corpus; the shape is not.
 *
 * Deliberately NOT a confidence threshold. `include[]=logprobs` is the model-side signal the
 * streaming API does expose, and it stays rejected for the reason it was rejected before: it is a
 * blind discard layer on the only transcription path anyone uses, there is no measured distribution
 * to tune it against, and the live complaint is speech going MISSING. This rule fires on a property
 * of the text that can be read off the recorded transcript and argued about.
 */
export const REPETITION_LONG_UNIT_MIN_WORDS = 6;
export const REPETITION_LONG_UNIT_MIN_RUN = 2;
/** Near-total, because two repeats is a low bar and coverage is what stops it eating a person who
 *  restated themselves and then carried on. */
export const REPETITION_LONG_UNIT_MIN_COVERAGE = 0.85;

/**
 * Is this transcript a decoder repetition loop rather than something a person said? (#512)
 *
 * Autoregressive decoders get stuck. Two real ones reached this platform on 2026-08-11, and the
 * first of them was **sent to the agent as a real user turn**:
 *
 *     "apps chess academy, chess academy, chess academy, chess academy, chess academy, chess academy"
 *     "chess-academy" ×14
 *
 * `isNoiseTranscript` cannot catch these: it matches a fixed list of silence hallucinations, and a
 * loop is made of the user's OWN vocabulary, so every phrase in it is plausible. The shape is the
 * signal, not the words — which is also why this survives whatever the transcription model does
 * next. Whether `temperature` provoked these is unresolved (see stt.ts); this holds either way,
 * and it is the half of #512 that does not depend on that answer.
 *
 * Judged on the whole utterance and on normalised words, so punctuation and casing between the
 * repeats ("chess academy, chess academy" vs "chess-academy chess-academy") cannot hide the shape.
 */
export function isRepetitionLoop(text: string): boolean {
	const w = normalizeSpeech(text).split(" ").filter(Boolean);
	if (w.length < REPETITION_MIN_RUN * 1) return false;
	// The two shapes are one scan with two sets of bars, so a unit can only be judged by the rule
	// whose length band it falls in and neither rule can be widened without the other being read.
	const maxSize = Math.max(REPETITION_MAX_PHRASE, Math.floor(w.length / REPETITION_LONG_UNIT_MIN_RUN));
	for (let size = 1; size <= Math.min(maxSize, Math.floor(w.length / REPETITION_LONG_UNIT_MIN_RUN)); size++) {
		const long = size >= REPETITION_LONG_UNIT_MIN_WORDS;
		if (!long && size > REPETITION_MAX_PHRASE) continue;
		const minRun = long ? REPETITION_LONG_UNIT_MIN_RUN : REPETITION_MIN_RUN;
		const minCoverage = long ? REPETITION_LONG_UNIT_MIN_COVERAGE : REPETITION_MIN_COVERAGE;
		for (let start = 0; start + size * minRun <= w.length; start++) {
			const phrase = w.slice(start, start + size).join(" ");
			let run = 1;
			while (w.slice(start + run * size, start + (run + 1) * size).join(" ") === phrase) run++;
			if (run >= minRun && (run * size) / w.length >= minCoverage) return true;
		}
	}
	return false;
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
