/**
 * #1515 — a repo-level admission blocker holds the objective queue behind ONE condition.
 *
 * Over the real schema and the real queue store, with only the engine start faked: queue several dependent objectives,
 * stop the first at its pre-flight, and assert no further entry is started, failed or consumed — then clear the blocker
 * and assert the queue resumes in order, exactly once per drain.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./d1-sqlite.js";
import type { Env } from "../types.js";

const start = vi.fn();
vi.mock("./provider-account-hold.js", () => ({ automaticProviderHold: async () => null }));
vi.mock("../routes/push.js", () => ({ notifyUser: async () => undefined }));
vi.mock("./agent-capabilities.js", () => ({ capabilitiesForInstance: async () => ({ workflow: "CODING_SESSION" }) }));
vi.mock("./delegation-budget-store.js", () => ({ openBudget: async () => ({ id: "bud-1" }), resolveAccountCeilings: async () => ({ loopMaxIterations: 10 }) }));
vi.mock("./loop-drivers.js", async (orig) => ({
	loopDriverFor: () => ({ id: "coding", label: "the engine", start: (...a: unknown[]) => start(...a) }),
	startRefusalIsWaitable: (await orig<typeof import("./loop-drivers.js")>()).startRefusalIsWaitable,
}));

const { tryDequeueAndStart } = await import("./objective-queue-start.js");
const { enqueueObjective, listQueue } = await import("./objective-queue.js");
const { clearRepoBlocker, describeRepoBlocker, listRepoBlockers, readRepoBlocker, setRepoBlocker } = await import("./repo-admission-blocker.js");

let d1: RealSchemaD1;
let env: Env;
const key = { instanceId: "i1", userId: "u1", repoId: "r1" };
const BLOCKER = "The checkout is dirty and 19 commits behind origin/main, so a fast-forward cannot run (#801).";

beforeEach(() => {
	start.mockReset();
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["i1"] });
	d1.exec("INSERT INTO coding_repos (id, instance_id, user_id, name, workdir, branch) VALUES ('r1', 'i1', 'u1', 'owner/repo', '/work/repo', 'main')");
	d1.exec("INSERT INTO coding_repos (id, instance_id, user_id, name, workdir, branch) VALUES ('r2', 'i1', 'u1', 'owner/other', '/work/other', 'main')");
	env = { DB: d1.DB } as unknown as Env;
	let n = 0;
	start.mockImplementation(async () => ({ ok: true, runId: `run-${++n}`, driver: "coding" }));
});
afterEach(() => d1.close());

const queue = async (repoId: string | null, ...objectives: string[]) => {
	for (const o of objectives) {
		await enqueueObjective(env, { instanceId: "i1", userId: "u1", repoId, objective: o });
		await new Promise((r) => setTimeout(r, 2)); // distinct created_at: FIFO is by it
	}
};
const statuses = () => d1.DB.prepare("SELECT objective, status FROM instance_objective_queue ORDER BY created_at, id").all<{ objective: string; status: string }>().then((r) => r.results ?? []);

describe("the blocker record", () => {
	it("is set once per repo, refreshed in place, listed, and cleared", async () => {
		expect(await readRepoBlocker(env, "i1", "r1")).toBeNull();
		await setRepoBlocker(env, { ...key, message: BLOCKER, runId: "run-0", now: 1000 });
		await setRepoBlocker(env, { ...key, message: `${BLOCKER} (again)`, runId: "run-1", now: 9000 });
		const b = await readRepoBlocker(env, "i1", "r1");
		expect(b).toMatchObject({ repoId: "r1", since: 1000, runId: "run-1" }); // `since` is when it FIRST held the queue
		expect(b?.message).toContain("(again)");
		expect(await listRepoBlockers(env, "i1", "u1")).toHaveLength(1);
		expect(await readRepoBlocker(env, "i1", "r2")).toBeNull(); // unrelated repos are unaffected
		expect(await clearRepoBlocker(env, key)).toBe(true);
		expect(await clearRepoBlocker(env, key)).toBe(false);
		expect(await readRepoBlocker(env, "i1", "r1")).toBeNull();
	});

	it("names what blocks and how to clear it", async () => {
		const text = describeRepoBlocker({ repoId: "r1", message: BLOCKER, since: 1, runId: null });
		expect(text).toContain("repo_blocked");
		expect(text).toContain(BLOCKER);
		expect(text).toContain("repair_checkout");
		expect(text).toContain("stash_checkout");
		expect(text).toContain("Nothing queued behind it was started or failed");
	});

	it("is the owner's: another user's repo is not written or read through this instance", async () => {
		await setRepoBlocker(env, { instanceId: "i1", userId: "someone-else", repoId: "r1", message: BLOCKER });
		expect(await readRepoBlocker(env, "i1", "r1")).toBeNull();
	});
});

describe("a blocked repo holds its whole queue (#1515)", () => {
	it("starts, fails and consumes NOTHING while the blocker stands, however many times the queue is drained", async () => {
		await queue("r1", "FAS #349 recovery", "FAS #350: requires #349 delivered", "FAS #351: requires #350 delivered", "FAS #352: requires #351 delivered");
		await setRepoBlocker(env, { ...key, message: BLOCKER, runId: "run-0" });
		for (let i = 0; i < 5; i++) {
			const out = await tryDequeueAndStart(env, "i1", "r1", "u1");
			expect(out).toMatchObject({ drained: false });
			expect((out as { held?: string }).held).toContain("repo_blocked");
		}
		expect(start).not.toHaveBeenCalled(); // no run, no failed attempt, no spend
		const rows = await statuses();
		expect(rows.map((r) => r.status)).toEqual(["pending", "pending", "pending", "pending"]);
		expect(rows.map((r) => r.objective)).toEqual(["FAS #349 recovery", "FAS #350: requires #349 delivered", "FAS #351: requires #350 delivered", "FAS #352: requires #351 delivered"]);
	});

	it("resumes in order, exactly one entry per drain, once the blocker is cleared", async () => {
		await queue("r1", "first", "second", "third");
		await setRepoBlocker(env, { ...key, message: BLOCKER });
		await tryDequeueAndStart(env, "i1", "r1", "u1");
		expect(start).not.toHaveBeenCalled();
		await clearRepoBlocker(env, key); // a repair run finished / the checkout was stashed
		const a = await tryDequeueAndStart(env, "i1", "r1", "u1");
		expect(a).toMatchObject({ drained: true, started: true, runId: "run-1" });
		expect(start).toHaveBeenCalledTimes(1);
		expect((start.mock.calls[0][0] as { objective: string }).objective).toBe("first");
		expect((await statuses()).map((r) => r.status)).toEqual(["started", "pending", "pending"]);
		// The started run's own terminal path drains the next — never two at once.
		await tryDequeueAndStart(env, "i1", "r1", "u1");
		expect((start.mock.calls[1][0] as { objective: string }).objective).toBe("second");
		expect(start).toHaveBeenCalledTimes(2);
	});

	it("does not hold work for another repo, or repo-agnostic work drained for one", async () => {
		await queue("r2", "other repo work");
		await setRepoBlocker(env, { ...key, message: BLOCKER }); // r1 is blocked, r2 is not
		const out = await tryDequeueAndStart(env, "i1", "r2", "u1");
		expect(out).toMatchObject({ drained: true, started: true });
		expect((start.mock.calls[0][0] as { objective: string }).objective).toBe("other repo work");
	});

	it("a blocker that cannot be read does not wedge the queue: the drain's own admission still decides", async () => {
		await queue("r1", "only");
		const broken = { DB: { prepare: (sql: string) => (/admission_blocker/.test(sql) ? { bind: () => ({ first: async () => { throw new Error("db down"); } }) } : d1.DB.prepare(sql)) } } as unknown as Env;
		expect(await readRepoBlocker(broken, "i1", "r1")).toBeNull();
	});

	it("the queue listing's pending entries are intact while held", async () => {
		await queue("r1", "a", "b");
		await setRepoBlocker(env, { ...key, message: BLOCKER });
		await tryDequeueAndStart(env, "i1", "r1", "u1");
		expect((await listQueue(env, "i1", "r1")).map((e) => e.objective)).toEqual(["a", "b"]);
	});
});
