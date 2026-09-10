/**
 * The objective queue's STORE (#788).
 *
 * The two properties worth asserting here are both about SQL that a type checker cannot see:
 *
 *  1. the dequeue predicate — `(repo_id IS NULL OR repo_id = ?2)` is what makes a repo-agnostic
 *     entry eligible for every repo and a chat-driver drain see only the repo-agnostic ones. Get
 *     the polarity wrong and a queued objective either never drains or drains onto the wrong repo,
 *     and nothing else in the system would notice.
 *  2. the claim — `dequeueNext` proposes candidates with a SELECT and then CLAIMS with a
 *     conditional UPDATE. The SELECT is never trusted, so losing the race must walk to the NEXT
 *     candidate rather than returning null. Two drains starting the same objective twice is the
 *     failure the shape exists to prevent, and it is only observable through `meta.changes`.
 */
import { describe, expect, it } from "vitest";
import { cancelQueueEntry, dequeueNext, enqueueObjective, finishQueueEntry, listQueue, requeueEntry } from "./objective-queue.js";
import type { Env } from "../types.js";

interface Call {
	sql: string;
	args: unknown[];
}

/**
 * D1 stub in the shape `delegation-budget-store.test.ts` uses: every statement is recorded, `rows`
 * scripts what the SELECTs read back, and `changes` scripts whether each UPDATE matched. `changes`
 * is a QUEUE of numbers so a test can say "the first claim loses, the second wins".
 */
function buildEnv(opts: { rows?: Array<Record<string, unknown>>; changes?: number[] } = {}) {
	const calls: Call[] = [];
	const changes = [...(opts.changes ?? [])];
	const env = {
		DB: {
			prepare(sql: string) {
				const exec = (args: unknown[]) => ({
					async all() {
						calls.push({ sql, args });
						return { results: opts.rows ?? [] };
					},
					async first() {
						calls.push({ sql, args });
						return (opts.rows ?? [])[0] ?? null;
					},
					async run() {
						calls.push({ sql, args });
						return { meta: { changes: changes.length ? (changes.shift() as number) : 1 } };
					},
				});
				return { bind: (...args: unknown[]) => exec(args) };
			},
		},
	} as unknown as Env;
	return { env, calls };
}

const row = (over: Record<string, unknown> = {}) => ({
	id: "objq-1",
	instance_id: "i1",
	repo_id: "r1",
	user_id: "u1",
	objective: "ship the thing",
	max_iterations: 12,
	metadata: null,
	status: "pending",
	stop_reason: null,
	run_id: null,
	created_at: 1000,
	started_at: null,
	finished_at: null,
	...over,
});

describe("enqueueObjective", () => {
	it("inserts a pending row and returns it without a second read", async () => {
		const { env, calls } = buildEnv();
		const entry = await enqueueObjective(env, { instanceId: "i1", repoId: "r1", userId: "u1", objective: "go", maxIterations: 7 });
		expect(calls).toHaveLength(1);
		expect(calls[0].sql).toContain("INSERT INTO instance_objective_queue");
		expect(calls[0].sql).toContain("'pending'");
		expect(entry.status).toBe("pending");
		expect(entry.repoId).toBe("r1");
		expect(entry.maxIterations).toBe(7);
		expect(entry.runId).toBeNull();
	});

	it("stores repo_id NULL when no repo was named — the 'any repo' entry", async () => {
		const { env, calls } = buildEnv();
		const entry = await enqueueObjective(env, { instanceId: "i1", userId: "u1", objective: "go" });
		expect(entry.repoId).toBeNull();
		expect(calls[0].args[2]).toBeNull();
	});

	it("stores maxIterations RAW so the account ceiling is applied at START time, not at enqueue", async () => {
		// A queued entry can sit across a limits change. Clamping here would apply the ceiling in
		// force when it was queued to a run that happens later under a different one.
		const { env, calls } = buildEnv();
		await enqueueObjective(env, { instanceId: "i1", userId: "u1", objective: "go", maxIterations: 999 });
		expect(calls[0].args[5]).toBe(999);
	});

	it("caps the objective at the same 2000 chars the run row and POST /loop enforce", async () => {
		const { env } = buildEnv();
		const entry = await enqueueObjective(env, { instanceId: "i1", userId: "u1", objective: "x".repeat(5000) });
		expect(entry.objective).toHaveLength(2000);
	});
});

describe("listQueue", () => {
	it("returns pending entries oldest-first", async () => {
		const { env, calls } = buildEnv({ rows: [row({ id: "objq-a", created_at: 1 }), row({ id: "objq-b", created_at: 2 })] });
		const entries = await listQueue(env, "i1");
		expect(entries.map((e) => e.id)).toEqual(["objq-a", "objq-b"]);
		expect(calls[0].sql).toContain("status = 'pending'");
		expect(calls[0].sql).toContain("ORDER BY created_at ASC");
	});

	it("without a repo filter it does NOT narrow by repo — one bind, the instance", async () => {
		const { env, calls } = buildEnv({ rows: [] });
		await listQueue(env, "i1");
		expect(calls[0].sql).not.toContain("repo_id IS NULL");
		expect(calls[0].args).toEqual(["i1"]);
	});

	it("with a repo filter it shows that repo's entries AND the repo-agnostic ones", async () => {
		const { env, calls } = buildEnv({ rows: [] });
		await listQueue(env, "i1", "r1");
		expect(calls[0].sql).toContain("(repo_id IS NULL OR repo_id = ?2)");
		expect(calls[0].args).toEqual(["i1", "r1"]);
	});

	it("with an explicit null repo it sees only the repo-agnostic entries", async () => {
		// `repo_id = NULL` is NULL rather than true in SQLite, so the same predicate collapses to
		// `repo_id IS NULL` — which is what a chat-driver drain must see.
		const { env, calls } = buildEnv({ rows: [] });
		await listQueue(env, "i1", null);
		expect(calls[0].args).toEqual(["i1", null]);
	});
});

describe("cancelQueueEntry", () => {
	it("cancels a pending entry, owner-scoped", async () => {
		const { env, calls } = buildEnv({ changes: [1] });
		expect(await cancelQueueEntry(env, "objq-1", "u1")).toBe(true);
		expect(calls[0].sql).toContain("status = 'cancelled'");
		expect(calls[0].sql).toContain("user_id = ?2");
		expect(calls[0].sql).toContain("status = 'pending'");
		expect(calls[0].args.slice(0, 2)).toEqual(["objq-1", "u1"]);
	});

	it("refuses an entry a drain has already claimed", async () => {
		// The `status = 'pending'` guard is what stops the queue recording "cancelled" for an
		// objective that is at that moment becoming a run.
		const { env } = buildEnv({ changes: [0] });
		expect(await cancelQueueEntry(env, "objq-1", "u1")).toBe(false);
	});
});

describe("dequeueNext", () => {
	it("claims the oldest eligible entry and returns it as running", async () => {
		const { env, calls } = buildEnv({ rows: [row({ id: "objq-a" })], changes: [1] });
		const claimed = await dequeueNext(env, "i1", "r1");
		expect(claimed?.id).toBe("objq-a");
		expect(claimed?.status).toBe("running");
		expect(claimed?.startedAt).toBeGreaterThan(0);
		expect(calls[0].sql).toContain("(repo_id IS NULL OR repo_id = ?2)");
		expect(calls[1].sql).toContain("SET status = 'running'");
		// The claim, and the whole reason this is safe: only a row still `pending` can be moved.
		expect(calls[1].sql).toContain("status = 'pending'");
	});

	it("walks to the next candidate when another drain won the claim", async () => {
		const { env } = buildEnv({ rows: [row({ id: "objq-a" }), row({ id: "objq-b" })], changes: [0, 1] });
		const claimed = await dequeueNext(env, "i1", "r1");
		expect(claimed?.id).toBe("objq-b");
	});

	it("returns null when every candidate was taken", async () => {
		const { env } = buildEnv({ rows: [row({ id: "objq-a" })], changes: [0] });
		expect(await dequeueNext(env, "i1", "r1")).toBeNull();
	});

	it("returns null when nothing is queued", async () => {
		const { env, calls } = buildEnv({ rows: [] });
		expect(await dequeueNext(env, "i1", "r1")).toBeNull();
		// One cheap SELECT and no write — this runs at the end of every single run.
		expect(calls).toHaveLength(1);
	});

	it("a chat-driver drain (repoId null) asks only for the repo-agnostic entries", async () => {
		const { env, calls } = buildEnv({ rows: [] });
		await dequeueNext(env, "i1", null);
		expect(calls[0].args[1]).toBeNull();
	});
});

describe("finishQueueEntry", () => {
	it("records the run an entry became", async () => {
		const { env, calls } = buildEnv();
		await finishQueueEntry(env, "objq-1", "started", null, "run-9");
		expect(calls[0].args[1]).toBe("started");
		expect(calls[0].args[2]).toBeNull();
		expect(calls[0].args[3]).toBe("run-9");
	});

	it("records a failure with its reason and no run", async () => {
		const { env, calls } = buildEnv();
		await finishQueueEntry(env, "objq-1", "failed", "no runner is connected");
		expect(calls[0].args[1]).toBe("failed");
		expect(calls[0].args[2]).toBe("no runner is connected");
		expect(calls[0].args[3]).toBeNull();
	});

	it("bounds the stop reason", async () => {
		const { env, calls } = buildEnv();
		await finishQueueEntry(env, "objq-1", "failed", "x".repeat(2000));
		expect(String(calls[0].args[2])).toHaveLength(500);
	});
});

describe("requeueEntry", () => {
	it("puts a claimed entry back WITHOUT touching created_at, so it keeps its place", async () => {
		// Losing a race is not a reason to go to the back of the queue.
		const { env, calls } = buildEnv();
		await requeueEntry(env, "objq-1");
		expect(calls[0].sql).toContain("status = 'pending'");
		expect(calls[0].sql).toContain("started_at = NULL");
		expect(calls[0].sql).not.toContain("created_at");
		// Only a row this drain actually claimed may be given back.
		expect(calls[0].sql).toContain("status = 'running'");
	});
});
