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

	// #332 — the heard-speech flag is what endOfTurnAction trusts to DISCARD a silent clip. It
	// used to latch on any recognised words, including the agent's own TTS coming back through
	// the speakers, so the gate vouched for a turn the user never took: the clip was uploaded,
	// and Whisper returned a term from its own vocabulary prompt ("Coder Lead", the agent's name).
	it("does NOT flag speech the caller says is not the user's (the agent's own voice)", () => {
		const { instances, restore } = withFakeSR();
		let mine = false; // the caller's echo/paused/muted guard
		const gate = createSpeechGate({ onInterim: () => {}, acceptSpeech: () => mine })!;
		gate.start();

		instances[0].emit("here is what I found in the repository", true); // the agent, aloud
		expect(gate.heardSpeech()).toBe(false); // → endOfTurnAction discards the silent turn

		mine = true;
		instances[0].emit("fix the bug", true); // the user, once the echo window has passed
		expect(gate.heardSpeech()).toBe(true);
		restore();
	});

	it("accepts speech by default, so a caller that passes no predicate is unchanged", () => {
		const { instances, restore } = withFakeSR();
		const gate = createSpeechGate({ onInterim: () => {} })!;
		gate.start();
		instances[0].emit("fix the bug", true);
		expect(gate.heardSpeech()).toBe(true);
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

	// #325 — the gate is a SECOND live recognizer beside the Whisper recorder, so a swallowed
	// stop leaves the mic capturing exactly the way #291 did, and `active = false` hides it:
	// it only suppresses the restart that a failed stop never triggers.
	it("aborts the recognizer when stop() throws, so the mic can't stay open", () => {
		const { instances, restore } = withFakeSR();
		const gate = createSpeechGate({ onInterim: () => {} })!;
		gate.start();
		const sr = instances[0] as FakeSR & { aborted?: boolean };
		sr.stop = () => {
			throw new Error("InvalidStateError");
		};
		sr.abort = () => {
			sr.aborted = true;
		};

		expect(() => gate.stop()).not.toThrow();
		expect(sr.aborted).toBe(true);
		restore();
	});
});

/**
 * #425 — "automation pops up and asks me for microphone use all the time."
 *
 * The gate re-arms itself on every `onend`, and Chrome ends a continuous recognizer after a short
 * silence — so while voice is engaged it is a perpetual start → end → start cycle, and Chrome
 * activates the microphone on every `start()`. Against a grant that is not persistent, that is one
 * prompt per RESTART rather than one per session. Re-arming into a device that has been REFUSED is
 * the part that turns a single denial into an endless loop, and there is nothing on the other side
 * of it: the request cannot start succeeding until the user changes a browser setting.
 */
describe("a refused microphone (#425)", () => {
	/** Chrome's own cycle: the recognizer stops itself after silence and `onend` fires. */
	const endsItself = (sr: FakeSR) => sr.onend?.();

	it("keeps re-arming through the ordinary churn a continuous recognizer produces", () => {
		const { instances, restore } = withFakeSR();
		const gate = createSpeechGate({ onInterim: () => {} })!;
		gate.start();
		const sr = instances[0];

		// The two codes these handlers exist to ignore. `aborted` in particular is what a
		// DELIBERATE stop produces — latching on it would disable the gate every time the main
		// recorder took the mic.
		for (const error of ["no-speech", "aborted"]) {
			sr.onerror?.({ error });
			endsItself(sr);
		}
		expect(sr.started, "the gate stopped watching over ordinary silence").toBeGreaterThan(1);
		restore();
	});

	it("stops re-arming once the browser has refused, and says so exactly once", () => {
		const { instances, restore } = withFakeSR();
		const denials: string[] = [];
		const gate = createSpeechGate({ onInterim: () => {}, onDenied: (c) => denials.push(c) })!;
		gate.start();
		const sr = instances[0];
		const startsBefore = sr.started;

		sr.onerror?.({ error: "not-allowed" });
		// Chrome would now end the recognizer, and the old handler restarted it — prompting again.
		for (let i = 0; i < 5; i++) endsItself(sr);

		expect(sr.started, "each restart into a denied device is another permission prompt (#425)").toBe(startsBefore);
		expect(denials, "a denial produced no evidence at all — the handler was an empty block").toEqual(["not-allowed"]);

		// A later turn must not resurrect it either: the caller calls start() at the top of every
		// turn, and nothing about the refusal has changed.
		gate.stop();
		gate.start();
		expect(sr.started).toBe(startsBefore);
		restore();
	});

	it("treats a missing device as transient, not as a refusal", () => {
		// `audio-capture` can be two recognizers contending for one microphone. Latching on it
		// would silently disable the gate — and, on the sibling control listener, mute-by-voice
		// with it, which is the ADR 0001 failure this ticket exists to make VISIBLE.
		const { instances, restore } = withFakeSR();
		const denials: string[] = [];
		const gate = createSpeechGate({ onInterim: () => {}, onDenied: (c) => denials.push(c) })!;
		gate.start();
		const sr = instances[0];
		sr.onerror?.({ error: "audio-capture" });
		endsItself(sr);
		expect(sr.started).toBeGreaterThan(1);
		expect(denials).toEqual([]);
		restore();
	});
});
