import { describe, expect, it } from "vitest";
import {
	machineAutoUpdateEnabled,
	machineAutoUpdateIsBusy,
	machineAutoUpdateStatus,
	machineCanRunAutomaticUpdates,
	machineFromResponse,
	machineLastAttempt,
	machineLatestVersion,
	machineStatusDetail,
	machineStatusLabel,
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
});
