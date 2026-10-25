/**
 * #1362 — settling a chat loop run. Real migrated schema; only the push itself is faked (it leaves the platform).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { notifyUser } = vi.hoisted(() => ({ notifyUser: vi.fn(async () => undefined) }));
vi.mock("../routes/push.js", () => ({ notifyUser }));

import { settleChatLoopRun } from "./chat-loop-settle.js";
import { finishLoopRun, getLoopRun } from "./agent-loop-store.js";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./d1-sqlite.js";
import type { Env } from "../types.js";

let d1: RealSchemaD1;
let env: Env;
const RUN = { runId: "r1", userId: "u1", instanceId: "i1", objective: "triage the inbox" };
const events = () => d1.sqlite.prepare("SELECT event FROM agent_events WHERE source = 'loop'").all() as Array<{ event: string }>;

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["i1"] });
	d1.exec(`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, iteration, max_iterations, started_at) VALUES ('r1', 'u1', 'i1', 'triage the inbox', 'running', 2, 10, ${Date.now() - 60_000})`);
	env = { DB: d1.DB } as unknown as Env;
	notifyUser.mockClear();
});
afterEach(() => d1.close());

describe("settleChatLoopRun", () => {
	it("records the ending, logs it and pushes the owner when the ending needs them", async () => {
		expect(await settleChatLoopRun(env, RUN, { reason: "failed", message: "the agent could not reach the mailbox" })).toBe("applied");
		expect(await getLoopRun(env, "u1", "r1")).toMatchObject({ status: "failed", stopReason: "failed" });
		expect(events().map((e) => e.event)).toEqual(["failed"]);
		expect(notifyUser).toHaveBeenCalledTimes(1);
	});

	it("does not push an ending that does not need the owner", async () => {
		expect(await settleChatLoopRun(env, RUN, { reason: "done", message: "inbox at zero" })).toBe("applied");
		expect(notifyUser).not.toHaveBeenCalled();
	});

	it("a run something else settled first is not logged, escalated or pushed with a reason it never recorded (#1362)", async () => {
		// The owner stopped it and the cancel sweep landed `cancelled`; the workflow then resumed and ended `failed`.
		await finishLoopRun(env, "r1", "cancelled", "stopped by you", Date.now());
		expect(await settleChatLoopRun(env, RUN, { reason: "failed", message: "late failure" })).toBe("superseded");
		expect(await getLoopRun(env, "u1", "r1")).toMatchObject({ status: "cancelled", stopReason: "cancelled" });
		expect(events()).toEqual([]);
		expect(notifyUser).not.toHaveBeenCalled();
		expect(d1.sqlite.prepare("SELECT COUNT(*) AS n FROM instance_runtime_tasks WHERE type = 'escalation'").get()).toEqual({ n: 0 });
	});

	it("a retried step of the same ending still notifies, once per run and reason (the push key dedupes it)", async () => {
		await settleChatLoopRun(env, RUN, { reason: "failed", message: "x" });
		expect(await settleChatLoopRun(env, RUN, { reason: "failed", message: "x" })).toBe("already");
		expect(notifyUser).toHaveBeenCalledTimes(2);
		const keys = (notifyUser.mock.calls as unknown as Array<[unknown, unknown, unknown, unknown, unknown, unknown, { key: string }]>).map((c) => c[6].key);
		expect(new Set(keys).size).toBe(1);
	});
});
