import { afterEach, describe, expect, it, vi } from "vitest";
import { createSpeechGate, speechGateAvailable } from "./gate.js";

// A controllable fake of the browser SpeechRecognition, so the gate's speech/liveness
// logic is tested without a real mic. Tests fire onresult/onend by hand.
class FakeSR {
	continuous = false;
	interimResults = false;
	lang = "";
	onresult: ((e: unknown) => void) | null = null;
	onerror: ((e: { error: string }) => void) | null = null;
	onend: (() => void) | null = null;
	started = 0;
	stopped = 0;
	start() { this.started++; }
	stop() { this.stopped++; if (this.onend) this.onend(); }
	// Helper: emit a result with one alternative.
	emit(transcript: string, isFinal: boolean) {
		this.onresult?.({ resultIndex: 0, results: { length: 1, 0: { isFinal, length: 1, 0: { transcript } } } });
	}
}

function withFakeSR(): { instances: FakeSR[]; restore: () => void } {
	const instances: FakeSR[] = [];
	class FakeSRCtor extends FakeSR {
		constructor() {
			super();
			instances.push(this);
		}
	}
	const ctor = FakeSRCtor as unknown as new () => FakeSR;
	const prev = (globalThis as { window?: unknown }).window;
	(globalThis as { window?: unknown }).window = { webkitSpeechRecognition: ctor };
	return { instances, restore: () => { (globalThis as { window?: unknown }).window = prev; } };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("speechGateAvailable / createSpeechGate feature-detection", () => {
	it("returns null / false when SpeechRecognition is absent (iOS Safari, Node)", () => {
		const prev = (globalThis as { window?: unknown }).window;
		(globalThis as { window?: unknown }).window = {};
		expect(speechGateAvailable()).toBe(false);
		expect(createSpeechGate({ onInterim: () => {} })).toBeNull();
		(globalThis as { window?: unknown }).window = prev;
	});
});

describe("speech gate", () => {
	it("listens in the configured language (defaults to en-US)", () => {
		const { instances, restore } = withFakeSR();
		createSpeechGate({ lang: "zh-CN", onInterim: () => {} })!.start();
		expect(instances[0].lang).toBe("zh-CN");
		createSpeechGate({ onInterim: () => {} })!.start();
		expect(instances[1].lang).toBe("en-US");
		restore();
	});

	it("shows interim words and flags real speech, but NOT noise", () => {
		const { instances, restore } = withFakeSR();
		const interims: string[] = [];
		let spoke = 0;
		const gate = createSpeechGate({ onInterim: (t) => interims.push(t), onSpeech: () => spoke++ })!;
		gate.start();
		const sr = instances[0];

		sr.emit("what's the", false);       // real partial
		expect(interims).toContain("what's the");
		expect(gate.heardSpeech()).toBe(true);
		expect(spoke).toBe(1);

		restore();
	});

	it("does NOT flag a pure noise hallucination as speech", () => {
		const { instances, restore } = withFakeSR();
		const gate = createSpeechGate({ onInterim: () => {} })!;
		gate.start();
		instances[0].emit("you", true);      // Whisper-style silence filler
		expect(gate.heardSpeech()).toBe(false);
		restore();
	});

	it("becomes alive on any event; reset clears heard but not liveness", () => {
		const { instances, restore } = withFakeSR();
		const gate = createSpeechGate({ onInterim: () => {} })!;
		gate.start();
		expect(gate.isAlive()).toBe(false);
		instances[0].emit("fix the bug", true);
		expect(gate.isAlive()).toBe(true);
		expect(gate.heardSpeech()).toBe(true);
		gate.reset();
		expect(gate.heardSpeech()).toBe(false);
		expect(gate.isAlive()).toBe(true); // liveness persists across turns
		restore();
	});

	it("start/stop drive the underlying recognizer", () => {
		const { instances, restore } = withFakeSR();
		const gate = createSpeechGate({ onInterim: () => {} })!;
		gate.start();
		expect(instances[0].started).toBe(1);
		gate.stop();
		expect(instances[0].stopped).toBe(1);
		restore();
	});
});
