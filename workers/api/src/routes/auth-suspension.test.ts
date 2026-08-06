import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { HttpError } from "../lib/auth.js";
import { signSession } from "../lib/session.js";
import { authRoutes } from "./auth.js";

/**
 * Operator suspension (#34) on the routes that verify a session BY HAND instead of
 * through `requireUser` (#273). `requireUser` is where the gate normally lives, so a
 * route that authenticates inline silently opts out of it — `/v1/auth/me` did, which
 * meant a suspended account could still read and edit its profile.
 *
 * `GET /v1/auth/me`'s 403 is doubly load-bearing: the MCP worker asks this route
 * whether the connected account is suspended, because it holds no D1 binding and
 * "suspended" must have exactly one definition. If this 403 ever becomes a 200 or a
 * 401, every MCP tool silently stops being gated.
 */

const SECRET = "suspension-test-secret";

function testApp(opts: { suspended?: boolean; dbThrows?: boolean } = {}) {
	const app = new Hono();
	app.route("/v1/auth", authRoutes);
	app.onError((err, c) => {
		if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
		throw err;
	});
	const env = {
		SESSION_SIGNING_KEY: SECRET,
		DB: {
			prepare(sql: string) {
				const first = async () => {
					if (sql.includes("SELECT suspended FROM users")) {
						// Only the suspension lookup fails, so the test isolates the gate's own
						// error handling rather than a broken route.
						if (opts.dbThrows) throw new Error("D1 unavailable");
						return { suspended: opts.suspended ? 1 : 0 };
					}
					// the /me profile row
					return { id: "u1", github_login: "octo", github_name: "Octo", avatar_url: "", roles: '["user"]' };
				};
				return {
					bind: () => ({ first, all: async () => ({ results: [] }), run: async () => ({}) }),
					first,
					run: async () => ({}),
				};
			},
		},
	};
	return { app, env };
}

const token = () => signSession("u1", SECRET, { roles: ["user"] });

describe("GET /v1/auth/me — suspension", () => {
	it("403s a suspended account", async () => {
		// Prevents: the MCP worker's tool gate silently failing open. It treats exactly 403
		// from this route as "suspended" (#273).
		const { app, env } = testApp({ suspended: true });
		const res = await app.request("/v1/auth/me", { headers: { Authorization: `Bearer ${await token()}` } }, env);
		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({ error: "Account suspended" });
	});

	it("200s an account in good standing", async () => {
		const { app, env } = testApp();
		const res = await app.request("/v1/auth/me", { headers: { Authorization: `Bearer ${await token()}` } }, env);
		expect(res.status).toBe(200);
	});

	it("still 401s an invalid token rather than 403", async () => {
		// Prevents: conflating "bad credential" with "suspended" — the MCP gate keys off the
		// difference, and a 401 must not read as a moderation verdict.
		const { app, env } = testApp({ suspended: true });
		const res = await app.request("/v1/auth/me", { headers: { Authorization: "Bearer not-a-token" } }, env);
		expect(res.status).toBe(401);
	});

	it("fails OPEN when D1 errors", async () => {
		// Prevents: a D1 blip 403ing every signed-in user. Deliberately the same trade-off
		// requireUser's isSuspended already documents — briefly not applying a moderation
		// gate is a far smaller failure than a platform-wide sign-out.
		const { app, env } = testApp({ dbThrows: true });
		const res = await app.request("/v1/auth/me", { headers: { Authorization: `Bearer ${await token()}` } }, env);
		expect(res.status).not.toBe(403);
	});
});

describe("PUT /v1/auth/me — suspension", () => {
	it("403s a suspended account before it writes", async () => {
		// Prevents: a suspended account still editing its public profile (bio/website), which
		// is exactly the visible surface a moderation action is usually about.
		const { app, env } = testApp({ suspended: true });
		const res = await app.request(
			"/v1/auth/me",
			{
				method: "PUT",
				headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json" },
				body: JSON.stringify({ bio: "spam" }),
			},
			env,
		);
		expect(res.status).toBe(403);
	});
});
