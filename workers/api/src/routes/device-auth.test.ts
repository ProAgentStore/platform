/**
 * #1157: `pags login --device` and session refresh — real schema, real routes; only the signed-in approver is faked.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { realSchemaD1, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import { verifySession } from "../lib/session.js";
import { generateUserCode, normalizeUserCode, pollDeviceAuthorization } from "../lib/device-auth.js";
import { checkConsoleLink } from "../../../../store/console/src/lib/routes.js";
import type { Env } from "../types.js";

const who = vi.hoisted(() => ({ uid: "u1" }));
vi.mock("../lib/auth.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/auth.js")>("../lib/auth.js");
	return { ...actual, requireUser: async () => ({ uid: who.uid, roles: ["user"], iat: 0, exp: 0 }) };
});
const { deviceAuthRoutes, sessionRoutes } = await import("./device-auth.js");

const KEY = "test-signing-key";
let d1: RealSchemaD1;
const env = () => ({ DB: d1.DB, SESSION_SIGNING_KEY: KEY }) as unknown as Env;
const app = () => {
	const a = new Hono<{ Bindings: Env }>().route("/v1/auth/device", deviceAuthRoutes).route("/v1/auth/session", sessionRoutes);
	a.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500)));
	return a;
};
async function call(method: string, path: string, body?: unknown, uid = "u1") {
	who.uid = uid;
	const res = await app().request(path, { method, headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.7" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, env());
	// biome-ignore lint/suspicious/noExplicitAny: assertions read the JSON field by field
	return { status: res.status, body: (await res.json()) as Record<string, any> };
}
const start = () => call("POST", "/v1/auth/device/start", { node: "dell-laptop" });
const token = (device_code: string) => call("POST", "/v1/auth/device/token", { device_code });

beforeEach(() => {
	d1 = realSchemaD1();
	d1.exec(`INSERT INTO users (id, github_login, roles) VALUES ('u1', 'one', '["user","creator"]'), ('u2', 'two', '["user"]')`);
});
afterEach(() => {
	d1.close();
	vi.useRealTimers();
});

describe("user codes (#1157)", () => {
	it("are XXXX-XXXX from consonants only — no word can be spelled — and normalise from what an owner types", () => {
		for (let i = 0; i < 200; i++) expect(generateUserCode()).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
		expect(normalizeUserCode(" bcdf ghjk ")).toBe("BCDF-GHJK");
		expect(normalizeUserCode("BCDFGHJK")).toBe("BCDF-GHJK");
		expect(normalizeUserCode("ABCD-EFGH")).toBeNull(); // vowels are never issued
		expect(normalizeUserCode("BCD-FGH")).toBeNull();
	});
});

describe("the device flow, end to end (#1157)", () => {
	it("start → pending → the owner sees which machine asked → approve → ONE session with the account's live roles", async () => {
		const s = await start();
		expect(s.status).toBe(200);
		expect(s.body).toMatchObject({ expires_in: 600, interval: 5, verification_uri: "https://proagentstore.online/console/device" });
		expect(s.body.verification_uri_complete).toBe(`https://proagentstore.online/console/device?code=${s.body.user_code}`);
		expect(checkConsoleLink(new URL(s.body.verification_uri_complete).pathname)).toMatchObject({ ok: true, route: "device" }); // a real console route
		// Only the hash of the machine's secret is stored.
		expect(JSON.stringify(d1.sqlite.prepare("SELECT * FROM device_authorizations").all())).not.toContain(s.body.device_code);

		expect((await token(s.body.device_code)).body).toEqual({ error: "authorization_pending" });

		const seen = await call("GET", `/v1/auth/device/requests/${s.body.user_code.toLowerCase()}`);
		expect(seen.body.request).toMatchObject({ userCode: s.body.user_code, status: "pending", node: "dell-laptop", ip: "203.0.113.7" });

		expect((await call("POST", `/v1/auth/device/requests/${s.body.user_code}`, { approve: true })).body.request.status).toBe("approved");
		const won = await token(s.body.device_code);
		expect(won.status).toBe(200);
		const payload = await verifySession(won.body.session, KEY);
		expect(payload).toMatchObject({ uid: "u1", roles: ["user", "creator"] });
		expect(Date.parse(won.body.expires_at)).toBe((payload?.exp ?? 0) * 1000);

		// Consumed: the same approval can never mint a second session.
		expect((await token(s.body.device_code)).body).toEqual({ error: "expired_token" });
		expect((await call("POST", `/v1/auth/device/requests/${s.body.user_code}`, { approve: true })).status).toBe(409);
	});

	it("a denied request answers access_denied, and stays denied", async () => {
		const s = await start();
		await call("POST", `/v1/auth/device/requests/${s.body.user_code}`, { approve: false });
		expect((await token(s.body.device_code)).body).toEqual({ error: "access_denied" });
		expect((await call("POST", `/v1/auth/device/requests/${s.body.user_code}`, { approve: true })).status).toBe(409);
	});

	it("a suspended account's approval mints nothing", async () => {
		d1.exec("UPDATE users SET suspended = 1 WHERE id = 'u2'");
		const s = await start();
		await call("POST", `/v1/auth/device/requests/${s.body.user_code}`, { approve: true }, "u2");
		expect((await token(s.body.device_code)).body).toEqual({ error: "access_denied" });
	});

	it("expires after 10 minutes: the code is gone from the approval page and the poll says expired_token", async () => {
		const s = await start();
		vi.useFakeTimers({ now: Date.now() + 601_000, toFake: ["Date"] });
		expect((await call("GET", `/v1/auth/device/requests/${s.body.user_code}`)).status).toBe(404);
		expect((await call("POST", `/v1/auth/device/requests/${s.body.user_code}`, { approve: true })).status).toBe(409);
		expect((await token(s.body.device_code)).body).toEqual({ error: "expired_token" });
	});

	it("a poll faster than the interval is told slow_down (RFC 8628 §3.5)", async () => {
		const s = await start();
		const t0 = Date.now();
		expect(await pollDeviceAuthorization(env(), s.body.device_code, t0)).toEqual({ kind: "authorization_pending" });
		expect(await pollDeviceAuthorization(env(), s.body.device_code, t0 + 1_000)).toEqual({ kind: "slow_down" });
		expect(await pollDeviceAuthorization(env(), s.body.device_code, t0 + 6_000)).toEqual({ kind: "authorization_pending" });
	});

	it("an unknown or malformed device code reveals nothing beyond expired_token", async () => {
		expect((await token("f".repeat(64))).body).toEqual({ error: "expired_token" });
		expect((await token("not-a-code")).body).toEqual({ error: "expired_token" });
		expect((await call("GET", "/v1/auth/device/requests/not-a-code")).status).toBe(400);
	});
});

describe("session refresh (#1157)", () => {
	it("a valid session gets a fresh 30-day one, with the account's live roles", async () => {
		const r = await call("POST", "/v1/auth/session/refresh");
		expect(r.status).toBe(200);
		const payload = await verifySession(r.body.session, KEY);
		expect(payload).toMatchObject({ uid: "u1", roles: ["user", "creator"] });
		expect((payload?.exp ?? 0) - Math.floor(Date.now() / 1000)).toBeGreaterThan(29 * 86_400);
	});

	it("an account that no longer exists gets nothing", async () => {
		expect((await call("POST", "/v1/auth/session/refresh", undefined, "gone")).status).toBe(403);
	});
});
