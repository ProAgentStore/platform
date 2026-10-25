/**
 * #1134 — four API surfaces whose failures never reached `error_log`, each driven at its real boundary
 * over the real migrated schema and read back from the table (and, for routes, through `GET /v1/errors`):
 *
 *   1. a 5xx a route RETURNS without recording it — the backstop in the request middleware;
 *   2. a route's `waitUntil` task that rejects — the Worker's wrapped execution context;
 *   3. `RelayDO` — a command that times out or is cut off, and a throw inside the relay;
 *   4. `RunnerUpdateWorkflow` — a failure that escapes the operation (`lib/runner-update-ops.test.ts`
 *      covers the operation's own throw and the machine's `failed` answer).
 *
 * Expected outcomes stay out, the way #1116 keeps caller 4xx out: a 4xx, a deliberate runner takeover,
 * a route that already recorded its failure (one row, not two), and the error endpoints themselves.
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

import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./lib/d1-sqlite.js";
import { resetServerBuildForTests } from "./lib/error-log.js";
import { logReturnedFailure } from "./lib/on-error.js";
import { withRequestId } from "./lib/request-context.js";
import { signSession } from "./lib/session.js";
import type { Env } from "./types.js";

const { default: worker, recordingWaitUntil } = await import("./index.js");
const { RelayDO } = await import("./relay-do.js");
const { runRunnerUpdateWorkflow } = await import("./lib/runner-update-workflow.js");

const KEY = "capture-gaps-test-key";
let d1: RealSchemaD1;
let failWhen: ((sql: string) => string | null) | null;
let env: Env;

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["iA"] });
	seedTenant(d1, { userId: "u2", instanceIds: ["iB"] });
	failWhen = null;
	resetServerBuildForTests();
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
	env = { DB, SESSION_SIGNING_KEY: KEY, API_BUILD: "gaps-build" } as unknown as Env;
	vi.spyOn(console, "error").mockImplementation(() => undefined);
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
	vi.spyOn(Math, "random").mockReturnValue(0.5);
});
afterEach(() => {
	d1.close();
	vi.restoreAllMocks();
});

const rows = () =>
	d1.sqlite.prepare("SELECT source, level, status, user_id, instance_id, message, context FROM error_log ORDER BY rowid").all() as Array<{
		source: string;
		level: string;
		status: number | null;
		user_id: string | null;
		instance_id: string | null;
		message: string;
		context: string | null;
	}>;
const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
const call = async (path: string, opts: { uid?: string; roles?: string[]; method?: string } = {}) => {
	const headers = new Headers({ "CF-Connecting-IP": "203.0.113.9", Authorization: `Bearer ${await signSession(opts.uid ?? "u1", KEY, { roles: opts.roles })}` });
	return worker.fetch(new Request(`https://api.proagentstore.online${path}`, { method: opts.method ?? "GET", headers }), env, ctx);
};

describe("1. a 5xx a route returns without recording it (#1134)", () => {
	it("is recorded once, under the signed-in owner, with the error text the caller got — a dependency's 503 is a warn", async () => {
		// The GitHub App is not configured on this deployment: `routes/github.ts` returns 503 itself.
		const res = await call("/v1/github/installations");
		expect(res.status).toBe(503);
		expect(rows()).toEqual([expect.objectContaining({ source: "route-5xx", level: "warn", status: 503, user_id: "u1", message: "GitHub App not configured" })]);
		expect(JSON.parse(rows()[0].context as string)).toEqual({ path: "/v1/github/installations", method: "GET" });
		// And the owner reads it back through the reader `list_errors` calls.
		const read = (await (await call("/v1/errors?source=route-5xx")).json()) as { errors: Array<Record<string, unknown>> };
		expect(read.errors).toEqual([expect.objectContaining({ source: "route-5xx", status: 503 })]);
	});

	it("a route whose 503 is its OWN fault records it at error itself — and the backstop adds no second row", async () => {
		failWhen = (sql) => (sql.includes("FROM admin_audit_log") ? "D1_ERROR: no such column: bogus" : null);
		const res = await call("/v1/audit/admin-actions", { uid: "admin-1", roles: ["user", "admin"] });
		failWhen = null;
		expect(res.status).toBe(503);
		expect(rows()).toEqual([expect.objectContaining({ source: "admin-audit", level: "error", status: 503 })]);
		expect(rows()[0].message).toMatch(/admin audit read failed: D1_ERROR: no such column: bogus/);
	});

	it("never records a failure of the error endpoints themselves — a failing log must not report itself", async () => {
		failWhen = (sql) => (sql.startsWith("SELECT id, created_at, user_id, source") ? "D1_ERROR: storage unavailable" : null);
		const res = await call("/v1/errors?cursor=newest");
		failWhen = null;
		expect(res.status).toBe(503);
		expect(rows()).toEqual([]);
	});

	it("a 4xx is the caller's, and records nothing", async () => {
		expect((await call("/v1/instances/does-not-exist/trace")).status).toBe(404);
		expect(rows()).toEqual([]);
	});

	it("level by status: a 500 is an error, 501 (not configured here) and 502–504 (a dependency) are warns; the path's instance is kept only for its owner", async () => {
		const json = (status: number, error: string) => new Response(JSON.stringify({ error }), { status, headers: { "Content-Type": "application/json" } });
		await logReturnedFailure(env, { response: json(500, "it broke"), path: "/v1/instances/iA/thing", method: "POST", userId: "u1" });
		await logReturnedFailure(env, { response: new Response("GitHub OAuth not configured", { status: 501, headers: { "Content-Type": "text/plain; charset=UTF-8" } }), path: "/v1/auth/github/start", method: "GET" });
		await logReturnedFailure(env, { response: json(502, "Runner not connected"), path: "/v1/instances/iB/coding/x", method: "POST", userId: "u1" });
		await logReturnedFailure(env, { response: new Response(null, { status: 504 }), path: "/v1/x", method: "GET" });
		await logReturnedFailure(env, { response: json(409, "conflict"), path: "/v1/x", method: "GET" });
		expect(rows().map((r) => [r.level, r.status, r.message, r.instance_id])).toEqual([
			["error", 500, "it broke", "iA"],
			["warn", 501, "GitHub OAuth not configured", null],
			// iB is u2's instance: the path names it, but this row is u1's, so it is not filed there.
			["warn", 502, "Runner not connected", null],
			["warn", 504, "HTTP 504", null],
		]);
	});
});

describe("2. a route's waitUntil task that rejects (#1134)", () => {
	it("is recorded through logUnhandled with its stack, path and request id — and the task still ran", async () => {
		const held: Promise<unknown>[] = [];
		const raw = { waitUntil: (p: Promise<unknown>) => void held.push(p), passThroughOnException: () => undefined } as unknown as ExecutionContext;
		const wrapped = recordingWaitUntil(raw, env, new Request("https://api.proagentstore.online/v1/instances/iA/apply-resume", { method: "POST" }));
		let ran = false;
		withRequestId("ray-bg", () =>
			wrapped.waitUntil(
				(async () => {
					ran = true;
					throw new Error("background write refused");
				})(),
			),
		);
		await Promise.all(held);
		expect(ran).toBe(true);
		const [row] = rows();
		expect(row).toMatchObject({ source: "unhandled", level: "error", status: 500 });
		expect(row.message).toMatch(/background write refused/);
		expect(JSON.parse(row.context as string)).toMatchObject({ path: "/v1/instances/iA/apply-resume", method: "POST waitUntil", stack: expect.stringMatching(/background write refused/) });
		expect(d1.sqlite.prepare("SELECT request_id FROM error_log").get()).toEqual({ request_id: "ray-bg" });
	});

	it("a task that succeeds records nothing, and a transient one is a warn", async () => {
		const held: Promise<unknown>[] = [];
		const wrapped = recordingWaitUntil({ waitUntil: (p: Promise<unknown>) => void held.push(p) } as unknown as ExecutionContext, env, new Request("https://api.proagentstore.online/v1/x"));
		wrapped.waitUntil(Promise.resolve("fine"));
		wrapped.waitUntil(Promise.reject(new Error("D1_ERROR: Network connection lost.")));
		await Promise.all(held);
		expect(rows()).toEqual([expect.objectContaining({ source: "transient", level: "warn" })]);
	});
});

describe("3. RelayDO (#1134)", () => {
	/** A runner socket that answers pings — and, once `silent`, nothing at all. */
	const relay = (name: string) => {
		const sent: string[] = [];
		let silent = false;
		const socket = {
			send(data: string) {
				sent.push(data);
				if (data === "ping" && !silent) queueMicrotask(() => void r.webSocketMessage(socket as unknown as WebSocket, "pong"));
			},
			close() {},
		};
		const state = { id: { name }, getWebSockets: () => [socket], acceptWebSocket: () => undefined };
		const r = new RelayDO(state as unknown as DurableObjectState, env);
		return { r, sent, socket, goSilent: () => (silent = true) };
	};
	const command = (r: InstanceType<typeof RelayDO>, body: unknown) =>
		r.fetch(new Request("https://relay/command", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }));

	it("a command that times out is the 504 its caller always got, and a warn row filed under the instance's owner", async () => {
		const { r } = relay("iA:node:macbook");
		const res = await command(r, { path: "/coding/capture?session=abc", timeoutMs: 20 });
		expect(res.status).toBe(504);
		expect(await res.json()).toEqual({ error: "Relay command timed out" });
		expect(rows()).toEqual([expect.objectContaining({ source: "relay", level: "warn", user_id: "u1", instance_id: "iA", message: "Relay command timed out after 20 ms" })]);
		// The runner path without its query: an id is not a label.
		expect(JSON.parse(rows()[0].context as string)).toMatchObject({ endpoint: "/command", runnerPath: "/coding/capture", outcome: "timeout", node: "macbook" });
	});

	it("a command cut off by the runner disconnecting is recorded; one ended by the owner's own eviction is not", async () => {
		const cut = relay("iA:node:macbook");
		const pending = command(cut.r, { path: "/tasks", timeoutMs: 5_000 });
		await vi.waitFor(() => expect(cut.sent.some((s) => s.includes('"path":"/tasks"'))).toBe(true));
		await cut.r.webSocketClose(cut.socket as unknown as WebSocket);
		expect((await pending).status).toBe(504);
		expect(rows()).toEqual([expect.objectContaining({ source: "relay", level: "warn", message: "Relay command failed: Runner disconnected" })]);

		const evicted = relay("iA:node:desk");
		const waiting = command(evicted.r, { path: "/tasks", timeoutMs: 5_000 });
		await vi.waitFor(() => expect(evicted.sent.some((s) => s.includes('"path":"/tasks"'))).toBe(true));
		evicted.goSilent();
		const verdict = (await (await evicted.r.fetch(new Request("https://relay/evict-stale", { method: "POST" }))).json()) as { evicted: number };
		expect(verdict.evicted).toBe(1);
		expect((await waiting).status).toBe(504);
		expect(rows()).toHaveLength(1);
	});

	it("a throw inside the relay is an error row with its stack — and is rethrown, so the caller sees what it always saw", async () => {
		const { r } = relay("iA:node:macbook");
		await expect(command(r, "{not json")).rejects.toThrow();
		const [row] = rows();
		expect(row).toMatchObject({ source: "relay", level: "error", user_id: "u1", instance_id: "iA" });
		expect(JSON.parse(row.context as string)).toMatchObject({ endpoint: "/command", stack: expect.any(String) });
	});

	it("a STALE socket closing does not fail a command running on the live one (#1344)", async () => {
		const { r, sent, socket } = relay("iA:node:macbook");
		const pending = command(r, { path: "/coding/capture", timeoutMs: 5_000 });
		await vi.waitFor(() => expect(sent.some((s) => s.includes('"path":"/coding/capture"'))).toBe(true));
		// Some other socket — the one the liveness probe just closed — reports its close.
		await r.webSocketClose({ send() {}, close() {} } as unknown as WebSocket);
		const id = (JSON.parse(sent.find((s) => s.includes('"path":"/coding/capture"')) as string) as { id: string }).id;
		await r.webSocketMessage(socket as unknown as WebSocket, JSON.stringify({ id, status: 200, result: { pane: "ok" } }));
		expect((await pending).status).toBe(200);
		// …and the live socket's own close still fails what it was carrying.
		const second = command(r, { path: "/tasks", timeoutMs: 5_000 });
		await vi.waitFor(() => expect(sent.some((s) => s.includes('"path":"/tasks"'))).toBe(true));
		await r.webSocketClose(socket as unknown as WebSocket);
		expect((await second).status).toBe(504);
	});

	it("a socket error is a warn row", async () => {
		const { r, socket } = relay("iA:node:macbook");
		await r.webSocketError(socket as unknown as WebSocket, new Error("ECONNRESET"));
		expect(rows()).toEqual([expect.objectContaining({ source: "relay", level: "warn", message: "Runner WebSocket error: ECONNRESET", instance_id: "iA" })]);
	});
});

describe("4. RunnerUpdateWorkflow (#1134)", () => {
	const event = { payload: { opId: "op-1", userId: "u1", node: "macbook", machineId: null } } as never;

	it("a failure that escapes the operation is an error row under its owner — and is rethrown, so the engine still retries the step", async () => {
		const step = { do: async () => Promise.reject(new Error("D1_ERROR: database is locked")) };
		await expect(runRunnerUpdateWorkflow(env, event, step as never)).rejects.toThrow(/database is locked/);
		const [row] = rows();
		expect(row).toMatchObject({ source: "runner-update", level: "error", user_id: "u1" });
		expect(row.message).toMatch(/runner_update workflow failed: Error: D1_ERROR: database is locked/);
		expect(JSON.parse(row.context as string)).toMatchObject({ opId: "op-1", node: "macbook", kind: "update", stack: expect.any(String) });
	});

	it("a step that completes records nothing", async () => {
		const step = { do: async () => ({ action: "up-to-date" }) };
		await expect(runRunnerUpdateWorkflow(env, event, step as never)).resolves.toEqual({ action: "up-to-date" });
		expect(rows()).toEqual([]);
	});
});
