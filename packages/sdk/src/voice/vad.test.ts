import { describe, it, expect } from "vitest";
import { initVad, shouldAutoDetectEndOfTurn, vadStep, type VadConfig, hadSpeech, VOICE_FLOOR, NOISE_SAMPLE_FRAMES, NOISE_ONSET_RATIO, HIGH_SPEECH_THRESHOLD } from "./vad.js";

const cfg = (o: Partial<VadConfig> = {}): VadConfig => ({ silenceMs: 1000, sensitivity: 1, ...o });

/** Feed `frames` of `level` at 100ms steps starting at `from`; return the last `now`. */
function feed(s: ReturnType<typeof initVad>, level: number, from: number, frames: number, c: VadConfig): { end: boolean; last: number } {
	let now = from;
	for (let i = 0; i < frames; i++) {
		now = from + i * 100;
		if (vadStep(s, level, now, c) === "end") return { end: true, last: now };
	}
	return { end: false, last: now };
}

/** Like `feed` but reports which terminal decision (if any) fired. */
function feedFor(s: ReturnType<typeof initVad>, level: number, from: number, frames: number, c: VadConfig): "end" | "idle" | null {
	for (let i = 0; i < frames; i++) {
		const d = vadStep(s, level, from + i * 100, c);
		if (d) return d;
	}
	return null;
}

describe("vadStep", () => {
	it("registers speech and does not end while you're talking", () => {
		const s = initVad();
		const r = feed(s, 0.3, 0, 10, cfg()); // 900ms of speech
		expect(r.end).toBe(false);
		expect(s.seen).toBe(true);
	});

	it("ends the turn after silenceMs of a pause (relative to your speech)", () => {
		const s = initVad();
		feed(s, 0.3, 0, 6, cfg()); // speak to t=500 → peak 0.3, lastLoud 500
		// Pause: 0.02 is far below peak*0.35 → not speaking. Ends once now-lastLoud > 1000ms.
		expect(vadStep(s, 0.02, 900, cfg())).toBe(null); // 400ms into pause
		expect(vadStep(s, 0.02, 1400, cfg())).toBe(null); // 900ms
		expect(vadStep(s, 0.02, 1600, cfg())).toBe("end"); // 1100ms → end
	});

	it("detects the pause even with a HIGH noise floor (the old stuck-listening bug)", () => {
		const s = initVad();
		feed(s, 0.3, 0, 6, cfg()); // speak → peak 0.3
		// Idle floor sits at 0.08 (would pin an absolute 0.05 threshold "loud" forever),
		// but 0.08 < peak*0.35 (0.105) → correctly seen as a pause.
		expect(vadStep(s, 0.08, 900, cfg())).toBe(null);
		expect(vadStep(s, 0.08, 1600, cfg())).toBe("end");
	});

	it("never ends when there was only room noise below the voice floor", () => {
		const s = initVad();
		const r = feed(s, 0.03, 0, 60, cfg()); // 6s of quiet noise (< 0.05)
		expect(r.end).toBe(false);
		expect(s.seen).toBe(false);
	});

	it("force-ends via the safety cap on unbroken speech", () => {
		const s = initVad();
		const r = feed(s, 0.3, 0, 100, cfg({ maxTurnMs: 5000 })); // 10s of continuous speech
		expect(r.end).toBe(true);
		expect(r.last).toBeGreaterThan(5000);
		expect(r.last).toBeLessThan(5300);
	});

	it("recycles (idle) when the mic sits open with no speech past idleMs", () => {
		const s = initVad();
		// 30s of near-silence (0.03, below the voice floor) → nothing said. With the idle
		// cap it returns "idle" (recycle the silent recorder), NOT "end" (which would
		// upload silence to Whisper).
		const d = feedFor(s, 0.03, 0, 300, cfg({ idleMs: 15_000 }));
		expect(d).toBe("idle");
		expect(s.seen).toBe(false);
	});

	it("does not idle-recycle before idleMs elapses", () => {
		const s = initVad();
		const d = feedFor(s, 0.03, 0, 100, cfg({ idleMs: 15_000 })); // 10s of silence < 15s
		expect(d).toBe(null);
	});

	it("prefers a real end over idle once speech has been heard", () => {
		const s = initVad();
		feed(s, 0.3, 0, 6, cfg({ silenceMs: 1000, idleMs: 2000 })); // speak → seen
		// Now go quiet. Even though idleMs is short, `seen` routes us through the
		// speech-pause path → "end", never "idle".
		expect(vadStep(s, 0.02, 700, cfg({ silenceMs: 1000, idleMs: 2000 }))).toBe(null);
		expect(vadStep(s, 0.02, 1700, cfg({ silenceMs: 1000, idleMs: 2000 }))).toBe("end");
	});

	it("sensitivity keeps a soft tail alive that lower sensitivity would cut", () => {
		// Speak loud (peak 0.3), then a soft 0.06 tail. At sensitivity 1 the gate is
		// peak*0.35=0.105 → 0.06 is a pause; at sensitivity 2 the gate is peak*0.175=0.0525
		// → 0.06 still counts as speaking.
		const lo = initVad(); feed(lo, 0.3, 0, 6, cfg({ silenceMs: 300 }));
		expect(vadStep(lo, 0.06, 900, cfg({ silenceMs: 300 }))).toBe("end"); // 400ms > 300

		const hi = initVad(); feed(hi, 0.3, 0, 6, cfg({ silenceMs: 300, sensitivity: 2 }));
		expect(vadStep(hi, 0.06, 900, cfg({ silenceMs: 300, sensitivity: 2 }))).toBe(null);
	});
});

describe("shouldAutoDetectEndOfTurn", () => {
	const base = { isWhisper: true, paused: false, muted: false, manualTalk: false };

	it("runs only in Whisper hands-free with nothing blocking", () => {
		expect(shouldAutoDetectEndOfTurn(base)).toBe(true);
	});

	it("is off for browser dictation (it has streaming results, no mic-level VAD)", () => {
		expect(shouldAutoDetectEndOfTurn({ ...base, isWhisper: false })).toBe(false);
	});

	it("is off while the agent is thinking/speaking or the mic is muted", () => {
		expect(shouldAutoDetectEndOfTurn({ ...base, paused: true })).toBe(false);
		expect(shouldAutoDetectEndOfTurn({ ...base, muted: true })).toBe(false);
	});

	it("is off during a manual push-to-talk turn — the user owns the boundary", () => {
		// The regression this guards: the auto-VAD cutting off a manual turn mid-sentence
		// and sending a half-formed message (e.g. "Debugging the function.").
		expect(shouldAutoDetectEndOfTurn({ ...base, manualTalk: true })).toBe(false);
	});
});

describe("hadSpeech — the mode-independent speech gate", () => {
	it("rejects room tone and accepts real speech", () => {
		// Typical room/keyboard/fan noise sits ~0.05–0.08; speech peaks ~0.15–0.4.
		expect(hadSpeech(0)).toBe(false);
		expect(hadSpeech(0.08)).toBe(false);
		expect(hadSpeech(VOICE_FLOOR)).toBe(false);
		expect(hadSpeech(0.2)).toBe(true);
	});

	it("agrees with the threshold vadStep already uses for unambiguous speech (high level)", () => {
		// Two different silence gates with two different floors is how one mode ends up
		// transcribing what the other correctly discards.
		// With the adaptive onset window, a single frame of 0.3 (>= HIGH_SPEECH_THRESHOLD)
		// triggers earlyHigh and onset fires via VOICE_FLOOR — same as hadSpeech(0.3) = true.
		const s = initVad();
		vadStep(s, 0.3, 1000, { silenceMs: 800, sensitivity: 1 });
		expect(s.seen).toBe(hadSpeech(0.3)); // earlyHigh → onset at VOICE_FLOOR; hadSpeech(0.3)=true
		// Quiet room noise stays quiet under VOICE_FLOOR — neither VAD nor hadSpeech trigger.
		const q = initVad();
		vadStep(q, 0.05, 1000, { silenceMs: 800, sensitivity: 1 });
		expect(q.seen).toBe(hadSpeech(0.05)); // both false
	});

	it("raises the bar when a noise floor is provided (adaptive mode)", () => {
		// Room noise at 0.08 → adaptive floor = max(0.1, 3 * 0.08) = 0.24.
		// A 0.2 level that passes the fixed floor should NOT pass the adaptive one.
		const roomNoise = 0.08;
		const adaptiveFloor = Math.max(VOICE_FLOOR, NOISE_ONSET_RATIO * roomNoise); // 0.24
		expect(hadSpeech(0.2, roomNoise)).toBe(false); // 0.2 < 0.24
		expect(hadSpeech(adaptiveFloor + 0.01, roomNoise)).toBe(true); // just above
	});

	it("falls back to fixed VOICE_FLOOR when no noise floor is available (noiseFloor = -1)", () => {
		// noiseFloor = -1 means the VAD hasn't sampled enough frames yet (e.g. tap-to-talk).
		expect(hadSpeech(0.08, -1)).toBe(false); // below VOICE_FLOOR
		expect(hadSpeech(0.15, -1)).toBe(true);  // above VOICE_FLOOR
	});
});

describe("adaptive noise floor — #490 noisy-room onset gate", () => {
	it("does NOT set seen when steady ambient noise above VOICE_FLOOR fills the sampling window", () => {
		// The bug: constant level=0.12 (above VOICE_FLOOR=0.1) caused vadStep to set
		// s.seen=true from room tone, letting a speechless clip reach Whisper. The fix:
		// the first NOISE_SAMPLE_FRAMES frames establish noiseFloor≈0.12, and the onset
		// threshold rises to max(0.1, 3*0.12)=0.36 — so 0.12 no longer triggers seen.
		const s = initVad();
		const ambientLevel = 0.12; // above VOICE_FLOOR, below onset with adaptive floor
		for (let i = 0; i < NOISE_SAMPLE_FRAMES + 5; i++) {
			vadStep(s, ambientLevel, i * 100, cfg());
		}
		expect(s.seen).toBe(false);
		expect(s.noiseFloor).toBeCloseTo(ambientLevel, 5);
	});

	it("DOES set seen when a voice spike arrives after the sampling window closes", () => {
		// After collecting NOISE_SAMPLE_FRAMES ambient frames at 0.12 (below HIGH_SPEECH_THRESHOLD),
		// the window closes and the adaptive onset threshold is 0.36. A real voice at 0.40 then
		// exceeds it and marks speech onset.
		const s = initVad();
		const ambient = 0.12;
		// Fill the noise window exactly
		for (let i = 0; i < NOISE_SAMPLE_FRAMES; i++) {
			vadStep(s, ambient, i * 100, cfg());
		}
		expect(s.seen).toBe(false); // window just closed but 0.12 didn't clear the adaptive threshold
		// Now a real voice spike arrives
		vadStep(s, 0.40, NOISE_SAMPLE_FRAMES * 100, cfg());
		expect(s.seen).toBe(true);
	});

	it("high-level speech from frame 0 (earlyHigh) fires onset without waiting for the window", () => {
		// When the user starts talking the instant the mic opens (level >= HIGH_SPEECH_THRESHOLD
		// on the very first frame), earlyHigh is true and onset is allowed immediately using
		// VOICE_FLOOR — no regression for the common case.
		const s = initVad();
		vadStep(s, HIGH_SPEECH_THRESHOLD, 0, cfg());
		expect(s.seen).toBe(true); // onset fired on first high-energy frame
	});

	it("accumulates the noise estimate only before speech onset (window closes when seen)", () => {
		const s = initVad();
		// Fill the window with ambient frames
		for (let i = 0; i < NOISE_SAMPLE_FRAMES; i++) {
			vadStep(s, 0.12, i * 100, cfg());
		}
		// Window is now closed; inject a voice spike to set onset
		vadStep(s, 0.40, NOISE_SAMPLE_FRAMES * 100, cfg());
		expect(s.seen).toBe(true);
		const floorsAfterOnset = s.noiseFrames;
		// Feeding more frames must NOT update the noise estimate (window is already closed)
		vadStep(s, 0.12, (NOISE_SAMPLE_FRAMES + 1) * 100, cfg());
		expect(s.noiseFrames).toBe(floorsAfterOnset); // unchanged after onset
	});
});
