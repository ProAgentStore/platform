import { describe, expect, it } from "vitest";
import { ECHO_GUARD_MS, isEchoing, shouldIgnoreResult, canOpenMic, endOfTurnAction, derivePhase } from "./machine.js";

const NOW = 1_000_000;

describe("isEchoing", () => {
	it("true while the agent is speaking", () => {
		expect(isEchoing({ ttsSpeaking: true, speakEndedAt: 0 }, NOW)).toBe(true);
	});
	it("true within the echo tail after speech ends, false after it", () => {
		expect(isEchoing({ ttsSpeaking: false, speakEndedAt: NOW - (ECHO_GUARD_MS - 1) }, NOW)).toBe(true);
		expect(isEchoing({ ttsSpeaking: false, speakEndedAt: NOW - ECHO_GUARD_MS }, NOW)).toBe(false);
		expect(isEchoing({ ttsSpeaking: false, speakEndedAt: NOW - 5000 }, NOW)).toBe(false);
	});
});

describe("shouldIgnoreResult", () => {
	const base = { ttsSpeaking: false, speakEndedAt: 0, paused: false, muted: false };
	it("ignores while echoing (self-transcription guard)", () => {
		expect(shouldIgnoreResult({ ...base, ttsSpeaking: true }, NOW)).toBe(true);
		expect(shouldIgnoreResult({ ...base, speakEndedAt: NOW - 100 }, NOW)).toBe(true);
	});
	it("ignores while paused (a turn is already in flight / teardown)", () => {
		expect(shouldIgnoreResult({ ...base, paused: true }, NOW)).toBe(true);
	});
	it("accepts a normal result (not echoing, not paused)", () => {
		expect(shouldIgnoreResult(base, NOW)).toBe(false);
	});
	it("muted alone does NOT swallow a result (that's handled by not opening the mic)", () => {
		expect(shouldIgnoreResult({ ...base, muted: true }, NOW)).toBe(false);
	});
});

describe("canOpenMic", () => {
	it("open only when neither paused nor muted", () => {
		expect(canOpenMic({ paused: false, muted: false })).toBe(true);
		expect(canOpenMic({ paused: true, muted: false })).toBe(false);
		expect(canOpenMic({ paused: false, muted: true })).toBe(false);
		expect(canOpenMic({ paused: true, muted: true })).toBe(false);
	});
});

describe("endOfTurnAction (dictation gate)", () => {
	it("no gate (iOS / gate off) → always transcribe", () => {
		expect(endOfTurnAction(null)).toBe("transcribe");
		expect(endOfTurnAction(undefined)).toBe("transcribe");
	});
	it("alive gate that heard nothing → discard (silence/keyboard/noise)", () => {
		expect(endOfTurnAction({ isAlive: true, heardSpeech: false })).toBe("discard");
	});
	it("alive gate that heard real words → transcribe", () => {
		expect(endOfTurnAction({ isAlive: true, heardSpeech: true })).toBe("transcribe");
	});
	it("a NOT-alive gate can never veto real speech → transcribe", () => {
		// The safety valve: a stalled/dead recognizer must not black-hole your voice.
		expect(endOfTurnAction({ isAlive: false, heardSpeech: false })).toBe("transcribe");
	});
});

describe("derivePhase", () => {
	const base = { mode: "handsfree" as const, thinking: false, speaking: false, transcribing: false, micOn: false, muted: false };
	it("thinking wins over everything (incl. text mode)", () => {
		for (const mode of ["text", "ptt", "handsfree"] as const) {
			expect(derivePhase({ ...base, mode, thinking: true, speaking: true, transcribing: true, micOn: true })).toBe("processing");
		}
	});
	it("speaking beats transcribing/listening", () => {
		expect(derivePhase({ ...base, speaking: true, transcribing: true, micOn: true })).toBe("speaking");
	});
	it("text mode with no work is idle", () => {
		expect(derivePhase({ ...base, mode: "text" })).toBe("idle");
	});
	it("transcribing shows after speech, before the reply", () => {
		expect(derivePhase({ ...base, transcribing: true, micOn: true })).toBe("transcribing");
	});
	it("hands-free muted reads muted, not a false listening", () => {
		expect(derivePhase({ ...base, muted: true })).toBe("muted");
	});
	it("mic hot → listening; mic off → idle", () => {
		expect(derivePhase({ ...base, micOn: true })).toBe("listening");
		expect(derivePhase({ ...base, micOn: false })).toBe("idle");
	});
});
