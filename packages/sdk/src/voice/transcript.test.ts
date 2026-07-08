import { describe, expect, it } from "vitest";
import { finalizeTranscript, initialTranscriptState, reduceTranscriptPayload, type TranscriptState } from "./transcript.js";

/** Fold a sequence of SSE `data:` payloads through the reducer, collecting the interims
 *  the caller would emit and returning the terminal state — mirrors stt.ts's stream loop. */
function run(payloads: string[]): { state: TranscriptState; interims: string[] } {
	let state = initialTranscriptState();
	const interims: string[] = [];
	for (const p of payloads) {
		const step = reduceTranscriptPayload(state, p);
		state = step.state;
		if (step.interim !== null) interims.push(step.interim);
	}
	return { state, interims };
}

const delta = (d: string) => JSON.stringify({ type: "transcript.text.delta", delta: d });
const done = (t: string) => JSON.stringify({ type: "transcript.text.done", text: t });

describe("reduceTranscriptPayload", () => {
	it("accumulates deltas and emits a growing partial each time", () => {
		const { state, interims } = run([delta("He"), delta("llo"), delta(" there")]);
		expect(interims).toEqual(["He", "Hello", "Hello there"]);
		expect(state.acc).toBe("Hello there");
		expect(state.final).toBe("");
	});

	it("a done event sets final and emits no partial", () => {
		const { state, interims } = run([delta("Hel"), done("Hello world")]);
		expect(state.final).toBe("Hello world");
		expect(interims).toEqual(["Hel"]); // only the delta produced a partial
	});

	it("captures an error event's reason without touching text", () => {
		const { state } = run([delta("Hel"), JSON.stringify({ type: "error", text: "rate limited" })]);
		expect(state.streamErr).toBe("rate limited");
		expect(state.acc).toBe("Hel");
	});

	it("a namespaced *.error event also records a reason", () => {
		const { state } = run([JSON.stringify({ type: "transcript.text.error", delta: "boom" })]);
		expect(state.streamErr).toBe("boom");
	});

	it("ignores heartbeats, [DONE], junk, and empty deltas (no state change, no partial)", () => {
		const { state, interims } = run(["", "[DONE]", "not json", JSON.stringify({ type: "transcript.text.delta" })]);
		expect(state).toEqual(initialTranscriptState());
		expect(interims).toEqual([]);
	});

	it("is pure — the input state object is not mutated", () => {
		const start = initialTranscriptState();
		reduceTranscriptPayload(start, delta("x"));
		expect(start).toEqual({ acc: "", final: "", streamErr: "" });
	});
});

describe("finalizeTranscript", () => {
	it("prefers the final over the accumulated deltas", () => {
		expect(finalizeTranscript({ acc: "Hel", final: "Hello world", streamErr: "" }, "")).toEqual({
			kind: "result",
			text: "Hello world",
		});
	});

	it("falls back to accumulated deltas when there is no done event", () => {
		expect(finalizeTranscript({ acc: "  fix the bug  ", final: "", streamErr: "" }, "")).toEqual({
			kind: "result",
			text: "fix the bug",
		});
	});

	it("salvages a non-SSE `{ text }` JSON body (proxy ignored stream:true)", () => {
		expect(finalizeTranscript(initialTranscriptState(), '{"text":"salvaged"}')).toEqual({
			kind: "result",
			text: "salvaged",
		});
	});

	it("empty, no error, unparseable raw → soft no-speech (not an error)", () => {
		expect(finalizeTranscript(initialTranscriptState(), "")).toEqual({ kind: "no-speech" });
		expect(finalizeTranscript(initialTranscriptState(), "garbage")).toEqual({ kind: "no-speech" });
	});

	it("empty text but a stream error → surfaced (truncated) error", () => {
		const out = finalizeTranscript({ acc: "", final: "", streamErr: "upstream exploded" }, "");
		expect(out).toEqual({ kind: "error", message: "Whisper error: upstream exploded" });
	});

	it("a result wins even if an error event also arrived (text > error)", () => {
		expect(finalizeTranscript({ acc: "hi", final: "", streamErr: "late error" }, "")).toEqual({
			kind: "result",
			text: "hi",
		});
	});

	it("does NOT JSON-salvage when a stream error is present (error takes precedence)", () => {
		expect(finalizeTranscript({ acc: "", final: "", streamErr: "boom" }, '{"text":"ignored"}')).toEqual({
			kind: "error",
			message: "Whisper error: boom",
		});
	});
});
