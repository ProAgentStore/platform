import type { Context } from "hono";
import { describe, expect, it } from "vitest";
import { HttpError, isAdmin, requireUser } from "./auth.js";
import { signSession } from "./session.js";
import type { Env, SessionPayload } from "../types.js";

describe("HttpError", () => {
	it("has status and message", () => {
		const err = new HttpError(401, "Unauthorized");
		expect(err.status).toBe(401);
		expect(err.message).toBe("Unauthorized");
		expect(err instanceof Error).toBe(true);
	});

	it("works with different status codes", () => {
		expect(new HttpError(400, "Bad Request").status).toBe(400);
		expect(new HttpError(403, "Forbidden").status).toBe(403);
		expect(new HttpError(404, "Not Found").status).toBe(404);
		expect(new HttpError(500, "Server Error").status).toBe(500);
	});
});

const SECRET = "test-secret";

/** Minimal Hono-context stand-in: requireUser only reads the Authorization header and env.DB. */
function ctx(token: string | undefined, db: unknown): Context<{ Bindings: Env }> {
	return {
		req: { header: (n: string) => (n === "Authorization" && token ? `Bearer ${token}` : undefined) },
		env: { SESSION_SIGNING_KEY: SECRET, DB: db },
	} as unknown as Context<{ Bindings: Env }>;
}

/** D1 stand-in whose single SELECT returns `row`, or throws when `boom`. */
function db(row: unknown, boom = false) {
	return {
		prepare() {
			return { bind: () => ({ first: async () => { if (boom) throw new Error("D1 down"); return row; } }) };
		},
	};
}

describe("requireUser — suspension gate (#34)", () => {
	it("403s a suspended account", async () => {
		// The whole point of the lever: a suspended user must be stopped at the door on
		// EVERY authenticated route. Revoking their token would not do it — sessions live
		// 30 days and they can just sign in again for a fresh one.
		const token = await signSession("u9", SECRET, { roles: ["user"] });
		await expect(requireUser(ctx(token, db({ suspended: 1 })))).rejects.toMatchObject({
			status: 403,
			message: "Account suspended",
		});
	});

	it("lets an unsuspended account through", async () => {
		const token = await signSession("u1", SECRET, { roles: ["user"] });
		const s = await requireUser(ctx(token, db({ suspended: 0 })));
		expect(s.uid).toBe("u1");
	});

	it("treats a user row with no suspension columns as not suspended", async () => {
		// Guards the migration window: rows read before 0078 lands have no `suspended`
		// value, and an `undefined` must not be mistaken for "blocked" and lock everyone out.
		const token = await signSession("u1", SECRET, { roles: ["user"] });
		expect((await requireUser(ctx(token, db({})))).uid).toBe("u1");
	});

	it("FAILS OPEN when D1 is unavailable", async () => {
		// A database blip must not 403 the entire platform. A moderation gate briefly not
		// applying is a far smaller failure than a total outage.
		const token = await signSession("u1", SECRET, { roles: ["user"] });
		expect((await requireUser(ctx(token, db(null, true)))).uid).toBe("u1");
	});

	it("still 401s an invalid token before ever touching the DB", async () => {
		await expect(requireUser(ctx("not-a-token", db({ suspended: 0 })))).rejects.toMatchObject({ status: 401 });
		await expect(requireUser(ctx(undefined, db({ suspended: 0 })))).rejects.toMatchObject({ status: 401 });
	});
});

describe("isAdmin — a malformed roles column is not an exception", () => {
	/** Context for isAdmin: it reads env.DB and env.ADMIN_ALLOWLIST, never the request. */
	function adminCtx(row: unknown, allowlist = ""): Context<{ Bindings: Env }> {
		return { env: { ADMIN_ALLOWLIST: allowlist, DB: db(row) } } as unknown as Context<{ Bindings: Env }>;
	}
	const user = { uid: "u1", roles: ["user"] } as SessionPayload;

	it("grants admin from a well-formed roles column", async () => {
		expect(await isAdmin(adminCtx({ roles: '["user","admin"]' }), user)).toBe(true);
	});

	it("does NOT let a malformed roles column cost the operator their allowlist path", async () => {
		// The regression: `roles` and `github_login` are resolved inside ONE try whose catch
		// means "the DB is unavailable". `JSON.parse("{oops")` threw out of the block, so the
		// github_login check on the next line never ran — one bad blob in a column nothing
		// validates, and a legitimate break-glass admin was silently locked out.
		const ctxWith = adminCtx({ roles: "{oops", github_login: "operator" }, "operator");
		expect(await isAdmin(ctxWith, user)).toBe(true);
	});

	it("fails closed: an unparseable or non-array roles value never grants admin", async () => {
		for (const roles of ["{oops", '"admin"', "null", '{"admin":true}', "[]"]) {
			expect(await isAdmin(adminCtx({ roles }), user)).toBe(false);
		}
	});

	it("ignores non-string entries rather than throwing on them", async () => {
		expect(await isAdmin(adminCtx({ roles: '[null,{"x":1},"admin"]' }), user)).toBe(true);
		expect(await isAdmin(adminCtx({ roles: "[1,2,3]" }), user)).toBe(false);
	});
});
