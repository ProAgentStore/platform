// One verdict on "is this runner there?", from two independent measurements (#880).
//
// ── What was wrong ──
//
// `coding_diagnostics` reported three things about one machine that were measured three different
// ways and could therefore disagree in a single response:
//
//   • `summary.runnerStatus` — the `status` COLUMN of the runtime row, i.e. whatever the runner
//     last registered as. It read "online" for a machine whose health responder was wedged.
//   • `summary.runnerOnline` — whether `/health` answered through the relay.
//   • `summary.relayConnected` — whether the relay holds a socket (what `list_runner_nodes` shows).
//
// So "relay connected, health responder hung" came out as `runnerOnline: false` beside
// `runnerStatus: "online"`, and `runner.health.error` was the raw relay text, which alternated
// between `Relay command timed out` and `Can't call WebSocket send() after close().` depending on
// which socket the relay happened to pick.
//
// ── What it is now ──
//
// The two live measurements are reported separately and named for what they measure —
// `relayConnected` (socket) and `healthCheck` (responder) — and `runnerStatus` is DERIVED from
// them, so it cannot contradict `runnerOnline`. A failed probe reports a closed `state` and a
// fixed `error` sentence per state; the raw relay text survives only as `detail`.
//
// Pure and import-light so the route and its tests agree on one rule.

import { isRunnerUnreachable } from "./runner-unreachable.js";

/** What the `/health` probe found. `not_attempted` = there was no relay socket to ask through. */
export type HealthCheckState = "ok" | "timeout" | "unresponsive" | "disconnected" | "failed" | "not_attempted";

/**
 * The single runner status every surface of a diagnostics report agrees with.
 *
 * `online` — relay socket live AND the health responder answered.
 * `unresponsive` — relay socket live, health responder did not answer: the machine is there and a
 *   process on it is wedged. Reconnecting does not fix this; restarting the runner does.
 * `offline` — registered, but no live relay socket.
 * `unregistered` — no runner has ever registered for this instance.
 */
export type RunnerLiveStatus = "online" | "unresponsive" | "offline" | "unregistered";

export interface HealthCheckFailure {
	ok: false;
	state: Exclude<HealthCheckState, "ok" | "not_attempted">;
	/** Fixed per state — the same failure reads the same on every call. */
	error: string;
	/** The raw relay/runner message, for debugging only. Varies; do not match on it. */
	detail: string;
}

const FAILURE_ERRORS: Record<HealthCheckFailure["state"], string> = {
	timeout: "Runner relay is connected but its health check did not answer in time",
	unresponsive: "Runner relay is connected but the runner is not answering pings",
	disconnected: "Runner relay socket closed during the health check",
	failed: "Runner health check failed",
};

/** Classify a `/health` probe failure into a stable state + message. */
export function classifyHealthProbeFailure(e: unknown): HealthCheckFailure {
	const detail = e instanceof Error ? e.message : String(e);
	const state: HealthCheckFailure["state"] = detail.includes("Relay command timed out")
		? "timeout"
		: detail.includes("connected but not responding")
			? "unresponsive"
			: isRunnerUnreachable(e) || /send\(\) after close/i.test(detail)
				? "disconnected"
				: "failed";
	return { ok: false, state, error: FAILURE_ERRORS[state], detail };
}

/** Derive the one status from the two measurements. */
export function runnerLiveStatus(input: { registered: boolean; relayConnected: boolean; healthCheck: HealthCheckState }): RunnerLiveStatus {
	if (!input.relayConnected) return input.registered ? "offline" : "unregistered";
	return input.healthCheck === "ok" ? "online" : "unresponsive";
}
