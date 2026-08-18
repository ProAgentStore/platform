import { describe, expect, it } from "vitest";
import { resolveHandoffStatus } from "./handoff-status.js";

/**
 * A handoff whose page was closed reported `solved: true` (#641) — three lines below a
 * comment stating that a status poll must never claim a lost handoff is done. The early
 * return sat ahead of all three per-reason branches, so one line answered for every reason.
 * There is a case per reason here for that reason: a fix that restores the shortcut for any
 * one of them has to fail something.
 */
describe("a handoff whose page is gone", () => {
	it("leaves a CHALLENGE unsolved — the captcha is no less unsolved for the tab being shut", () => {
		expect(resolveHandoffStatus({ reason: "challenge", pageClosed: true })).toEqual({ solved: false, challenge: null });
	});

	it("leaves a STUCK handoff unsolved even when the human said they were done", () => {
		// Deliberate: `humanDone` says a step was performed, but the page it was performed
		// in no longer exists, so the brain has nothing to resume onto — its next action
		// would land on a fresh blank tab. Unsolved times out into "not resolved in time",
		// which the cloud maps to `escalated` → "Needs you", where the owner can retry.
		expect(resolveHandoffStatus({ reason: "stuck", pageClosed: true, humanDone: true })).toEqual({ solved: false, challenge: null });
		expect(resolveHandoffStatus({ reason: "stuck", pageClosed: true })).toEqual({ solved: false, challenge: null });
	});

	it("still delivers a NEEDS_INPUT value, which never travelled through the page", () => {
		// The one reason whose answer arrives out of band (browserSubmitInput). Answering it
		// after the tab has gone is honest; dropping it would make the brain re-ask for a
		// value the owner already typed. `value` must survive — the workflow saves it to the
		// Profile only when it is actually present.
		expect(resolveHandoffStatus({ reason: "needs_input", pageClosed: true, inputValue: "3 years" })).toEqual({
			solved: true,
			challenge: null,
			value: "3 years",
		});
	});

	it("holds a NEEDS_INPUT handoff that has no value yet", () => {
		expect(resolveHandoffStatus({ reason: "needs_input", pageClosed: true })).toMatchObject({ solved: false, challenge: null });
		expect(resolveHandoffStatus({ reason: "needs_input", pageClosed: false })).toMatchObject({ solved: false, challenge: null });
	});

	it("treats an unrecognised reason as a challenge — lost, not done", () => {
		// `reason` is a string off the HTTP boundary, so an unknown one must land in the
		// conservative branch rather than fall through to `solved: true`.
		expect(resolveHandoffStatus({ reason: "something-new", pageClosed: true })).toEqual({ solved: false, challenge: null });
	});
});

describe("a handoff whose page is alive", () => {
	it("defers a challenge to the live DOM", () => {
		// null = "ask the page". Only `browserHandoffStatus` can answer this one, by reading
		// the captcha token out of the DOM.
		expect(resolveHandoffStatus({ reason: "challenge", pageClosed: false })).toBeNull();
		expect(resolveHandoffStatus({ pageClosed: false })).toBeNull();
	});

	it("resolves a stuck handoff on the human's explicit Resume, and only that", () => {
		expect(resolveHandoffStatus({ reason: "stuck", pageClosed: false })).toEqual({ solved: false, challenge: null });
		expect(resolveHandoffStatus({ reason: "stuck", pageClosed: false, humanDone: true })).toEqual({ solved: true, challenge: null });
	});
});
