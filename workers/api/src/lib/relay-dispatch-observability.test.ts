import { describe, expect, it } from "vitest";
import { RELAY_DISPATCH_SLOW_MS, relayDispatchObservation } from "./relay-dispatch-observability.js";

describe("relay dispatch observability", () => {
	it("tracks latency and emits a structured metric event once a dispatch is slow", () => {
		const observation = relayDispatchObservation({
			path: "/coding/start",
			latencyMs: RELAY_DISPATCH_SLOW_MS + 18.4,
			timeoutMs: 120_000,
			outcome: "completed",
		});
		expect(observation).toEqual({
			event: "relay.command.dispatch_slow",
			metric: "relay.command.dispatch_latency_ms",
			latencyMs: RELAY_DISPATCH_SLOW_MS + 18,
			path: "/coding/start",
			timeoutMs: 120_000,
			outcome: "completed",
		});
	});

	it("emits an unresponsive event for a connected relay that fails its bounded ping probe", () => {
		expect(relayDispatchObservation({
			path: "/coding/start",
			latencyMs: 1_500,
			timeoutMs: 120_000,
			outcome: "unresponsive",
		})).toMatchObject({
			event: "relay.command.unresponsive",
			metric: "relay.command.dispatch_latency_ms",
			path: "/coding/start",
		});
	});
});
