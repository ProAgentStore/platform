/**
 * #880: one runner, one verdict. A hung health responder behind a live relay socket must read the
 * same on every call, and `runnerStatus` must never contradict `runnerOnline`.
 */
import { describe, expect, it } from "vitest";
import { classifyHealthProbeFailure, type HealthCheckState, runnerHealthRemedy, runnerLiveStatus } from "./runner-health.js";
import { NO_SOCKET_MARKER, RunnerUnreachableError } from "./runner-unreachable.js";

describe("classifyHealthProbeFailure", () => {
	it("gives the two wordings #880 saw alternate a stable error each, keeping the raw text as detail", () => {
		const timeout = classifyHealthProbeFailure(new Error('Runner /health → 504: {"error":"Relay command timed out"}'));
		expect(timeout).toMatchObject({ ok: false, state: "timeout", error: "Runner relay is connected but its health check did not answer in time" });
		expect(timeout.detail).toContain("Relay command timed out");

		const closed = classifyHealthProbeFailure(new Error(`Runner /health → 504: {"error":"Can't call WebSocket send() after close()."}`));
		expect(closed.state).toBe("disconnected");
		expect(closed.error).toBe("Runner relay socket closed during the health check");
	});

	it("repeats the same error for the same failure, whatever the raw text varies in", () => {
		const a = classifyHealthProbeFailure(new Error('Runner /health → 504: {"error":"Relay command timed out"}'));
		const b = classifyHealthProbeFailure(new Error("Relay command timed out"));
		expect(a.error).toBe(b.error);
		expect(a.state).toBe(b.state);
	});

	it("names a relay that fails its ping gate, and a typed disconnect", () => {
		expect(classifyHealthProbeFailure(new RunnerUnreachableError(`Runner relay is connected but not responding — ${NO_SOCKET_MARKER} for this agent.`)).state).toBe("unresponsive");
		expect(classifyHealthProbeFailure(new RunnerUnreachableError(`No runner connected — ${NO_SOCKET_MARKER} for this agent.`)).state).toBe("disconnected");
		expect(classifyHealthProbeFailure(new Error('Runner /health → 504: {"error":"Runner disconnected"}')).state).toBe("disconnected");
	});

	it("falls back to `failed` for anything else, and accepts a non-Error throw", () => {
		expect(classifyHealthProbeFailure(new Error("Runner /health → 500: boom"))).toMatchObject({ state: "failed", error: "Runner health check failed" });
		expect(classifyHealthProbeFailure("weird").detail).toBe("weird");
	});
});

describe("runnerLiveStatus", () => {
	it("separates a wedged responder behind a live socket from an absent machine", () => {
		expect(runnerLiveStatus({ registered: true, relayConnected: true, healthCheck: "ok" })).toBe("online");
		expect(runnerLiveStatus({ registered: true, relayConnected: true, healthCheck: "timeout" })).toBe("unresponsive");
		expect(runnerLiveStatus({ registered: true, relayConnected: false, healthCheck: "not_attempted" })).toBe("offline");
		expect(runnerLiveStatus({ registered: false, relayConnected: false, healthCheck: "not_attempted" })).toBe("unregistered");
	});

	it("is `online` exactly when the health check passed over a live socket", () => {
		const states: HealthCheckState[] = ["ok", "timeout", "unresponsive", "disconnected", "failed", "not_attempted"];
		for (const registered of [true, false])
			for (const relayConnected of [true, false])
				for (const healthCheck of states) {
					const status = runnerLiveStatus({ registered, relayConnected, healthCheck });
					expect(status === "online").toBe(relayConnected && healthCheck === "ok");
				}
	});
});

describe("runnerHealthRemedy (#901)", () => {
	it("recommends explicit remote recovery before restarting for failed live health probes", () => {
		for (const state of ["timeout", "unresponsive", "failed"] as const) {
			const remedy = runnerHealthRemedy("unresponsive", state)!;
			expect(remedy).toContain("force_runner_attach");
			expect(remedy.indexOf("force_runner_attach")).toBeLessThan(remedy.indexOf("restart `pags up`"));
			expect(remedy).toContain("`evicted` is 0");
			expect(remedy).toContain("`attached: true` confirms the socket, not a healthy responder");
			expect(remedy).toContain("check `instance_runner_node` before retrying");
		}
	});

	/**
	 * #896: the 2026-10-01 machine had THREE `pags up` processes, one owning a relay link that then
	 * wedged. "Try force_runner_attach, then restart `pags up`" was the advice, and with the old
	 * start path still running `pkill` that made a fourth process. A duplicate changes the answer.
	 */
	it("leads with the duplicate when there is one, because re-attaching cannot fix it", () => {
		const detail = "2 `pags up` processes are running on pink-laptop: pid 4121, in a terminal, started X; pid 977, in a tmux session, started Y. Fix: run `pags up --replace`…";
		const remedy = runnerHealthRemedy("unresponsive", "timeout", detail)!;
		expect(remedy.startsWith(detail), "the duplicate comes first — it is the cause, not a footnote").toBe(true);
		expect(remedy).toMatch(/re-attaching only moves the agent between them/);
		// A healthy runner with a duplicate still gets told: two processes is a problem by itself.
		expect(runnerHealthRemedy("online", "ok", detail)).toBe(detail);
		// And without one, nothing changes.
		expect(runnerHealthRemedy("online", "ok", null)).toBeNull();
		expect(runnerHealthRemedy("unresponsive", "timeout")).toContain("force_runner_attach");
	});

	it("distinguishes a missing or closed socket and an unregistered runner", () => {
		for (const [status, state] of [["offline", "not_attempted"], ["unresponsive", "disconnected"]] as const) {
			const remedy = runnerHealthRemedy(status, state)!;
			expect(remedy).toContain("socket is absent or closed");
			expect(remedy).toContain("If another of your agents has a responding runner on the same machine");
			expect(remedy).toContain("Otherwise check `pags up`");
		}
		expect(runnerHealthRemedy("unregistered", "not_attempted")).toContain("register and connect");
		expect(runnerHealthRemedy("online", "ok")).toBeNull();
	});
});
