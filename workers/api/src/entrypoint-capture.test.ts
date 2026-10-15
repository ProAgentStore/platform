/**
 * #1086 — failures are captured where they actually happen: the request entrypoint (`index.ts`
 * `default.fetch`), a response a route RETURNS instead of throwing, the Durable Object's WebSocket
 * handlers, the storage engine, pipeline bookkeeping and the cron sweeps.
 *
 * Every test drives a real entrypoint against the real schema (`d1-sqlite.ts`) and reads back what
 * landed in `error_log` — persistence and retrieval, not a helper's return value. Failures are
 * injected at the boundary (a D1 statement, the model call, a runner read), never by stubbing the
 * logging under test. `cloudflare:workers` does not resolve in Node, so it is replaced by the two
 * base classes the Worker actually extends; nothing else about the Worker is mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => {
	class DurableObject {
		ctx: unknown;
		env: unknown;
		constructor(ctx: unknown, env: unknown) {
			this.ctx = ctx;
			this.env = env;
		}
	}
	class WorkflowEntrypoint extends DurableObject {}
	return { DurableObject, WorkflowEntrypoint };
});

const ai = vi.hoisted(() => ({ impl: null as null | (() => Promise<unknown>) }));
vi.mock("./lib/user-ai.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./lib/user-ai.js")>();
	return { ...actual, runUserWorkersAi: (...a: unknown[]) => (ai.impl ? ai.impl() : (actual.runUserWorkersAi as (...x: unknown[]) => Promise<unknown>)(...a)) };
});
const reauth = vi.hoisted(() => ({ failFinish: false }));
vi.mock("./lib/engine-reauth-store.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./lib/engine-reauth-store.js")>();
	return {
		...actual,
		finishReauthIfCurrent: (...a: Parameters<typeof actual.finishReauthIfCurrent>) => (reauth.failFinish ? Promise.reject(new Error("D1_ERROR: write refused")) : actual.finishReauthIfCurrent(...a)),
	};
});
vi.mock("./lib/runner-client.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./lib/runner-client.js")>();
	return {
		...actual,
		getBoundRunnerConn: async () => (reauth.failFinish ? { endpoint: "relay", token: "t", node: "n" } : null),
		// The relay's "session gone" reading — it sends the sweep down its finish path.
		callRunner: async () => {
			throw new Error("runner /tmux/capture → 404");
		},
	};
});

import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./lib/d1-sqlite.js";
import { resetServerBuildForTests } from "./lib/error-log.js";
import { closeRun, openRun } from "./lib/pipeline-runs.js";
import { runReauthExpiryWatch } from "./lib/engine-reauth-expiry.js";
import { signSession } from "./lib/session.js";
import type { Env } from "./types.js";

const { default: worker } = await import("./index.js");
const { AgentDO } = await import("./agent-do.js");
const { AgentStorageEngine } = await import("./agent-storage.js");

const KEY = "entrypoint-capture-test-key";
let d1: RealSchemaD1;
let failWhen: ((sql: string) => string | null) | null;
let env: Env;

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["iA"] });
	failWhen = null;
	ai.impl = null;
	reauth.failFinish = false;
	resetServerBuildForTests();
	// D1 that refuses chosen statements — the failure, injected where the code meets storage.
	const DB = new Proxy(d1.DB, {
		get(target, prop) {
			if (prop === "prepare") {
				return (sql: string) => {
					const msg = failWhen?.(sql);
					if (msg) throw new Error(msg);
					return target.prepare(sql);
				};
			}
			const v = Reflect.get(target, prop);
			return typeof v === "function" ? v.bind(target) : v;
		},
	});
	env = { DB, SESSION_SIGNING_KEY: KEY, API_BUILD: "test-build" } as unknown as Env;
	vi.spyOn(console, "error").mockImplementation(() => undefined);
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
	vi.spyOn(Math, "random").mockReturnValue(0.5);
});
afterEach(() => {
	d1.close();
	vi.restoreAllMocks();
});

const rows = (source?: string) =>
	(d1.sqlite.prepare("SELECT source, level, status, user_id, instance_id, run_id, message, context, build, repeat_count FROM error_log ORDER BY rowid").all() as Array<Record<string, unknown>>).filter(
		(r) => !source || r.source === source,
	);
const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
const call = async (path: string, init: RequestInit & { ip?: string; auth?: boolean } = {}) => {
	const headers = new Headers(init.headers);
	headers.set("CF-Connecting-IP", init.ip ?? "203.0.113.9");
	if (init.auth !== false) headers.set("Authorization", `Bearer ${await signSession("u1", KEY)}`);
	return worker.fetch(new Request(`https://api.proagentstore.online${path}`, { ...init, headers }), env, ctx);
};

describe("the request entrypoint (index.ts default.fetch)", () => {
	it("a transient exception is answered 503 AND recorded — it used to return before the log", async () => {
		failWhen = (sql) => (sql.startsWith("SELECT id, created_at, user_id, source") ? "Network connection lost." : null);
		const res = await call("/v1/errors");
		expect(res.status).toBe(503);
		expect(rows("transient")).toEqual([expect.objectContaining({ level: "warn", status: 503, user_id: "u1", build: "test-build" })]);
		expect(JSON.parse(String(rows("transient")[0].context))).toMatchObject({ path: "/v1/errors", method: "GET" });
	});

	it("a genuine exception is a 500 with its stack, once", async () => {
		failWhen = (sql) => (sql.startsWith("SELECT id, created_at, user_id, source") ? "no such column: bogus" : null);
		expect((await call("/v1/errors")).status).toBe(500);
		expect(rows("unhandled")).toEqual([expect.objectContaining({ level: "error", status: 500, user_id: "u1" })]);
		expect(JSON.parse(String(rows("unhandled")[0].context)).stack).toMatch(/no such column/);
	});

	it("a rate-limited caller gets 429 and ONE warn per window — not one row per refusal, and never its IP", async () => {
		const ip = "198.51.100.77";
		const send = () => call("/v1/errors/client", { method: "POST", auth: false, ip, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "x" }) });
		for (let i = 0; i < 10; i++) expect((await send()).status).not.toBe(429);
		expect((await send()).status).toBe(429);
		expect((await send()).status).toBe(429);
		const limited = rows("rate-limit");
		expect(limited).toEqual([expect.objectContaining({ level: "warn", status: 429, user_id: null, repeat_count: 1 })]);
		const context = JSON.parse(String(limited[0].context));
		expect(context).toMatchObject({ bucket: "strict", subject: "ip", path: "/v1/errors/client", method: "POST" });
		expect(String(limited[0].context) + String(limited[0].message)).not.toContain(ip);
	});

	it("an ordinary 401 / 404 is not recorded — the noise classification", async () => {
		expect((await call("/v1/errors", { auth: false })).status).toBe(401);
		expect((await call("/v1/no-such-route")).status).toBe(404);
		expect(rows()).toEqual([]);
	});
});

describe("a failure a route RETURNS is recorded where it is built", () => {
	const ticket = () => {
		d1.exec(
			`INSERT INTO instance_runtime_tasks (id, instance_id, user_id, type, status, payload, created_at, updated_at) VALUES ('t1', 'iA', 'u1', 'ticket', 'completed', '{"id":"t1","title":"Deploy"}', datetime('now'), datetime('now'))`,
		);
	};
	const ask = () => call("/v1/instances/iA/tasks/t1/thread", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "why did this fail?" }) });

	it("the ticket thread's model failure: 502 to the owner, an error row under their instance and task, secrets masked", async () => {
		ticket();
		ai.impl = async () => {
			throw Object.assign(new Error("upstream 502: Bearer sk-ant-api03-LEAKEDLEAKEDLEAKED rejected"), { status: 502 });
		};
		expect((await ask()).status).toBe(502);
		const [row] = rows("ticket-thread");
		expect(row).toMatchObject({ level: "error", status: 502, user_id: "u1", instance_id: "iA" });
		expect(JSON.parse(String(row.context))).toMatchObject({ taskId: "t1" });
		expect(String(row.message)).not.toContain("LEAKEDLEAKED");
	});

	it("an EMPTY answer is a recorded 502 as well, not a silent one", async () => {
		ticket();
		ai.impl = async () => ({ response: "   " });
		expect((await ask()).status).toBe(502);
		expect(rows("ticket-thread")).toEqual([expect.objectContaining({ status: 502, message: "The agent returned an empty answer.", instance_id: "iA" })]);
	});

	it("'runner not connected' is a 502 to the client and a WARN in the log — an expected state, not a bug", async () => {
		const res = await call("/v1/instances/iA/coding/close-sessions", { method: "POST" });
		expect(res.status).toBe(502);
		expect(rows("coding-diagnostics")).toEqual([expect.objectContaining({ level: "warn", status: 502, user_id: "u1", instance_id: "iA" })]);
	});
});

describe("the Durable Object's WebSocket handlers", () => {
	const make = () => {
		const storage = { get: async (k: string) => (k === "state" ? { agentId: "iA" } : undefined) };
		const agent = new AgentDO({ storage, getWebSockets: () => [] } as unknown as DurableObjectState, env);
		const sent: string[] = [];
		const ws = { send: (m: string) => sent.push(m), deserializeAttachment: () => ({ userId: "u1", agentId: "iA" }) } as unknown as WebSocket;
		return { agent, ws, sent };
	};

	it("a frame that is not JSON is the client's mistake: answered 'Invalid message', NOT recorded", async () => {
		const { agent, ws, sent } = make();
		await agent.webSocketMessage(ws, "not json{");
		expect(sent.map((m) => JSON.parse(m))).toEqual([{ type: "error", error: "Invalid message" }]);
		expect(rows()).toEqual([]);
	});

	it("a server failure behind the socket is recorded under the PINNED user and the DO's instance — it used to read 'Invalid message'", async () => {
		const { agent, ws, sent } = make();
		(agent as unknown as { handleChat: () => Promise<Response> }).handleChat = async () => {
			throw new TypeError("Cannot read properties of undefined (reading 'model')");
		};
		await agent.webSocketMessage(ws, JSON.stringify({ type: "chat", message: "hi", userId: "someone-else" }));
		expect(JSON.parse(sent[0]).error).not.toBe("Invalid message");
		expect(rows("agent-ws")).toEqual([expect.objectContaining({ level: "error", user_id: "u1", instance_id: "iA" })]);
		expect(String(rows("agent-ws")[0].message)).toMatch(/reading 'model'/);
	});

	it("a socket error the runtime reports is recorded (there was no handler)", async () => {
		const { agent, ws } = make();
		await agent.webSocketError(ws, new Error("socket reset"));
		expect(rows("agent-ws")).toEqual([expect.objectContaining({ user_id: "u1", instance_id: "iA" })]);
	});
});

describe("background bookkeeping that used to fail into the console", () => {
	it("a pipeline run whose record cannot be OPENED says so durably", async () => {
		failWhen = (sql) => (sql.includes("INTO pipeline_runs") ? "D1_ERROR: disk full" : null);
		expect(await openRun(env, { runId: "run-9", userId: "u1", instanceId: "iA", pipeline: "leads", trigger: "manual" })).toBe(false);
		expect(rows("pipeline-run-record")).toEqual([expect.objectContaining({ user_id: "u1", instance_id: "iA", run_id: "run-9" })]);
	});

	it("a run that cannot be CLOSED is recorded under its run — the 'running' row is explained, and the caller is told", async () => {
		await openRun(env, { runId: "run-7", userId: "u1", instanceId: "iA", pipeline: "leads", trigger: "manual" });
		failWhen = (sql) => (sql.startsWith("UPDATE pipeline_runs") ? "D1_ERROR: write refused" : null);
		expect(await closeRun(env, "run-7", "failed", { seen: 1, added: 0, skipped: 0, errors: 1 }, "crashed")).toBe(false);
		expect(d1.sqlite.prepare("SELECT status FROM pipeline_runs WHERE run_id = 'run-7'").get()).toEqual({ status: "running" });
		const [row] = rows("pipeline-run-record");
		expect(row).toMatchObject({ user_id: "u1", instance_id: "iA", run_id: "run-7" });
		expect(String(row.message)).toMatch(/may still read 'running'/);
	});

	it("a failed conversation summary is an error row under the DO's verified owner and instance, and callers still get null", async () => {
		const engine = new AgentStorageEngine({} as DurableObjectStorage, null, null, { run: async () => Promise.reject(new Error("model overloaded")) } as unknown as Ai, "iA", { DB: env.DB });
		const msg = { id: "m", role: "user", content: "hello", createdAt: new Date().toISOString() };
		expect(await engine.generateSummary([msg] as never, "@cf/meta/llama-3.2-3b-instruct")).toBeNull();
		expect(rows("storage")).toEqual([expect.objectContaining({ level: "error", user_id: "u1", instance_id: "iA" })]);
		expect(String(rows("storage")[0].message)).toMatch(/summarization failed: model overloaded/);
	});

	it("a summary model that answers without JSON is a warn, not a silent null", async () => {
		const engine = new AgentStorageEngine({} as DurableObjectStorage, null, null, { run: async () => ({ response: "I cannot do that" }) } as unknown as Ai, "iA", { DB: env.DB });
		expect(await engine.generateSummary([{ id: "m", role: "user", content: "x", createdAt: "" }] as never, "@cf/x")).toBeNull();
		expect(rows("storage")).toEqual([expect.objectContaining({ level: "warn", instance_id: "iA" })]);
	});

	it("the reauth sweep: one flow's failure is recorded under its instance, and the sweep's own failure too", async () => {
		const now = Date.now();
		const state = { clientType: "codex", method: "codex-device-auth", session: "s", runnerNode: null, status: "pending", startedAt: now - 11 * 60_000 };
		d1.exec(`UPDATE agent_instances SET config = '${JSON.stringify({ engineReauth: state })}' WHERE id = 'iA'`);
		reauth.failFinish = true;
		await runReauthExpiryWatch(env, now);
		expect(rows("reauth-expiry")).toEqual([expect.objectContaining({ user_id: "u1", instance_id: "iA" })]);

		failWhen = (sql) => (sql.includes("engineReauth.status") ? "D1_ERROR: unavailable" : null);
		await runReauthExpiryWatch(env, now);
		expect(rows("reauth-expiry").map((r) => r.message)).toContainEqual(expect.stringMatching(/reauth expiry sweep failed/));
	});
});
