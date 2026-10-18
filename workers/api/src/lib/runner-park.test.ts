/**
 * #1160 — a machine away longer than the guard's poll PARKS its run, and the run continues when the
 * machine comes back.
 *
 * Measured incident: `coding run 3f9dfbc7 failed (runner_gone) at s22-snapshot after 3 steps: The
 * runner did not come back after waiting 10 minutes.` The guard is driven here with a fake clock and a
 * fake `waitForEvent`; the wake is driven over the real schema with only the Workflows binding faked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./d1-sqlite.js";
import { RUN_WAIT_REASONS } from "./agent-loop-store.js";
import { listIdleSessions } from "./coding-sweep-queries.js";
import { reconcileOrphanedSessions } from "./coding-store.js";
import { sweepStaleRuns } from "./run-sweeper.js";
import type { RuntimeFacts } from "./instance-connectivity.js";
import {
	isRunnerGone,
	makeRunnerGuard,
	NO_SOCKET_MARKER,
	RUNNER_PARK_CHECK_MS,
	RUNNER_PARK_MS,
	RUNNER_WAIT_MS,
	runnerBackEventType,
	RunnerUnreachableError,
	UNRESPONSIVE_MARKER,
	type RunnerParkDeps,
	type RunnerWaitDeps,
	type RunStep,
} from "./runner-availability.js";
import { STALE_DRIVER_MS } from "./coding-store.js";
import { wakeRunnerParkedRuns } from "./runner-park.js";
import type { Env } from "../types.js";

const HOUR = 60 * 60_000;
const T0 = Date.UTC(2026, 9, 17, 22, 37);
const OFFLINE: RuntimeFacts = { hasRuntimeRow: true, relayConnected: false, node: "Sergeys-Mac-mini.local", runnerVersion: null, lastSeenAt: "2026-10-17 22:37:00" };
const ONLINE: RuntimeFacts = { ...OFFLINE, relayConnected: true };

/**
 * A machine that goes away at T0 and comes back at `backAt` (never, when null), on a fake clock.
 * `step.sleep` and `waitForEvent` advance the clock; the re-registration event fires at `backAt` when
 * `registers` is true, otherwise the run only finds out by its own periodic look.
 */
function world(opts: { backAt: number | null; registers?: boolean }) {
	let clock = T0;
	const said: string[] = [];
	const parks: Array<{ op: string; until?: number; at: number }> = [];
	const ticks: number[] = [];
	const isBack = () => opts.backAt !== null && clock >= opts.backAt;
	const wait: RunnerWaitDeps = {
		probe: async () => (isBack() ? ONLINE : OFFLINE),
		sleep: async () => {
			clock += 15_000;
		},
		announce: async (m) => {
			said.push(m);
		},
		tick: async (ms) => {
			ticks.push(ms);
		},
	};
	const park: RunnerParkDeps = {
		now: async () => clock,
		begin: async (_label, until) => {
			parks.push({ op: "begin", until, at: clock });
		},
		waitForBack: async (_label, timeoutMs) => {
			const deadline = clock + timeoutMs;
			if (opts.registers !== false && opts.backAt !== null && opts.backAt > clock && opts.backAt <= deadline) {
				clock = opts.backAt;
				return true;
			}
			clock = deadline;
			return false;
		},
		end: async () => {
			parks.push({ op: "end", at: clock });
		},
	};
	return { wait, park, said, parks, ticks, now: () => clock };
}

const stepper = (): RunStep => (async (_name: string, fn: () => Promise<unknown>) => fn()) as RunStep;
const gone = () => new RunnerUnreachableError(`No runner connected — ${NO_SOCKET_MARKER} for this agent.`);

/** One step that fails while the machine is away and reads the pane once it is back. */
async function snapshotStep(w: ReturnType<typeof world>, reconnect = vi.fn(async () => undefined)) {
	const guard = makeRunnerGuard({ wait: w.wait, park: w.park, reconnect });
	let attempts = 0;
	return guard(stepper(), "s22-snapshot", async () => {
		if (attempts++ === 0) throw gone();
		return "pane";
	});
}

describe("a machine away past the poll parks the run instead of ending it (#1160)", () => {
	it("away three hours: parks with a published waiting_until, resumes at the same step when it re-registers", async () => {
		const w = world({ backAt: T0 + 3 * HOUR });
		const reconnect = vi.fn(async () => undefined);
		await expect(snapshotStep(w, reconnect)).resolves.toBe("pane");
		const begin = w.parks.find((p) => p.op === "begin");
		// The park starts once the ten-minute poll is spent, and announces an end hours away.
		expect(begin?.at).toBe(T0 + RUNNER_WAIT_MS);
		expect(begin?.until).toBe(T0 + RUNNER_WAIT_MS + RUNNER_PARK_MS);
		expect(w.parks.at(-1)?.op).toBe("end");
		const announced = w.said.find((m) => m.includes("parked, not stopped"));
		expect(announced).toContain("2026-10-18 22:47 UTC");
		expect(announced).toContain("24 hours");
		// Woken by the registration, not by its next look.
		expect(w.now()).toBe(T0 + 3 * HOUR);
		expect(w.said.at(-1)).toContain("Runner is back");
		expect(reconnect).toHaveBeenCalledTimes(1);
	});

	it("a lost wake event costs at most one look, not the run", async () => {
		const backAt = T0 + 3 * HOUR + 60_000;
		const w = world({ backAt, registers: false });
		await expect(snapshotStep(w)).resolves.toBe("pane");
		expect(w.now()).toBeGreaterThanOrEqual(backAt);
		expect(w.now() - backAt).toBeLessThanOrEqual(RUNNER_PARK_CHECK_MS);
	});

	it("keeps its claim on the session while parked: a heartbeat every look, inside the stale-driver window", async () => {
		const w = world({ backAt: T0 + 5 * HOUR, registers: false });
		await snapshotStep(w);
		expect(RUNNER_PARK_CHECK_MS).toBeLessThan(STALE_DRIVER_MS);
		const parkTicks = w.ticks.filter((t) => t >= RUNNER_PARK_CHECK_MS);
		for (let i = 1; i < parkTicks.length; i++) expect(parkTicks[i] - parkTicks[i - 1]).toBeLessThanOrEqual(RUNNER_PARK_CHECK_MS);
	});

	it("a machine that never returns stops past the stated bound, and says which bound", async () => {
		const w = world({ backAt: null });
		const err = await snapshotStep(w).then(
			() => null,
			(e) => e as Error,
		);
		expect(isRunnerGone(err)).toBe(true);
		expect(err?.message).toContain("waited 24 hours for its machine");
		expect(w.now()).toBe(T0 + RUNNER_WAIT_MS + RUNNER_PARK_MS);
		expect(w.parks.at(-1)?.op).toBe("end");
	});

	it("the day is per run: a second loss parks only for what is left of it", async () => {
		const opts: { backAt: number | null } = { backAt: T0 + 20 * HOUR };
		const w = world(opts);
		const guard = makeRunnerGuard({ wait: w.wait, park: w.park, reconnect: async () => undefined });
		let first = 0;
		await guard(stepper(), "a", async () => (first++ === 0 ? Promise.reject(gone()) : "ok"));
		const firstPark = w.now() - (T0 + RUNNER_WAIT_MS);
		// It goes away again, for good.
		opts.backAt = null;
		const away = w.now();
		const err = await guard(stepper(), "b", async () => Promise.reject(gone())).then(
			() => null,
			(e) => e as Error,
		);
		expect(isRunnerGone(err)).toBe(true);
		expect(w.now() - away).toBe(RUNNER_WAIT_MS + RUNNER_PARK_MS - firstPark);
	});

	it("a runner connected but not answering is NOT parked — no registration would ever wake it", async () => {
		const w = world({ backAt: null });
		const silent = new RunnerUnreachableError(`Runner relay is ${UNRESPONSIVE_MARKER} — ${NO_SOCKET_MARKER} for this agent.`);
		const guard = makeRunnerGuard({ wait: { ...w.wait, probe: async () => ONLINE }, park: w.park, reconnect: async () => undefined });
		await expect(guard(stepper(), "s0", async () => Promise.reject(silent))).rejects.toThrow(UNRESPONSIVE_MARKER);
		expect(w.parks).toEqual([]);
	});

	it("without park deps the old ending stands (a run with no loop-run row cannot be woken)", async () => {
		const w = world({ backAt: T0 + 3 * HOUR });
		const guard = makeRunnerGuard({ wait: w.wait, reconnect: async () => undefined });
		await expect(guard(stepper(), "s0", async () => Promise.reject(gone()))).rejects.toThrow("did not come back after waiting 10 minutes");
	});
});

describe("re-registration wakes the parked run, over the real schema (#1160)", () => {
	let d1: RealSchemaD1;
	let env: Env;
	let sent: Array<{ instance: string; type: string }>;

	beforeEach(() => {
		d1 = realSchemaD1();
		seedTenant(d1, { userId: "u1", instanceIds: ["i1", "i2"] });
		d1.exec(`INSERT INTO coding_repos (id, instance_id, user_id, name) VALUES ('r1', 'i1', 'u1', 'owner/repo')`);
		sent = [];
		const CODING_SESSION = { get: async (instance: string) => ({ sendEvent: async (e: { type: string }) => void sent.push({ instance, type: e.type }) }) };
		env = { DB: d1.DB, CODING_SESSION } as unknown as Env;
	});
	afterEach(() => d1.close());

	function run(id: string, instance: string, reason: string | null, opts: { status?: string; wf?: string | null; session?: string } = {}) {
		const now = Date.now();
		const wf = opts.wf === undefined ? `'wf-${id}'` : opts.wf === null ? "NULL" : `'${opts.wf}'`;
		d1.exec(`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, max_iterations, started_at, session_id, last_alive_at, waiting_reason, waiting_until, parked_since, workflow_instance_id)
		  VALUES ('${id}', 'u1', '${instance}', 'x', '${opts.status ?? "running"}', 10, ${now - 4 * HOUR}, ${opts.session ? `'${opts.session}'` : "NULL"}, ${now}, ${reason ? `'${reason}'` : "NULL"}, ${reason ? now + 20 * HOUR : "NULL"}, ${reason ? now - 3 * HOUR : "NULL"}, ${wf})`);
	}

	it("sends the run's own event to each run of THIS instance parked on its machine — and to nothing else", async () => {
		run("away", "i1", "runner_away");
		run("question", "i1", "decision");
		run("other-instance", "i2", "runner_away");
		run("finished", "i1", "runner_away", { status: "completed" });
		run("never-recorded", "i1", "runner_away", { wf: null });
		expect(await wakeRunnerParkedRuns(env, "i1", "u1")).toBe(1);
		expect(sent).toEqual([{ instance: "wf-away", type: runnerBackEventType("away") }]);
	});

	it("never fails the registration: a send that throws is a run that looks again on its own", async () => {
		run("away", "i1", "runner_away");
		const broken = { DB: d1.DB, CODING_SESSION: { get: async () => { throw new Error("no such instance"); } } } as unknown as Env;
		await expect(wakeRunnerParkedRuns(broken, "i1", "u1")).resolves.toBe(0);
	});

	it("a parked run keeps its session through the reconnect — the orphan reconcile and the idle reaper leave it", async () => {
		const longAgo = Date.now() - 3 * HOUR;
		d1.exec(`INSERT INTO coding_sessions (id, instance_id, repo_id, user_id, status, client_type, last_activity_at, updated_at) VALUES ('s1', 'i1', 'r1', 'u1', 'active', 'claude', ${longAgo}, datetime('now', '-3 hours'))`);
		run("away", "i1", "runner_away", { session: "s1" });
		// The machine is back after a reboot: its runner tracks no session at all.
		expect(await reconcileOrphanedSessions(env, "i1", "u1", [])).toEqual([]);
		expect((await listIdleSessions(env, Date.now(), 10)).map((s) => s.id)).not.toContain("s1");
	});

	it("the run sweeper keeps a park inside its published end", async () => {
		run("away", "i1", "runner_away");
		await sweepStaleRuns(env);
		expect((d1.sqlite.prepare("SELECT status FROM agent_loop_runs WHERE run_id = 'away'").get() as { status: string }).status).toBe("running");
	});

	it("runner_away is a park reason every reader knows", () => {
		expect(RUN_WAIT_REASONS).toContain("runner_away");
	});
});
