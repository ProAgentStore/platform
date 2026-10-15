/**
 * #1085 — an error row keeps WHOSE it is, WHERE it happened, which RUN, how SEVERE and which BUILD,
 * through the write-side deduplication.
 *
 * Driven through the real `logError` against the real schema (`d1-sqlite.ts`, every migration
 * including 0239), and read back through the real readers — `listErrors` and the
 * `/v1/errors/summary` route. Every assertion is a row the table actually holds.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./d1-sqlite.js";
import { listErrors, logError, resetServerBuildForTests } from "./error-log.js";
import type { Env } from "../types.js";

const auth = vi.hoisted(() => ({ uid: "u1" }));
vi.mock("./auth.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./auth.js")>();
	return { ...actual, requireUser: async () => ({ uid: auth.uid, roles: [] }) };
});
const { errorRoutes } = await import("../routes/errors.js");

let d1: RealSchemaD1;
let env: Env;
beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["iA", "iB", "iC"] });
	seedTenant(d1, { userId: "u2", instanceIds: ["iZ"] });
	env = { DB: d1.DB } as unknown as Env;
	auth.uid = "u1";
	resetServerBuildForTests();
	vi.spyOn(Math, "random").mockReturnValue(0.5); // no opportunistic prune mid-test
});
afterEach(() => {
	d1.close();
	vi.restoreAllMocks();
	resetServerBuildForTests();
});

const errors = () => d1.sqlite.prepare("SELECT user_id, instance_id, run_id, level, repeat_count, build, context FROM error_log ORDER BY created_at, rowid").all() as Array<Record<string, unknown>>;
const traces = () => d1.sqlite.prepare("SELECT user_id, instance_id, trace_id, level FROM agent_events WHERE event = 'error' ORDER BY rowid").all() as Array<Record<string, unknown>>;
const fail = (context: Record<string, unknown>, extra: Partial<Parameters<typeof logError>[1]> = {}) =>
	logError(env, { source: "pipeline-step", message: "upstream 502", userId: "u1", context, ...extra });

describe("the same failure on instances A, B and C (#1085)", () => {
	it("stays three rows — B is findable, and each count is that instance's own", async () => {
		await fail({ instanceId: "iA" });
		await fail({ instanceId: "iB" });
		await fail({ instanceId: "iB" });
		await fail({ instanceId: "iC" });

		expect(errors().map((r) => [r.instance_id, r.repeat_count])).toEqual([
			["iA", 1],
			["iB", 2],
			["iC", 1],
		]);
		for (const [instanceId, count] of [["iA", 1], ["iB", 2], ["iC", 1]] as const) {
			const rows = await listErrors(env, { userId: "u1", instanceId });
			expect(rows.map((r) => [r.instance_id, r.repeat_count])).toEqual([[instanceId, count]]);
		}
		// Each instance's first occurrence reached the trace, under that instance.
		expect(traces().map((t) => t.instance_id)).toEqual(["iA", "iB", "iC"]);
	});

	it("a repeat inside ONE instance's ONE run still folds — the flood bound is kept, trace included", async () => {
		for (let i = 0; i < 5; i++) await fail({ instanceId: "iA", runId: "run-1" });
		expect(errors().map((r) => r.repeat_count)).toEqual([5]);
		expect(traces()).toHaveLength(1);
	});

	it("each run is its own row, readable by run id, and its trace carries the run", async () => {
		await fail({ instanceId: "iA", runId: "run-1" });
		await fail({ instanceId: "iA", runId: "run-2" });
		await fail({ instanceId: "iA", run_id: "run-2" });
		const r2 = await listErrors(env, { userId: "u1", runId: "run-2" });
		expect(r2.map((r) => [r.run_id, r.repeat_count])).toEqual([["run-2", 2]]);
		expect(traces().map((t) => t.trace_id)).toEqual(["run-1", "run-2"]);
	});
});

describe("severity survives (#1085)", () => {
	it("a warn is a warn in the log AND in the trace", async () => {
		await fail({ instanceId: "iA" }, { level: "warn" });
		expect(errors()[0].level).toBe("warn");
		expect(traces()[0].level).toBe("warn");
	});

	it("a warn and an error of the same text are never one row", async () => {
		await fail({ instanceId: "iA" }, { level: "warn" });
		await fail({ instanceId: "iA" });
		expect(errors().map((r) => r.level)).toEqual(["warn", "error"]);
	});
});

describe("ownership is verified, never taken on the caller's word (#1085)", () => {
	it("a row naming another owner's instance keeps its own user and loses the instance", async () => {
		await logError(env, { source: "x", message: "m", userId: "u2", context: { instanceId: "iA" } });
		expect(errors()).toEqual([expect.objectContaining({ user_id: "u2", instance_id: null })]);
		expect(await listErrors(env, { userId: "u1", instanceId: "iA" })).toEqual([]);
		expect(await listErrors(env, { userId: "u2", instanceId: "iA" })).toEqual([]);
		// …and its trace mirror is not filed under the instance either.
		expect(traces()).toEqual([expect.objectContaining({ user_id: "u2", instance_id: null })]);
	});

	it("two owners' identical failures never share a row", async () => {
		await logError(env, { source: "x", message: "m", userId: "u1", context: { instanceId: "iA" } });
		await logError(env, { source: "x", message: "m", userId: "u2", context: { instanceId: "iZ" } });
		expect(errors().map((r) => [r.user_id, r.instance_id, r.repeat_count])).toEqual([
			["u1", "iA", 1],
			["u2", "iZ", 1],
		]);
	});

	it("a Durable Object path that names no user is filed under the instance's verified owner", async () => {
		await logError(env, { source: "agent-do", message: "boom", context: { agentId: "iB" } });
		expect(errors()).toEqual([expect.objectContaining({ user_id: "u1", instance_id: "iB" })]);
	});

	it("a template DO (its name is an agent id) is filed under the agent's owner, with no instance", async () => {
		await logError(env, { source: "alarm", message: "boom", context: { agentId: "agent-1" } });
		expect(errors()).toEqual([expect.objectContaining({ user_id: "u1", instance_id: null })]);
	});

	it("an unknown name attributes nothing", async () => {
		await logError(env, { source: "alarm", message: "boom", context: { agentId: "nope" } });
		expect(errors()).toEqual([expect.objectContaining({ user_id: null, instance_id: null })]);
	});

	it("an untrusted client report keeps an instance only its own session owns, and never a run", async () => {
		await logError(env, { source: "client:window", message: "m", userId: null, untrusted: true, context: { instanceId: "iA", runId: "r" } });
		await logError(env, { source: "client:window", message: "m", userId: "u2", untrusted: true, context: { instanceId: "iA", runId: "r" } });
		await logError(env, { source: "client:window", message: "m", userId: "u1", untrusted: true, context: { instanceId: "iA", runId: "r" } });
		expect(errors().map((r) => [r.user_id, r.instance_id, r.run_id])).toEqual([
			[null, null, null],
			["u2", null, null],
			["u1", "iA", null],
		]);
	});

	it("POST /v1/errors/client is the untrusted path", async () => {
		const app = new Hono<{ Bindings: Env }>();
		app.route("/v1/errors", errorRoutes);
		auth.uid = "u2";
		await app.request("/v1/errors/client", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "m", context: { instanceId: "iA", runId: "r" } }) }, env);
		expect(errors()).toEqual([expect.objectContaining({ user_id: "u2", instance_id: null, run_id: null })]);
	});
});

describe("build identity on every entrypoint (#1085)", () => {
	it("a fresh isolate that never served a fetch stamps the deployed build from its own env", async () => {
		// A cron / Durable Object / Workflow isolate: `index.ts`'s fetch never ran, so nothing was stamped.
		await logError({ ...env, API_BUILD: "abc1234" }, { source: "alarm", message: "boom" });
		expect(errors()[0].build).toBe("abc1234");
	});

	it("a narrowed env without the var still gets the isolate's stamp once one exists", async () => {
		await logError({ ...env, API_BUILD: "abc1234" }, { source: "a", message: "1" });
		await logError({ DB: env.DB }, { source: "b", message: "2" });
		expect(errors().map((r) => r.build)).toEqual(["abc1234", "abc1234"]);
	});

	it("two builds never share a row", async () => {
		await logError({ ...env, API_BUILD: "old1" }, { source: "a", message: "m", build: "old1" });
		await logError({ ...env, API_BUILD: "old1" }, { source: "a", message: "m", build: "new2" });
		expect(errors().map((r) => r.build)).toEqual(["old1", "new2"]);
	});
});

describe("legacy collapsed rows are reported honestly (#1085)", () => {
	// A row from before migration 0239: one bucket, two samples, no verified instance.
	const legacy = () =>
		d1.exec(
			`INSERT INTO error_log (id, user_id, source, message, level, repeat_count, context, last_context, created_at, last_seen_at)
			 VALUES ('old', 'u1', 'pipeline-step', 'upstream 502', 'error', 3, '{"instanceId":"iA"}', '{"instanceId":"iC"}', datetime('now'), datetime('now'))`,
		);

	it("is never assigned to an instance it cannot prove — the exact read does not return it", async () => {
		legacy();
		expect(await listErrors(env, { userId: "u1", instanceId: "iA" })).toEqual([]);
		expect(await listErrors(env, { userId: "u1", instanceId: "iB" })).toEqual([]);
	});

	it("is still found by its samples in the summary, which says it is a lower bound", async () => {
		legacy();
		await fail({ instanceId: "iA" });
		const app = new Hono<{ Bindings: Env }>();
		app.route("/v1/errors", errorRoutes);
		const read = async (q: string) => (await (await app.request(`/v1/errors/summary?${q}`, {}, env)).json()) as { rows: number; total: number };
		// iA: the verified new row + the legacy row its first sample names.
		expect(await read("instance_id=iA")).toMatchObject({ rows: 2 });
		// iB: in the middle of the legacy bucket, never sampled — not invented.
		expect(await read("instance_id=iB")).toMatchObject({ rows: 0 });
		expect(await read("run_id=nope")).toMatchObject({ rows: 0 });
	});
});
