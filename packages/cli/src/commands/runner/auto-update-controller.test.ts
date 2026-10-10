import { describe, expect, it, vi } from "vitest";
import { AutomaticUpdateController } from "./auto-update-controller.js";
import type { AutoUpdatePolicy, AutoUpdateStatus } from "./auto-update.js";
import type { UpdateFacts, UpdatePlan } from "./self-update.js";

type QueuedTimer = { fn: () => void; ms: number; unref(): void };
const idleFacts = (): UpdateFacts => ({ current: "0.4.90", latest: "0.4.91", fromSource: false, restarter: "pags-up", busy: [] });
const updatePlan: Extract<UpdatePlan, { action: "update" }> = { action: "update", current: "0.4.90", latest: "0.4.91", restarter: "pags-up" };

function harness(overrides: Partial<{
	policy: { value: AutoUpdatePolicy; authoritative: boolean };
	refresh: () => Promise<boolean>;
	facts: () => Promise<UpdateFacts>;
	plan: (facts: UpdateFacts) => UpdatePlan;
	install: (plan: typeof updatePlan, automatic: boolean) => Promise<boolean>;
}> = {}) {
	const timers: QueuedTimer[] = [];
	const statuses: Array<{ status: AutoUpdateStatus; extra?: Partial<AutoUpdatePolicy> }> = [];
	const state = overrides.policy ?? { value: { autoUpdate: true }, authoritative: true };
	const refresh = vi.fn(overrides.refresh ?? (async () => true));
	const facts = vi.fn(overrides.facts ?? (async () => idleFacts()));
	const plan = vi.fn(overrides.plan ?? (() => updatePlan));
	const install = vi.fn(overrides.install ?? (async () => true));
	const controller = new AutomaticUpdateController({
		policy: () => state,
		refreshPolicy: refresh,
		facts,
		plan,
		installAndRestart: install,
		status: (status, extra) => statuses.push({ status, extra }),
		setTimer: (fn, ms) => {
			const timer: QueuedTimer = { fn, ms, unref() {} };
			timers.push(timer);
			return timer as unknown as ReturnType<typeof setTimeout>;
		},
		clearTimer: (timer) => {
			const i = timers.indexOf(timer as unknown as QueuedTimer);
			if (i >= 0) timers.splice(i, 1);
		},
		random: () => 0,
	});
	return { controller, timers, statuses, state, refresh, facts, plan, install };
}

describe("AutomaticUpdateController — relay-wired unattended update orchestration", () => {
	it("fires a due scheduled check despite repeated enabled heartbeat policy reads", async () => {
		const h = harness({ plan: () => ({ action: "up-to-date", current: "0.4.90" }) });
		h.controller.onPolicy("start");
		for (let heartbeat = 0; heartbeat < 720; heartbeat++) h.controller.onPolicy("keep");
		expect(h.timers).toHaveLength(1);
		expect(h.timers[0].ms).toBe(5_000);
		h.timers.shift()?.fn();
		await vi.waitFor(() => expect(h.refresh).toHaveBeenCalledTimes(1));
		expect(h.facts).toHaveBeenCalledTimes(1);
		await vi.waitFor(() => expect(h.statuses.at(-1)?.status).toBe("verified-success"));
	});

	it("never installs from cached policy when authoritative refresh is offline or disabled", async () => {
		const offline = harness({ refresh: async () => false });
		await offline.controller.runNow();
		expect(offline.install).not.toHaveBeenCalled();
		expect(offline.statuses.at(-1)?.status).toBe("offline");

		const disabled = harness();
		disabled.state.value.autoUpdate = false;
		await disabled.controller.runNow();
		expect(disabled.refresh).not.toHaveBeenCalled();
		expect(disabled.install).not.toHaveBeenCalled();
	});

	it("defers coding/local work and retries through the same scheduled controller", async () => {
		let busy = true;
		const h = harness({
			facts: async () => ({ ...idleFacts(), busy: busy ? ["coding-turn-1", "local-run-1"] : [] }),
			plan: (facts) => facts.busy.length ? { action: "wait", current: facts.current, latest: "0.4.91", waitingFor: facts.busy } : updatePlan,
		});
		await h.controller.runNow();
		expect(h.install).not.toHaveBeenCalled();
		expect(h.statuses.at(-1)?.status).toBe("waiting-for-idle");
		const retry = h.timers.find((timer) => timer.ms === 15_000);
		expect(retry).toBeTruthy();
		busy = false;
		retry?.fn();
		await vi.waitFor(() => expect(h.install).toHaveBeenCalledWith(updatePlan, true));
		expect(h.statuses.at(-1)?.status).toBe("restarting");
	});

	it("does not restart when a coding/local run begins during npm; the relay bridge declines final admission", async () => {
		let workStarted = false;
		const h = harness({
			install: async () => {
				// This is the injected production bridge's post-npm observation: the turn began while
				// npm was running, so it refuses restart and the controller stays in waiting state.
				workStarted = true;
				return false;
			},
		});
		await h.controller.runNow();
		expect(workStarted).toBe(true);
		expect(h.install).toHaveBeenCalledWith(updatePlan, true);
		expect(h.statuses.at(-1)?.status).toBe("waiting-for-idle");
	});

	it("defers on failed workload probes and backs off without invoking npm", async () => {
		const h = harness({ facts: async () => { throw new Error("/health unavailable"); } });
		await h.controller.runNow();
		expect(h.install).not.toHaveBeenCalled();
		expect(h.statuses.at(-1)).toMatchObject({ status: "failure", extra: { reason: "/health unavailable" } });
		expect(h.timers.some((timer) => timer.ms >= 51_000)).toBe(true);
	});

	it("deduplicates an explicit update racing the unattended check", async () => {
		let resolveInstall: ((value: boolean) => void) | undefined;
		const h = harness({ install: async () => new Promise<boolean>((resolve) => { resolveInstall = resolve; }) });
		const automatic = h.controller.runNow();
		await vi.waitFor(() => expect(h.install).toHaveBeenCalledTimes(1));
		const manual = h.controller.installManually(updatePlan);
		expect(await manual).toBe(false);
		resolveInstall?.(true);
		await automatic;
		expect(h.install).toHaveBeenCalledTimes(1);
	});

	it("persists running then restarting status around a successful idle install", async () => {
		const h = harness();
		await h.controller.runNow();
		expect(h.install).toHaveBeenCalledWith(updatePlan, true);
		expect(h.statuses.map(({ status }) => status)).toEqual(["running", "restarting"]);
	});
});
