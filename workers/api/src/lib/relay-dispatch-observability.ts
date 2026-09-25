/**
 * The RelayDO is deliberately not coupled to D1: it is on the hot path for every command and
 * does not know the user or instance ids behind its DO name.  Structured Worker logs are therefore
 * its operational event stream.  Keep these records small and machine-readable so they can become
 * counters/histograms in Workers Observability without parsing prose.
 */

/** Dispatches at or above this duration are slow enough to investigate. */
export const RELAY_DISPATCH_SLOW_MS = 2_000;

export type RelayDispatchOutcome = "completed" | "timeout" | "unresponsive" | "failed";

export interface RelayDispatchObservation {
	/** Stable event name for log/metric queries. */
	event: "relay.command.dispatch_slow" | "relay.command.dispatch_timeout" | "relay.command.unresponsive" | "relay.command.dispatch_failed";
	metric: "relay.command.dispatch_latency_ms";
	latencyMs: number;
	path: string;
	timeoutMs: number;
	outcome: RelayDispatchOutcome;
}

/** Build an observation only for a condition that needs operational attention. */
export function relayDispatchObservation(input: {
	path: string;
	latencyMs: number;
	timeoutMs: number;
	outcome: RelayDispatchOutcome;
}): RelayDispatchObservation | null {
	const latencyMs = Math.max(0, Math.round(input.latencyMs));
	const base = { metric: "relay.command.dispatch_latency_ms" as const, latencyMs, path: input.path, timeoutMs: input.timeoutMs, outcome: input.outcome };
	if (input.outcome === "unresponsive") return { event: "relay.command.unresponsive", ...base };
	if (input.outcome === "timeout") return { event: "relay.command.dispatch_timeout", ...base };
	if (input.outcome === "failed") return { event: "relay.command.dispatch_failed", ...base };
	if (latencyMs >= RELAY_DISPATCH_SLOW_MS) return { event: "relay.command.dispatch_slow", ...base };
	return null;
}
