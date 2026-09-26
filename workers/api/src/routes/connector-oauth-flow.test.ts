/**
 * #352 Stage 2 — Drive, WorkDrive and Gmail connect through the ONE generic OAuth flow, and nothing a
 * connected owner already has changes.
 *
 * On the REAL migrated schema with real envelope encryption, because the properties that matter are
 * about rows: a reconnect must update the row an existing connection already is (Drive's single
 * `account_id = ''`, Gmail's one-per-mailbox) rather than add a second beside it, and a refused state
 * must write nothing at all.
 */
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { signConnectorState } from "../lib/connector-oauth.js";
import { realSchemaD1, type RealSchemaD1, seedTenant } from "../lib/d1-sqlite.js";
import { newOauthNonce, oauthBindCookie } from "../lib/oauth-nonce.js";
import { signSession } from "../lib/session.js";
import { connectorRoutes } from "./connectors.js";
import { driveRoutes } from "./drive.js";
import { emailRoutes } from "./email.js";
import { workdriveRoutes } from "./workdrive.js";
import type { Env } from "../types.js";

const SECRET = "flow-secret";
const KEK = `${"0".repeat(63)}1`;
const ORIGIN = "https://api.example.test";

let d1: RealSchemaD1;
afterEach(() => {
	vi.unstubAllGlobals();
	d1?.close();
	d1 = undefined as unknown as RealSchemaD1;
});

function setup(extraEnv: Record<string, string> = {}) {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["i1"] });
	seedTenant(d1, { userId: "u2", instanceIds: ["i2"] });
	const env = {
		SESSION_SIGNING_KEY: SECRET,
		KEY_ENCRYPTION_KEY: KEK,
		GOOGLE_CLIENT_ID: "google-client",
		GOOGLE_CLIENT_SECRET: "google-secret",
		ZOHO_CLIENT_ID: "zoho-client",
		ZOHO_CLIENT_SECRET: "zoho-secret",
		DB: d1.DB,
		...extraEnv,
	} as unknown as Env;
	const app = new Hono<{ Bindings: Env }>();
	app.route("/v1/connectors", connectorRoutes);
	app.route("/v1/email", emailRoutes);
	app.route("/v1/drive", driveRoutes);
	app.route("/v1/workdrive", workdriveRoutes);
	app.onError((err, c) => (err instanceof HttpError ? c.json({ error: err.message }, err.status as 400) : c.json({ error: String(err) }, 500)));
	const req = (path: string, init: RequestInit = {}) => app.request(`${ORIGIN}${path}`, init, env);
	return { env, req };
}

/** A provider that answers the token exchange and userinfo, recording every call. */
function provider(opts: { email?: string; scope?: string; refresh?: string | null } = {}) {
	const calls: Array<{ url: string; body: URLSearchParams | null }> = [];
	vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		calls.push({ url, body: init?.body ? new URLSearchParams(String(init.body)) : null });
		if (url.includes("/userinfo")) return Response.json({ email: opts.email ?? "me@x.test" });
		return Response.json({ ...(opts.refresh === null ? {} : { refresh_token: opts.refresh ?? "RT" }), access_token: "AT", ...(opts.scope ? { scope: opts.scope } : {}) });
	});
	return calls;
}

/** A state + the browser cookie it is bound to, as the start route would have minted them. */
async function minted(providerId: string, uid = "u1", opts: { exp?: number } = {}) {
	const nonce = newOauthNonce();
	const state = await signConnectorState(uid, opts.exp ?? Math.floor(Date.now() / 1000) + 600, SECRET, { nonce, provider: providerId });
	return { state, cookie: oauthBindCookie(nonce, providerId).split(";")[0] };
}

const rows = (providerId: string) =>
	d1.sqlite.prepare("SELECT user_id, account_id, account_label, granted_scopes FROM user_api_keys WHERE provider = ? ORDER BY account_id").all(providerId) as Array<Record<string, string | null>>;

async function authorize(req: ReturnType<typeof setup>["req"], path: string) {
	const res = await req(path, { headers: { Authorization: `Bearer ${await signSession("u1", SECRET, { roles: [] })}` } });
	expect(res.status, path).toBe(200);
	return new URL(((await res.json()) as { url: string }).url);
}

describe("start — one flow, each connector's REGISTERED redirect (#352 Stage 2)", () => {
	it("Drive, WorkDrive and Gmail each send the browser back to the path their OAuth app already has registered", async () => {
		const { req } = setup();
		expect((await authorize(req, "/v1/connectors/google_drive/oauth/start")).searchParams.get("redirect_uri")).toBe(`${ORIGIN}/v1/drive/google/callback`);
		expect((await authorize(req, "/v1/connectors/gmail/oauth/start")).searchParams.get("redirect_uri")).toBe(`${ORIGIN}/v1/email/google/callback`);
		expect((await authorize(req, "/v1/connectors/zoho_workdrive/oauth/start")).searchParams.get("redirect_uri")).toBe(`${ORIGIN}/v1/workdrive/zoho/callback`);
	});

	it("the legacy start paths are aliases: same endpoint, same redirect, same scopes", async () => {
		const { req } = setup();
		for (const [legacy, generic] of [
			["/v1/drive/google/start", "/v1/connectors/google_drive/oauth/start"],
			["/v1/email/google/start", "/v1/connectors/gmail/oauth/start"],
			["/v1/workdrive/zoho/start", "/v1/connectors/zoho_workdrive/oauth/start"],
		]) {
			const a = await authorize(req, legacy);
			const b = await authorize(req, generic);
			a.searchParams.delete("state");
			b.searchParams.delete("state");
			expect(a.toString(), legacy).toBe(b.toString());
		}
	});

	it("WorkDrive's consent page is on THIS deployment's Zoho data-centre", async () => {
		const { req } = setup({ ZOHO_ACCOUNTS_BASE: "https://accounts.zoho.eu" });
		const url = await authorize(req, "/v1/connectors/zoho_workdrive/oauth/start");
		expect(url.origin).toBe("https://accounts.zoho.eu");
		expect(url.searchParams.get("scope")).toBe("aaaserver.profile.READ,WorkDrive.files.READ,WorkDrive.teamfolders.READ,ZohoFiles.files.READ");
	});

	it("only a connector with owner-chosen powers widens its grant with include_granted_scopes — Drive's token never inherits Gmail's", async () => {
		const { req } = setup();
		expect((await authorize(req, "/v1/connectors/gmail/oauth/start")).searchParams.get("include_granted_scopes")).toBe("true");
		expect((await authorize(req, "/v1/connectors/google_drive/oauth/start")).searchParams.get("include_granted_scopes")).toBeNull();
		expect((await authorize(req, "/v1/connectors/google_drive/oauth/start?account=me%40x.test")).searchParams.get("login_hint")).toBeNull();
	});

	it("a power a connector does not declare is refused, never passed to the provider", async () => {
		const { req } = setup();
		const auth = { headers: { Authorization: `Bearer ${await signSession("u1", SECRET, { roles: [] })}` } };
		expect((await req("/v1/connectors/google_drive/oauth/start?grant=send", auth)).status).toBe(400);
		expect((await req("/v1/connectors/gmail/oauth/start?grant=https://mail.google.com/", auth)).status).toBe(400);
	});

	it("the bind cookie is set for the connector the state names", async () => {
		const { req } = setup();
		const res = await req("/v1/connectors/google_drive/oauth/start", { headers: { Authorization: `Bearer ${await signSession("u1", SECRET, { roles: [] })}` } });
		const state = new URL(((await res.json()) as { url: string }).url).searchParams.get("state")!;
		expect(res.headers.get("set-cookie")).toMatch(/google_drive/);
		expect(JSON.parse(atob(state.split(".")[0].replace(/-/g, "+").replace(/_/g, "/")))).toMatchObject({ uid: "u1", p: "google_drive" });
	});
});

describe("callback — existing connections are preserved, row for row (#352 Stage 2)", () => {
	it("Drive, via its registered path: the SINGLE row, labelled with the address, exchanged against the same redirect", async () => {
		const { req } = setup();
		const calls = provider({ email: "me@x.test", scope: "openid email https://www.googleapis.com/auth/drive.readonly" });
		const { state, cookie } = await minted("google_drive");
		const res = await req(`/v1/drive/google/callback?code=C&state=${encodeURIComponent(state)}`, { headers: { cookie } });
		expect(res.status).toBe(200);
		expect(calls[0].url).toBe("https://oauth2.googleapis.com/token");
		expect(calls[0].body?.get("redirect_uri")).toBe(`${ORIGIN}/v1/drive/google/callback`);
		expect(rows("google_drive")).toEqual([{ user_id: "u1", account_id: "", account_label: "me@x.test", granted_scopes: "openid email https://www.googleapis.com/auth/drive.readonly" }]);
	});

	it("an owner connected BEFORE this change reconnects into the same row — never a second Drive beside it", async () => {
		const { req } = setup();
		d1.exec(`INSERT INTO user_api_keys (user_id, provider, account_id, key_ciphertext, dek_wrapped, iv, account_label, created_at) VALUES ('u1', 'google_drive', '', x'00', x'00', x'00', 'me@x.test', datetime('now'))`);
		provider({ email: "me@x.test" });
		const { state, cookie } = await minted("google_drive");
		expect((await req(`/v1/connectors/google_drive/oauth/callback?code=C&state=${encodeURIComponent(state)}`, { headers: { cookie } })).status).toBe(200);
		expect(rows("google_drive")).toHaveLength(1);
	});

	it("Gmail keeps one row PER mailbox, and a reconnect merges what the mailbox already held", async () => {
		const { req } = setup();
		const READ = "https://www.googleapis.com/auth/gmail.readonly";
		const SEND = "https://www.googleapis.com/auth/gmail.send";
		provider({ email: "a@x.test", scope: `openid email ${READ} ${SEND}` });
		let m = await minted("gmail");
		await req(`/v1/email/google/callback?code=C&state=${encodeURIComponent(m.state)}`, { headers: { cookie: m.cookie } });
		provider({ email: "b@x.test", scope: `openid email ${READ}` });
		m = await minted("gmail");
		await req(`/v1/connectors/gmail/oauth/callback?code=C&state=${encodeURIComponent(m.state)}`, { headers: { cookie: m.cookie } });
		// A narrower reconnect of the first mailbox cannot take `send` away.
		provider({ email: "a@x.test", scope: `openid ${READ}` });
		m = await minted("gmail");
		await req(`/v1/email/google/callback?code=C&state=${encodeURIComponent(m.state)}`, { headers: { cookie: m.cookie } });
		const got = rows("gmail");
		expect(got.map((r) => r.account_id)).toEqual(["a@x.test", "b@x.test"]);
		expect(got[0].granted_scopes?.split(" ")).toEqual(expect.arrayContaining([READ, SEND]));
	});

	it("WorkDrive: the token is exchanged at THIS deployment's data-centre, stored as the single labelled row", async () => {
		const { req } = setup({ ZOHO_ACCOUNTS_BASE: "https://accounts.zoho.eu" });
		const calls = provider();
		const { state, cookie } = await minted("zoho_workdrive");
		expect((await req(`/v1/workdrive/zoho/callback?code=C&state=${encodeURIComponent(state)}`, { headers: { cookie } })).status).toBe(200);
		expect(calls.map((c) => c.url)).toEqual(["https://accounts.zoho.eu/oauth/v2/token"]);
		expect(calls[0].body?.get("redirect_uri")).toBe(`${ORIGIN}/v1/workdrive/zoho/callback`);
		expect(rows("zoho_workdrive")).toEqual([{ user_id: "u1", account_id: "", account_label: "Zoho WorkDrive", granted_scopes: null }]);
	});

	it("a provider that returns no refresh token stores nothing", async () => {
		const { req } = setup();
		provider({ refresh: null });
		const { state, cookie } = await minted("google_drive");
		expect((await req(`/v1/drive/google/callback?code=C&state=${encodeURIComponent(state)}`, { headers: { cookie } })).status).toBe(400);
		expect(rows("google_drive")).toEqual([]);
	});
});

describe("state and nonce security holds on every path (#352 Stage 2)", () => {
	const refusedAndNothingStored = async (res: Response, providerId: string) => {
		expect(res.status).toBe(400);
		expect(rows(providerId)).toEqual([]);
	};

	it("a state minted for Drive is refused at Gmail's callback, on the legacy and the generic path", async () => {
		const { req } = setup();
		provider();
		const { state, cookie } = await minted("google_drive");
		await refusedAndNothingStored(await req(`/v1/email/google/callback?code=C&state=${encodeURIComponent(state)}`, { headers: { cookie } }), "gmail");
		await refusedAndNothingStored(await req(`/v1/connectors/gmail/oauth/callback?code=C&state=${encodeURIComponent(state)}`, { headers: { cookie } }), "gmail");
	});

	it("a state completed by a DIFFERENT browser (no cookie, or another flow's cookie) is refused — the account-takeover shape", async () => {
		const { req } = setup();
		provider();
		const { state } = await minted("google_drive", "attacker");
		const other = await minted("google_drive", "attacker");
		await refusedAndNothingStored(await req(`/v1/drive/google/callback?code=C&state=${encodeURIComponent(state)}`), "google_drive");
		await refusedAndNothingStored(await req(`/v1/drive/google/callback?code=C&state=${encodeURIComponent(state)}`, { headers: { cookie: other.cookie } }), "google_drive");
	});

	it("an expired or re-signed state is refused", async () => {
		const { req } = setup();
		provider();
		const expired = await minted("google_drive", "u1", { exp: Math.floor(Date.now() / 1000) - 1 });
		await refusedAndNothingStored(await req(`/v1/drive/google/callback?code=C&state=${encodeURIComponent(expired.state)}`, { headers: { cookie: expired.cookie } }), "google_drive");
		const good = await minted("google_drive");
		const [payload] = good.state.split(".");
		const forged = `${btoa(JSON.stringify({ uid: "u2", exp: 9_999_999_999, n: "x", p: "google_drive" })).replace(/=+$/, "")}.${good.state.split(".")[1]}`;
		expect(payload).not.toBe(forged.split(".")[0]);
		await refusedAndNothingStored(await req(`/v1/drive/google/callback?code=C&state=${encodeURIComponent(forged)}`, { headers: { cookie: good.cookie } }), "google_drive");
	});

	it("the bind cookie is cleared by the callback whatever the outcome — single use", async () => {
		const { req } = setup();
		provider();
		const { state, cookie } = await minted("google_drive");
		const res = await req(`/v1/drive/google/callback?code=C&state=${encodeURIComponent(state)}`, { headers: { cookie } });
		expect(res.headers.get("set-cookie")).toMatch(/google_drive=;|Max-Age=0/);
	});

	describe("the id-less generic callback — one redirect URI per OAuth app", () => {
		it("completes the connector the state names, and only with that connector's own nonce", async () => {
			const { req } = setup();
			provider({ email: "me@x.test" });
			const { state, cookie } = await minted("google_drive");
			expect((await req(`/v1/connectors/oauth/callback?code=C&state=${encodeURIComponent(state)}`, { headers: { cookie } })).status).toBe(200);
			expect(rows("google_drive")).toHaveLength(1);
		});

		it("a forged provider claim only selects a verification that fails — nothing stored anywhere", async () => {
			const { req } = setup();
			provider();
			const drive = await minted("google_drive");
			const [, sig] = drive.state.split(".");
			const claim = btoa(JSON.stringify({ uid: "u1", exp: 9_999_999_999, n: "x", p: "gmail" })).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
			await refusedAndNothingStored(await req(`/v1/connectors/oauth/callback?code=C&state=${encodeURIComponent(`${claim}.${sig}`)}`, { headers: { cookie: drive.cookie } }), "gmail");
			expect(rows("google_drive")).toEqual([]);
		});

		it("an unknown or non-OAuth provider claim, or garbage, is refused", async () => {
			const { req } = setup();
			provider();
			for (const p of ["github", "nope"]) {
				const m = await minted(p);
				expect((await req(`/v1/connectors/oauth/callback?code=C&state=${encodeURIComponent(m.state)}`, { headers: { cookie: m.cookie } })).status, p).toBe(400);
			}
			expect((await req("/v1/connectors/oauth/callback?code=C&state=not-a-state")).status).toBe(400);
		});
	});
});

describe("generic disconnect carries what the retired routes did (#352 Stage 2)", () => {
	const del = async (req: ReturnType<typeof setup>["req"], path: string, uid = "u1") =>
		req(path, { method: "DELETE", headers: { Authorization: `Bearer ${await signSession(uid, SECRET, { roles: [] })}` } });

	it("Gmail: ?account= removes ONE mailbox and reports what remains", async () => {
		const { req } = setup();
		for (const a of ["a@x.test", "b@x.test"]) d1.exec(`INSERT INTO user_api_keys (user_id, provider, account_id, key_ciphertext, dek_wrapped, iv, account_label, created_at) VALUES ('u1', 'gmail', '${a}', x'00', x'00', x'00', '${a}', datetime('now'))`);
		const res = await del(req, "/v1/connectors/gmail/oauth?account=a%40x.test");
		expect(await res.json()).toMatchObject({ success: true, removed: 1, remaining: [{ accountId: "b@x.test", label: "b@x.test" }] });
		expect(rows("gmail").map((r) => r.account_id)).toEqual(["b@x.test"]);
	});

	it("only the caller's own rows are touched", async () => {
		const { req } = setup();
		d1.exec(`INSERT INTO user_api_keys (user_id, provider, account_id, key_ciphertext, dek_wrapped, iv, created_at) VALUES ('u2', 'google_drive', '', x'00', x'00', x'00', datetime('now'))`);
		await del(req, "/v1/connectors/google_drive/oauth", "u1");
		expect(rows("google_drive").map((r) => r.user_id)).toEqual(["u2"]);
	});
});
