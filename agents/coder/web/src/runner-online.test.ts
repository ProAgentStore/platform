import { describe, expect, it } from "vitest";
import { resolveRunnerOnline } from "./runner-online";

describe("resolveRunnerOnline — a stale offline verdict must not outlive its sessions (#241)", () => {
	it("clears once the sessions that produced it are gone", () => {
		// The exact trap: runner drops mid-session (capture says false), the session then ends or
		// errors, the runner comes back. Nothing could re-check, because re-checking needed a
		// session and the button that starts one was hidden by the offline notice.
		expect(resolveRunnerOnline({ relay: true, capture: false, hasActiveSessions: false })).toBe(true);
	});

	it("still reports offline while a live session cannot reach the machine", () => {
		expect(resolveRunnerOnline({ relay: true, capture: false, hasActiveSessions: true })).toBe(false);
	});

	it("follows the relay once it has answered — the same signal the header dot reads", () => {
		expect(resolveRunnerOnline({ relay: false, capture: true, hasActiveSessions: false })).toBe(false);
		expect(resolveRunnerOnline({ relay: true, capture: null, hasActiveSessions: false })).toBe(true);
		expect(resolveRunnerOnline({ relay: false, capture: null, hasActiveSessions: false })).toBe(false);
	});

	it("falls back to a live capture before the first status answer", () => {
		expect(resolveRunnerOnline({ relay: null, capture: true, hasActiveSessions: true })).toBe(true);
		expect(resolveRunnerOnline({ relay: null, capture: false, hasActiveSessions: true })).toBe(false);
	});

	it("is unknown, not offline, when nothing has answered yet", () => {
		// null renders as neither a green state nor a warning. Defaulting to `false` would put the
		// "your machine isn't connected" notice on screen before anything had been checked.
		expect(resolveRunnerOnline({ relay: null, capture: null, hasActiveSessions: false })).toBeNull();
		expect(resolveRunnerOnline({ relay: null, capture: null, hasActiveSessions: true })).toBeNull();
		expect(resolveRunnerOnline({ relay: null, capture: false, hasActiveSessions: false })).toBeNull();
	});
});
