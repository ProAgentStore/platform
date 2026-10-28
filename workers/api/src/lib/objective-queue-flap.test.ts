/**
 * #1388 — three dependent objectives (#507 → #508 → #509) queued on one repo, and a runner that flaps.
 *
 * What happened: the runner's socket was up but it missed the relay's 1.5 s pong, so a start met UNRESPONSIVE. The driver gave that refusal no
 * reason, the queue drain failed the entry, and the next entry — which depended on it — started ahead of it. The owner stopped #508 and re-queued by hand.
 *
 * Here the REAL queue (real schema, real SQL, the real drain and its retry tick) meets a driver whose start answers `runner_unresponsive` while a
 * clock says the runner is still flapping. Only the driver is faked; how it classifies a missed pong is `loop-drivers.test.ts`'s to prove.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./d1-sqlite.js";
import type { Env } from "../types.js";

const start = vi.fn();
vi.mock("./loop-drivers.js", async (orig) => ({
	loopDriverFor: () => ({ id: "coding", label: "the engine", start: (...a: unknown[]) => start(...a) }),
	// The REAL predicate: which refusals are waited for is the decision under test, and a mock that answered it would assert the mock.
	startRefusalIsWaitable: (await orig<typeof import("./loop-drivers.js")>()).startRefusalIsWaitable,
}));
vi.mock("./agent-capabilities.js", () => ({ capabilitiesForInstance: async () => ({ workflow: "CODING_SESSION" }) }));
vi.mock("./delegation-budget-store.js", () => ({
	openBudget: async () => ({ id: "b1" }),
	resolveAccountCeilings: async () => ({ loopMaxIterations: 50 }),
}));

const { clearUnresponsiveBackoff, enqueueObjective, backingOffAhead } = await import("./objective-queue.js");
const { drainPendingQueues, runDueOverloadRetries, tryDequeueAndStart } = await import("./objective-queue-start.js");

const T0 = 1_800_000_000_000;
const MIN = 60_000;
const MISSED_PONG =
	"Runner relay is connected but not responding — its socket is up, but the runner did not answer the relay's ping in time. A busy or reconnecting machine usually recovers on its own. [runner-unreachable:UNRESPONSIVE@/coding/start]";

let d1: RealSchemaD1;
let env: Env;
/** The objectives the driver was asked to start, in order — including the attempts it refused. */
let asked: string[];
/** The runner answers pings again from this instant; before it, every start meets UNRESPONSIVE. */
let flapUntil: number;

const at = (ms: number) => vi.setSystemTime(T0 + ms);
const rows = () =>
	d1.sqlite
		.prepare("SELECT objective, status, defer_reason AS reason, deferral_count AS n, next_retry_at AS retry, stop_reason AS note, run_id AS runId FROM instance_objective_queue ORDER BY created_at, id")
		.all() as Array<{ objective: string; status: string; reason: string | null; n: number; retry: number | null; note: string | null; runId: string | null }>;
const byName = (name: string) => rows().find((r) => r.objective === name);

async function enqueueThree(repoId = "r1") {
	for (const [i, name] of ["#507", "#508", "#509"].entries()) {
		at(i * 1000);
		await enqueueObjective(env, { instanceId: "i1", repoId, userId: "u1", objective: name });
	}
}

beforeEach(() => {
	vi.useFakeTimers({ now: T0, toFake: ["Date"] });
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["i1"] });
	for (const id of ["r1", "r2"]) d1.exec(`INSERT INTO coding_repos (id, instance_id, user_id, name, workdir, clone_status) VALUES ('${id}', 'i1', 'u1', '${id}', '/w/${id}', 'ready')`);
	env = { DB: d1.DB } as unknown as Env;
	asked = [];
	flapUntil = T0 + 2 * MIN;
	start.mockReset();
	start.mockImplementation(async (input: { objective: string }) => {
		asked.push(input.objective);
		if (Date.now() < flapUntil) return { ok: false, status: 409, reason: "runner_unresponsive", error: `r1 could not start: ${MISSED_PONG}` };
		return { ok: true, runId: `run-${input.objective}`, driver: "coding" };
	});
});
afterEach(() => {
	d1.close();
	vi.useRealTimers();
});

describe("three queued objectives survive a two-minute runner flap, and run in order (#1388)", () => {
	it("the entry that meets UNRESPONSIVE is deferred on a timed backoff — not failed — and keeps its place", async () => {
		await enqueueThree();
		at(5_000);
		const first = await tryDequeueAndStart(env, "i1", "r1", "u1");
		expect(first).toMatchObject({ drained: true, started: false, requeued: true });
		expect(byName("#507")).toMatchObject({ status: "pending", reason: "runner_unresponsive", n: 1, retry: T0 + 5_000 + MIN });
		expect(byName("#507")?.note).toContain("[runner-unreachable:UNRESPONSIVE@/coding/start]");
		// The two behind it were never touched.
		expect(byName("#508")).toMatchObject({ status: "pending", reason: null, n: 0, retry: null });
		expect(byName("#509")).toMatchObject({ status: "pending", reason: null, n: 0, retry: null });
	});

	it("a later entry NEVER starts ahead of the earlier one that is backing off, however often the queue is drained meanwhile", async () => {
		await enqueueThree();
		at(5_000);
		await tryDequeueAndStart(env, "i1", "r1", "u1");
		expect(asked).toEqual(["#507"]);
		// A run ending elsewhere, a resume, a relay event: all drain the queue. None of them may reach #508.
		for (const ms of [10_000, 20_000, 40_000, 60_000]) {
			at(ms);
			expect(await drainPendingQueues(env, "i1", "u1")).toEqual([{ drained: false }]);
		}
		expect(asked).toEqual(["#507"]); // the driver was never asked for #508 or #509
		expect(rows().map((r) => r.status)).toEqual(["pending", "pending", "pending"]);
	});

	it("rides out the flap on the retry tick and then runs #507, #508, #509 in that order, none failed", async () => {
		await enqueueThree();
		at(5_000);
		await tryDequeueAndStart(env, "i1", "r1", "u1"); // refused: flapping
		// Not yet due: the tick does nothing.
		at(30_000);
		expect(await runDueOverloadRetries(env, Date.now())).toBe(0);
		// Due at +65 s — the runner is still flapping (until +120 s), so it backs off again, longer.
		at(65_000);
		expect(await runDueOverloadRetries(env, Date.now())).toBe(1);
		expect(byName("#507")).toMatchObject({ status: "pending", reason: "runner_unresponsive", n: 2, retry: T0 + 65_000 + 2 * MIN });
		// The flap is over by the next attempt: #507 starts.
		at(65_000 + 2 * MIN);
		expect(await runDueOverloadRetries(env, Date.now())).toBe(1);
		expect(byName("#507")).toMatchObject({ status: "started", runId: "run-#507" });
		// #507's run ends and drains the next, then #508's run ends and drains the next.
		const second = await tryDequeueAndStart(env, "i1", "r1", "u1");
		expect(second).toMatchObject({ drained: true, started: true, runId: "run-#508" });
		const third = await tryDequeueAndStart(env, "i1", "r1", "u1");
		expect(third).toMatchObject({ drained: true, started: true, runId: "run-#509" });
		// The driver saw the dependent objectives in dependency order, and no entry was failed.
		expect(asked).toEqual(["#507", "#507", "#507", "#508", "#509"]);
		expect(rows().map((r) => `${r.objective}:${r.status}`)).toEqual(["#507:started", "#508:started", "#509:started"]);
	});

	it("the runner reconnecting ends the wait early: the entry is eligible the moment the machine answers", async () => {
		await enqueueThree();
		at(5_000);
		await tryDequeueAndStart(env, "i1", "r1", "u1");
		flapUntil = 0; // the runner is back
		at(20_000); // …well before the 60 s backoff is up
		expect(await drainPendingQueues(env, "i1", "u1")).toEqual([{ drained: false }]); // the clock still holds it
		expect(await clearUnresponsiveBackoff(env, "i1", "u1")).toBe(1); // what a relay connect does
		const out = await drainPendingQueues(env, "i1", "u1");
		expect(out).toMatchObject([{ drained: true, started: true, runId: "run-#507" }]);
	});

	it("a runner_overloaded entry is NOT woken by a reconnect: a reconnect says nothing about CPU", async () => {
		await enqueueObjective(env, { instanceId: "i1", repoId: "r1", userId: "u1", objective: "#600", deferral: { reason: "runner_overloaded", note: "overloaded" } });
		expect(await clearUnresponsiveBackoff(env, "i1", "u1")).toBe(0);
		expect(byName("#600")?.retry).not.toBeNull();
	});

	it("the hold is per repo: an entry for ANOTHER repo is not held behind #507", async () => {
		await enqueueThree("r1");
		at(4_000);
		await enqueueObjective(env, { instanceId: "i1", repoId: "r2", userId: "u1", objective: "#900" });
		flapUntil = 0;
		at(5_000);
		start.mockImplementationOnce(async (input: { objective: string }) => {
			asked.push(input.objective);
			return { ok: false, status: 409, reason: "runner_unresponsive", error: MISSED_PONG };
		});
		await tryDequeueAndStart(env, "i1", "r1", "u1"); // #507 backs off
		at(6_000);
		const other = await tryDequeueAndStart(env, "i1", "r2", "u1");
		expect(other).toMatchObject({ drained: true, started: true, runId: "run-#900" });
		expect(byName("#507")?.status).toBe("pending");
	});
});

describe("structural refusals still fail at once (#1388)", () => {
	it("an unusable checkout is not waited for: the entry fails with the driver's sentence, and #508 is next in line", async () => {
		await enqueueThree();
		start.mockReset();
		start.mockResolvedValueOnce({ ok: false, status: 409, error: "r1's checkout is not a git repository." });
		at(5_000);
		const out = await tryDequeueAndStart(env, "i1", "r1", "u1");
		expect(out).toMatchObject({ drained: true, started: false, requeued: false });
		expect(byName("#507")).toMatchObject({ status: "failed", note: "r1's checkout is not a git repository.", retry: null });
		// A failed entry holds no line: the queue moves on to the next one.
		start.mockResolvedValueOnce({ ok: true, runId: "run-#508", driver: "coding" });
		at(6_000);
		expect(await tryDequeueAndStart(env, "i1", "r1", "u1")).toMatchObject({ started: true, runId: "run-#508" });
	});
});

describe("a start that arrives while an earlier entry is backing off queues behind it (#1388)", () => {
	it("backingOffAhead names the entry on a timed backoff, and nothing once the clock has run out or for another repo", async () => {
		await enqueueThree();
		at(5_000);
		await tryDequeueAndStart(env, "i1", "r1", "u1");
		expect(await backingOffAhead(env, "i1", "r1", Date.now())).toMatchObject({ deferReason: "runner_unresponsive", nextRetryAt: T0 + 5_000 + MIN });
		expect(await backingOffAhead(env, "i1", "r2", Date.now())).toBeNull(); // #507 is r1's
		at(5_000 + MIN + 1);
		expect(await backingOffAhead(env, "i1", "r1", Date.now())).toBeNull(); // due: it is eligible, nothing is "ahead and waiting"
	});

	it("an entry queued by the route because the machine was overloaded or silent carries its reason and first retry from the start", async () => {
		at(1_000);
		const entry = await enqueueObjective(env, { instanceId: "i1", repoId: "r1", userId: "u1", objective: "#700", deferral: { reason: "runner_unresponsive", note: MISSED_PONG } });
		expect(entry).toMatchObject({ deferReason: "runner_unresponsive", nextRetryAt: T0 + 1_000 + MIN });
		expect(byName("#700")).toMatchObject({ status: "pending", reason: "runner_unresponsive", n: 0, retry: T0 + 1_000 + MIN });
		// The retry tick finds it once due — without it, an overload-queued entry waited for a run to end rather than for the metric to recover.
		at(1_000 + MIN);
		expect(await runDueOverloadRetries(env, Date.now())).toBe(1);
	});

	it("a refusal that is waited on for an EVENT (busy, offline) gets no clock: only the two timed reasons do", async () => {
		for (const [i, reason] of ["busy", "runner_offline", "paused", "recovery_required"].entries()) {
			at(i * 1000);
			const entry = await enqueueObjective(env, { instanceId: "i1", repoId: "r1", userId: "u1", objective: `#${800 + i}`, deferral: { reason, note: "waiting" } });
			expect(entry).toMatchObject({ deferReason: null, nextRetryAt: null });
		}
	});
});
