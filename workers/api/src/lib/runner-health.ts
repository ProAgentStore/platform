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
 * `unresponsive` — the relay reported a socket, but the health responder did not answer.
 *   This can be stale relay state or a wedged local responder; a reconnect may recover it.
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

/** Recovery guidance from observed health, without assuming a timeout proves a frozen process (#901).
 * Diagnostics only recommends recovery: force attach is an explicit takeover, never a read-side effect.
 *
 * `duplicateDetail` (#896) comes FIRST when it is present, because it changes the answer rather than
 * decorating it: a relay link that goes stale while two `pags up` processes compete for the same
 * agents is not fixed by re-attaching, and the old advice — "restart `pags up`" — was how the next
 * duplicate got made while the start path still ran `pkill`. The 2026-10-01 machine had three.
 */
export function runnerHealthRemedy(status: RunnerLiveStatus, healthCheck: HealthCheckState, duplicateDetail?: string | null): string | null {
	if (status === "online") return duplicateDetail ? duplicateDetail : null;
	if (duplicateDetail) return `${duplicateDetail} Until one of them is stopped, re-attaching only moves the agent between them.`;
	if (status === "unregistered") return "Run `pags up` on the machine to register and connect this instance";
	if (status === "offline" || healthCheck === "disconnected") {
		return "The relay socket is absent or closed. If another of your agents has a responding runner on the same machine, try `force_runner_attach` for this instance and recheck `coding_diagnostics`. Otherwise check `pags up` on the machine and start or restart it if it does not reconnect";
	}
	return "Try `force_runner_attach` for this instance on its pinned machine (or specify `runner_node` if unpinned) to reconnect its relay socket. This can recover a stale connection even when `evicted` is 0. Then run `coding_diagnostics` again: `attached: true` confirms the socket, not a healthy responder. If attachment is unconfirmed, check `instance_runner_node` before retrying; if reattachment fails or the health check still fails, restart `pags up` on the machine";
}

/**
 * What a `/health` probe found right AFTER an attach (#1032).
 *
 * An attach is a TRANSPORT fact: the relay holds this agent's socket. On the 2026-10 machine
 * `force_runner_attach` answered `attached: true` while `/health` kept timing out — the attach is
 * answered by the CLI's relay client, `/health` by the local runtime behind it, and the second was
 * the one wedged. So an attach now carries the probe that says whether the agent can actually work.
 */
export interface PostAttachHealth {
	state: HealthCheckState;
	/** Fixed per state (see {@link classifyHealthProbeFailure}); absent when `ok`. */
	error?: string;
}

/** The next step after an attach whose transport is up but whose health is not — null when healthy. */
export function attachHealthRemedy(node: string, state: HealthCheckState): string | null {
	if (state === "ok") return null;
	if (state === "not_attempted") return `The relay socket is attached on ${node}, but its health was not checked. Run coding_diagnostics (or instance_runtime_status) before relying on it.`;
	return `The relay socket is attached on ${node}, but the runner behind it did not pass its health check (${state}). Attaching again will not fix that: call runner_restart for ${node} — with force if it refuses because the machine's work check cannot answer, which loses any run in progress there. If runner_restart cannot reach it, restart \`pags up\` at the machine.`;
}

/**
 * Four separate facts about one agent's runner, each measured on its own (#1032).
 *
 * The 2026-10 report read a fresh heartbeat, `relayConnected: true`, `runnerOnline: false` and a
 * `/health` 504 off one machine at once — and `runtime/status` still said "online", because a fresh
 * heartbeat let the probe's failure pass. These are four different questions, so they are four fields:
 *
 *   heartbeat — is `pags up` reaching the platform at all (its 30s report)?
 *   relay     — does the relay hold THIS agent's socket (transport only)?
 *   rpc       — does the runner behind that socket answer `/health`?
 *   eligible  — would work dispatched now reach a runner that can do it? Both of the last two.
 *
 * `status` is {@link runnerLiveStatus} over the same inputs, so it can never say "online" while the
 * health probe fails.
 */
export interface RunnerStatusView {
	status: RunnerLiveStatus;
	heartbeat: { lastSeenAt: string | null; fresh: boolean };
	relay: { attached: boolean };
	rpc: { health: HealthCheckState; error?: string };
	eligible: { ok: boolean; reason: "ready" | "unregistered" | "no_relay" | "rpc_unhealthy" | "rpc_unchecked"; detail: string };
}

export function runnerStatusView(input: {
	registered: boolean;
	lastSeenAt: string | null;
	heartbeatFresh: boolean;
	relayConnected: boolean;
	health: HealthCheckState;
	healthError?: string;
}): RunnerStatusView {
	const status = runnerLiveStatus({ registered: input.registered, relayConnected: input.relayConnected, healthCheck: input.health });
	const eligible: RunnerStatusView["eligible"] = !input.registered
		? { ok: false, reason: "unregistered", detail: "No runner has registered for this agent. Run `pags up` on a machine." }
		: !input.relayConnected
			? {
					ok: false,
					reason: "no_relay",
					detail: input.heartbeatFresh
						? "`pags up` is reporting in, but it holds no relay socket for this agent, so no work can reach it. force_runner_attach takes the slot."
						: "No relay socket for this agent and no recent heartbeat: the machine's `pags up` is not running or not reaching the platform.",
				}
			: input.health === "ok"
				? { ok: true, reason: "ready", detail: "Attached, and the runner answered its health check: work can be dispatched." }
				: input.health === "not_attempted"
					? { ok: false, reason: "rpc_unchecked", detail: "Attached, but the runner's health was not checked. Run coding_diagnostics before relying on it." }
					: { ok: false, reason: "rpc_unhealthy", detail: `Attached, but the runner behind the socket did not pass its health check (${input.health}), so work sent now would fail. Attaching again will not fix that: runner_restart restarts it on the machine.` };
	return {
		status,
		heartbeat: { lastSeenAt: input.lastSeenAt, fresh: input.heartbeatFresh },
		relay: { attached: input.relayConnected },
		rpc: { health: input.health, ...(input.healthError ? { error: input.healthError } : {}) },
		eligible,
	};
}

/** A `/health` answer that came back as an HTTP response rather than a throw (`callRuntime`). */
export function healthOfResponse(ok: boolean, body: unknown): { health: HealthCheckState; healthError?: string } {
	if (ok) return { health: "ok" };
	const message = (body as { error?: unknown } | null)?.error;
	const failure = classifyHealthProbeFailure(new Error(typeof message === "string" ? message : JSON.stringify(body ?? {})));
	return { health: failure.state, healthError: failure.error };
}

/** A `/health` probe that THREW, in {@link runnerStatusView}'s terms. */
export function healthOfError(error: unknown): { health: HealthCheckState; healthError: string } {
	const failure = classifyHealthProbeFailure(error);
	return { health: failure.state, healthError: failure.error };
}
