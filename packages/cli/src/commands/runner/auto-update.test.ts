import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { autoUpdatePolicyKey, autoUpdateStatusWire, loadAutoUpdatePolicy, mayAutomaticallyRestart, nextAutoUpdateDelayMs, parseAutoUpdatePolicy, policyFromResponse, policyScheduleAction, saveAutoUpdatePolicy } from "./auto-update.js";

describe("runner automatic-update policy", () => {
	let dir = "";
	afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ""; });

	it("defaults to absent/off, accepts API casing, and keeps aliases on the same stable-machine cache key", () => {
		expect(parseAutoUpdatePolicy(undefined)).toBeNull();
		expect(parseAutoUpdatePolicy({ auto_update: true, auto_update_status: "checking", latest_version: "0.5.0" }))
			.toEqual({ autoUpdate: true, status: "checking", latestVersion: "0.5.0" });
		expect(autoUpdatePolicyKey("physical-machine", { PAGS_LOCK_ACCOUNT: "owner" } as NodeJS.ProcessEnv))
			.toBe(autoUpdatePolicyKey("physical-machine", { PAGS_LOCK_ACCOUNT: "owner" } as NodeJS.ProcessEnv));
	});

	it("persists policy per owner and machine without leaking it to another owner", () => {
		dir = mkdtempSync(join(tmpdir(), "pags-auto-update-"));
		const env = { PAGS_AUTO_UPDATE_POLICY_FILE: join(dir, "policy.json"), PAGS_LOCK_ACCOUNT: "owner-a" } as NodeJS.ProcessEnv;
		const key = autoUpdatePolicyKey("machine-1", env);
		expect(saveAutoUpdatePolicy(key, { autoUpdate: true, status: "enabled" }, env)).toBe(true);
		expect(loadAutoUpdatePolicy(key, env)).toEqual({ autoUpdate: true, status: "enabled" });
		expect(loadAutoUpdatePolicy(autoUpdatePolicyKey("machine-1", { ...env, PAGS_LOCK_ACCOUNT: "owner-b" }), env)).toBeNull();
	});

	it("reads direct and nested registration responses", () => {
		expect(policyFromResponse({ autoUpdatePolicy: { autoUpdate: true } })).toEqual({ autoUpdate: true });
		expect(policyFromResponse({ machine: { auto_update_policy: { auto_update: false, status: "offline" } } })).toEqual({ autoUpdate: false, status: "offline" });
	});

	it("backs registry failures off exponentially with bounded jitter", () => {
		expect(nextAutoUpdateDelayMs(0, () => 0)).toBe(5.1 * 60 * 60_000);
		expect(nextAutoUpdateDelayMs(1, () => 0)).toBe(51_000);
		expect(nextAutoUpdateDelayMs(20, () => 1)).toBe(69 * 60_000);
	});

	it("maps readable runner statuses to the API's persisted enum", () => {
		expect(autoUpdateStatusWire("waiting-for-idle")).toBe("waiting_for_idle");
		expect(autoUpdateStatusWire("running")).toBe("installing");
		expect(autoUpdateStatusWire("verified-success")).toBe("verified_success");
		expect(autoUpdateStatusWire("failure")).toBe("failed");
	});

	it("controller preserves a due automatic check across repeated enabled heartbeats", () => {
		let now = 0;
		let dueAt: number | null = null;
		const cached = { autoUpdate: true };
		// First authoritative registration starts a 6h timer.
		if (policyScheduleAction(cached, cached, false) === "start") dueAt = now + 6 * 60 * 60_000;
		for (let beat = 0; beat < 720; beat++) { // six hours of 30s heartbeats
			now += 30_000;
			expect(policyScheduleAction(cached, cached, true)).toBe("keep");
		}
		expect(now).toBe(6 * 60 * 60_000);
		expect(dueAt).toBe(now); // a controller calling `keep` never pushes this deadline out.
	});

	it("controller rejects unknown, coding, and local workload at final restart admission", () => {
		expect(mayAutomaticallyRestart({ authoritative: false, enabled: true, workObserved: true, busy: [] })).toBe(false);
		expect(mayAutomaticallyRestart({ authoritative: true, enabled: true, workObserved: false, busy: ["runner-work-observation-unavailable"] })).toBe(false);
		expect(mayAutomaticallyRestart({ authoritative: true, enabled: true, workObserved: true, busy: ["coding-turn-1"] })).toBe(false);
		expect(mayAutomaticallyRestart({ authoritative: true, enabled: true, workObserved: true, busy: ["local-run-1"] })).toBe(false);
		expect(mayAutomaticallyRestart({ authoritative: true, enabled: true, workObserved: true, busy: [] })).toBe(true);
	});
});
