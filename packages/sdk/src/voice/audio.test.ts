import { describe, expect, it } from "vitest";
import { computeRmsLevel, describeTranscribeHttpError, drainSseData, isNoiseTranscript, isPlatformErrorBody, isTooShortToTranscribe, MIN_TRANSCRIBE_MS, parseTranscriptionEvent, parseUpstreamErrorDetail, pickRecorderMimeType, whisperFilename, RECORDER_MIME_CANDIDATES , isRepetitionLoop } from "./audio.js";

describe("isNoiseTranscript", () => {
	it("drops the exact Whisper silence hallucinations seen in the wild", () => {
		// These were submitted as real turns when the user wasn't talking (all had audio).
		for (const junk of ["you", "You", "...", "…", '"', ".", "Thank you.", "thanks for watching", "so", "um"]) {
			expect(isNoiseTranscript(junk)).toBe(true);
		}
	});

	it("drops empty / whitespace / single-glyph transcripts", () => {
		for (const junk of ["", "   ", "-", "’", "u"]) expect(isNoiseTranscript(junk)).toBe(true);
	});

	it("KEEPS genuine short commands and real sentences", () => {
		for (const real of ["yes", "no", "go", "stop", "do it", "next", "fix bugs", "what's the latest?", "you should refactor this"]) {
			expect(isNoiseTranscript(real)).toBe(false);
		}
	});

	it("KEEPS non-Latin speech — a Chinese sentence is not 'a stray glyph'", () => {
		// The old [^a-z0-9] strip deleted every CJK character, so real Chinese turns
		// were classified as noise and silently discarded before upload.
		for (const real of ["你好，我叫小明。", "我想练习中文", "好", "はい、そうです", "안녕하세요"]) {
			expect(isNoiseTranscript(real)).toBe(false);
		}
	});

	it("still drops Chinese Whisper silence hallucinations and CJK-punctuation-only junk", () => {
		for (const junk of ["谢谢观看", "请订阅", "。", "、…。"]) {
			expect(isNoiseTranscript(junk)).toBe(true);
		}
		// "谢谢" (thank you) is a real learner utterance — must NOT be dropped.
		expect(isNoiseTranscript("谢谢")).toBe(false);
	});

	// ── #332: silence comes back as OUR OWN vocabulary list ────────────────────────────────
	//
	// Two user messages in a row, both with audio, both reading "Coder Lead" — the agent's own
	// name, which the console adds to the transcription bias list. The user said neither. Given
	// silence the decoder returns a term from the list it was handed, and the proper noun is the
	// likeliest one because it is the only distinctive token among generic vocabulary.
	it("drops a transcript that is exactly one term from the bias prompt", () => {
		const bias = "bug, bugs, refactor, function, commit, Coder Lead";
		expect(isNoiseTranscript("Coder Lead", bias)).toBe(true);
		expect(isNoiseTranscript("coder lead.", bias)).toBe(true);
		// Without the prompt there is nothing to compare against — the caller decides.
		expect(isNoiseTranscript("Coder Lead")).toBe(false);
	});

	it("KEEPS a real utterance that merely contains a bias term", () => {
		const bias = "bug, bugs, refactor, function, commit, Coder Lead";
		for (const real of ["ask Coder Lead to look at this", "Coder Lead, what's the status?", "refactor the function"]) {
			expect(isNoiseTranscript(real, bias)).toBe(false);
		}
	});

	// The narrowing that keeps this from becoming the opposite bug: a one-word utterance is a
	// plausible genuine command, and this filter's whole contract is that short commands survive.
	it("KEEPS a single-word bias term — 'commit' alone is something a user really says", () => {
		const bias = "bug, bugs, refactor, function, commit, Coder Lead";
		for (const real of ["commit", "refactor", "bugs"]) expect(isNoiseTranscript(real, bias)).toBe(false);
	});
});

describe("isTooShortToTranscribe", () => {
	it("drops a sub-threshold clip (the 'audio too short' 400 case)", () => {
		expect(isTooShortToTranscribe(4000, MIN_TRANSCRIBE_MS - 50)).toBe(true);
		expect(isTooShortToTranscribe(50, 3000)).toBe(true); // header-only capture
	});
	it("keeps a real utterance", () => {
		expect(isTooShortToTranscribe(8000, 700)).toBe(false);
		expect(isTooShortToTranscribe(2000, MIN_TRANSCRIBE_MS)).toBe(false);
	});
});

describe("parseTranscriptionEvent", () => {
	it("decodes a delta event", () => {
		expect(parseTranscriptionEvent('{"type":"transcript.text.delta","delta":"He"}'))
			.toEqual({ type: "transcript.text.delta", delta: "He" });
	});
	it("decodes a done event", () => {
		expect(parseTranscriptionEvent('{"type":"transcript.text.done","text":"Hello world"}'))
			.toEqual({ type: "transcript.text.done", text: "Hello world" });
	});
	it("ignores [DONE], blanks, and malformed json", () => {
		expect(parseTranscriptionEvent("[DONE]")).toBeNull();
		expect(parseTranscriptionEvent("   ")).toBeNull();
		expect(parseTranscriptionEvent("{not json")).toBeNull();
		expect(parseTranscriptionEvent('{"no":"type"}')).toBeNull();
	});
});

describe("drainSseData", () => {
	it("extracts complete data: lines and holds the partial remainder", () => {
		const { data, rest } = drainSseData('data: {"a":1}\ndata: {"b":2}\ndata: {"c":');
		expect(data).toEqual(['{"a":1}', '{"b":2}']);
		expect(rest).toBe('data: {"c":'); // incomplete — carried to the next chunk
	});
	it("drops event:/comment/blank lines", () => {
		const { data } = drainSseData("event: transcript.text.delta\ndata: {\"delta\":\"hi\"}\n\n");
		expect(data).toEqual(['{"delta":"hi"}']);
	});
	it("reassembles across chunk boundaries", () => {
		const first = drainSseData('data: {"x":');
		expect(first.data).toEqual([]);
		const second = drainSseData(first.rest + '1}\n');
		expect(second.data).toEqual(['{"x":1}']);
	});
});

describe("computeRmsLevel", () => {
	it("is 0 for silence and an empty frame", () => {
		expect(computeRmsLevel(new Uint8Array(0))).toBe(0);
		expect(computeRmsLevel(new Uint8Array([0, 0, 0, 0]))).toBe(0);
	});

	it("clamps a maxed-out frame to 1", () => {
		expect(computeRmsLevel(new Uint8Array([255, 255, 255, 255]))).toBe(1);
	});

	it("rises monotonically with loudness", () => {
		const quiet = computeRmsLevel(new Uint8Array([10, 10, 10, 10]));
		const loud = computeRmsLevel(new Uint8Array([90, 90, 90, 90]));
		expect(quiet).toBeGreaterThan(0);
		expect(loud).toBeGreaterThan(quiet);
		expect(loud).toBeLessThanOrEqual(1);
	});

	it("matches the RMS formula (uniform 128 → 1.0)", () => {
		expect(computeRmsLevel(new Uint8Array([128, 128]))).toBeCloseTo(1, 5);
	});
});

describe("pickRecorderMimeType", () => {
	it("prefers opus-in-webm when supported", () => {
		expect(pickRecorderMimeType(() => true)).toBe("audio/webm;codecs=opus");
	});

	it("falls through to the first supported candidate (Safari → mp4)", () => {
		const only = (t: string) => t === "audio/mp4";
		expect(pickRecorderMimeType(only)).toBe("audio/mp4");
	});

	it("returns '' when nothing is supported (let the recorder decide)", () => {
		expect(pickRecorderMimeType(() => false)).toBe("");
	});

	it("only ever returns a known candidate or ''", () => {
		const picked = pickRecorderMimeType((t) => t === "audio/ogg");
		expect([...RECORDER_MIME_CANDIDATES, ""]).toContain(picked);
	});
});

describe("whisperFilename", () => {
	it("maps mp4 (Safari) so Whisper doesn't 400 on a wrong extension", () => {
		expect(whisperFilename("audio/mp4")).toBe("audio.mp4");
	});
	it("maps ogg", () => {
		expect(whisperFilename("audio/ogg;codecs=vorbis")).toBe("audio.ogg");
	});
	it("defaults to webm (incl. opus and unknown types)", () => {
		expect(whisperFilename("audio/webm;codecs=opus")).toBe("audio.webm");
		expect(whisperFilename("")).toBe("audio.webm");
		expect(whisperFilename("application/octet-stream")).toBe("audio.webm");
	});
});

describe("parseUpstreamErrorDetail", () => {
	it("pulls the message out of an OpenAI-style error body", () => {
		expect(parseUpstreamErrorDetail('{"error":{"message":"audio file is too short"}}')).toBe("audio file is too short");
	});
	it("falls back to raw text for non-JSON", () => {
		expect(parseUpstreamErrorDetail("Bad Gateway")).toBe("Bad Gateway");
	});
	it("falls back to raw text for JSON without error.message", () => {
		expect(parseUpstreamErrorDetail('{"ok":false}')).toBe('{"ok":false}');
	});
	it("is empty for an empty body (no throw)", () => {
		expect(parseUpstreamErrorDetail("")).toBe("");
	});

	/**
	 * #421. TWO envelopes reach this parser and it only knew one. OpenAI wraps the reason in an
	 * OBJECT (`{error:{message}}`); PAGS's own API returns a STRING (`{error:"…"}`,
	 * `workers/api/src/index.ts`), so `?.error?.message` was undefined and it fell through to the
	 * raw body. The one message the platform writes to be reassuring during a deploy therefore
	 * reached the user as literal JSON.
	 */
	it("pulls the message out of the PLATFORM's own error body, whose error is a string", () => {
		expect(parseUpstreamErrorDetail('{"error":"The service is updating — please try again in a moment."}')).toBe("The service is updating — please try again in a moment.");
	});
	it("tells the two envelopes apart, which is the only signal available at the boundary", () => {
		expect(isPlatformErrorBody('{"error":"The service is updating — please try again in a moment."}')).toBe(true);
		expect(isPlatformErrorBody('{"error":{"message":"audio file is too short"}}')).toBe(false);
		expect(isPlatformErrorBody("Bad Gateway")).toBe(false);
		expect(isPlatformErrorBody("")).toBe(false);
	});
});

describe("describeTranscribeHttpError (#421 — say whose failure it is)", () => {
	const DEPLOY = '{"error":"The service is updating — please try again in a moment."}';

	/**
	 * The observed message, verbatim:
	 *
	 *     ⚠ Whisper error 503: {"error":"The service is updating — please try again in a moment."}
	 *
	 * Raw JSON, and a PAGS redeploy attributed to the user's AI vendor — which sends them to check
	 * their OpenAI key and their billing for something neither of those caused.
	 */
	it("does not blame OpenAI for a PAGS deploy, and does not print JSON at anyone", () => {
		const msg = describeTranscribeHttpError(503, DEPLOY);
		expect(msg).not.toMatch(/Whisper/);
		expect(msg).not.toMatch(/[{}"]/);
		expect(msg).toMatch(/ProAgentStore is updating/);
	});
	it("keeps the platform's own wording for its other statuses — it is already written for a person", () => {
		expect(describeTranscribeHttpError(429, '{"error":"Too many requests — slow down."}')).toBe("Too many requests — slow down.");
	});
	it("still surfaces OpenAI's real reason rather than a bare status", () => {
		expect(describeTranscribeHttpError(400, '{"error":{"message":"audio file is too short"}}')).toBe("Whisper error 400: audio file is too short");
	});
	it("survives a body that is neither (an edge 502 page, say)", () => {
		expect(describeTranscribeHttpError(502, "<html>Bad Gateway</html>")).toMatch(/Whisper error 502/);
	});
});

describe("isRepetitionLoop — #512: a decoder that stuck is not a user turn", () => {
	it("catches the loop that WAS sent to an agent as a real user message", () => {
		// Recorded 2026-08-11 21:44:05. isNoiseTranscript cannot catch this: it matches a fixed
		// list of silence hallucinations, and every phrase here is the user's own vocabulary.
		expect(isRepetitionLoop("apps chess academy, chess academy, chess academy, chess academy, chess academy, chess academy")).toBe(true);
	});

	it("catches the longer loop that was only caught by luck downstream (01:33:37)", () => {
		expect(isRepetitionLoop(Array(14).fill("chess-academy").join(" "))).toBe(true);
	});

	it("is blind to punctuation and casing between the repeats", () => {
		// "chess academy, chess academy" and "chess-academy chess-academy" are the same shape.
		expect(isRepetitionLoop("Chess Academy. chess-academy, CHESS academy chess academy")).toBe(true);
	});

	it("does NOT fire on a person being emphatic — a false positive DROPS a real turn", () => {
		expect(isRepetitionLoop("no, no, no, that is not what I meant")).toBe(false);
		expect(isRepetitionLoop("very very good")).toBe(false);
		expect(isRepetitionLoop("run the tests again and again until they pass")).toBe(false);
		expect(isRepetitionLoop("I said it three times: stop, stop, stop")).toBe(false);
	});

	it("does NOT fire on ordinary speech that repeats a word naturally", () => {
		expect(isRepetitionLoop("the deploy failed so the deploy needs a rerun and the deploy log is here")).toBe(false);
		expect(isRepetitionLoop("add a test for the test runner in the test directory")).toBe(false);
	});

	it("needs COVERAGE as well as a run — a loop tacked onto a real sentence stays a real sentence", () => {
		// Deliberate: refusing to send a long instruction because it ended in a stutter would lose
		// more than it saves. Only a transcript that is MOSTLY the loop is refused.
		const real = "please review the deployment logs and open an issue for anything that looks wrong before the release";
		expect(isRepetitionLoop(`${real} chess academy chess academy chess academy chess academy`)).toBe(false);
	});
});
