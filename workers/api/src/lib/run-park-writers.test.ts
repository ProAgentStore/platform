
import { describe, expect, it, vi } from "vitest";
import { recordLiveness } from "./agent-loop-store.js";
import { HANDOFF_GIVE_UP_MS, resolvePause, type PauseDeps } from "./coding-pause.js";
import { realSchemaD1, seedTenant } from "./d1-sqlite.js";
import type { Env } from "../types.js";


// ── 1. The module that knows the instant hands it over ───────────────────────

function pauseDeps(over: Partial<PauseDeps> = {}): PauseDeps {
	return {
		repo: "demo",
		instanceId: "inst-1",
		takeover: vi.fn(async () => undefined),
		takeoverStatus: vi.fn(async () => ({ resolved: true, value: "ok" })),
		endTakeover: vi.fn(async () => undefined),
		sleep: vi.fn(async () => undefined),
		notify: vi.fn(async () => undefined),
		announce: vi.fn(async () => undefined),
		card: vi.fn(async () => undefined),
		tick: vi.fn(async () => true),
		// #881's sign-in park; no test in this file parks on sign-in, so it never completes or restarts.
		reauthCompletedSince: vi.fn(async () => false),
		restartEngine: vi.fn(async () => undefined),
		now: () => 1_000_000,
		...over,
	};
}

describe("the pause machine hands the park's END to the heartbeat", () => {
	it("an engine-limit park ticks WITH the instant it computed", async () => {
		const deps = pauseDeps();
		const resetsAt = new Date(1_000_000 + 90 * 60_000).toISOString();
		await resolvePause(deps, {
			round: 1,
			result: { outcome: "waiting", detail: "usage limit", steps: 1, waitUntil: resetsAt },
			state: { waits: 0, spentMs: 0 },
		});
		const calls = (deps.tick as ReturnType<typeof vi.fn>).mock.calls;
		expect(calls.length, "the park heartbeats at least once").toBeGreaterThan(0);
		// Before #591 every one of these was `tick()` with no argument, so the instant died here.
		for (const [park] of calls) {
			expect(park?.until, "every tick restates the end, so a replayed park cannot blank it").toBeGreaterThan(1_000_000);
		}
	});

	it("a human handoff ticks WITH its give-up instant, which is the deadline the owner can beat", async () => {
		// The inversion #596 argues for. This park publishes nothing until now, on the grounds that
		// `waiting_until` was rendered unconditionally as "expected to resume in …" — true of the
		// engine park, and a lie here, where the instant is when the run STOPS waiting for the
		// reader. The renderer now reads the KIND off the park reason, so withholding the instant no
		// longer protects anybody: it hides the only deadline anyone can still act on.
		let polls = 0;
		// A clock the sleeps actually move, because the property under test is about elapsed time:
		// `step.sleep` really does advance the wall clock by what it was asked to wait, and a frozen
		// `now()` would measure the fixture rather than the rule.
		let clock = 1_000_000;
		const deps = pauseDeps({
			now: () => clock,
			sleep: vi.fn(async (_label: string, ms: number) => {
				clock += ms;
			}),
			takeoverStatus: vi.fn(async () => ({ resolved: ++polls > 20, value: "v" })),
		});
		await resolvePause(deps, {
			round: 1,
			result: { outcome: "stuck", detail: "a widget", steps: 1 },
			state: { waits: 0, spentMs: 0 },
		});
		const calls = (deps.tick as ReturnType<typeof vi.fn>).mock.calls;
		expect(calls.length).toBeGreaterThan(0);
		// EXACTLY the instant the loop gives up at — 15 minutes after the wait opened — restated
		// identically by every tick. Computed from the polls REMAINING, so it cannot slide: a
		// deadline captured once before the loop would move a whole wait on a Workflow replay, and
		// one computed as `now + 15min` per tick would never arrive at all.
		const instants = new Set(calls.map(([park]) => park?.until));
		expect(instants.size, `${instants.size} distinct give-up instants across ${calls.length} ticks`).toBe(1);
		expect([...instants][0], "the published instant is not the moment the loop actually stops waiting").toBe(1_000_000 + HANDOFF_GIVE_UP_MS);
	});
});

// ── 2. The production call sites consume it ─────────────────────────────────────
//
// That a working run CLEARS its park, and that each park a run actually takes — waiting on the owner,
// backing off a platform interruption — writes both its reason AND its `until`, is asserted by RUNNING
// the workflow in `workflows/coding-session/workflow-run.test.ts` (#915). It used to be a scan of two
// hard-coded source files for one-line `recordLiveness(` calls, which a moved park would have
// satisfied by vanishing from the list.

// ── 3. …and the column actually takes it, against the real schema ────────────

describe("the column stores what the park hands it", () => {
	it("an until written by the heartbeat is readable, and a clear removes it", async () => {
		const db = realSchemaD1();
		seedTenant(db, { userId: "u1", instanceIds: ["i1"] });
		db.exec(
			"INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, iteration, max_iterations, started_at) VALUES ('r1','u1','i1','x','running',1,10,1)",
		);
		const env = { DB: db.DB } as unknown as Env;
		const until = 1_000_000 + 6 * 3_600_000;
		await recordLiveness(env, "r1", 2_000, { reason: "engine_limit", until });
		const parked = await db.DB.prepare("SELECT waiting_reason, waiting_until FROM agent_loop_runs WHERE run_id='r1'").first<{
			waiting_reason: string | null;
			waiting_until: number | null;
		}>();
		expect(parked).toEqual({ waiting_reason: "engine_limit", waiting_until: until });
		await recordLiveness(env, "r1", 3_000, null);
		const cleared = await db.DB.prepare("SELECT waiting_until FROM agent_loop_runs WHERE run_id='r1'").first<{ waiting_until: number | null }>();
		expect(cleared?.waiting_until).toBeNull();
	});
});
