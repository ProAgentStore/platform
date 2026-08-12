import { describe, expect, it } from "vitest";
import {
	isBenignRecognizerEnd,
	MIC_CONTENTION_NOTICE_AFTER,
	MIC_RETRY_BASE_MS,
	MIC_RETRY_MAX_MS,
	micRetryDelayMs,
	planMicRestart,
	shouldAnnounceMicContention,
} from "./mic-retry.js";

/**
 * #425 reopened — 20 production `client:voice-control` rows reading
 * `control listener refused the microphone: audio-capture`, ten of them in one 94-minute window,
 * correlating with the owner giving up on voice for the evening.
 *
 * The rule this module holds has to satisfy three constraints that pull against each other:
 * mute-by-voice must survive a transient (ADR 0001 M1), a failing restart must not re-activate the
 * microphone at the browser's cycle rate, and the ordinary silence cycle — by far the most common
 * event in a continuous recognizer's life — must stay instant.
 */
describe("planMicRestart", () => {
	it("keeps the ordinary silence cycle instant", () => {
		// This is the path that runs constantly. Any delay here is a window in which a spoken
		// "mute" reaches nothing, which is the invariant ADR 0001 M1 exists to protect.
		for (const code of ["no-speech", "aborted", null, undefined, ""]) {
			expect(planMicRestart({ code, consecutiveFailures: 0 })).toEqual({ restart: true, delayMs: 0, terminal: false });
		}
	});

	it("re-arms after a contention failure, but not immediately", () => {
		// `audio-capture` is what two recognizers reaching for one device produce at a turn
		// boundary. It must NOT be terminal — latching on it deletes mute-by-voice for the rest of
		// the session, the exact ADR 0001 M1 failure this ticket exists to expose.
		const plan = planMicRestart({ code: "audio-capture", consecutiveFailures: 1 });
		expect(plan.restart, "a transient device conflict disabled the control listener (ADR 0001 M1)").toBe(true);
		expect(plan.terminal).toBe(false);
		expect(plan.delayMs, "the failing restart is still firing at the browser's own rate").toBe(MIC_RETRY_BASE_MS);
	});

	it("treats a permission verdict as terminal", () => {
		// Not a slow retry — a stop. It cannot start succeeding until the user changes a browser
		// setting, and each attempt against a non-persistent grant is another prompt.
		for (const code of ["not-allowed", "service-not-allowed"]) {
			expect(planMicRestart({ code, consecutiveFailures: 1 })).toEqual({ restart: false, delayMs: 0, terminal: true });
		}
	});

	it("backs off an unknown failure the same way, rather than spinning on it", () => {
		// `network` and friends are not in any allowlist, and the safe reading of "the browser
		// raised something we do not recognise" is that the last start did not work.
		expect(planMicRestart({ code: "network", consecutiveFailures: 2 }).delayMs).toBe(MIC_RETRY_BASE_MS * 2);
	});
});

describe("micRetryDelayMs", () => {
	it("doubles per consecutive failure and stops at the ceiling", () => {
		expect(micRetryDelayMs(0)).toBe(0);
		expect(micRetryDelayMs(1)).toBe(400);
		expect(micRetryDelayMs(2)).toBe(800);
		expect(micRetryDelayMs(3)).toBe(1600);
		expect(micRetryDelayMs(4)).toBe(3200);
		expect(micRetryDelayMs(5)).toBe(6400);
		expect(micRetryDelayMs(6)).toBe(MIC_RETRY_MAX_MS);
		expect(micRetryDelayMs(500), "an unbounded backoff would take the control channel out for hours").toBe(MIC_RETRY_MAX_MS);
	});

	it("keeps the first retry short enough to hide a turn-boundary transient", () => {
		// The recorder releases its tracks asynchronously; the common contention resolves in well
		// under this. A first delay measured in seconds would turn a recoverable blip into a
		// visible hole in the control channel.
		expect(micRetryDelayMs(1)).toBeLessThanOrEqual(500);
	});
});

describe("shouldAnnounceMicContention", () => {
	it("fires once per run, and not on the transient", () => {
		expect(shouldAnnounceMicContention(1), "a single turn-boundary conflict must not nag").toBe(false);
		expect(shouldAnnounceMicContention(MIC_CONTENTION_NOTICE_AFTER)).toBe(true);
		// Equality, not `>=`: past the threshold the run keeps climbing and the user has been told.
		// The counter resets on recovery, which is what makes this once-per-outage rather than
		// once-per-retry — the property that keeps a notice from replacing the log flood #423 was
		// about with an on-screen one.
		expect(shouldAnnounceMicContention(MIC_CONTENTION_NOTICE_AFTER + 1)).toBe(false);
		expect(shouldAnnounceMicContention(0)).toBe(false);
	});

	it("announces within a few seconds of a real outage", () => {
		// The user's report is "voice sometimes isn't capturing", with nothing on screen. Sum the
		// backoff up to the notice: it must land while they are still wondering, not a minute later.
		let elapsed = 0;
		for (let n = 1; n <= MIC_CONTENTION_NOTICE_AFTER; n++) elapsed += micRetryDelayMs(n);
		expect(elapsed).toBeLessThan(10_000);
	});
});

describe("isBenignRecognizerEnd", () => {
	it("covers exactly the churn, and nothing that says something about the device", () => {
		expect(isBenignRecognizerEnd("no-speech")).toBe(true);
		expect(isBenignRecognizerEnd("aborted"), "a deliberate stop() raises this — counting it would back off on every turn").toBe(true);
		expect(isBenignRecognizerEnd(undefined)).toBe(true);
		for (const code of ["audio-capture", "not-allowed", "service-not-allowed", "network"]) {
			expect(isBenignRecognizerEnd(code), `${code} was read as ordinary churn`).toBe(false);
		}
	});
});
