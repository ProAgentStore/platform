import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { HttpError } from "../lib/auth.js";
import { signSession } from "../lib/session.js";
import type { Env } from "../types.js";
import { readInstanceConfig, registerApplyRoutes } from "./instances-apply.js";

/** Minimal DB stub: prepare().bind().first() resolves to the given row. */
function envWithConfig(row: { config: string } | null): Env {
	return {
		DB: {
			prepare: () => ({ bind: () => ({ first: async () => row }) }),
		},
	} as unknown as Env;
}

describe("readInstanceConfig", () => {
	it("parses valid JSON config", async () => {
		const cfg = await readInstanceConfig(envWithConfig({ config: '{"specialInstructions":"be terse","x":1}' }), "i1", "u1");
		expect(cfg.specialInstructions).toBe("be terse");
		expect(cfg.x).toBe(1);
	});

	it("returns {} for malformed JSON (never throws)", async () => {
		const cfg = await readInstanceConfig(envWithConfig({ config: "{not json" }), "i1", "u1");
		expect(cfg).toEqual({});
	});

	it("returns {} when the instance has no row", async () => {
		expect(await readInstanceConfig(envWithConfig(null), "i1", "u1")).toEqual({});
	});

	it("returns {} for an empty config string", async () => {
		expect(await readInstanceConfig(envWithConfig({ config: "" }), "i1", "u1")).toEqual({});
	});
});

// ── #325: a deletion endpoint that cannot fail is a retention record that lies ─
//
// `DELETE /apply-resume` is the only way to remove an uploaded CV — name, address, employment
// history — and it swallowed the R2 delete and answered `{ok:true}` unconditionally. A failed
// delete left the object readable by the token-authed download beside it and by every later apply
// run, while the console reported the résumé gone.
describe("DELETE /:instanceId/apply-resume reports what actually happened (#325)", () => {
	const SECRET = "apply-delete-secret";
	const INSTANCE = "inst-1";

	async function drive(remove: () => Promise<void>) {
		const env = {
			SESSION_SIGNING_KEY: SECRET,
			DB: { prepare: () => ({ bind: () => ({ first: async () => ({ id: INSTANCE, user_id: "u1", config: "{}" }) }) }) },
			STORAGE: { delete: remove },
		} as unknown as Env;
		const router = new Hono<{ Bindings: Env }>();
		registerApplyRoutes(router);
		const app = new Hono<{ Bindings: Env }>();
		app.route("/v1/instances", router);
		app.onError((err, c) => (err instanceof HttpError ? c.json({ error: err.message }, err.status as 400) : c.json({ error: String(err) }, 500)));
		const token = await signSession({ uid: "u1", email: "a@b.c", roles: [] }, SECRET);
		return app.request(`/v1/instances/${INSTANCE}/apply-resume`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } }, env);
	}

	it("still reports ok when the object is gone", async () => {
		const res = await drive(async () => undefined);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
	});

	it("refuses to claim the résumé was removed when R2 rejected", async () => {
		const res = await drive(async () => {
			throw new Error("R2: internal error");
		});
		expect(res.status).toBe(502);
		expect(await res.json()).toMatchObject({ error: expect.stringMatching(/still on file/i) });
	});
});
