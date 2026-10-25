/**
 * #1358 — the rules between the timing values the cloud and the runner share, as assertions. Each used to be a sentence in a comment
 * beside a literal: "a read fails fast", "the lease outlives a decision", "the poll stays under the claim's staleness". Change one number
 * until it breaks another and this fails, instead of a run failing in production.
 */
import { describe, expect, it } from "vitest";
import { DECIDE_RETRY, IDLE_RETRY } from "../workflows/coding-session/step-retry-presets.js";
import { IDLE_WAIT_MAX_MS } from "./coding-idle-poll.js";
import { STALE_DRIVER_MS } from "./coding-store.js";
import { PONG_DEADLINE_MS } from "./relay-liveness.js";
import { RUNNER_WAIT_MS } from "./runner-availability.js";
import {
	CLI_FORWARD_MS,
	DECIDE_STEP_MS,
	DECISION_RECOVERY_MAX_MS,
	IDLE_STEP_MS,
	READ_TIMEOUT_MS,
	RELAY_DEFAULT_TIMEOUT_MS,
	RELAY_PONG_DEADLINE_MS,
	RUN_OWNERSHIP_LEASE_MS,
	RUNNER_MAX_RUN_LEASE_MS,
} from "./runner-timeouts.js";

/** A step option such as "12 minutes", in ms: the workflow states its budgets in words, the rules compare them in numbers. */
const stepMs = (t: string): number => {
	const m = /^(\d+) (second|minute|hour)s?$/.exec(t);
	if (!m) throw new Error(`unreadable step timeout ${t}`);
	return Number(m[1]) * { second: 1_000, minute: 60_000, hour: 3_600_000 }[m[2] as "second" | "minute" | "hour"];
};

describe("the relay and the runner agree on how long a command may take (#1358)", () => {
	it("a read fails fast and a liveness probe answers before a read could: pong < read < relay < CLI forward", () => {
		expect(RELAY_PONG_DEADLINE_MS).toBeLessThan(READ_TIMEOUT_MS);
		expect(READ_TIMEOUT_MS).toBeLessThan(RELAY_DEFAULT_TIMEOUT_MS);
		// The relay gives up first and tells the CLI to cancel; the CLI's own limit is only the backstop for a relay that never does.
		expect(RELAY_DEFAULT_TIMEOUT_MS).toBeLessThan(CLI_FORWARD_MS);
	});

	it("the relay's liveness deadline is this module's, not a second copy", () => {
		expect(PONG_DEADLINE_MS).toBe(RELAY_PONG_DEADLINE_MS);
	});
});

describe("a Pilot decision, its lease and its steps nest inside one another (#1178, #907)", () => {
	it("the workflow's step budgets are the values named here", () => {
		expect(stepMs(DECIDE_RETRY.timeout)).toBe(DECIDE_STEP_MS);
		expect(stepMs(IDLE_RETRY.timeout)).toBe(IDLE_STEP_MS);
	});

	it("a decide step outlasts the longest decision recovery it hosts", () => {
		expect(DECISION_RECOVERY_MAX_MS).toBeLessThanOrEqual(DECIDE_STEP_MS);
	});

	it("an idle wait fits inside its step, with room for the engine's slow start", () => {
		expect(IDLE_WAIT_MAX_MS).toBeLessThan(IDLE_STEP_MS);
	});

	it("the lease a capture takes outlives a decision, and is not longer than the runner will honour", () => {
		expect(RUN_OWNERSHIP_LEASE_MS).toBeGreaterThan(DECIDE_STEP_MS);
		expect(RUN_OWNERSHIP_LEASE_MS).toBeLessThanOrEqual(RUNNER_MAX_RUN_LEASE_MS);
	});

	it("waiting for a machine to come back ends before the claim the run holds on its session goes stale", () => {
		expect(RUNNER_WAIT_MS).toBeLessThan(STALE_DRIVER_MS);
	});
});
