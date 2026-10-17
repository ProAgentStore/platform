/**
 * #1120 — a client error row is never `client:undefined` / "undefined", and it says where it came from.
 *
 * The production log held `source: "client:undefined"`, `message: "undefined"`, `build: "unset"`, no
 * user and no context — nothing to find the sender by. `reportClientError` sent `String(undefined)`,
 * and the route stored any non-empty string.
 *
 * The REAL Worker route over the real schema; each row is read back from `error_log`. The SDK half — it
 * never sends "undefined" — is `packages/sdk/src/client.test.ts`; its browser module is not imported
 * here, because the Worker's tsconfig has no DOM.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { realSchemaD1, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import type { Env } from "../types.js";

vi.mock("../lib/auth.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/auth.js")>();
	return { ...actual, requireUser: async () => { throw new actual.HttpError(401, "Not signed in"); } };
});
const { callerOrigin, errorRoutes } = await import("./errors.js");

let d1: RealSchemaD1;
let env: Env;

const app = () => {
	const a = new Hono<{ Bindings: Env }>();
	a.route("/v1/errors", errorRoutes);
	a.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 401) : c.json({ error: String(e) }, 500)));
	return a;
};

beforeEach(() => {
	d1 = realSchemaD1();
	env = { DB: d1.DB } as unknown as Env;
});
afterEach(() => d1.close());

const rows = () => d1.sqlite.prepare("SELECT source, message, context FROM error_log ORDER BY rowid").all() as Array<{ source: string; message: string; context: string | null }>;
const post = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
	app().request("/v1/errors/client", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) }, env);

describe("a report that names no source or message (#1120)", () => {
	it("an older bundle's literal 'undefined' strings: kept as evidence, but named for what they are", async () => {
		expect((await post({ source: "undefined", message: "undefined" })).status).toBe(200);
		expect((await post({ source: "null", message: "null" })).status).toBe(200);
		expect(rows().map((r) => [r.source, r.message])).toEqual([
			["client:unlabelled", '(no message: the reporter sent the literal "undefined")'],
			["client:unlabelled", '(no message: the reporter sent the literal "null")'],
		]);
		expect(JSON.stringify(rows())).not.toMatch(/client:undefined|client:null/);
	});

	it("what the fixed SDK sends for a missing source and message is stored as sent", async () => {
		await post({ source: "unlabelled", message: "(no message: reportClientError was called with undefined)" });
		expect(rows().map((r) => [r.source, r.message])).toEqual([["client:unlabelled", "(no message: reportClientError was called with undefined)"]]);
	});

	it("a real report is unchanged", async () => {
		await post({ source: "voice-config", message: "voice-settings load failed — using defaults for this call", context: { attempt: 1 } });
		const [row] = rows();
		expect([row.source, row.message]).toEqual(["client:voice-config", "voice-settings load failed — using defaults for this call"]);
		expect(JSON.parse(row.context ?? "{}")).toMatchObject({ attempt: 1 });
	});
});

describe("every client row says where it came from (#1120)", () => {
	it("a browser page's origin — from Origin, else the Referer with its path dropped; `none` for a caller that sent neither", async () => {
		await post({ source: "api", message: "from the admin app" }, { Origin: "https://admin.proagentstore.online" });
		await post({ source: "api", message: "from a referer only" }, { Referer: "http://localhost:5173/console/instances/x?token=secret" });
		await post({ source: "api", message: "from a script" });
		expect(rows().map((r) => JSON.parse(r.context ?? "{}").caller)).toEqual([
			{ origin: "https://admin.proagentstore.online" },
			{ origin: "http://localhost:5173" },
			{ origin: "none" },
		]);
	});

	it("the body cannot name its own origin — the server's header reading wins", async () => {
		await post({ source: "api", message: "spoof", context: { caller: { origin: "https://elsewhere.example" }, kept: true } }, { Origin: "https://proagentstore.online" });
		expect(JSON.parse(rows()[0].context ?? "{}")).toEqual({ kept: true, caller: { origin: "https://proagentstore.online" } });
	});

	it("callerOrigin: only an http(s) origin, never a path, and nothing from junk", () => {
		expect(callerOrigin("null", "https://x.example/a/b?c=d")).toBe("https://x.example");
		expect(callerOrigin("not a url", undefined)).toBe("none");
		expect(callerOrigin("chrome-extension://abc", undefined)).toBe("none");
		expect(callerOrigin(undefined, undefined)).toBe("none");
		expect(callerOrigin(`https://${"a".repeat(250)}.example`, undefined)).toBe("(origin too long)");
	});
});
