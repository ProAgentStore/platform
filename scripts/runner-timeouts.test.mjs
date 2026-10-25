// #1358 — the timing values the cloud shares with the runner live in two packages the API worker cannot import from each other.
// This is the one place both are loaded, so the pairs that have to be EQUAL are asserted equal.
import { describe, expect, it } from "vitest";
import { CodingRuntime } from "../packages/browser-runner/src/coding/runtime.ts";
import { relayLimits } from "../packages/cli/src/commands/runner/relay.ts";
import { CLI_FORWARD_MS, RELAY_DEFAULT_TIMEOUT_MS, RUNNER_MAX_RUN_LEASE_MS } from "../workers/api/src/lib/runner-timeouts.ts";

describe("cloud and runner agree on the numbers they share (#1358)", () => {
	it("the cloud's copy of the CLI's forward limit is the CLI's", () => {
		expect(CLI_FORWARD_MS).toBe(relayLimits.forwardMs);
		// …which is longer than the relay waits, so the relay's cancel always lands first.
		expect(relayLimits.forwardMs).toBeGreaterThan(RELAY_DEFAULT_TIMEOUT_MS);
	});

	it("the cloud's copy of the runner's lease cap is the runner's", () => {
		expect(RUNNER_MAX_RUN_LEASE_MS).toBe(CodingRuntime.MAX_RUN_LEASE_MS);
	});
});
