import { describe, expect, it, vi } from "vitest";
import { createMicHandoff, MIC_HANDOFF_TIMEOUT_MS } from "./mic-handoff.js";

describe("the microphone handoff (#425)", () => {
	it("opens the device immediately when nobody is mid-close", () => {
		// The overwhelmingly common case, and the one that must not acquire any latency: the
		// control listener re-arming during a silence, a gate starting a turn nothing else wanted.
		const h = createMicHandoff();
		let started = 0;
		h.whenFree("gate:1", () => started++);
		expect(started, "a consumer waited for a close that was not happening").toBe(1);
	});

	it("makes the next consumer wait for the close, not for the stop() that asked for it", () => {
		// THE bug. `SpeechRecognition.stop()` and `MediaRecorder.stop()` both return immediately and
		// finish asynchronously, and every handoff in use-voice.ts starts the next consumer in the
		// same tick — so both hold the device for the length of the close. `audio-capture` is the
		// code a browser produces for exactly that, and it is the code on every production row.
		const h = createMicHandoff();
		let started = 0;
		h.releasing("gate:1");
		h.whenFree("stt:1", () => started++);
		expect(started, "the next consumer opened the device while the previous one was still closing it").toBe(0);
		h.released("gate:1");
		expect(started, "the close completed and nothing was waiting on it after all").toBe(1);
	});

	it("waits for EVERY close in flight, not just the first", () => {
		// A turn ends by stopping the gate AND the recorder. The control listener that follows must
		// wait for both — releasing on the first one back is the same race one link along.
		const h = createMicHandoff();
		let started = 0;
		h.releasing("gate:1");
		h.releasing("stt:rec");
		h.whenFree("stt:ctrl", () => started++);
		h.released("gate:1");
		expect(started, "the recorder's tracks were still coming down").toBe(0);
		h.released("stt:rec");
		expect(started).toBe(1);
	});

	it("never leaves a waiter unstarted, however badly the other consumer is wedged (ADR 0001 M1)", () => {
		// The control listener carries mute-by-voice through every phase where the mic is idle. A
		// consumer whose `onend` never arrives — a recognizer wedged by the very device failure
		// this ticket is about — must forfeit the device, not hold the control channel shut.
		vi.useFakeTimers();
		const h = createMicHandoff();
		let started = 0;
		h.releasing("gate:1"); // and never releases
		h.whenFree("stt:ctrl", () => started++);
		expect(started).toBe(0);
		vi.advanceTimersByTime(MIC_HANDOFF_TIMEOUT_MS);
		expect(started, "a wedged recognizer could hold mute-by-voice shut for the rest of the session").toBe(1);
		expect(h.closing(), "the presumed-closed owner is still claiming the device").toEqual([]);
		vi.useRealTimers();
	});

	it("bounds that wait at a few hundred milliseconds, not at a human-noticeable pause", () => {
		// The number itself is load-bearing: it is the ceiling on how long mute-by-voice can be
		// unreachable because of a handoff. M1 tolerates the exchange, not a dead zone.
		expect(MIC_HANDOFF_TIMEOUT_MS).toBeLessThanOrEqual(500);
	});

	it("does not make an owner wait for its OWN close", () => {
		// The gate stops and restarts itself inside a single turn, and `VoiceStt` rebuilds a
		// recognizer Chrome refused to restart. Waiting on itself would deadlock both.
		const h = createMicHandoff();
		let started = 0;
		h.releasing("gate:1");
		h.whenFree("gate:1", () => started++);
		expect(started).toBe(1);
	});

	it("drops a queued start when the owner is stopped, so the mic is not reopened behind the user", () => {
		// The #291 class of leak through the new door: a start queued behind someone else's close
		// belongs to a session the caller has since cancelled.
		const h = createMicHandoff();
		let started = 0;
		h.releasing("gate:1");
		h.whenFree("stt:ctrl", () => started++);
		h.cancel("stt:ctrl");
		h.released("gate:1");
		expect(started, "a microphone opened after the caller closed it").toBe(0);
	});

	it("keeps one intention per owner — the latest", () => {
		const h = createMicHandoff();
		const ran: string[] = [];
		h.releasing("gate:1");
		h.whenFree("stt:ctrl", () => ran.push("stale"));
		h.whenFree("stt:ctrl", () => ran.push("current"));
		h.released("gate:1");
		expect(ran, "a superseded start still opened the device").toEqual(["current"]);
	});

	it("ignores a release from an owner that was never closing", () => {
		const h = createMicHandoff();
		let started = 0;
		h.releasing("gate:1");
		h.released("stt:ctrl"); // never claimed a close
		h.whenFree("stt:ctrl", () => started++);
		expect(started, "someone else's stray release freed the device").toBe(0);
	});
});
