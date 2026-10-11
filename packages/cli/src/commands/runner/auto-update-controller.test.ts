import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AutomaticUpdateController, IDLE_RETRY_MS, OBSERVATION_TIMEOUT_MS } from "./auto-update-controller.js";
import { loadAutoUpdatePolicy, nextAutoUpdateDelayMs, saveAutoUpdatePolicy } from "./auto-update.js";
import { observedRunnerWork } from "./runner-work-observation.js";
import type { AutoUpdatePolicy, AutoUpdateStatus } from "./auto-update.js";
import { planRunnerUpdate, type UpdateFacts, type UpdatePlan } from "./self-update.js";

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
		// The refresh is bounded now (#1020): facts follow one await later.
		await vi.waitFor(() => expect(h.facts).toHaveBeenCalledTimes(1));
		// No install was attempted, so finding the runner current is `enabled`, never a verified cycle (#1020).
		await vi.waitFor(() => expect(h.statuses.at(-1)?.status).toBe("enabled"));
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
		// A reconnect after an ATTEMPTED install carries that attempt's persisted record and a healthy paired look (#1020).
		const h = harness({
			policy: { value: { autoUpdate: true, status: "restarting", latestVersion: "0.4.91" }, authoritative: true },
			facts: async () => ({ ...idleFacts(), current: "0.4.91", observations: [{ source: "sessions", success: true, sampledAt: 1 }, { source: "health", success: true, sampledAt: 1 }] }),
			plan: (f) => ({ action: "up-to-date", current: f.current }),
		});
		await h.controller.runNow();
		expect(h.install).not.toHaveBeenCalled();
		expect(h.statuses.at(-1)).toMatchObject({ status: "verified-success", extra: { latestVersion: "0.4.91" } });
		expect(h.controller.diagnostics()).toMatchObject({ blockerClass: null, decisionAt: h.clock.t, checkAt: h.clock.t });
	});
});

// ── #1020: a failed policy refresh keeps a retry, and only a fresh ON installs ───────────────────

/**
 * The relay's real `refreshAutomaticPolicy` contract: authority is cleared BEFORE the fetch and
 * restored only by a successful response. The earlier stub (`refresh: false`, authority left true)
 * could not reach the defect — production never leaves authority standing after a failed fetch.
 */
function productionRefresh() {
	const net = { up: false, serves: { autoUpdate: true } as AutoUpdatePolicy };
	let state: { value: AutoUpdatePolicy; authoritative: boolean } | undefined;
	const refresh = async () => {
		const s = state as { value: AutoUpdatePolicy; authoritative: boolean };
		s.authoritative = false;
		if (!net.up) return false;
		s.value = { ...s.value, ...net.serves };
		s.authoritative = true;
		return s.authoritative;
	};
	return { net, refresh, bind: (s: { value: AutoUpdatePolicy; authoritative: boolean }) => { state = s; } };
}
const refreshHarness = (overrides: Parameters<typeof harness>[0] = {}) => {
	const p = productionRefresh();
	const h = harness({ ...overrides, refresh: p.refresh });
	p.bind(h.state);
	return { ...h, net: p.net };
};
const backoff = (failures: number) => nextAutoUpdateDelayMs(failures, () => 0);

describe("AutomaticUpdateController — policy-refresh retry under the production authority contract (#1020)", () => {
	it("initial path: a failed refresh leaves authority unknown, no install, and exactly one retry timer", async () => {
		const h = refreshHarness();
		await h.controller.runNow();
		expect(h.state.authoritative).toBe(false);
		expect(h.statuses.at(-1)?.status).toBe("offline");
		expect(h.facts).not.toHaveBeenCalled();
		expect(h.install).not.toHaveBeenCalled();
		expect(h.timers.map((t) => t.ms)).toEqual([backoff(1)]);
		expect(h.controller.diagnostics().nextRetryDueAt).toBe(h.clock.t + backoff(1));
	});

	it("deferred path: a refresh failing in the idle-wait callback still leaves a retry timer", async () => {
		const h = refreshHarness({ facts: async () => ({ ...idleFacts(), busy: ["coding session s1 (thinking)"] }), plan: planOver });
		h.net.up = true;
		await h.controller.runNow();
		expect(h.statuses.at(-1)?.status).toBe("waiting-for-idle");
		h.net.up = false;
		await fire(h, IDLE_RETRY_MS);
		await vi.waitFor(() => expect(h.statuses.at(-1)?.status).toBe("offline"));
		expect(h.state.authoritative).toBe(false);
		expect(h.timers.map((t) => t.ms)).toEqual([backoff(1)]);
		expect(h.install).not.toHaveBeenCalled();
	});

	it("repeated failures back off boundedly, one timer at a time, never observing work or installing", async () => {
		const h = refreshHarness();
		await h.controller.runNow();
		for (let failures = 1; failures <= 9; failures++) {
			expect(h.timers.map((t) => t.ms)).toEqual([backoff(failures)]);
			expect(h.timers[0].ms).toBeLessThanOrEqual(backoff(99));
			h.clock.t += h.timers[0].ms;
			await fire(h, h.timers[0].ms);
			await vi.waitFor(() => expect(h.timers).toHaveLength(1));
		}
		expect(h.facts).not.toHaveBeenCalled();
		expect(h.install).not.toHaveBeenCalled();
	});

	it("heartbeat recovery: restored authority does not add a second timer, and the retry installs exactly once", async () => {
		const h = refreshHarness();
		await h.controller.runNow();
		// The relay's heartbeat: `policyScheduleAction(…, wasAuthoritative=false)` → "start".
		h.state.authoritative = true;
		h.controller.onPolicy("start");
		expect(h.timers).toHaveLength(1);
		h.net.up = true;
		await fire(h, backoff(1));
		await vi.waitFor(() => expect(h.statuses.at(-1)?.status).toBe("restarting"));
		expect(h.install).toHaveBeenCalledTimes(1);
		expect(h.install).toHaveBeenCalledWith(updatePlan, true);
	});

	it("network recovery without a heartbeat: the retry itself re-establishes authority, and busy work still waits", async () => {
		const h = refreshHarness({ facts: async () => ({ ...idleFacts(), busy: ["local run r1"] }), plan: planOver });
		await h.controller.runNow();
		h.net.up = true;
		await fire(h, backoff(1));
		await vi.waitFor(() => expect(h.statuses.at(-1)?.status).toBe("waiting-for-idle"));
		expect(h.state.authoritative).toBe(true);
		expect(h.install).not.toHaveBeenCalled();
		expect(h.timers.map((t) => t.ms)).toEqual([IDLE_RETRY_MS]);
		expect(h.controller.diagnostics()).toMatchObject({ blockerClass: "active_sessions", nextRetryDueAt: h.clock.t + IDLE_RETRY_MS });
	});

	it("OFF while a retry is pending: the cancel clears it; OFF served by the retry installs nothing and keeps no timer", async () => {
		const cancelled = refreshHarness();
		await cancelled.controller.runNow();
		cancelled.state.value = { ...cancelled.state.value, autoUpdate: false };
		cancelled.state.authoritative = true;
		cancelled.controller.onPolicy("cancel");
		expect(cancelled.timers).toHaveLength(0);
		expect(cancelled.controller.diagnostics().nextRetryDueAt).toBeNull();

		const served = refreshHarness();
		await served.controller.runNow();
		served.net.up = true;
		served.net.serves = { autoUpdate: false };
		const before = served.statuses.length;
		await fire(served, backoff(1));
		await vi.waitFor(() => expect(served.state.value.autoUpdate).toBe(false));
		expect(served.timers).toHaveLength(0);
		expect(served.facts).not.toHaveBeenCalled();
		expect(served.install).not.toHaveBeenCalled();
		expect(served.statuses.length).toBe(before);
	});

	it("authority lost mid-check (a concurrent refresh failed) decides nothing and keeps a retry", async () => {
		const h = refreshHarness({ facts: async () => { h.state.authoritative = false; return idleFacts(); } });
		h.net.up = true;
		await h.controller.runNow();
		expect(h.plan).not.toHaveBeenCalled();
		expect(h.install).not.toHaveBeenCalled();
		expect(h.statuses.at(-1)?.status).toBe("offline");
		expect(h.timers.map((t) => t.ms)).toEqual([backoff(1)]);
	});

	it("a start that lands while a decision is in flight is superseded by the idle wait — one timer", async () => {
		let release: (() => void) | undefined;
		const h = harness({
			facts: () => new Promise<UpdateFacts>((resolve) => { release = () => resolve({ ...idleFacts(), busy: ["x"] }); }),
			plan: planOver,
		});
		const run = h.controller.runNow();
		await vi.waitFor(() => expect(release).toBeTruthy());
		h.controller.onPolicy("start");
		expect(h.timers).toHaveLength(1);
		release?.();
		await run;
		expect(h.timers.map((t) => t.ms)).toEqual([IDLE_RETRY_MS]);
	});
});

type BlockerExpectation = "active_sessions" | "observation_failure";

// ── #1020: a verified cycle needs an attempted install, readable versions and a healthy look; every look is bounded ──

describe("AutomaticUpdateController — verified update cycle and bounded observation (#1020)", () => {
	const looked = (sessions = true, health = true) => [
		{ source: "sessions" as const, success: sessions, sampledAt: 1 },
		{ source: "health" as const, success: health, sampledAt: 1 },
	];
	const upToDate = (f: UpdateFacts): UpdatePlan => planRunnerUpdate(f);
	const attempted = (target: string): { value: AutoUpdatePolicy; authoritative: boolean } => ({ value: { autoUpdate: true, status: "restarting", latestVersion: target }, authoritative: true });
	const current = (version: string, latest = version, observations = looked()): (() => Promise<UpdateFacts>) => async () => ({ ...idleFacts(), current: version, latest, observations });

	it("verified-success requires an actual attempted install, not ordinary up-to-date", async () => {
		const h = harness({ facts: current("0.4.91"), plan: upToDate });
		await h.controller.runNow();
		expect(h.statuses.map((s) => s.status)).not.toContain("verified-success");
		expect(h.statuses.at(-1)?.status).toBe("enabled");
	});

	it("malformed current version does not produce verified-success — with or without an attempted install", async () => {
		for (const policy of [undefined, attempted("0.4.91")]) {
			const h = harness({ policy, facts: current("not-a-version", "0.4.91"), plan: upToDate });
			await h.controller.runNow();
			expect(h.statuses.at(-1)).toMatchObject({ status: "failure", extra: { reason: expect.stringContaining("could not be read") } });
		}
	});

	it("malformed latest version does not produce verified-success — !olderThan alone is not evidence", async () => {
		const h = harness({ policy: attempted("0.4.91"), facts: current("0.4.91", "not-a-version"), plan: upToDate });
		await h.controller.runNow();
		expect(h.statuses.at(-1)).toMatchObject({ status: "failure", extra: { reason: expect.stringContaining("could not be read") } });
	});

	it("attempted target mismatch does not produce verified-success", async () => {
		const h = harness({ policy: attempted("0.4.108"), facts: current("0.4.107"), plan: upToDate });
		await h.controller.runNow();
		expect(h.statuses.at(-1)).toMatchObject({ status: "failure", extra: { reason: expect.stringContaining("came back on 0.4.107, not the attempted 0.4.108") } });
	});

	it.each([
		["no health look at all", [], "no health look was taken"],
		["only the sessions half answered", looked(true, false), "answered only partly (sessions ok, health failed)"],
		["only the health half answered", looked(false, true), "answered only partly (sessions failed, health ok)"],
		["both halves malformed", looked(false, false), "answered only partly (sessions failed, health failed)"],
	])("health evidence: %s is not a healthy reattachment", async (_l, observations, reason) => {
		const h = harness({ policy: attempted("0.4.91"), facts: current("0.4.91", "0.4.91", observations as ReturnType<typeof looked>), plan: upToDate });
		await h.controller.runNow();
		expect(h.statuses.at(-1)).toMatchObject({ status: "failure", extra: { reason: expect.stringContaining(reason) } });
	});

	it("the attempted install survives an ACTUAL restart: the record persisted by one controller verifies in the next", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pags-auto-update-cache-"));
		const env = { PAGS_AUTO_UPDATE_POLICY_FILE: join(dir, "auto-update.json") } as NodeJS.ProcessEnv;
		const key = "default:machine-1";
		try {
			// Process A: an idle install of 0.4.91 — its status writer is the relay's (merge + persist).
			let record: AutoUpdatePolicy = { autoUpdate: true };
			const writer = (status: AutoUpdateStatus, extra: Partial<AutoUpdatePolicy> = {}) => {
				record = { ...record, ...extra, status };
				saveAutoUpdatePolicy(key, record, env);
			};
			const a = new AutomaticUpdateController({ policy: () => ({ value: record, authoritative: true }), refreshPolicy: async () => true, facts: current("0.4.90", "0.4.91"), plan: planRunnerUpdate, installAndRestart: async () => true, status: writer, setTimer: () => ({ unref() {} }) as unknown as ReturnType<typeof setTimeout>, random: () => 0 });
			await a.runNow();
			expect(loadAutoUpdatePolicy(key, env)).toMatchObject({ status: "restarting", latestVersion: "0.4.91" });
			// Process B: a NEW controller, its policy read back from the file, on the version A installed.
			const restarted = harness({ policy: { value: loadAutoUpdatePolicy(key, env) as AutoUpdatePolicy, authoritative: true }, facts: current("0.4.91"), plan: upToDate });
			await restarted.controller.runNow();
			expect(restarted.statuses.at(-1)?.status).toBe("verified-success");
			// …while a machine with no persisted attempt, on the same version, is only current.
			const fresh = harness({ policy: { value: loadAutoUpdatePolicy("default:other", env) ?? { autoUpdate: true }, authoritative: true }, facts: current("0.4.91"), plan: upToDate });
			await fresh.controller.runNow();
			expect(fresh.statuses.at(-1)?.status).toBe("enabled");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	/** A harness whose bound timer is controlled: `expire()` fires the pending bound. */
	function bounded(overrides: Parameters<typeof harness>[0] = {}) {
		const bounds: Array<{ fn: () => void; ms: number }> = [];
		const h = harness(overrides);
		const controller = new AutomaticUpdateController({
			policy: () => h.state,
			refreshPolicy: h.refresh,
			facts: h.facts,
			plan: h.plan,
			installAndRestart: h.install,
			status: (status, extra) => h.statuses.push({ status, extra }),
			setTimer: (fn, ms) => {
				const timer = { fn, ms, unref() {} };
				h.timers.push(timer);
				return timer as unknown as ReturnType<typeof setTimeout>;
			},
			clearTimer: (timer) => {
				const i = h.timers.indexOf(timer as unknown as (typeof h.timers)[number]);
				if (i >= 0) h.timers.splice(i, 1);
				const j = bounds.indexOf(timer as unknown as (typeof bounds)[number]);
				if (j >= 0) bounds.splice(j, 1);
			},
			boundTimer: (fn, ms) => {
				const timer = { fn, ms, unref() {} };
				bounds.push(timer);
				return timer as unknown as ReturnType<typeof setTimeout>;
			},
			random: () => 0,
			now: () => h.clock.t,
		});
		const expire = async () => {
			const b = bounds.shift();
			expect(b?.ms).toBe(OBSERVATION_TIMEOUT_MS);
			h.clock.t += OBSERVATION_TIMEOUT_MS;
			b?.fn();
			await new Promise((r) => setTimeout(r, 0));
		};
		/** The facts look has started and its bound is the only one pending (the refresh's was cleared when it answered). */
		const factsPending = () => vi.waitFor(() => {
			expect(h.facts.mock.calls.length).toBeGreaterThan(0);
			expect(bounds).toHaveLength(1);
		});
		return { ...h, controller, bounds, expire, factsPending };
	}

	it("facts() timeout produces failure status and schedules retry — a failed CHECK, not a decision, and the look is aborted", async () => {
		let seen: AbortSignal | undefined;
		const h = bounded({ facts: (signal?: AbortSignal) => { seen = signal; return new Promise<UpdateFacts>(() => undefined); } });
		const run = h.controller.runNow();
		await h.factsPending();
		await h.expire();
		await run;
		expect(seen?.aborted).toBe(true);
		expect(h.statuses.at(-1)).toMatchObject({ status: "failure", extra: { reason: expect.stringContaining("did not answer within 30s") } });
		expect(h.controller.diagnostics()).toMatchObject({ checkAt: h.clock.t, decisionAt: null });
		expect(h.timers.map((t) => t.ms)).toEqual([backoff(1)]);
		expect(h.install).not.toHaveBeenCalled();
	});

	it("late facts() completion after timeout does not overwrite newer result", async () => {
		let lateResolve: ((f: UpdateFacts) => void) | undefined;
		let calls = 0;
		const h = bounded({
			facts: () => (++calls === 1 ? new Promise<UpdateFacts>((r) => { lateResolve = r; }) : current("0.4.91")()),
			plan: (f) => (f.current === "0.4.90" ? updatePlan : upToDate(f)),
		});
		const first = h.controller.runNow();
		await h.factsPending();
		await h.expire();
		await first;
		await h.controller.runNow(); // the newer check: current, nothing to install
		expect(h.statuses.at(-1)?.status).toBe("enabled");
		const newer = h.controller.diagnostics();
		lateResolve?.({ ...idleFacts(), current: "0.4.90", latest: "0.4.91", observations: looked() }); // would plan an install
		await new Promise((r) => setTimeout(r, 0));
		expect(h.install).not.toHaveBeenCalled();
		expect(h.statuses.at(-1)?.status).toBe("enabled");
		expect(h.controller.diagnostics()).toEqual(newer);
	});

	it("facts() timeout retry eventually succeeds when facts resolve in time", async () => {
		let calls = 0;
		const h = bounded({ policy: attempted("0.4.91"), facts: () => (++calls === 1 ? new Promise<UpdateFacts>(() => undefined) : current("0.4.91")()), plan: upToDate });
		const first = h.controller.runNow();
		await h.factsPending();
		await h.expire();
		await first;
		expect(h.statuses.at(-1)?.status).toBe("failure");
		h.timers.shift()?.fn(); // the backed-off retry
		await vi.waitFor(() => expect(h.statuses.at(-1)?.status).toBe("verified-success"));
		expect(calls).toBe(2);
	});

	it("a policy refresh that never answers is bounded too: aborted, offline, no facts or install, one retry", async () => {
		let seen: AbortSignal | undefined;
		const h = bounded({ refresh: (signal?: AbortSignal) => { seen = signal; return new Promise<boolean>(() => undefined); } });
		const run = h.controller.runNow();
		await vi.waitFor(() => expect(h.bounds).toHaveLength(1));
		await h.expire();
		await run;
		expect(seen?.aborted).toBe(true);
		expect(h.statuses.at(-1)?.status).toBe("offline");
		expect(h.facts).not.toHaveBeenCalled();
		expect(h.install).not.toHaveBeenCalled();
		expect(h.timers.map((t) => t.ms)).toEqual([backoff(1)]);
	});

	it("a bounded look that later REJECTS leaves no unhandled rejection behind", async () => {
		let reject: ((e: Error) => void) | undefined;
		const h = bounded({ facts: () => new Promise<UpdateFacts>((_r, j) => { reject = j; }) });
		const run = h.controller.runNow();
		await h.factsPending();
		await h.expire();
		await run;
		const unhandled = vi.fn();
		process.on("unhandledRejection", unhandled);
		reject?.(new Error("aborted"));
		await new Promise((r) => setTimeout(r, 10));
		process.off("unhandledRejection", unhandled);
		expect(unhandled).not.toHaveBeenCalled();
	});
});
