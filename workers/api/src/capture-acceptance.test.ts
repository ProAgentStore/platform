/**
 * #1091 — local end-to-end acceptance for epic #1083: a failure injected at a REAL entrypoint travels
 * capture → persistence (or spool → replay) → retrieval through the authorized reader the MCP tools
 * call, with its owner, build, stack and count intact and its tenant isolation held.
 *
 * The per-surface capture tests already exist (`entrypoint-capture.test.ts`, `host-template-capture`,
 * `browser-error-delivery`, `runner-crash-ingest`, `lib/telemetry-spool`, `routes/history-retrieval`,
 * and the MCP worker's `call-audit`). What none of them drove is the Worker's own cron entrypoint,
 * the Durable Object alarm, or the whole chain through a sink outage to the reader. This file does,
 * against the real migrated schema; failures are injected at the D1 boundary, never by stubbing the
 * logging under test. It is LOCAL evidence: see `docs/capture-matrix.md` for what is and is not
 * verified live.
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
import { fakeKv } from "./lib/kv-fake.js";
import { signSession } from "./lib/session.js";
import { BACKOFF_MS, drainTelemetrySpool } from "./lib/telemetry-spool.js";
import type { Env } from "./types.js";

const { default: worker } = await import("./index.js");
const { AgentDO } = await import("./agent-do.js");

const KEY = "capture-acceptance-test-key";
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
	env = { DB, OAUTH_KV: kv.kv, SESSION_SIGNING_KEY: KEY, API_BUILD: "acceptance-build" } as unknown as Env;
	vi.spyOn(console, "error").mockImplementation(() => undefined);
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
	vi.spyOn(Math, "random").mockReturnValue(0.5);
});
afterEach(() => {
	d1.close();
	vi.restoreAllMocks();
});

const rows = (source?: string) =>
	(d1.sqlite.prepare("SELECT source, level, status, user_id, instance_id, message, context, build, repeat_count FROM error_log ORDER BY rowid").all() as Array<Record<string, unknown>>).filter(
		(r) => !source || r.source === source,
	);
const ctx = () => {
	const pending: Promise<unknown>[] = [];
	return { pending, ctx: { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException: () => undefined } as unknown as ExecutionContext };
};
const call = async (path: string, uid = "u1") => {
	const headers = new Headers({ "CF-Connecting-IP": "203.0.113.9", Authorization: `Bearer ${await signSession(uid, KEY)}` });
	return worker.fetch(new Request(`https://api.proagentstore.online${path}`, { headers }), env, ctx().ctx);
};
/** The reader `list_errors` calls (`GET /v1/errors`), as one account. */
const readErrors = async (uid: string) => ((await (await call("/v1/errors?limit=50", uid)).json()) as { errors: Array<Record<string, unknown>> }).errors;

describe("the cron entrypoint (index.ts default.scheduled)", () => {
	it("a failing terminal-snapshot sweep is recorded under its cron path and build — it used to vanish (#1119)", async () => {
		failWhen = (sql) => (sql.includes("FROM coding_timeline") && sql.includes("GROUP BY session_id") ? "D1_ERROR: no such table: coding_timeline_x" : null);
		const { pending, ctx: c } = ctx();
		await worker.scheduled({ scheduledTime: Date.parse("2026-10-16T12:01:00Z"), cron: "* * * * *" } as ScheduledEvent, env, c);
		// Every sweep is its own failure domain: the tick settles even though one of them failed.
		const settled = await Promise.allSettled(pending);
		expect(settled.every((s) => s.status === "fulfilled")).toBe(true);
		const swept = rows("unhandled").filter((r) => JSON.parse(String(r.context)).path === "scheduled:terminal-snapshots");
		expect(swept).toEqual([expect.objectContaining({ level: "error", status: 500, build: "acceptance-build", repeat_count: 1 })]);
		expect(JSON.parse(String(swept[0].context))).toMatchObject({ method: "CRON", stack: expect.stringMatching(/coding_timeline_x/) });
	});
	it("a TRANSIENT sweep failure (D1 'Network connection lost') stays warn, under `transient` — logUnhandled's own rule (#1119)", async () => {
		failWhen = (sql) => (sql.includes("FROM coding_timeline") && sql.includes("GROUP BY session_id") ? "D1_ERROR: Network connection lost." : null);
		const { pending, ctx: c } = ctx();
		await worker.scheduled({ scheduledTime: Date.parse("2026-10-16T12:02:00Z"), cron: "* * * * *" } as ScheduledEvent, env, c);
		expect((await Promise.allSettled(pending)).every((s) => s.status === "fulfilled")).toBe(true);
		const transient = rows("transient").filter((r) => JSON.parse(String(r.context)).path === "scheduled:terminal-snapshots");
		expect(transient).toEqual([expect.objectContaining({ level: "warn", status: 503, build: "acceptance-build" })]);
		expect(rows("unhandled").filter((r) => JSON.parse(String(r.context)).path === "scheduled:terminal-snapshots")).toEqual([]);
	});
});

describe("the Durable Object alarm", () => {
	it("a crashed alarm is recorded with its stack and rethrown, so Cloudflare still retries it", async () => {
		let reads = 0;
		const storage = {
			get: async () => {
				reads++;
				throw new Error("storage reset during deploy rollover");
			},
		};
		const agent = new AgentDO({ storage, getWebSockets: () => [] } as unknown as DurableObjectState, env);
		await expect(agent.alarm()).rejects.toThrow(/storage reset/);
		expect(reads).toBeGreaterThan(0);
		const [row] = rows("alarm");
		expect(row).toMatchObject({ level: "error", build: "acceptance-build" });
		expect(String(row.message)).toMatch(/DO alarm crashed: storage reset/);
		expect(JSON.parse(String(row.context)).stack).toMatch(/storage reset/);
	});
});

describe("capture → sink outage → replay → retrieval, through the authorized reader", () => {
	const genuine = (sql: string) => (sql.startsWith("SELECT id, created_at, user_id, source") ? "no such column: bogus" : null);
	const errorLogDown = (sql: string) => (/INSERT INTO error_log|UPDATE error_log|INSERT INTO agent_events/.test(sql) ? "D1_ERROR: storage unavailable" : null);

	it("two crashes during an error_log outage are spooled, replayed once, and read back by their owner only", async () => {
		// The request entrypoint crashes twice while the log itself refuses writes.
		failWhen = (sql) => genuine(sql) ?? errorLogDown(sql);
		expect((await call("/v1/errors")).status).toBe(500);
		expect((await call("/v1/errors")).status).toBe(500);
		expect(rows()).toEqual([]);
		const spooled = [...kv.data.keys()].filter((k) => k.startsWith("tel_spool:error_log:"));
		expect(spooled).toHaveLength(2);

		// The store recovers; the cron's drain replays what it refused — and a second drain adds nothing.
		failWhen = null;
		expect(await drainTelemetrySpool(env, Date.now() + BACKOFF_MS[0])).toMatchObject({ delivered: 2, dead: 0 });
		expect(await drainTelemetrySpool(env, Date.now() + BACKOFF_MS[1])).toMatchObject({ delivered: 0 });
		expect([...kv.data.keys()].filter((k) => k.startsWith("tel_spool:error_log:"))).toEqual([]);

		// Retrieval: the owner reads both occurrences with their build and stack, newest first.
		const mine = (await readErrors("u1")).filter((r) => r.source === "unhandled");
		expect(mine.reduce((n, r) => n + Number(r.repeat_count), 0)).toBe(2);
		for (const r of mine) {
			expect(r).toMatchObject({ user_id: "u1", level: "error", status: 500, build: "acceptance-build" });
			expect(JSON.parse(String(r.context))).toMatchObject({ path: "/v1/errors", method: "GET", stack: expect.stringMatching(/no such column: bogus/) });
		}
		// Isolation: another account's reader never sees them.
		expect((await readErrors("u2")).filter((r) => r.source === "unhandled")).toEqual([]);
	});

	it("an outage of the spool as well is counted as loss, not hidden — and the caller's answer is unchanged", async () => {
		failWhen = (sql) => genuine(sql) ?? errorLogDown(sql);
		kv.failPuts((name) => name.startsWith("tel_spool:"));
		expect((await call("/v1/errors")).status).toBe(500);
		expect([...kv.data.keys()].filter((k) => k.startsWith("tel_spool:"))).toEqual([]);
		const lost = [...kv.data.entries()].filter(([k]) => k.startsWith("tel_loss:error_log:"));
		expect(lost.map(([, v]) => Number(v.value))).toEqual([1]);
	});
});
