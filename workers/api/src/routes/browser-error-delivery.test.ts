/**
 * #1088 end to end: the SDK's real error outbox delivering to the real `POST /v1/errors/client` over the real
 * schema, read back the way MCP `list_errors` reads it. Only the network between them is simulated — it can be
 * offline, lose an answer, or meet a database that refuses the write.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorOutbox } from "../../../../packages/sdk/src/error-outbox.js";
import { HttpError } from "../lib/auth.js";
import { listErrors } from "../lib/error-log.js";
import { realSchemaD1, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import type { Env } from "../types.js";

vi.mock("../lib/auth.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/auth.js")>();
	return {
		...actual,
		requireUser: async (c: { req: { header(n: string): string | undefined } }) => {
			const auth = c.req.header("Authorization");
			if (auth === "Bearer token-u1") return { uid: "u1", roles: [] };
			throw new actual.HttpError(401, "Not signed in");
		},
	};
});
const { errorRoutes } = await import("./errors.js");

let d1: RealSchemaD1;
let env: Env;
let refuseErrorLogWrites: boolean;
let online: boolean;
let token: string | null;
let loseNextAnswer: boolean;
let clock: number;
let storage: Map<string, string>;
let ids: number;

beforeEach(() => {
	d1 = realSchemaD1();
	d1.exec("INSERT INTO users (id, github_login) VALUES ('u1', 'u1')");
	refuseErrorLogWrites = false;
	online = true;
	token = null;
	loseNextAnswer = false;
	clock = Date.parse("2026-10-16T12:00:00Z");
	storage = new Map();
	ids = 0;
	// A database that can refuse error_log writes on demand — the outage a 503 answer stands for.
	const DB = new Proxy(d1.DB, {
		get(target, prop, receiver) {
			if (prop !== "prepare") return Reflect.get(target, prop, receiver);
			return (sql: string) => {
				if (refuseErrorLogWrites && /INSERT INTO error_log|UPDATE error_log/.test(sql)) throw new Error("D1_ERROR: database unavailable");
				return target.prepare(sql);
			};
		},
	});
	env = { DB } as unknown as Env;
});
afterEach(() => d1.close());

const app = () => {
	const a = new Hono<{ Bindings: Env }>();
	a.route("/v1/errors", errorRoutes);
	a.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 401) : c.json({ error: String(e) }, 500)));
	return a;
};

/** The browser side: the SDK's outbox, its fetch going to the real Worker route. */
function browser(): ErrorOutbox {
	return new ErrorOutbox({
		endpoint: "/v1/errors/client",
		fetch: async (url, init) => {
			const res = await app().request(url, { method: "POST", headers: init.headers, body: init.body }, env);
			if (loseNextAnswer) {
				loseNextAnswer = false;
				throw new TypeError("Failed to fetch"); // stored server-side; the answer never reached the tab
			}
			return { ok: res.ok, status: res.status };
		},
		storage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => void storage.set(k, v) },
		now: () => clock,
		online: () => online,
		token: () => token,
		schedule: () => undefined,
		newId: () => `evt-${String(++ids).padStart(8, "0")}`,
	});
}
const rows = async (scope: { userId?: string } = {}) => (await listErrors(env, scope.userId ? { userId: scope.userId } : { scope: "all" } as never)).filter((r) => r.source.startsWith("client:"));
const allRows = () => d1.sqlite.prepare("SELECT user_id, source, message, level, repeat_count FROM error_log WHERE source LIKE 'client:%' ORDER BY message").all() as Array<Record<string, unknown>>;

describe("browser error delivery, end to end (#1088)", () => {
	it("offline → online: reports made offline reach the log once the browser is back", async () => {
		online = false;
		const tab = browser();
		tab.report({ source: "window", message: "TypeError: x is undefined", build: "b1" });
		await tab.flush();
		expect(allRows()).toEqual([]);
		online = true;
		await tab.flush();
		expect(allRows()).toEqual([expect.objectContaining({ source: "client:window", message: "TypeError: x is undefined", level: "error", repeat_count: 1 })]);
	});

	it("a delivery whose answer was lost is re-sent with the same id and written ONCE", async () => {
		const tab = browser();
		loseNextAnswer = true;
		tab.report({ source: "api", message: "GET /v1/x → 500", status: 500, build: "b1" });
		await tab.flush();
		expect(tab.pending()).toHaveLength(1); // the tab does not know it was stored
		clock += 2_000;
		await tab.flush();
		expect(tab.pending()).toHaveLength(0);
		expect(allRows()).toEqual([expect.objectContaining({ message: "GET /v1/x → 500", repeat_count: 1 })]);
	});

	it("a reload replays the outbox: the new page delivers what the old one could not, without a duplicate", async () => {
		refuseErrorLogWrites = true;
		const before = browser();
		before.report({ source: "react", message: "Error: render failed", build: "b1" });
		await before.flush();
		expect(before.pending()).toHaveLength(1); // 503: not delivered, kept
		refuseErrorLogWrites = false;
		clock += 2_000;
		const afterReload = browser();
		await afterReload.flush();
		expect(afterReload.pending()).toHaveLength(0);
		expect(allRows()).toEqual([expect.objectContaining({ source: "client:react", message: "Error: render failed" })]);
	});

	it("occurrences folded in the browser are counted in the row", async () => {
		online = false;
		const tab = browser();
		for (let i = 0; i < 3; i++) tab.report({ source: "upload", message: "upload failed: part 3 rejected (HTTP 500)", status: 500, build: "b1" });
		online = true;
		await tab.flush();
		expect(allRows()).toEqual([expect.objectContaining({ source: "client:upload", repeat_count: 3 })]);
	});

	it("pre-auth failures stay anonymous when replayed after sign-in; signed-in ones are filed under the user", async () => {
		online = false;
		const tab = browser();
		tab.report({ source: "auth", message: "OAuth callback failed: state mismatch", build: "b1" });
		token = "token-u1";
		tab.report({ source: "api", message: "POST /v1/instances → 500", status: 500, build: "b1" });
		online = true;
		await tab.flush();
		const byMessage = Object.fromEntries(allRows().map((r) => [r.message, r.user_id]));
		expect(byMessage["OAuth callback failed: state mismatch"]).toBeNull();
		expect(byMessage["POST /v1/instances → 500"]).toBe("u1");
		expect((await rows({ userId: "u1" })).map((r) => r.message)).toEqual(["POST /v1/instances → 500"]);
	});

	it("network failures are filed as warnings, not bugs; a malformed id is refused and the browser stops retrying it", async () => {
		const tab = browser();
		tab.report({ source: "network", message: "3 request(s) failed while the browser was offline", build: "b1" });
		await tab.flush();
		expect(allRows()).toEqual([expect.objectContaining({ source: "client:network", level: "warn" })]);
		const bad = await app().request("/v1/errors/client", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: "x", message: "m" }) }, env);
		expect(bad.status).toBe(400);
	});
});
