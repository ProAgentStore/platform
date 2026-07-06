import { describe, expect, it } from "vitest";
import { computeRmsLevel, parseUpstreamErrorDetail, pickRecorderMimeType, whisperFilename, RECORDER_MIME_CANDIDATES } from "./audio.js";

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
});
