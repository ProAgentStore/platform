/**
 * #1184: runner sign-ins that are per machine, revocable, and of a lifetime the owner chooses. Real schema, real routes AND
 * the real `requireUser` — a revoked credential must be refused by the same gate every route sits behind.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { realSchemaD1, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import { deviceCredentialRefused, DAY_SECONDS, getAccountLifetime } from "../lib/device-credentials.js";
import { signSession, verifySession } from "../lib/session.js";
import type { Env } from "../types.js";

const { deviceAuthRoutes, sessionRoutes } = await import("./device-auth.js");
const { authRoutes } = await import("./auth.js");

const KEY = "test-signing-key";
let d1: RealSchemaD1;
const env = () => ({ DB: d1.DB, SESSION_SIGNING_KEY: KEY }) as unknown as Env;
const app = () => {
	const a = new Hono<{ Bindings: Env }>().route("/v1/auth/device", deviceAuthRoutes).route("/v1/auth/session", sessionRoutes).route("/v1/auth", authRoutes);
	a.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500)));
	return a;
};
async function call(method: string, path: string, opts: { body?: unknown; bearer?: string } = {}) {
	const res = await app().request(path, { method, headers: { "Content-Type": "application/json", ...(opts.bearer ? { Authorization: `Bearer ${opts.bearer}` } : {}) }, ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }) }, env());
	// biome-ignore lint/suspicious/noExplicitAny: assertions read the JSON field by field
	return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
}
const browser = (uid = "u1") => signSession(uid, KEY, { roles: ["user"] });

/** A machine signed in end to end: start, the owner approves (optionally choosing days), the machine's poll collects the session. */
async function enroll(opts: { days?: number; owner?: string; node?: string } = {}) {
	const started = await call("POST", "/v1/auth/device/start", { body: { node: opts.node ?? "dell-laptop" } });
	const approve = await call("POST", `/v1/auth/device/requests/${started.body.user_code}`, { bearer: await browser(opts.owner ?? "u1"), body: { approve: true, ...(opts.days ? { lifetimeDays: opts.days } : {}) } });
	expect(approve.status).toBe(200);
	const token = await call("POST", "/v1/auth/device/token", { body: { device_code: started.body.device_code } });
	return { started, token };
}

beforeEach(() => {
	d1 = realSchemaD1();
	d1.exec(`INSERT INTO users (id, github_login, roles) VALUES ('u1', 'one', '["user"]'), ('u2', 'two', '["user"]')`);
});
afterEach(() => {
	d1.close();
	vi.useRealTimers();
});

describe("how long a machine's sign-in lasts", () => {
	it("is 30 days unless the owner says otherwise", async () => {
		const { token } = await enroll();
		expect(token.body).toMatchObject({ lifetime_days: 30 });
		const payload = await verifySession(token.body.session, KEY);
		expect((payload?.exp ?? 0) - (payload?.iat ?? 0)).toBe(30 * DAY_SECONDS);
	});
	it("takes the length chosen on the approval page: 90 or 180 days", async () => {
		for (const days of [90, 180]) {
			const { token } = await enroll({ days });
			const payload = await verifySession(token.body.session, KEY);
			expect(token.body.lifetime_days).toBe(days);
			expect((payload?.exp ?? 0) - (payload?.iat ?? 0)).toBe(days * DAY_SECONDS);
		}
	});
	it("takes the owner's default for new machines when the approval does not choose", async () => {
		expect((await call("PUT", "/v1/auth/device/lifetime", { bearer: await browser(), body: { days: 90 } })).body).toMatchObject({ lifetimeDays: 90 });
		expect(await getAccountLifetime(env(), "u1")).toBe(90);
		expect((await enroll()).token.body.lifetime_days).toBe(90);
		// the choice on the approval wins over the default, and the default is per account
		expect((await enroll({ days: 30 })).token.body.lifetime_days).toBe(30);
		expect(await getAccountLifetime(env(), "u2")).toBe(30);
	});
	it("refuses any other length, on the default and on an approval", async () => {
		for (const days of [0, 7, 45, 365, "90", null]) expect((await call("PUT", "/v1/auth/device/lifetime", { bearer: await browser(), body: { days } })).status).toBe(400);
		const started = await call("POST", "/v1/auth/device/start", { body: { node: "n" } });
		expect((await call("POST", `/v1/auth/device/requests/${started.body.user_code}`, { bearer: await browser(), body: { approve: true, lifetimeDays: 60 } })).status).toBe(400);
		// the request is still pending: a refused length decides nothing
		expect((await call("POST", "/v1/auth/device/token", { body: { device_code: started.body.device_code } })).body.error).toBe("authorization_pending");
	});
	it("a changed default does not shorten or lengthen machines already signed in", async () => {
		const { token } = await enroll({ days: 30 });
		await call("PUT", "/v1/auth/device/lifetime", { bearer: await browser(), body: { days: 180 } });
		const listed = await call("GET", "/v1/auth/device/credentials", { bearer: token.body.session });
		expect(listed.body.credentials[0]).toMatchObject({ lifetimeDays: 30, status: "active" });
		expect(listed.body).toMatchObject({ lifetimeDays: 180, allowedLifetimeDays: [30, 90, 180] });
	});
});

describe("a machine's credential is its own", () => {
	it("is listed with the machine's name and when it expires; the session names it", async () => {
		const { token } = await enroll({ node: "pink-laptop", days: 90 });
		const payload = await verifySession(token.body.session, KEY);
		expect(payload?.did).toBe(token.body.device_id);
		const listed = await call("GET", "/v1/auth/device/credentials", { bearer: await browser() });
		expect(listed.body.credentials).toEqual([expect.objectContaining({ id: token.body.device_id, node: "pink-laptop", lifetimeDays: 90, status: "active", revokedAt: null })]);
	});
	it("revoked: the very next request from that machine is refused — everywhere the gate applies", async () => {
		const { token } = await enroll();
		const machine = token.body.session;
		expect((await call("GET", "/v1/auth/device/credentials", { bearer: machine })).status).toBe(200);
		expect((await call("GET", "/v1/auth/me", { bearer: machine })).status).not.toBe(401);

		const revoked = await call("DELETE", `/v1/auth/device/credentials/${token.body.device_id}`, { bearer: await browser() });
		expect(revoked.body).toMatchObject({ revoked: true });

		const after = await call("GET", "/v1/auth/device/credentials", { bearer: machine });
		expect(after.status).toBe(401);
		expect(after.body.error).toMatch(/revoked or has expired.*pags login --device/);
		expect((await call("GET", "/v1/auth/me", { bearer: machine })).status).toBe(401);
		// a refresh cannot bring it back
		expect((await call("POST", "/v1/auth/session/refresh", { bearer: machine })).status).toBe(401);
		// the owner's browser session, and the owner's other machines, are untouched
		expect((await call("GET", "/v1/auth/device/credentials", { bearer: await browser() })).status).toBe(200);
		const other = await enroll({ node: "mac-mini" });
		expect((await call("GET", "/v1/auth/device/credentials", { bearer: other.token.body.session })).status).toBe(200);
		expect((await call("GET", "/v1/auth/device/credentials", { bearer: await browser() })).body.credentials.map((c: { status: string }) => c.status).sort()).toEqual(["active", "revoked"]);
	});
	it("only the owner can revoke it, and only once", async () => {
		const { token } = await enroll();
		const id = token.body.device_id;
		expect((await call("DELETE", `/v1/auth/device/credentials/${id}`, { bearer: await browser("u2") })).status).toBe(404);
		expect((await call("GET", "/v1/auth/device/credentials", { bearer: token.body.session })).status).toBe(200);
		expect((await call("DELETE", `/v1/auth/device/credentials/${id}`, { bearer: await browser() })).status).toBe(200);
		expect((await call("DELETE", `/v1/auth/device/credentials/${id}`, { bearer: await browser() })).status).toBe(404);
		expect((await call("DELETE", "/v1/auth/device/credentials/dev_nope", { bearer: await browser() })).status).toBe(404);
	});
	it("expired: the credential's own expiry ends the session even if the token were still valid", async () => {
		const { token } = await enroll();
		d1.exec(`UPDATE device_credentials SET expires_at = ${Math.floor(Date.now() / 1000) - 5}`);
		const r = await call("GET", "/v1/auth/device/credentials", { bearer: token.body.session });
		expect(r.status).toBe(401);
		expect(await deviceCredentialRefused(env(), token.body.device_id, "u1")).toBe(true);
	});
	it("a session naming a credential that does not exist, or is another account's, is refused", async () => {
		expect(await deviceCredentialRefused(env(), "dev_unknown", "u1")).toBe(true);
		const { token } = await enroll();
		expect(await deviceCredentialRefused(env(), token.body.device_id, "u2")).toBe(true);
		expect(await deviceCredentialRefused(env(), token.body.device_id, "u1")).toBe(false);
		const forged = await signSession("u1", KEY, { roles: ["user"], did: "dev_forged" });
		expect((await call("GET", "/v1/auth/device/credentials", { bearer: forged })).status).toBe(401);
	});
	it("a browser session carries no credential and costs no lookup", async () => {
		expect((await verifySession(await browser(), KEY))?.did).toBeUndefined();
		d1.exec("DROP TABLE device_credentials");
		expect((await call("GET", "/v1/auth/me", { bearer: await browser() })).status).not.toBe(401);
	});
	it("a database error while checking does not sign every machine out (the signed expiry still bounds it)", async () => {
		d1.exec("DROP TABLE device_credentials");
		expect(await deviceCredentialRefused(env(), "dev_any", "u1")).toBe(false);
	});
});

describe("renewing a machine's sign-in", () => {
	it("keeps the same credential and its own length, and moves the expiry forward", async () => {
		const { token } = await enroll({ days: 90 });
		d1.exec(`UPDATE device_credentials SET expires_at = ${Math.floor(Date.now() / 1000) + 3 * DAY_SECONDS}`);
		const refreshed = await call("POST", "/v1/auth/session/refresh", { bearer: token.body.session });
		expect(refreshed.status).toBe(200);
		expect(refreshed.body).toMatchObject({ device_id: token.body.device_id, lifetime_days: 90 });
		const payload = await verifySession(refreshed.body.session, KEY);
		expect(payload?.did).toBe(token.body.device_id);
		expect((payload?.exp ?? 0) - (payload?.iat ?? 0)).toBe(90 * DAY_SECONDS);
		const row = d1.sqlite.prepare("SELECT expires_at, last_refreshed_at FROM device_credentials").get() as { expires_at: number; last_refreshed_at: number };
		expect(row.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000) + 89 * DAY_SECONDS);
		expect(row.last_refreshed_at).toBeGreaterThan(0);
	});
	it("a browser session still refreshes to a plain 30-day one with no credential", async () => {
		const r = await call("POST", "/v1/auth/session/refresh", { bearer: await browser() });
		expect(r.status).toBe(200);
		expect((await verifySession(r.body.session, KEY))?.did).toBeUndefined();
		expect(r.body.device_id).toBeUndefined();
	});
});

describe("the request states, end to end (#1184 acceptance)", () => {
	it("pending → approved (one credential) → the same code never yields a second", async () => {
		const started = await call("POST", "/v1/auth/device/start", { body: { node: "dell-laptop" } });
		expect((await call("POST", "/v1/auth/device/token", { body: { device_code: started.body.device_code } })).body.error).toBe("authorization_pending");
		await call("POST", `/v1/auth/device/requests/${started.body.user_code}`, { bearer: await browser(), body: { approve: true } });
		expect((await call("POST", "/v1/auth/device/token", { body: { device_code: started.body.device_code } })).status).toBe(200);
		expect((await call("POST", "/v1/auth/device/token", { body: { device_code: started.body.device_code } })).body.error).toBe("expired_token");
		expect(d1.sqlite.prepare("SELECT COUNT(*) AS n FROM device_credentials").get()).toEqual({ n: 1 });
	});
	it("rejected: no credential is created", async () => {
		const started = await call("POST", "/v1/auth/device/start", { body: { node: "n" } });
		await call("POST", `/v1/auth/device/requests/${started.body.user_code}`, { bearer: await browser(), body: { approve: false, lifetimeDays: 180 } });
		expect((await call("POST", "/v1/auth/device/token", { body: { device_code: started.body.device_code } })).body.error).toBe("access_denied");
		expect(d1.sqlite.prepare("SELECT COUNT(*) AS n FROM device_credentials").get()).toEqual({ n: 0 });
	});
	it("expired: a code nobody approved in time yields nothing", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-10-25T00:00:00Z"));
		const started = await call("POST", "/v1/auth/device/start", { body: { node: "n" } });
		vi.setSystemTime(new Date("2026-10-25T00:11:00Z"));
		expect((await call("POST", "/v1/auth/device/token", { body: { device_code: started.body.device_code } })).body.error).toBe("expired_token");
		expect(d1.sqlite.prepare("SELECT COUNT(*) AS n FROM device_credentials").get()).toEqual({ n: 0 });
	});
	it("a suspended account's approved request mints nothing and leaves no live credential", async () => {
		const started = await call("POST", "/v1/auth/device/start", { body: { node: "n" } });
		await call("POST", `/v1/auth/device/requests/${started.body.user_code}`, { bearer: await browser(), body: { approve: true } });
		d1.exec("UPDATE users SET suspended = 1 WHERE id = 'u1'");
		const r = await call("POST", "/v1/auth/device/token", { body: { device_code: started.body.device_code } });
		expect(r.body.error).toBe("access_denied");
		expect(d1.sqlite.prepare("SELECT COUNT(*) AS n FROM device_credentials WHERE revoked_at IS NULL").get()).toEqual({ n: 0 });
	});
});
