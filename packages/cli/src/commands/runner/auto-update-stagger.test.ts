/**
 * #1141 — a fleet updates one machine at a time, and a release this machine rolled back from is not retried.
 *
 * On 2026-10-17 two machines went dark mid-update to the same release at the same time. The service now
 * answers every registration and heartbeat with how many OTHER machines are mid-update (`fleetUpdating`,
 * counting only those ahead of this one); the controller and the install bridge wait while it is above zero.
 */
import { describe, expect, it, vi } from "vitest";
import { AutomaticUpdateController, IDLE_RETRY_MS, RelayMutationAdmission } from "./auto-update-controller.js";
import { acceptPolicyResponse, type AutoUpdatePolicy, type AutoUpdateStatus } from "./auto-update.js";
import { planRunnerUpdate, type UpdateFacts, type UpdatePlan } from "./self-update.js";
import { createInstallBridge, PolicyCell } from "./update-bridge.js";

type QueuedTimer = { fn: () => void; ms: number; unref(): void };
const facts = (over: Partial<UpdateFacts> = {}): UpdateFacts => ({
	current: "0.4.148",
	latest: "0.4.149",
	fromSource: false,
	restarter: "service",
	busy: [],
	observations: [{ source: "sessions", success: true, sampledAt: 1 }, { source: "health", success: true, sampledAt: 1 }],
	...over,
});
const updatePlan: Extract<UpdatePlan, { action: "update" }> = { action: "update", current: "0.4.148", latest: "0.4.149", restarter: "service" };

function controller(policy: AutoUpdatePolicy) {
	const timers: QueuedTimer[] = [];
	const statuses: Array<{ status: AutoUpdateStatus; extra?: Partial<AutoUpdatePolicy> }> = [];
	const state = { value: policy, authoritative: true };
	const install = vi.fn(async () => true);
	const c = new AutomaticUpdateController({
		policy: () => state,
		refreshPolicy: async () => true,
		facts: async () => facts(),
		plan: planRunnerUpdate,
		installAndRestart: install,
		status: (status, extra) => {
			statuses.push({ status, extra });
			state.value = { ...state.value, ...extra, status };
		},
		setTimer: (fn, ms) => {
			const t: QueuedTimer = { fn, ms, unref() {} };
			timers.push(t);
			return t as unknown as ReturnType<typeof setTimeout>;
		},
		clearTimer: (t) => {
			const i = timers.indexOf(t as unknown as QueuedTimer);
			if (i >= 0) timers.splice(i, 1);
		},
		random: () => 0,
	});
	return { c, timers, statuses, state, install };
}

describe("one machine at a time (#1141)", () => {
	it("another machine mid-update: no install, `waiting_for_idle` with fleet_stagger, re-checked on the idle cadence", async () => {
		const h = controller({ autoUpdate: true, fleetUpdating: 1 });
		await h.c.runNow();
		expect(h.install).not.toHaveBeenCalled();
		expect(h.statuses.at(-1)?.status).toBe("waiting-for-idle");
		expect(h.statuses.some((s) => /1 other machine\(s\) on this account are mid-update/.test(s.extra?.reason ?? ""))).toBe(true);
		expect(h.c.diagnostics().blockerClass).toBe("fleet_stagger");
		expect(h.timers.map((t) => t.ms)).toEqual([IDLE_RETRY_MS]);
	});

	it("…and installs on the first re-check after the other machine finished", async () => {
		const h = controller({ autoUpdate: true, fleetUpdating: 1 });
		await h.c.runNow();
		h.state.value = { ...h.state.value, fleetUpdating: 0 };
		h.timers.shift()?.fn();
		await vi.waitFor(() => expect(h.install).toHaveBeenCalledTimes(1));
		expect(h.install).toHaveBeenCalledWith(expect.objectContaining({ latest: "0.4.149" }), true);
	});

	it("the bridge re-reads it in the refresh right before npm — the race-safe look — and installs nothing while it is set", async () => {
		const cell = new PolicyCell({ autoUpdate: true }, () => undefined);
		const install = vi.fn(async () => undefined);
		const bridge = createInstallBridge({
			cell,
			// The answer to the refresh that already reported this machine `installing`: one machine started before it.
			refresh: async () => {
				cell.authoritative = true;
				cell.policy = { ...cell.policy, fleetUpdating: 1 };
				return true;
			},
			facts: async () => facts(),
			install,
			admission: new RelayMutationAdmission(),
			leaseActive: () => true,
			detachAll: () => undefined,
			log: () => undefined,
			settle: async () => undefined,
		});
		expect(await bridge.run(updatePlan, true)).toBe(false);
		expect(install).not.toHaveBeenCalled();
		expect(bridge.inFlight()).toBe(false);
	});

	it("the count is the service's live fact: taken from every answer, and cleared by one that carries none", () => {
		const local: AutoUpdatePolicy = { autoUpdate: true, status: "waiting-for-idle", fleetUpdating: 2 };
		expect(acceptPolicyResponse(local, true, { autoUpdatePolicy: { autoUpdate: true, status: "enabled", fleetUpdating: 0 } })?.policy).toEqual({ autoUpdate: true, status: "waiting-for-idle", fleetUpdating: 0 });
		expect(acceptPolicyResponse(local, true, { autoUpdatePolicy: { autoUpdate: true, fleetUpdating: 3 } })?.policy.fleetUpdating).toBe(3);
		expect(acceptPolicyResponse(local, true, { autoUpdatePolicy: { autoUpdate: true } })?.policy).toEqual({ autoUpdate: true, status: "waiting-for-idle" });
	});
});

describe("a release this machine rolled back from is not installed again (#1141)", () => {
	it("refused — retryable, so it is a visible failure — and the next release installs as usual", () => {
		const rolledBack = { "0.4.149": "it crashed on start: SyntaxError" };
		expect(planRunnerUpdate(facts({ rolledBack }))).toMatchObject({ action: "refused", retryable: true, reason: expect.stringMatching(/0\.4\.149 was installed here and rolled back: it crashed on start/) });
		expect(planRunnerUpdate(facts({ rolledBack, latest: "0.4.150" }))).toMatchObject({ action: "update", latest: "0.4.150" });
	});

	it("…which the controller records as a failure with that reason, and installs nothing", async () => {
		const h = controller({ autoUpdate: true });
		const c = new AutomaticUpdateController({
			policy: () => h.state,
			refreshPolicy: async () => true,
			facts: async () => facts({ rolledBack: { "0.4.149": "it did not register with the platform within 5 minutes of first starting" } }),
			plan: planRunnerUpdate,
			installAndRestart: h.install,
			status: (status, extra) => h.statuses.push({ status, extra }),
			setTimer: (fn, ms) => ({ fn, ms, unref() {} }) as unknown as ReturnType<typeof setTimeout>,
			random: () => 0,
		});
		await c.runNow();
		expect(h.install).not.toHaveBeenCalled();
		expect(h.statuses.at(-1)).toMatchObject({ status: "failure", extra: { reason: expect.stringMatching(/rolled back: it did not register/) } });
	});
});
