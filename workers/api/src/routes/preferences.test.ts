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
