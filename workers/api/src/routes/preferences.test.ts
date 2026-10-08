/**
 * The account timezone, at the edge (#329).
 *
 * The pure parse/format half lives in `lib/agent-clock.test.ts`. What can only be asserted here is
 * the WRITE contract, and both halves of it are the point of the ticket:
 *
 *   • a zone the runtime cannot resolve is REJECTED, never coerced — a typo silently becoming UTC is
 *     the same lie #18 refused for cron schedules, except the user believes they told us where they
 *     live and every timestamp they read afterwards is quietly hours wrong;
 *   • clearing it returns to UNSET, which is a distinct state from `"UTC"` and must stay reachable —
 *     it is what makes an agent say "UTC" out loud instead of dressing a guess as local time.
 */
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { HttpError } from "../lib/auth.js";
import { signSession } from "../lib/session.js";
import { preferenceRoutes } from "./preferences.js";
import type { AccountPreferences } from "../lib/preferences.js";
import type { Env } from "../types.js";

const TEST_SECRET = "test-secret";

function testApp(stored: Record<string, unknown> = {}) {
	const app = new Hono<{ Bindings: Env }>();
	app.route("/v1/preferences", preferenceRoutes);
	app.onError((err, c) => {
		if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
		throw err;
	});

	let blob = JSON.stringify(stored);
	const env = {
		SESSION_SIGNING_KEY: TEST_SECRET,
		DB: {
			prepare(sql: string) {
				return {
					bind(...args: unknown[]) {
						return {
							first: async () => (sql.startsWith("SELECT") ? { preferences: blob } : null),
							run: async () => {
								blob = String(args[0]);
								return { success: true };
							},
						};
					},
				};
			},
		},
	} as unknown as Env;

	return { app, env, saved: () => JSON.parse(blob) as Record<string, unknown> };
}

async function call(app: Hono<{ Bindings: Env }>, env: Env, init?: RequestInit) {
	const token = await signSession("user-1", TEST_SECRET);
	return app.request("/v1/preferences", { ...init, headers: { Authorization: `Bearer ${token}` } }, env);
}

const put = (body: unknown): RequestInit => ({ method: "PUT", body: JSON.stringify(body) });
const read = async (res: Response) => (await res.json<{ preferences: AccountPreferences }>()).preferences;

describe("the account timezone", () => {
	it("round-trips the account coding engine default without touching other sections (#879)", async () => {
		const { app, env, saved } = testApp({ timezone: "Europe/London", voice: { speed: 130 } });
		const res = await call(app, env, put({ coding: { defaultEngineId: "codex" } }));
		expect(res.status).toBe(200);
		const prefs = await read(res);
		expect(prefs.coding).toEqual({ defaultEngineId: "codex" });
		expect(prefs.timezone).toBe("Europe/London");
		expect(prefs.voice?.speed).toBe(130);
		expect(saved().coding).toEqual({ defaultEngineId: "codex" });
	});

	it("rejects an unknown account coding engine instead of silently falling back (#879)", async () => {
		const { app, env, saved } = testApp();
		const res = await call(app, env, put({ coding: { defaultEngineId: "cursor" } }));
		expect(res.status).toBe(400);
		expect(saved().coding).toBeUndefined();
	});

	it("clears the account coding engine default back to platform inheritance (#879)", async () => {
		const { app, env } = testApp({ coding: { defaultEngineId: "codex" } });
		expect((await read(await call(app, env, put({ coding: { defaultEngineId: null } })))).coding).toEqual({});
	});

	it("round-trips the notification instance scope and rejects a malformed one (#784)", async () => {
		const { app, env, saved } = testApp();
		const res = await call(app, env, put({ notifications: { muted: ["deploy"], instances: ["inst-a", "inst-b"] } }));
		expect(res.status).toBe(200);
		expect((await read(res)).notifications).toEqual({ muted: ["deploy"], instances: ["inst-a", "inst-b"] });
		expect(saved().notifications).toEqual({ muted: ["deploy"], instances: ["inst-a", "inst-b"] });

		// Clearing the scope is a whole-section write with no `instances`, and the key goes away.
		const cleared = await call(app, env, put({ notifications: { muted: ["deploy"] } }));
		expect((await read(cleared)).notifications).toEqual({ muted: ["deploy"] });

		const bad = await call(app, env, put({ notifications: { muted: [], instances: "inst-a" } }));
		expect(bad.status).toBe(400);
		const badEntry = await call(app, env, put({ notifications: { muted: [], instances: ["inst-a", 3] } }));
		expect(badEntry.status).toBe(400);
	});

	it("round-trips the owner-attention channel control, and serves the vocabulary (#991)", async () => {
		// The config surface for the generic attention policy. Two things have to hold: the event
		// table is SERVED (so a new event gets a control by being added to `lib/owner-attention.ts`,
		// not by editing the page), and a save of this section leaves the other mutes alone — they
		// are different axes, product area vs kind of attention.
		const { app, env, saved } = testApp({ notifications: { muted: ["deploy"] } });
		const vocab = await (await call(app, env)).json<{ attentionEvents: { id: string; pushOptional: boolean }[] }>();
		expect(vocab.attentionEvents.map((e) => e.id)).toContain("approval_required");

		const res = await call(app, env, put({ attention: { pushOff: ["approval_required"] } }));
		expect(res.status).toBe(200);
		const prefs = await read(res);
		expect(prefs.attention).toEqual({ pushOff: ["approval_required"] });
		expect(saved().attention).toEqual({ pushOff: ["approval_required"] });
		expect(prefs.notifications).toEqual({ muted: ["deploy"] });

		// Strict on write for the same reason `notifications` is: a silently dropped id leaves the
		// owner believing they turned a push off.
		expect((await call(app, env, put({ attention: { pushOff: ["not_an_event"] } }))).status).toBe(400);
		expect((await call(app, env, put({ attention: { pushOff: "approval_required" } }))).status).toBe(400);
		expect((await call(app, env, put({ attention: [] }))).status).toBe(400);
		// And the refused saves changed nothing.
		expect(saved().attention).toEqual({ pushOff: ["approval_required"] });

		// Turning it back on is a whole-section write with an empty list, and the key goes away.
		expect((await read(await call(app, env, put({ attention: { pushOff: [] } })))).attention).toBeUndefined();
	});

	it("round-trips an IANA zone", async () => {
		const { app, env, saved } = testApp();
		const res = await call(app, env, put({ timezone: "Australia/Sydney" }));
		expect(res.status).toBe(200);
		expect((await read(res)).timezone).toBe("Australia/Sydney");
		expect(saved().timezone).toBe("Australia/Sydney");

		expect((await read(await call(app, env))).timezone).toBe("Australia/Sydney");
	});

	it("rejects a zone the runtime cannot resolve rather than coercing it to UTC", async () => {
		const { app, env, saved } = testApp();
		for (const bad of ["Australia/Melbourn", "AEST", "GMT+10", 42]) {
			const res = await call(app, env, put({ timezone: bad }));
			expect(res.status, `${String(bad)} must be rejected`).toBe(400);
		}
		// And nothing was written on the way to the 400.
		expect(saved().timezone).toBeUndefined();
	});

	it("clears back to UNSET, which is not the same as UTC", async () => {
		// The distinction the whole design rests on: `undefined` means "nobody told us" and produces
		// an honest UTC narration; `"UTC"` means a user who really is there. A user must be able to
		// get back to the first one.
		const { app, env } = testApp({ timezone: "Australia/Sydney" });
		expect((await read(await call(app, env, put({ timezone: null })))).timezone).toBeUndefined();
		expect((await read(await call(app, env, put({ timezone: "UTC" })))).timezone).toBe("UTC");
		expect((await read(await call(app, env, put({ timezone: "" })))).timezone).toBeUndefined();
	});

	it("is left alone by a save that does not mention it", async () => {
		// Section-level PATCH semantics, same as voice and translation: the console saves one card at
		// a time and must not have to round-trip the others (and race a change made in another tab).
		const { app, env } = testApp({ timezone: "Europe/London" });
		const prefs = await read(await call(app, env, put({ translation: { enabled: true, target: "French" } })));
		expect(prefs.timezone).toBe("Europe/London");
		expect(prefs.translation?.enabled).toBe(true);
	});

	it("survives beside the voice section it shares a blob with", async () => {
		const { app, env } = testApp({ voice: { speed: 130 } });
		const prefs = await read(await call(app, env, put({ timezone: "Asia/Kolkata" })));
		expect(prefs.timezone).toBe("Asia/Kolkata");
		expect(prefs.voice?.speed).toBe(130);
	});
});
