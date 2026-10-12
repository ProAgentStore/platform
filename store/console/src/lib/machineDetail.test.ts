import { describe, expect, it } from "vitest";
import {
	machineAutoUpdateEnabled,
	machineAutoUpdateIsBusy,
	machineAutoUpdateStatus,
	machineBlockerLabel,
	machineSessionStatesLine,
	machineCanRunAutomaticUpdates,
	machineFromResponse,
	machineLastAttempt,
	machineLatestVersion,
	machineObservationOutcome,
	machineRetryOverdue,
	machineStatusDetail,
	machineStatusLabel,
	machineUpdateDiagnostics,
} from "./machineDetail";

describe("machine details from the terminals API", () => {
	it("accepts both the direct and enveloped detail responses during a rolling API deployment", () => {
		const machine = { machineId: "mac-1", node: "laptop", auto_update_policy: false };
		expect(machineFromResponse(machine)).toEqual(machine);
		expect(machineFromResponse({ machine })).toEqual(machine);
	});

	it("keeps the absence of a legacy policy safely off", () => {
		expect(machineAutoUpdateEnabled({ machineId: "legacy" })).toBe(false);
		expect(machineAutoUpdateEnabled({ machineId: "configured", auto_update_policy: true })).toBe(true);
	});

	it("normalizes the status fields used by runner reports", () => {
		const status = machineAutoUpdateStatus({
			machineId: "m1",
			auto_update_status: { state: "waiting-for-idle", last_attempt_at: "2026-10-10T00:00:00.000Z" },
		});
		expect(status.state).toBe("waiting-for-idle");
		expect(machineLastAttempt({ machineId: "m1", last_attempt_at: "2026-10-10T00:00:00.000Z" })).toBe("2026-10-10T00:00:00.000Z");
		expect(machineStatusLabel(status)).toBe("waiting for idle");
		expect(machineStatusDetail({ machineId: "m1", last_error: "Registry unavailable" })).toBe("Registry unavailable");
	});

	it("uses a fast refresh cadence while an automatic update can advance", () => {
		expect(machineAutoUpdateIsBusy(null)).toBe(true);
		expect(machineAutoUpdateIsBusy({ machineId: "offline", connected: false })).toBe(true);
		expect(machineAutoUpdateIsBusy({ machineId: "checking", connected: true, auto_update_status: "checking" })).toBe(true);
		expect(machineAutoUpdateIsBusy({ machineId: "installing", connected: true, auto_update_status: "installing" })).toBe(true);
		expect(machineAutoUpdateIsBusy({ machineId: "quiet", connected: true, auto_update_status: "verified-success" })).toBe(false);
	});

	it("shows the server's latest version regardless of its response casing", () => {
		expect(machineLatestVersion({ machineId: "snake", latest_version: "0.5.0" })).toBe("0.5.0");
		expect(machineLatestVersion({ machineId: "camel", latestVersion: "0.5.1" })).toBe("0.5.1");
	});

	it("does not mistake an identifiable pre-controller runner for an automatic-update capable one", () => {
		expect(machineCanRunAutomaticUpdates({ machineId: "macmini", runnerVersion: "0.4.90" })).toBe(false);
		expect(machineCanRunAutomaticUpdates({ machineId: "unknown" })).toBe(false);
		expect(machineCanRunAutomaticUpdates({ machineId: "supported", runnerVersion: "0.4.92" })).toBe(true);
		expect(machineCanRunAutomaticUpdates({ machineId: "newer", runnerVersion: "v0.5.0" })).toBe(true);
	});

	it("shows no diagnostics for an older API rather than an empty card", () => {
		expect(machineUpdateDiagnostics({ machineId: "old" })).toBeNull();
		expect(machineUpdateDiagnostics({ machineId: "new", auto_update_diagnostics: { blocker_class: "idle_wait" } })).toEqual({ blocker_class: "idle_wait" });
	});

	it("names every blocker class in plain words, and says nothing when nothing blocks", () => {
		expect(machineBlockerLabel("active_sessions")).toMatch(/coding session .* not proven idle/);
		expect(machineBlockerLabel("observation_failure")).toMatch(/could not read whether this machine is busy.*never assumes idle/);
		expect(machineBlockerLabel("idle_wait")).toMatch(/final safety check before installing refused/);
		expect(machineBlockerLabel("unknown")).toMatch(/did not report why/);
		expect(machineBlockerLabel("future_class")).toBe("future class");
		expect(machineBlockerLabel(null)).toBeNull();
	});

	it("flags a retry overdue only when heartbeats keep arriving past it with no new decision", () => {
		const due = "2026-10-11T04:40:00.000Z";
		const late = "2026-10-11T04:45:00.000Z";
		// Heartbeats well past the due time, no decision since: the timer is not running.
		expect(machineRetryOverdue({ next_retry_due_at: due, last_heartbeat_at: late, last_decision_at: "2026-10-11T04:39:00.000Z" })).toBe(true);
		// A decision at or after the due time: the timer ran.
		expect(machineRetryOverdue({ next_retry_due_at: due, last_heartbeat_at: late, last_decision_at: "2026-10-11T04:40:05.000Z" })).toBe(false);
		// Within the grace window: not yet.
		expect(machineRetryOverdue({ next_retry_due_at: due, last_heartbeat_at: "2026-10-11T04:40:30.000Z" })).toBe(false);
		// A runner that went quiet, nothing scheduled, or no diagnostics: no claim either way.
		expect(machineRetryOverdue({ next_retry_due_at: due, last_heartbeat_at: "2026-10-11T04:30:00.000Z" })).toBe(false);
		expect(machineRetryOverdue({ next_retry_due_at: null, last_heartbeat_at: late })).toBe(false);
		expect(machineRetryOverdue(null)).toBe(false);
	});

	it("keeps an unreadable observation distinct from a failed one", () => {
		expect(machineObservationOutcome({ success: true, sampled_at: "t", source: "health" })).toBe("ok");
		expect(machineObservationOutcome({ success: false, sampled_at: "t", source: "sessions" })).toBe("failed");
		expect(machineObservationOutcome({ success: false, sampled_at: "t", source: "sessions", malformed: true })).toBe("unreadable");
	});
});

describe("machineSessionStatesLine (#1020)", () => {
	it("names what blocks first, and counts idle retained engines apart from it", () => {
		const o = { success: true, sampled_at: "2026-10-12T00:00:00Z", source: "sessions", session_states: { active_turns: 1, idle_retained: 2, stopped: 0, unknown: 3 } };
		expect(machineSessionStatesLine(o)).toBe("1 active turn · 3 unknown · 2 idle retained · 0 stopped");
		expect(machineSessionStatesLine({ ...o, session_states: { active_turns: 0, idle_retained: 1, stopped: 1, unknown: 0 } })).toBe("0 active turns · 0 unknown · 1 idle retained · 1 stopped");
	});

	it("is null for a look that carried no counts (a health look, a failed one, an older runner)", () => {
		expect(machineSessionStatesLine({ success: true, sampled_at: "2026-10-12T00:00:00Z", source: "health" })).toBeNull();
		expect(machineSessionStatesLine({ success: false, sampled_at: "2026-10-12T00:00:00Z", source: "sessions", session_states: null })).toBeNull();
	});
});
