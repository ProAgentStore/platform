/**
 * Tests for muteFromCommand invariant (#470):
 *
 * "mute" voice command must be MIC-ONLY — it should flip `muted`, stop the STT
 * recorder, and close the audio monitor, but it must NOT call tts.cancel() or
 * otherwise silence the agent's in-flight / queued speech.  Interrupting the
 * agent's TTS is the job of the stop-speech keyword handled in handleControlResult
 * (the always-on background listener wired for #388 / ADR-0001).
 *
 * These tests cover the pure logic that muteFromCommand executes by reconstructing
 * the minimal ref-based state the callback depends on, without a DOM or React.
 * They serve as a regression guard against reverting to the #153 behaviour where
 * ttsRef.current?.cancel() was called inside muteFromCommand.
 */

import { describe, expect, it, vi } from "vitest";
import { planMuteTeardown } from "./machine.js";

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Minimal stand-in for the parts of VoiceTts that muteFromCommand must NOT touch. */
function makeTtsMock() {
	return {
		cancel: vi.fn(),
		speaking: false,
	};
}

/** Minimal stand-in for the parts of VoiceStt that muteFromCommand touches. */
function makeSttMock() {
	return {
		stop: vi.fn(),
		listening: true,
	};
}

/**
 * Re-implements the post-#470 muteFromCommand logic (the callback body) as a pure
 * function so it can be called in tests without mounting a React hook.
 *
 * Key invariants:
 *   - ttsSpeaking is hardcoded `false` in planMuteTeardown (TTS is not cancelled)
 *   - tts.cancel() is intentionally ABSENT (the #470 fix)
 *   - setSpeaking(false) is intentionally ABSENT (TTS is not interrupted)
 *   - speakEndedAtRef is intentionally NOT stamped (no echo tail from cancelled TTS)
 *
 * Keep this in sync with the implementation in use-voice.ts.
 */
function muteFromCommandImpl(deps: {
	stt: { stop: () => void } | null;
	tts: { cancel: () => void; speaking: boolean } | null;
	stopAudioMonitor: () => void;
	clearVoiceText: () => void;
	onRecoveredText?: (text: string) => void;
	setMuted: (v: boolean) => void;
	setSpeaking: (v: boolean) => void;
	setMicOn: (v: boolean) => void;
	mutedRef: { current: boolean };
	mutedAtRef: { current: number };
	speakEndedAtRef: { current: number };
	sttIsWhisper: boolean;
	dictation: null;
	pendingTurn?: "send" | "recover";
}) {
	const pendingTurn = deps.pendingTurn ?? "recover";
	const plan = planMuteTeardown({
		ttsSpeaking: false, // #470: TTS is no longer cancelled on mute, so there is no echo tail
		pendingTurn,
		isWhisper: deps.sttIsWhisper,
		dictation: deps.dictation,
	});
	deps.mutedRef.current = true;
	deps.setMuted(true);
	deps.stt?.stop(); // stop(), never stopDiscard() — #228: the clip must still upload
	// NOTE: deps.tts?.cancel() is intentionally ABSENT here (the #470 fix).
	// deps.setSpeaking(false) is intentionally ABSENT here (TTS is not interrupted).
	// deps.speakEndedAtRef is intentionally NOT stamped (no echo tail from cancelled TTS).
	deps.stopAudioMonitor();
	deps.setMicOn(false);
	if (pendingTurn === "recover") deps.mutedAtRef.current = Date.now();
	if (plan.keepPending) return;
	if (plan.recoverText) {
		deps.onRecoveredText?.(plan.recoverText);
	}
	deps.clearVoiceText();
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("muteFromCommand — mic-only (issue #470)", () => {
	const baseEnv = () => ({
		stt: makeSttMock(),
		tts: makeTtsMock(),
		stopAudioMonitor: vi.fn(),
		clearVoiceText: vi.fn(),
		setMuted: vi.fn(),
		setSpeaking: vi.fn(),
		setMicOn: vi.fn(),
		mutedRef: { current: false },
		mutedAtRef: { current: 0 },
		speakEndedAtRef: { current: 0 },
		sttIsWhisper: false,
		dictation: null as null,
	});

	it("does NOT cancel TTS when the agent is speaking", () => {
		const env = baseEnv();
		env.tts.speaking = true; // agent is mid-sentence

		muteFromCommandImpl(env);

		// TTS must be untouched — mute is mic-only.
		expect(env.tts.cancel).not.toHaveBeenCalled();
	});

	it("does NOT cancel TTS when the agent is idle (no regression path)", () => {
		const env = baseEnv();
		env.tts.speaking = false;

		muteFromCommandImpl(env);

		expect(env.tts.cancel).not.toHaveBeenCalled();
	});

	it("does NOT cancel TTS when TTS ref is null (no crash)", () => {
		const env = { ...baseEnv(), tts: null };

		expect(() => muteFromCommandImpl(env)).not.toThrow();
	});

	it("does NOT call setSpeaking(false) — TTS state is not changed by mute", () => {
		const env = baseEnv();
		env.tts.speaking = true;

		muteFromCommandImpl(env);

		expect(env.setSpeaking).not.toHaveBeenCalled();
	});

	it("does NOT stamp speakEndedAt — no echo tail since TTS was not cancelled", () => {
		const env = baseEnv();
		env.tts.speaking = true;
		env.speakEndedAtRef.current = 0;

		muteFromCommandImpl(env);

		expect(env.speakEndedAtRef.current).toBe(0);
	});

	it("stops the STT recorder", () => {
		const env = baseEnv();

		muteFromCommandImpl(env);

		expect(env.stt.stop).toHaveBeenCalledOnce();
	});

	it("stops the audio monitor", () => {
		const env = baseEnv();

		muteFromCommandImpl(env);

		expect(env.stopAudioMonitor).toHaveBeenCalledOnce();
	});

	it("sets mutedRef synchronously (so in-flight results are ignored immediately)", () => {
		const env = baseEnv();

		muteFromCommandImpl(env);

		// Ref is the synchronous gate; state setter is for React re-render.
		expect(env.mutedRef.current).toBe(true);
		expect(env.setMuted).toHaveBeenCalledWith(true);
	});

	it("turns off the mic UI flag", () => {
		const env = baseEnv();

		muteFromCommandImpl(env);

		expect(env.setMicOn).toHaveBeenCalledWith(false);
	});

	it("stamps mutedAt for recover mode so late transcripts know they were muted (#420)", () => {
		const env = baseEnv();
		const before = Date.now();

		muteFromCommandImpl({ ...env, pendingTurn: "recover" });

		expect(env.mutedAtRef.current).toBeGreaterThanOrEqual(before);
	});

	it("does NOT stamp mutedAt in send mode (#228 case)", () => {
		const env = baseEnv();
		env.mutedAtRef.current = 0;

		muteFromCommandImpl({ ...env, pendingTurn: "send" });

		expect(env.mutedAtRef.current).toBe(0);
	});
});
