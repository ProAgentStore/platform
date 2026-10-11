import { describe, expect, it, vi } from "vitest";
import { AutomaticUpdateController, IDLE_RETRY_MS } from "./auto-update-controller.js";
import { observedRunnerWork } from "./runner-work-observation.js";
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
	const clock = { t: 1_000_000 };
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
		now: () => clock.t,
	});
	return { controller, timers, statuses, state, refresh, facts, plan, install, clock };
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

// ── #1020: the controller stays alive, and says what it last did ─────────────────────────────

/** The production wait rule over the production work reader — what `planRunnerUpdate` does with busy work. */
const planOver = (facts: UpdateFacts): UpdatePlan => (facts.busy.length ? { action: "wait", current: facts.current, latest: "0.4.91", waitingFor: facts.busy } : updatePlan);
const observedFacts = (sessions: unknown, work: unknown = { codingTurns: 0, localRuns: 0, detail: [] }): UpdateFacts => ({
	...idleFacts(),
	busy: observedRunnerWork({ sessions, work: work as never }),
	observations: [
		{ source: "sessions", success: Array.isArray(sessions), sampledAt: 1_000_000 },
		{ source: "health", success: !!work, sampledAt: 1_000_000 },
	],
});
const fire = async (h: ReturnType<typeof harness>, ms: number) => {
	const t = h.timers.find((timer) => timer.ms === ms);
	expect(t, `a ${ms}ms timer is armed`).toBeTruthy();
	h.timers.splice(h.timers.indexOf(t as QueuedTimer), 1);
	t?.fn();
};

describe("AutomaticUpdateController — liveness and diagnostics (#1020)", () => {
	it("a deferred re-decision whose final admission refuses arms a NEW retry, and that retry installs once idle", async () => {
		let admit = false;
		let busy = true;
		const h = harness({
			facts: async () => ({ ...idleFacts(), busy: busy ? ["coding session s1 (thinking)"] : [] }),
			plan: planOver,
			install: async () => admit,
		});
		await h.controller.runNow();
		expect(h.statuses.at(-1)?.status).toBe("waiting-for-idle");
		// Busy → idle: the deferred callback plans an update, but final admission refuses it.
		busy = false;
		await fire(h, IDLE_RETRY_MS);
		await vi.waitFor(() => expect(h.install).toHaveBeenCalledTimes(1));
		// The fix: a refused deferred install is retried; before #1020 no timer remained here.
		await vi.waitFor(() => expect(h.timers.filter((t) => t.ms === IDLE_RETRY_MS)).toHaveLength(1));
		expect(h.controller.diagnostics()).toMatchObject({ blockerClass: "idle_wait", nextRetryDueAt: h.clock.t + IDLE_RETRY_MS });
		admit = true;
		await fire(h, IDLE_RETRY_MS);
		await vi.waitFor(() => expect(h.statuses.at(-1)?.status).toBe("restarting"));
		expect(h.install).toHaveBeenCalledTimes(2);
	});

	it("repeated busy observations keep exactly one bounded retry armed, advancing the due time each round", async () => {
		const h = harness({ facts: async () => ({ ...idleFacts(), busy: ["coding session s1 (responding)"] }), plan: planOver });
		await h.controller.runNow();
		for (let round = 1; round <= 4; round++) {
			h.clock.t += IDLE_RETRY_MS;
			await fire(h, IDLE_RETRY_MS);
			await vi.waitFor(() => expect(h.facts).toHaveBeenCalledTimes(round + 1));
			await vi.waitFor(() => expect(h.timers.filter((t) => t.ms === IDLE_RETRY_MS)).toHaveLength(1));
			expect(h.controller.diagnostics()).toMatchObject({ blockerClass: "active_sessions", decisionAt: h.clock.t, nextRetryDueAt: h.clock.t + IDLE_RETRY_MS });
		}
		expect(h.install).not.toHaveBeenCalled();
	});

	it("classifies retained sessions: alive+idle and dead do not block; unknown/malformed state does; a malformed list is an observation failure", async () => {
		const cases: Array<[unknown, "install" | BlockerExpectation]> = [
			[[{ sessionId: "s1", alive: true, runState: "idle" }], "install"],
			[[{ sessionId: "s1", alive: false, runState: "responding" }], "install"],
			[[{ sessionId: "s1", alive: true, runState: "mystery" }], "active_sessions"],
			[[{ sessionId: "s1" }], "active_sessions"],
			[[{ alive: true, runState: "thinking" }], "active_sessions"],
			[{ not: "a list" }, "observation_failure"],
		];
		for (const [sessions, expected] of cases) {
			const h = harness({ facts: async () => observedFacts(sessions), plan: planOver });
			await h.controller.runNow();
			if (expected === "install") {
				expect(h.install, JSON.stringify(sessions)).toHaveBeenCalledTimes(1);
				expect(h.controller.diagnostics().blockerClass).toBeNull();
			} else {
				expect(h.install, JSON.stringify(sessions)).not.toHaveBeenCalled();
				expect(h.controller.diagnostics().blockerClass, JSON.stringify(sessions)).toBe(expected);
			}
		}
	});

	it("both observations failing is fail-closed: no install, observation_failure, the failed looks recorded with their time", async () => {
		const h = harness({
			facts: async () => ({
				...idleFacts(),
				busy: ["runner-work-observation-unavailable"],
				observations: [
					{ source: "sessions", success: false, sampledAt: 999_000 },
					{ source: "health", success: false, sampledAt: 999_000 },
				],
			}),
			plan: planOver,
		});
		await h.controller.runNow();
		expect(h.install).not.toHaveBeenCalled();
		const d = h.controller.diagnostics();
		expect(d.blockerClass).toBe("observation_failure");
		expect(d.observations).toEqual([
			{ source: "sessions", success: false, sampledAt: 999_000 },
			{ source: "health", success: false, sampledAt: 999_000 },
		]);
		expect(d.checkAt).toBe(h.clock.t);
	});

	it("keeps only the last five observations", async () => {
		let n = 0;
		const h = harness({ facts: async () => ({ ...idleFacts(), busy: ["x"], observations: [{ source: "health", success: true, sampledAt: ++n }] }), plan: planOver });
		await h.controller.runNow();
		for (let i = 0; i < 6; i++) await fire(h, IDLE_RETRY_MS).then(() => vi.waitFor(() => expect(h.timers.some((t) => t.ms === IDLE_RETRY_MS)).toBe(true)));
		expect(h.controller.diagnostics().observations.map((o) => o.sampledAt)).toEqual([3, 4, 5, 6, 7]);
	});

	it("a policy that cannot be refreshed keeps a backed-off timer instead of going silent", async () => {
		const h = harness({ refresh: async () => false });
		await h.controller.runNow();
		expect(h.statuses.at(-1)?.status).toBe("offline");
		expect(h.install).not.toHaveBeenCalled();
		expect(h.timers).toHaveLength(1);
		expect(h.controller.diagnostics().nextRetryDueAt).toBe(h.clock.t + h.timers[0].ms);
	});

	it("a disabled policy is not kept alive", async () => {
		const h = harness({ refresh: async () => true });
		h.state.value.autoUpdate = false;
		h.controller.onPolicy("start");
		expect(h.timers).toHaveLength(0);
		expect(h.controller.diagnostics().nextRetryDueAt).toBeNull();
	});

	it("timer liveness: the scheduled timer is armed, fires, and re-decides — and a cancel clears the due time", async () => {
		const h = harness({ plan: () => ({ action: "up-to-date", current: "0.4.91" }) });
		h.controller.onPolicy("start");
		expect(h.controller.diagnostics()).toMatchObject({ nextRetryDueAt: h.clock.t + 5_000, decisionAt: null });
		h.clock.t += 5_000;
		await fire(h, 5_000);
		await vi.waitFor(() => expect(h.controller.diagnostics().decisionAt).toBe(h.clock.t));
		expect(h.timers).toHaveLength(1);
		h.controller.onPolicy("cancel");
		expect(h.controller.diagnostics().nextRetryDueAt).toBeNull();
	});

	it("a versioned reconnect on the latest release reports verified-success with no blocker", async () => {
		const h = harness({ facts: async () => ({ ...idleFacts(), current: "0.4.91" }), plan: (f) => ({ action: "up-to-date", current: f.current }) });
		await h.controller.runNow();
		expect(h.install).not.toHaveBeenCalled();
		expect(h.statuses.at(-1)).toMatchObject({ status: "verified-success", extra: { latestVersion: "0.4.91" } });
		expect(h.controller.diagnostics()).toMatchObject({ blockerClass: null, decisionAt: h.clock.t, checkAt: h.clock.t });
	});
});

type BlockerExpectation = "active_sessions" | "observation_failure";
