/**
 * #1087 — runner crash reports reach the platform log, once, under the right account.
 *
 * End to end: the CLI's own delivery code (`packages/cli/src/crash-delivery.ts`) sends to the real
 * API Worker (`index.ts` `default.fetch`, real schema), and the result is read back with
 * `listErrors` — what MCP `list_errors(source: "runner-crash")` reads. "Offline" is a fetch that
 * fails; "storage down" is a D1 that refuses the log write.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { listErrors } from "./lib/error-log.js";
import { signSession } from "./lib/session.js";
import type { Env } from "./types.js";

const { default: api } = await import("./index.js");
// By computed path: the CLI is a Node package this Worker's typecheck must not follow.
const CLI = "../../../packages/cli/src";
type Paths = { runtimeFile: string; cliFile: string; ledgerFile: string };
type Report = { id: string; kind: string; message: string; account?: string };
const delivery = (await import(/* @vite-ignore */ `${CLI}/crash-delivery.js`)) as {
	crashPaths: (configDir: string, account: string, dataDir?: string) => Paths;
	deliverCrashReports: (o: { apiBase: string; token: string; account: string; paths: Paths; fetchImpl?: typeof fetch }) => Promise<{ delivered: number; pending: number; error?: string }>;
	recordChildExit: (o: Record<string, unknown>) => Report;
};
const crash = (await import(/* @vite-ignore */ `${CLI}/crash-reports.js`)) as {
	CrashLog: new (path: string, base?: Record<string, unknown>) => { record: (r: Report) => boolean };
	crashReport: (r: Record<string, unknown>) => Report;
	crashAccountKey: (login: string) => string;
};

const KEY = "runner-crash-test-key";
let d1: RealSchemaD1;
let env: Env;
let dir: string;
let failLogWrite = false;
let online = true;
beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["iA"] });
	seedTenant(d1, { userId: "u2", instanceIds: ["iZ"] });
	dir = mkdtempSync(join(tmpdir(), "pags-crash-ingest-"));
	failLogWrite = false;
	online = true;
	const DB = new Proxy(d1.DB, {
		get(target, prop) {
			if (prop === "prepare") {
				return (sql: string) => {
					if (failLogWrite && sql.startsWith("INSERT INTO error_log")) throw new Error("D1_ERROR: storage unavailable");
					return target.prepare(sql);
				};
			}
			const v = Reflect.get(target, prop);
			return typeof v === "function" ? v.bind(target) : v;
		},
	});
	env = { DB, SESSION_SIGNING_KEY: KEY, API_BUILD: "b1" } as unknown as Env;
	vi.spyOn(console, "error").mockImplementation(() => undefined);
	vi.spyOn(Math, "random").mockReturnValue(0.5);
});
afterEach(() => {
	d1.close();
	rmSync(dir, { recursive: true, force: true });
	vi.restoreAllMocks();
});

const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
/** The CLI's fetch, pointed at the real API Worker — or failing, while "offline". */
const fetchImpl = (async (url: string, init: RequestInit) => {
	if (!online) throw new TypeError("fetch failed: ECONNREFUSED");
	const headers = new Headers(init.headers);
	headers.set("CF-Connecting-IP", "192.0.2.44");
	return api.fetch(new Request(url, { ...init, headers }), env, ctx);
}) as unknown as typeof fetch;
const deliverAs = async (login: string, uid: string) =>
	delivery.deliverCrashReports({ apiBase: "https://api.proagentstore.online", token: await signSession(uid, KEY), account: login, paths: delivery.crashPaths(join(dir, "config"), login, join(dir, "runner")), fetchImpl });
const runtimeCrash = (login: string, extra: Record<string, unknown> = {}) => {
	const report = crash.crashReport({ source: "runtime", account: crash.crashAccountKey(login), build: "0.4.130", kind: "uncaught_exception", message: "TypeError: x is undefined", stack: "TypeError: x is undefined\n    at run (runner.ts:1)", ...extra });
	new crash.CrashLog(join(dir, "runner", "crash-reports.json")).record(report);
	return report;
};
const crashRows = (uid: string) => listErrors(env, { userId: uid, source: "runner-crash" });

describe("runner crash reports through the real API (#1087)", () => {
	it("offline then reconnected: pending, then ONE log row with build, kind and the verified instance — and a repeat sends nothing", async () => {
		const report = runtimeCrash("alice", { instanceId: "iA", taskId: "task_7" });
		online = false;
		expect(await deliverAs("alice", "u1")).toMatchObject({ delivered: 0, pending: 1 });
		expect(await crashRows("u1")).toEqual([]);

		online = true;
		expect(await deliverAs("alice", "u1")).toEqual({ delivered: 1, pending: 0 });
		const rows = await crashRows("u1");
		expect(rows).toEqual([expect.objectContaining({ source: "runner-crash", level: "error", build: "0.4.130", instance_id: "iA", run_id: "task_7" })]);
		expect(JSON.parse(String(rows[0].context))).toMatchObject({ crashId: report.id, kind: "uncaught_exception", reporter: "runtime" });

		expect(await deliverAs("alice", "u1")).toEqual({ delivered: 0, pending: 0 });
		expect(await crashRows("u1")).toHaveLength(1);
	});

	it("the same report delivered twice (a lost acknowledgement) is still one row", async () => {
		const report = runtimeCrash("alice");
		const post = async () =>
			api.fetch(
				new Request("https://api.proagentstore.online/v1/errors/runner-crashes", {
					method: "POST",
					headers: { Authorization: `Bearer ${await signSession("u1", KEY)}`, "Content-Type": "application/json", "CF-Connecting-IP": "192.0.2.45" },
					body: JSON.stringify({ reports: [report] }),
				}),
				env,
				ctx,
			);
		expect(await (await post()).json()).toEqual({ accepted: [report.id], rejected: [] });
		expect(await (await post()).json()).toEqual({ accepted: [report.id], rejected: [] });
		expect(await crashRows("u1")).toHaveLength(1);
		expect(d1.sqlite.prepare("SELECT COUNT(*) AS n FROM runner_crash_reports").get()).toEqual({ n: 1 });
	});

	it("is filed under the SIGNED-IN account; an instance that account does not own is dropped", async () => {
		runtimeCrash("alice", { instanceId: "iZ" }); // iZ is u2's
		await deliverAs("alice", "u1");
		expect(await crashRows("u1")).toEqual([expect.objectContaining({ user_id: "u1", instance_id: null })]);
		expect(await crashRows("u2")).toEqual([]);
	});

	it("a signal-killed runtime recorded by the CLI arrives with its signal", async () => {
		delivery.recordChildExit({ paths: delivery.crashPaths(join(dir, "config"), "alice", join(dir, "runner")), account: "alice", build: "0.4.130", kind: "runner_exit", what: "the local runtime", code: null, signal: "SIGKILL", tail: ["last line"] });
		await deliverAs("alice", "u1");
		const [row] = await crashRows("u1");
		expect(row.message).toBe("runner_exit: the local runtime was killed by SIGKILL");
		expect(JSON.parse(String(row.context))).toMatchObject({ kind: "runner_exit", reporter: "cli", signal: "SIGKILL", tail: ["last line"] });
	});

	it("storage down: the report is NOT acknowledged, so it is sent again and lands once storage is back", async () => {
		runtimeCrash("alice");
		failLogWrite = true;
		expect(await deliverAs("alice", "u1")).toMatchObject({ delivered: 0, pending: 1 });
		failLogWrite = false;
		expect(await deliverAs("alice", "u1")).toMatchObject({ delivered: 1, pending: 0 });
		expect(await crashRows("u1")).toHaveLength(1);
	});

	it("a malformed report is rejected by name, and an unauthenticated call is refused", async () => {
		const res = await api.fetch(
			new Request("https://api.proagentstore.online/v1/errors/runner-crashes", {
				method: "POST",
				headers: { Authorization: `Bearer ${await signSession("u1", KEY)}`, "Content-Type": "application/json", "CF-Connecting-IP": "192.0.2.46" },
				body: JSON.stringify({ reports: [{ id: "c1", kind: "made_up", message: "x" }] }),
			}),
			env,
			ctx,
		);
		expect(await res.json()).toEqual({ accepted: [], rejected: [{ id: "c1", reason: "a report needs an id, a known kind and a message" }] });
		const anon = await api.fetch(new Request("https://api.proagentstore.online/v1/errors/runner-crashes", { method: "POST", body: "{}", headers: { "CF-Connecting-IP": "192.0.2.47" } }), env, ctx);
		expect(anon.status).toBe(401);
	});
});
