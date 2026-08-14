import { describe, expect, it, vi, afterEach } from "vitest";
import { ORPHANABLE_TASK_TYPES } from "../lib/runtime-task-ownership.js";
import { callRuntime, expireOrphanedRuntimeTasks, type RuntimeRow } from "./instances-runtime.js";
import type { Env } from "../types.js";

interface Write {
	sql: string;
	args: unknown[];
}

/** Minimal env.DB stub: SELECT returns `rows`, INSERT/UPDATE writes are recorded. */
function mockEnv(rows: Array<{ id: string; payload: string }>): {
	env: Env;
	writes: Write[];
	selects: Write[];
} {
	const writes: Write[] = [];
	const selects: Write[] = [];
	const DB = {
		prepare(sql: string) {
			return {
				bind(...args: unknown[]) {
					return {
						async all() {
							selects.push({ sql, args });
							// Deliberately NOT filtered by the SQL: the stub hands back every row so the
							// per-row guard is exercised on its own. The SQL half is asserted separately
							// against `selects` — those two predicates drifting apart is the original bug.
							return { results: rows };
						},
						async run() {
							writes.push({ sql, args });
							return {};
						},
						async first() {
							return null;
						},
					};
				},
			};
		},
	};
	return { env: { DB } as unknown as Env, writes, selects };
}

/** Minimal RuntimeRow for callRuntime tests. */
function mockRow(overrides: Partial<RuntimeRow> = {}): RuntimeRow {
	return {
		instance_id: "inst-1",
		user_id: "user-1",
		placement: "local",
		endpoint_url: "https://tunnel.example.com",
		token_ciphertext: null,
		token_dek_wrapped: null,
		token_iv: null,
		token_plaintext: "tok",
		capabilities: "[]",
		runner_version: "",
		runner_node: "",
		status: "online",
		last_seen_at: null,
		created_at: "",
		updated_at: "",
		...overrides,
	};
}

/** Build a mock RELAY DO namespace. */
function mockRelay(handler: (req: Request) => Promise<Response>) {
	return {
		idFromName: (name: string) => ({ name }),
		get: (_id: unknown) => ({ fetch: handler }),
	};
}

describe("expireOrphanedRuntimeTasks", () => {
	it("marks a task the dead runner process was running failed, with an orphan reason", async () => {
		const rows = [
			{ id: "t1", payload: JSON.stringify({ id: "t1", type: "browser.open", status: "needs_human" }) },
			{ id: "t2", payload: JSON.stringify({ id: "t2", type: "echo", status: "running" }) },
		];
		const { env, writes } = mockEnv(rows);
		const n = await expireOrphanedRuntimeTasks(env, "inst1", "user1");
		expect(n).toBe(2);
		// mirrorRuntimeTask binds (id, instanceId, userId, type, status, payload, ...)
		expect(writes.map((w) => w.args[4])).toEqual(["failed", "failed"]);
		expect(String(writes[0].args[5])).toContain("orphaned");
	});

	it("does NOT expire workflow-driven job.apply_agent tasks (they survive a runner reconnect)", async () => {
		const rows = [
			{ id: "a1", payload: JSON.stringify({ id: "a1", type: "job.apply_agent", status: "needs_human" }) },
			{ id: "b2", payload: JSON.stringify({ id: "b2", type: "browser.open", status: "running" }) },
		];
		const { env, writes } = mockEnv(rows);
		const n = await expireOrphanedRuntimeTasks(env, "inst1", "user1");
		expect(n).toBe(1); // only the browser.open task, NOT the apply task
		expect(writes.map((w) => String(w.args[0]))).toEqual(["b2"]);
	});

	it("does nothing when there are no in-flight tasks", async () => {
		const { env, writes } = mockEnv([]);
		const n = await expireOrphanedRuntimeTasks(env, "inst1", "user1");
		expect(n).toBe(0);
		expect(writes.length).toBe(0);
	});
});

/**
 * #567, from production. A runner reconnect failed a coding session that then ran for two more
 * hours and made 15 irreversible pushes to `origin main`, and failed a standing-policy card whose
 * policy deliberately has no actuator — both told "its browser session is gone. Re-run it to try
 * again." Neither was a browser session, and neither could be re-run.
 *
 * Both directions are asserted in one place, because the sweep's two halves have been fixed
 * against each other three times: a dead browser task IS still expired, and everything the cloud
 * owns is NOT.
 */
describe("a runner reconnect ends only what the dead runner process was running (#567)", () => {
	/** Every board card in this list is one a real reconnect fed to the old predicate. */
	const cloudOwnedRows = [
		// The live coding session from the report — `running`, and still working.
		{ id: "csess-1", payload: JSON.stringify({ id: "csess-1", type: "coding.session", status: "running" }) },
		// #553's contribution: a Pilot parked in a handoff. `needs_human` is the FIRST status in the
		// sweep's SELECT, so the column #553 built was inside the blast radius from the day it landed.
		{ id: "csess-2", payload: JSON.stringify({ id: "csess-2", type: "coding.session", status: "needs_human" }) },
		// The standing-policy card. `repo.tree_clean`'s actuator is null by decision.
		{ id: "repo-dirty-1", payload: JSON.stringify({ id: "repo-dirty-1", type: "coding.uncommitted", status: "needs_human" }) },
		{ id: "repo-branch-1", payload: JSON.stringify({ id: "repo-branch-1", type: "coding.off_branch", status: "needs_human" }) },
		{ id: "deleg-1", payload: JSON.stringify({ id: "deleg-1", type: "delegation", status: "running" }) },
		{ id: "esc-1", payload: JSON.stringify({ id: "esc-1", type: "escalation", status: "needs_human" }) },
		{ id: "pipe-1", payload: JSON.stringify({ id: "pipe-1", type: "pipeline.run", status: "running" }) },
		{ id: "tick-1", payload: JSON.stringify({ id: "tick-1", type: "ticket", status: "running" }) },
		{ id: "authz-1", payload: JSON.stringify({ id: "authz-1", type: "coding.unauthorized_act", status: "needs_human" }) },
		// The fourth drift: the runner keeps this across its own restart, the API's denylist never
		// named it, so `pags up` failed a live engine sign-in takeover from the cloud side.
		{ id: "handoff-1", payload: JSON.stringify({ id: "handoff-1", type: "browser.handoff", status: "needs_human" }) },
		{ id: "signin-1", payload: JSON.stringify({ id: "signin-1", type: "engine.signin", status: "needs_human" }) },
	];

	it("leaves every cloud-owned card untouched", async () => {
		const { env, writes } = mockEnv(cloudOwnedRows);
		const n = await expireOrphanedRuntimeTasks(env, "inst1", "user1");
		// The denominator: eleven cards went in, and the assertion is about all eleven — not about
		// finding one survivor.
		expect(cloudOwnedRows.length).toBe(11);
		expect(writes.map((w) => String(w.args[0]))).toEqual([]);
		expect(n).toBe(0);
	});

	it("still expires the browser takeover the sweep was built for, in the same pass", async () => {
		const dead = { id: "b-1", payload: JSON.stringify({ id: "b-1", type: "browser.open", status: "needs_human" }) };
		const { env, writes } = mockEnv([...cloudOwnedRows, dead]);
		const n = await expireOrphanedRuntimeTasks(env, "inst1", "user1");
		expect(n).toBe(1);
		expect(writes.map((w) => String(w.args[0]))).toEqual(["b-1"]);
		expect(JSON.parse(String(writes[0].args[5])).error).toContain("browser session is gone");
	});

	it("does not stamp completedAt on a task it never observed completing", async () => {
		const { env, writes } = mockEnv([
			{ id: "b-1", payload: JSON.stringify({ id: "b-1", type: "browser.open", status: "needs_human", createdAt: "2026-08-11T01:29:42Z" }) },
		]);
		await expireOrphanedRuntimeTasks(env, "inst1", "user1");
		const payload = JSON.parse(String(writes[0].args[5]));
		// The card in the report read `completedAt: 01:31:00` while the work ran until 03:31:35.
		// The sweep knows when it gave up looking; it does not know when the work stopped.
		expect(payload).not.toHaveProperty("completedAt");
		expect(payload.status).toBe("failed");
		expect(payload.updatedAt).toBeTruthy();
	});

	it("filters in SQL by the same allowlist, so the two predicates cannot drift apart", async () => {
		const { env, selects } = mockEnv([]);
		await expireOrphanedRuntimeTasks(env, "inst1", "user1");
		expect(selects.length).toBe(1);
		// An allowlist (`IN`), never an exception list (`NOT IN`) — that direction is the bug.
		expect(selects[0].sql).toContain("type IN (");
		expect(selects[0].sql).not.toContain("NOT IN");
		expect(selects[0].args.slice(2)).toEqual([...ORPHANABLE_TASK_TYPES]);
	});
});

describe("callRuntime (relay-only)", () => {
	afterEach(() => { vi.restoreAllMocks(); });

	it("sends GET requests with correct method", async () => {
		let relayPayload: { method: string; path: string; body: unknown } | null = null;
		const relay = mockRelay(async (req) => {
			relayPayload = await req.json() as typeof relayPayload;
			return Response.json({ ok: true });
		});
		const env = { RELAY: relay } as unknown as Env;
		const row = mockRow();

		const res = await callRuntime(env, row, "/health");
		expect(res.status).toBe(200);
		expect(relayPayload!.method).toBe("GET");
		expect(relayPayload!.path).toBe("/health");
	});

	it("sends POST requests and forwards body", async () => {
		let relayPayload: { method: string; path: string; body: unknown } | null = null;
		const relay = mockRelay(async (req) => {
			relayPayload = await req.json() as typeof relayPayload;
			return Response.json({ task: "created" });
		});
		const env = { RELAY: relay } as unknown as Env;
		const row = mockRow();

		const body = JSON.stringify({ type: "echo", input: {} });
		const res = await callRuntime(env, row, "/tasks", { method: "POST", body });
		expect(res.status).toBe(200);
		expect(relayPayload!.method).toBe("POST");
		expect(relayPayload!.body).toEqual({ type: "echo", input: {} });
	});

	it("throws when RELAY binding is absent", async () => {
		const env = {} as unknown as Env;
		const row = mockRow();
		await expect(callRuntime(env, row, "/health")).rejects.toThrow("RELAY binding not configured");
	});
});
