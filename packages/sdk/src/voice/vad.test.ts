import { describe, it, expect } from "vitest";
import { initVad, vadStep, type VadConfig } from "./vad.js";

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
