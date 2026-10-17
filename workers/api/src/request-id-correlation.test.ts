/**
 * #1135 — an `error_log` row written inside a request carries that request's id, readable through the
 * real reader (`GET /v1/errors`, what MCP `list_errors` calls) and shared with the request's trace row
 * and the `X-Request-Id` its response carried. Driven through the Worker's own `fetch` over the real
 * migrated schema; failures are injected at the D1 boundary, never by stubbing the logging under test.
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
import { logError, resetServerBuildForTests } from "./lib/error-log.js";
import { fakeKv } from "./lib/kv-fake.js";
import { signSession } from "./lib/session.js";
import { BACKOFF_MS, drainTelemetrySpool } from "./lib/telemetry-spool.js";
import type { Env } from "./types.js";

const { default: worker } = await import("./index.js");

const KEY = "request-id-test-key";
let d1: RealSchemaD1;
let kv: ReturnType<typeof fakeKv>;
let failWhen: ((sql: string) => string | null) | null;
let env: Env;

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["iA"] });
	seedTenant(d1, { userId: "u2", instanceIds: ["iB"] });
	kv = fakeKv();
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
	env = { DB, OAUTH_KV: kv.kv, SESSION_SIGNING_KEY: KEY, API_BUILD: "rid-build" } as unknown as Env;
	vi.spyOn(console, "error").mockImplementation(() => undefined);
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
	vi.spyOn(Math, "random").mockReturnValue(0.5);
});
afterEach(() => {
	d1.close();
	vi.restoreAllMocks();
});

const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
const call = async (path: string, opts: { uid?: string; headers?: Record<string, string> } = {}) => {
	const headers = new Headers({ "CF-Connecting-IP": "203.0.113.9", Authorization: `Bearer ${await signSession(opts.uid ?? "u1", KEY)}`, ...opts.headers });
	return worker.fetch(new Request(`https://api.proagentstore.online${path}`, { headers }), env, ctx);
};
/** A genuine crash of the error reader itself: a request that fails inside the Worker, and is logged. */
const crashReads = (sql: string) => (sql.startsWith("SELECT id, created_at, user_id, source") ? "no such column: bogus" : null);
const crash = async (headers?: Record<string, string>) => {
	failWhen = crashReads;
	const res = await call("/v1/errors", { headers });
	failWhen = null;
	expect(res.status).toBe(500);
	return res;
};
const rows = () => d1.sqlite.prepare("SELECT source, request_id, last_request_id, repeat_count FROM error_log ORDER BY rowid").all() as Array<Record<string, unknown>>;
/** The reader `list_errors` calls, filtered to one request. */
const byRequest = async (requestId: string, uid = "u1") =>
	((await (await call(`/v1/errors?request_id=${encodeURIComponent(requestId)}`, { uid })).json()) as { errors: Array<Record<string, unknown>> }).errors;

describe("a request id on error_log (#1135)", () => {
	it("a crash's row carries the id its 500 answered with, is found by it through GET /v1/errors, and the trace row shares it", async () => {
		const res = await crash({ "cf-ray": "8d1f0a2b3c4d5e6f-SYD" });
		const requestId = res.headers.get("X-Request-Id");
		expect(requestId).toBe("8d1f0a2b3c4d5e6f-SYD");
		expect(rows()).toEqual([expect.objectContaining({ source: "unhandled", request_id: requestId, last_request_id: null })]);

		const found = await byRequest(requestId as string);
		expect(found).toEqual([expect.objectContaining({ source: "unhandled", user_id: "u1", request_id: requestId })]);
		// Another account's reader cannot reach it by its id: the request filter never widens `scope`.
		expect(await byRequest(requestId as string, "u2")).toEqual([]);

		const trace = d1.sqlite.prepare("SELECT context FROM agent_events WHERE event = 'error'").all() as Array<{ context: string }>;
		expect(trace.map((t) => JSON.parse(t.context).requestId)).toEqual([requestId]);
	});

	it("takes the caller's X-Request-Id when it is id-shaped — the MCP Worker's call id — and otherwise the edge's ray, else a fresh one", async () => {
		const mcp = await crash({ "X-Request-Id": "mcp-1f2e3d4c-aaaa-bbbb-cccc-0123456789ab", "cf-ray": "ray-1" });
		expect(mcp.headers.get("X-Request-Id")).toBe("mcp-1f2e3d4c-aaaa-bbbb-cccc-0123456789ab");
		const junk = await crash({ "X-Request-Id": "not an id; DROP TABLE", "cf-ray": "ray-2" });
		expect(junk.headers.get("X-Request-Id")).toBe("ray-2");
		const bare = await crash({ "X-Request-Id": "x".repeat(129) });
		expect(bare.headers.get("X-Request-Id")).toMatch(/^[0-9a-f-]{36}$/);
	});

	it("every response says its id, not only a failed one", async () => {
		const res = await call("/v1/errors", { headers: { "cf-ray": "ray-ok" } });
		expect(res.status).toBe(200);
		expect(res.headers.get("X-Request-Id")).toBe("ray-ok");
	});

	it("a repeat folds into one row that names BOTH ends — the request that opened it and the latest one — and either finds it", async () => {
		await crash({ "cf-ray": "ray-first" });
		await crash({ "cf-ray": "ray-second" });
		expect(rows()).toEqual([expect.objectContaining({ request_id: "ray-first", last_request_id: "ray-second", repeat_count: 2 })]);
		expect(await byRequest("ray-first")).toHaveLength(1);
		expect(await byRequest("ray-second")).toHaveLength(1);
		expect(await byRequest("ray-other")).toEqual([]);
	});

	it("a row the database refused keeps its request id through the spool's replay", async () => {
		failWhen = (sql) => crashReads(sql) ?? (/INSERT INTO error_log|UPDATE error_log|INSERT INTO agent_events/.test(sql) ? "D1_ERROR: storage unavailable" : null);
		expect((await call("/v1/errors", { headers: { "cf-ray": "ray-spooled" } })).status).toBe(500);
		failWhen = null;
		expect(rows()).toEqual([]);
		expect(await drainTelemetrySpool(env, Date.now() + BACKOFF_MS[0])).toMatchObject({ delivered: 1 });
		expect(rows()).toEqual([expect.objectContaining({ source: "unhandled", request_id: "ray-spooled" })]);
	});

	it("a browser report's row carries the id of the request that delivered it", async () => {
		const res = await worker.fetch(
			new Request("https://api.proagentstore.online/v1/errors/client", {
				method: "POST",
				headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.9", "cf-ray": "ray-client" },
				body: JSON.stringify({ id: "evt-0001-rid", source: "app", message: "boom" }),
			}),
			env,
			ctx,
		);
		expect(res.status).toBe(200);
		expect(rows()).toEqual([expect.objectContaining({ source: "client:app", request_id: "ray-client" })]);
	});

	it("outside any request — a Durable Object, Workflow or cron — the row says so with NULL, never a borrowed id", async () => {
		await logError(env, { source: "alarm", message: "outside a request", userId: "u1" });
		expect(rows()).toEqual([expect.objectContaining({ source: "alarm", request_id: null })]);
	});
});
