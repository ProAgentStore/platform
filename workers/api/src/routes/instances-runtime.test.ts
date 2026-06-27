import { describe, expect, it, vi, afterEach } from "vitest";
import { callRuntime, expireOrphanedRuntimeTasks, type RuntimeRow } from "./instances-runtime.js";
import type { Env } from "../types.js";

interface Write {
	sql: string;
	args: unknown[];
}

/** Minimal env.DB stub: SELECT returns `rows`, INSERT/UPDATE writes are recorded. */
function mockEnv(rows: Array<{ id: string; payload: string }>): { env: Env; writes: Write[] } {
	const writes: Write[] = [];
	const DB = {
		prepare(sql: string) {
			return {
				bind(...args: unknown[]) {
					return {
						async all() {
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
	return { env: { DB } as unknown as Env, writes };
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
	it("marks needs_human / running tasks failed with an orphan reason", async () => {
		const rows = [
			{ id: "t1", payload: JSON.stringify({ id: "t1", type: "job.apply_basic", status: "needs_human" }) },
			{ id: "t2", payload: JSON.stringify({ id: "t2", type: "browser.open", status: "running" }) },
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
