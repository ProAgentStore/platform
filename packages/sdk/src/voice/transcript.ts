/**
 * The streaming-transcription (gpt-4o-transcribe SSE) reduction as PURE logic — extracted
 * from `stt.ts`'s `_readTranscriptionStream` so the fiddly bits (delta accumulation, the
 * done-vs-error precedence, the non-SSE JSON salvage, and the "empty ≠ error" / no-speech
 * decision) are unit-tested without a real network stream. `stt.ts` keeps only the
 * ReadableStream glue and drives these two functions.
 */

import { parseTranscriptionEvent } from "./audio.js";

/** The running state as SSE events fold in. `acc` = concatenated deltas (the live partial);
 *  `final` = the `transcript.text.done` text (wins over `acc`); `streamErr` = a reason from
 *  an `error` event on an otherwise-200 stream. */
export interface TranscriptState {
	acc: string;
	final: string;
	streamErr: string;
}

export function initialTranscriptState(): TranscriptState {
	return { acc: "", final: "", streamErr: "" };
}

/** The result of folding one payload: the new state plus any live partial to surface
 *  (`onResult(interim, false)`), or null when the event produced no partial. */
export interface TranscriptStep {
	state: TranscriptState;
	interim: string | null;
}

/**
 * Fold ONE SSE `data:` payload into the transcript state. Deltas accumulate and yield a
 * live partial; a done event sets the final; an `error` (or `*.error`) event records a
 * reason. Unknown/heartbeat payloads are inert. Pure — no side effects.
 */
export function reduceTranscriptPayload(state: TranscriptState, payload: string): TranscriptStep {
	const ev = parseTranscriptionEvent(payload);
	if (!ev) return { state, interim: null };
	if (ev.type === "transcript.text.delta" && ev.delta) {
		const acc = state.acc + ev.delta;
		return { state: { ...state, acc }, interim: acc.trim() };
	}
	if (ev.type === "transcript.text.done" && typeof ev.text === "string") {
		return { state: { ...state, final: ev.text }, interim: null };
	}
	if (ev.type === "error" || ev.type.endsWith(".error")) {
		// OpenAI can end a 200 stream with an error event (mid-transcription failure) — keep
		// the reason so the turn surfaces it instead of silently dropping.
		return { state: { ...state, streamErr: ev.text || ev.delta || "transcription error" }, interim: null };
	}
	return { state, interim: null };
}

export type TranscriptOutcome =
	| { kind: "result"; text: string }
	| { kind: "no-speech" }
	| { kind: "error"; message: string };

/**
 * Decide the outcome of a completed stream. Precedence: any transcribed text wins (final
 * over accumulated deltas); else a mid-stream error surfaces; else it's a plain empty
 * result — silence / echo / the agent's own voice tail — reported as the soft `no-speech`
 * sentinel, NOT a scary error. `raw` is every decoded byte so a non-SSE `{ text }` JSON
 * body (proxy/model ignored `stream:true`) can still be salvaged. Pure.
 */
export function finalizeTranscript(state: TranscriptState, raw: string): TranscriptOutcome {
	let result = (state.final || state.acc).trim();
	if (!result && !state.streamErr) {
		try {
			const j = JSON.parse(raw.trim()) as { text?: string };
			if (typeof j.text === "string") result = j.text.trim();
		} catch {}
	}
	if (result) return { kind: "result", text: result };
	if (state.streamErr) return { kind: "error", message: `Whisper error: ${state.streamErr.slice(0, 300)}` };
	return { kind: "no-speech" };
}
