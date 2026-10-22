/**
 * #1282 — the account's default coding engine against the REAL preferences route and a real stored blob: select an engine, reset to
 * Platform default, reload, and a refused write. The route's clear contract (`defaultEngineId: null`) is unchanged; what is proved is that
 * what the page sends is accepted by it, and that a refusal leaves the stored engine alone.
 */
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { codingWriteBody, saveCodingEngine } from "../../../../store/console/src/lib/codingDefault";
import { HttpError } from "../lib/auth.js";
import { signSession } from "../lib/session.js";
import type { Env } from "../types.js";
import { preferenceRoutes } from "./preferences.js";

const SECRET = "test-secret";

function server(stored: Record<string, unknown> = {}) {
	const app = new Hono<{ Bindings: Env }>();
	app.route("/v1/preferences", preferenceRoutes);
	app.onError((err, c) => {
		if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
		throw err;
	});
	let blob = JSON.stringify(stored);
	const env = {
		SESSION_SIGNING_KEY: SECRET,
		DB: {
			prepare: (sql: string) => ({
				bind: (...args: unknown[]) => ({
					first: async () => (sql.startsWith("SELECT") ? { preferences: blob } : null),
					run: async () => {
						blob = String(args[0]);
						return { success: true };
					},
				}),
			}),
		},
	} as unknown as Env;
	const request = async (init?: RequestInit) => app.request("/v1/preferences", { ...init, headers: { Authorization: `Bearer ${await signSession("user-1", SECRET)}` } }, env);
	const write = async (body: unknown) => {
		const res = await request({ method: "PUT", body: JSON.stringify(body) });
		const json = (await res.json()) as { error?: string };
		if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
		return json as never;
	};
	/** What a reloaded page reads back as the selected engine ("" = Platform default). */
	const reload = async () => (((await (await request()).json()) as { preferences?: { coding?: { defaultEngineId?: string } } }).preferences?.coding?.defaultEngineId ?? "");
	return { write, reload, stored: () => (JSON.parse(blob) as { coding?: unknown }).coding, raw: () => JSON.parse(blob) as Record<string, unknown> };
}

describe("the account default coding engine, through the real route (#1282)", () => {
	it("the old reset body, `coding: {}`, is refused and keeps the override — why the page must send null", async () => {
		const s = server({ coding: { defaultEngineId: "codex" } });
		await expect(s.write({ coding: {} })).rejects.toThrow(/must be an engine id/);
		expect(s.stored()).toEqual({ defaultEngineId: "codex" });
	});

	it("select a concrete engine, then Platform default: both accepted, the override is gone, and a reload agrees", async () => {
		const s = server();
		expect(await saveCodingEngine(s.write, "codex")).toEqual({ ok: true, persisted: "codex" });
		expect(await s.reload()).toBe("codex");
		expect(await saveCodingEngine(s.write, "")).toEqual({ ok: true, persisted: "" });
		expect(s.stored()).toEqual({});
		expect(await s.reload()).toBe("");
	});

	it("resetting leaves the account's other sections alone", async () => {
		const s = server({ timezone: "Australia/Sydney", coding: { defaultEngineId: "codex" } });
		await saveCodingEngine(s.write, "");
		expect(s.raw()).toMatchObject({ timezone: "Australia/Sydney", coding: {} });
	});

	it("a rejected write reports why, yields no new value, and leaves the stored engine as it was", async () => {
		const s = server({ coding: { defaultEngineId: "codex" } });
		const r = await saveCodingEngine(s.write, "no-such-engine");
		expect(r).toEqual({ ok: false, error: "unknown coding engine: no-such-engine" });
		expect(s.stored()).toEqual({ defaultEngineId: "codex" });
		expect(await s.reload()).toBe("codex");
		// and the page is not wedged: the next valid choice lands
		expect(await saveCodingEngine(s.write, "")).toEqual({ ok: true, persisted: "" });
	});

	it("what the page sends for each choice is what the route accepts", async () => {
		const s = server({ coding: { defaultEngineId: "codex" } });
		await expect(s.write(codingWriteBody(""))).resolves.toBeDefined();
		expect(s.stored()).toEqual({});
	});
});
