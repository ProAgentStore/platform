/**
 * #1354 — the stop-reason table every reader derives from. The first test pins the behaviour measured BEFORE the table
 * existed (statusFor, needsHuman, the resumable list, stopReasonFor and the unknown-reason fallbacks), so the refactor is
 * proven to change nothing it did not mean to; a deliberate change to a reason now shows up here as a one-row diff.
 */
import { describe, expect, it } from "vitest";
import { needsHuman, statusFor } from "./agent-loop.js";
import { isResumableStopReason } from "./agent-loop-store.js";
import { stopReasonFor } from "./coding-pause.js";
import type { CodingOutcome } from "./coding-loop.js";
import { LOOP_STOP_REASONS, PROVIDER_ACCOUNT_STOP_REASONS, RESUMABLE_STOP_REASONS, STOP_REASONS, stopReasonFacts, stopReasonsSql } from "./stop-reasons.js";

describe("the table reproduces the behaviour it replaced, reason by reason", () => {
	// [reason, statusFor, needsHuman, resumable] — measured on 51e8f80b, before #1354.
	const BEFORE: ReadonlyArray<[string, string, boolean, boolean]> = [
		["done", "completed", false, false],
		["escalated", "needs_human", true, false],
		["failed", "failed", true, false],
		["max_iterations", "failed", false, true],
		["budget", "failed", true, false],
		["cancelled", "cancelled", false, false],
		["no_progress", "failed", true, false],
		["engine_limit", "needs_human", true, true],
		["provider_credit", "needs_human", true, true],
		["provider_credentials", "needs_human", true, true],
		["engine_auth", "needs_human", true, true],
		["interrupted", "needs_human", true, true],
		["constraint_refused", "needs_human", true, true],
		["turn_lost", "needs_human", true, true],
		["decision", "needs_human", true, true],
		["runner_gone", "needs_human", true, true],
		["engine_error", "failed", false, true],
	];

	it("covers exactly the reasons the union had", () => {
		expect([...LOOP_STOP_REASONS].sort()).toEqual(BEFORE.map(([r]) => r).sort());
	});

	it.each(BEFORE)("%s → status %s, notifies %s, resumable %s", (reason, status, notifies, resumable) => {
		const r = reason as (typeof LOOP_STOP_REASONS)[number];
		expect(statusFor(r)).toBe(status);
		expect(needsHuman(r)).toBe(notifies);
		expect(isResumableStopReason(r)).toBe(resumable);
	});

	it("an unknown reason (a stored value from another build) files as failed and does not notify, as before", () => {
		expect(statusFor("some_future_reason" as never)).toBe("failed");
		expect(needsHuman("some_future_reason" as never)).toBe(false);
		expect(isResumableStopReason("some_future_reason")).toBe(false);
		expect(stopReasonFacts("some_future_reason")).toBeUndefined();
		expect(stopReasonFacts(null)).toBeUndefined();
	});

	it("stopReasonFor maps every coding outcome as before", () => {
		const outcomes: Array<[CodingOutcome, string]> = [
			["done", "done"],
			["stuck", "escalated"],
			["needs_input", "escalated"],
			["failed", "failed"],
			["max_steps", "max_iterations"],
			["cancelled", "cancelled"],
			["waiting", "engine_limit"],
			["needs_reauth", "engine_auth"],
			["engine_error", "engine_error"],
		];
		for (const [outcome, reason] of outcomes) expect(stopReasonFor(outcome), outcome).toBe(reason);
	});
});

describe("derived lists", () => {
	it("RESUMABLE_STOP_REASONS and PROVIDER_ACCOUNT_STOP_REASONS are the rows that say so, in table order", () => {
		expect(RESUMABLE_STOP_REASONS).toEqual(LOOP_STOP_REASONS.filter((r) => STOP_REASONS[r].resumable));
		expect(PROVIDER_ACCOUNT_STOP_REASONS).toEqual(["provider_credit", "provider_credentials"]);
	});

	it("renders a SQL IN list of the table's own keys", () => {
		expect(stopReasonsSql(PROVIDER_ACCOUNT_STOP_REASONS)).toBe("'provider_credit', 'provider_credentials'");
	});
});

describe("every reason has its own words on every surface (the drift #1354 fixed)", () => {
	it.each(LOOP_STOP_REASONS)("%s", (reason) => {
		const f = STOP_REASONS[reason];
		for (const text of [f.label, f.outcomeWord, f.endLabel]) {
			expect(text.trim(), reason).not.toBe("");
			// A raw identifier on screen ("runner_gone") is what the copies used to fall back to. "failed" reads as English.
			expect(text, reason).not.toMatch(/^[a-z]+(?:_[a-z]+)+$/);
		}
	});

	it("no two reasons share a label — each ending is a different thing to tell a person", () => {
		for (const key of ["label", "outcomeWord", "endLabel"] as const) {
			const seen = LOOP_STOP_REASONS.map((r) => STOP_REASONS[r][key]);
			expect(new Set(seen).size, key).toBe(seen.length);
		}
	});
});
