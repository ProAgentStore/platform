/**
 * #1686 — the pause tick is one D1 round per tick of the wait, however often the Workflow replays.
 *
 * The body replays after every `step.sleep`, re-running everything outside a `step.do`. The tick used to be
 * outside one, so a 15-minute handoff wait (180 five-second sleeps, a tick every 12th) re-ran every earlier
 * tick on each wake: ~1,440 `UPDATE agent_loop_runs SET last_alive_at` calls for 15 designed ones, which is
 * what put the statement at 843K calls a day with a few open runs. This replays a wait the way the engine does
 * (journalled steps return their stored answer, everything else runs again) and counts the statements.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "../../lib/d1-sqlite.js";
import { HANDOFF_TICK_EVERY, HANDOFF_WAIT_POLLS } from "../../lib/coding-pause.js";
import type { Env } from "../../types.js";
import { makePauseEffects } from "./pause-effects.js";

let d1: RealSchemaD1;
let env: Env;
let statements: string[];

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["i1"] });
	d1.exec(`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, max_iterations, started_at) VALUES ('run-1', 'u1', 'i1', 'x', 'running', 10, ${Date.now()})`);
	statements = [];
	const DB = new Proxy(d1.DB, {
		get(target, prop, receiver) {
			if (prop !== "prepare") return Reflect.get(target, prop, receiver);
			return (sql: string) => {
				statements.push(sql);
				return target.prepare(sql);
			};
		},
	});
	env = { DB } as unknown as Env;
});
afterEach(() => d1.close());

const livenessWrites = () => statements.filter((s) => s.includes("UPDATE agent_loop_runs") && s.includes("last_alive_at")).length;

/** One pass of the Workflow body over the wait, against a journal that survives between passes. */
function pass(journal: Map<string, unknown>, upTo: number): Promise<void> {
	let n = 0;
	const effects = makePauseEffects({
		env,
		step: {} as never,
		goal: { repo: "acme/app" } as never,
		instanceId: "i1",
		userId: "u1",
		sessionId: "s1",
		repoId: "r1",
		boardTaskId: undefined,
		loopRunId: "run-1",
		driverId: null,
		workflowInstanceId: undefined,
		cloneUrl: undefined,
		branch: undefined,
		token: undefined,
		tokenUsername: undefined,
		cardId: null,
		runRetry: (async (label: string, fn: () => Promise<unknown>) => {
			if (!journal.has(label)) journal.set(label, await fn());
			return journal.get(label);
		}) as never,
		postToChat: async () => {},
		getConn: () => ({}) as never,
		setConn: () => {},
		nextN: () => n++,
		startOnRunner: async () => {},
		getObjective: () => null,
	});
	const deps = effects.deps(0, "decision");
	return (async () => {
		for (let poll = 0; poll <= upTo; poll++) if (poll % HANDOFF_TICK_EVERY === 0) await deps.tick({ until: Date.now() + 60_000 });
	})();
}

describe("the pause tick under replay (#1686)", () => {
	it("a whole handoff wait replayed after every sleep makes one liveness write per tick, not one per tick per replay", async () => {
		const journal = new Map<string, unknown>();
		for (let poll = 0; poll < HANDOFF_WAIT_POLLS; poll++) await pass(journal, poll);
		const ticks = Math.ceil(HANDOFF_WAIT_POLLS / HANDOFF_TICK_EVERY);
		expect(livenessWrites()).toBe(ticks);
	});

	it("a replay answers from the journal: a cancel seen by the first pass is seen again without asking D1", async () => {
		const journal = new Map<string, unknown>();
		await pass(journal, 0);
		const before = statements.length;
		await pass(journal, 0);
		expect(statements.length).toBe(before);
	});
});
