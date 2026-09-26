/**
 * Gmail access the owner chooses, and can widen later without losing any (#718).
 *
 * A plain connect is read-only; send and manage-mail are optional grants asked for only when named.
 * Every authorize URL carries `include_granted_scopes`, and the callback MERGES the stored grant —
 * the regression the issue calls the sharp edge: an elevate for manage-mail that came back without
 * send would leave a working sending agent refusing every send.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/session.js", () => ({
	verifySession: async (t: string) => (t ? { uid: "u1", roles: [] } : null),
}));

import { Hono } from "hono";
import { HttpError } from "../lib/auth.js";
import { signConnectorState } from "../lib/connector-oauth.js";
import { newOauthNonce, oauthBindCookie } from "../lib/oauth-nonce.js";
import { connectorRoutes } from "./connectors.js";
import { emailRoutes } from "./email.js";
import { mergeScopes, requestScopesFor } from "../lib/connector-oauth-flow.js";
import { getConnector } from "../lib/connectors/registry.js";
import type { Env } from "../types.js";

const READ = "https://www.googleapis.com/auth/gmail.readonly";
const SEND = "https://www.googleapis.com/auth/gmail.send";
const MODIFY = "https://www.googleapis.com/auth/gmail.modify";
const KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const app = new Hono<{ Bindings: Env }>();
app.route("/v1/email", emailRoutes);
app.route("/v1/connectors", connectorRoutes);
app.onError((err, c) => (err instanceof HttpError ? c.json({ error: err.message }, err.status as 400) : c.json({ error: String(err) }, 500)));

/** A D1 holding at most one Gmail row for u1 (`prior`), recording every write. */
function env(opts: { prior?: string | null; rows?: Array<{ account_id: string; account_label: string; granted_scopes: string | null }> } = {}) {
	const writes: Array<{ sql: string; binds: unknown[] }> = [];
	const e = {
		SESSION_SIGNING_KEY: "signing-key",
		GOOGLE_CLIENT_ID: "google-client",
		GOOGLE_CLIENT_SECRET: "google-secret",
		KEY_ENCRYPTION_KEY: KEY,
		DB: {
			prepare: (sql: string) => ({
				bind: (...binds: unknown[]) => ({
					first: async () => (sql.includes("SELECT granted_scopes FROM user_api_keys") && opts.prior !== undefined ? { granted_scopes: opts.prior } : null),
					all: async () => ({
						results: sql.includes("FROM user_api_keys")
							? (opts.rows ?? []).map((r) => ({ provider: "gmail", created_at: "2026-09-01 00:00:00", ...r }))
							: [],
					}),
					run: async () => {
						writes.push({ sql, binds });
						return { meta: { changes: 1 } };
					},
				}),
			}),
		},
	} as unknown as Env;
	return { env: e, writes };
}

const authed = { headers: { Authorization: "Bearer tok" } };

async function authorizeUrl(query = ""): Promise<URL> {
	const res = await app.request(`/v1/email/google/start${query}`, authed, env().env);
	expect(res.status).toBe(200);
	return new URL(((await res.json()) as { url: string }).url);
}

afterEach(() => vi.unstubAllGlobals());

describe("GET /v1/email/google/start — what is asked for is the owner's choice (#718)", () => {
	it("a plain connect asks for read-only, and always includes what was granted before", async () => {
		const url = await authorizeUrl();
		expect(url.searchParams.get("scope")?.split(" ")).toEqual(["openid", "email", READ]);
		expect(url.searchParams.get("include_granted_scopes")).toBe("true");
		expect(url.searchParams.get("prompt")).toBe("consent");
		expect(url.searchParams.get("login_hint")).toBeNull();
	});

	it("?grant= adds exactly the chosen powers — repeated or comma-separated", async () => {
		expect((await authorizeUrl("?grant=send")).searchParams.get("scope")?.split(" ")).toEqual(["openid", "email", READ, SEND]);
		expect((await authorizeUrl("?grant=modify")).searchParams.get("scope")?.split(" ")).toEqual(["openid", "email", READ, MODIFY]);
		expect((await authorizeUrl("?grant=send,modify")).searchParams.get("scope")?.split(" ")).toEqual(["openid", "email", READ, SEND, MODIFY]);
		expect((await authorizeUrl("?grant=send&grant=modify&grant=send")).searchParams.get("scope")?.split(" ")).toEqual(["openid", "email", READ, SEND, MODIFY]);
	});

	it("a grant the manifest does not declare is refused, naming the ones that exist — never passed to Google", async () => {
		for (const grant of ["everything", "https://mail.google.com/"]) {
			const res = await app.request(`/v1/email/google/start?grant=${encodeURIComponent(grant)}`, authed, env().env);
			expect(res.status).toBe(400);
			expect(((await res.json()) as { error: string }).error).toMatch(/choose from: send, modify/);
		}
		expect(requestScopesFor(getConnector("gmail")!, ["send"])).toEqual({ scopes: ["openid", "email", READ, SEND] });
	});

	it("?account= pre-selects that mailbox at Google, for an Allow on one of several accounts", async () => {
		expect((await authorizeUrl("?grant=send&account=me%40x.test")).searchParams.get("login_hint")).toBe("me@x.test");
	});
});

/** Complete a consent whose token response grants `returned`, against a stored grant `prior`. */
async function callback(prior: string | null | undefined, returned: string | undefined) {
	vi.stubGlobal("fetch", async (input: string | URL | Request) => {
		const u = String(input);
		if (u.startsWith("https://oauth2.googleapis.com/token")) return Response.json({ refresh_token: "refresh", access_token: "access", ...(returned ? { scope: returned } : {}) });
		if (u.startsWith("https://www.googleapis.com/oauth2/v2/userinfo")) return Response.json({ email: "me@x.test" });
		return new Response("unexpected", { status: 500 });
	});
	const nonce = newOauthNonce();
	const state = await signConnectorState("u1", Math.floor(Date.now() / 1000) + 600, "signing-key", { nonce, provider: "gmail" });
	const h = env({ prior });
	const res = await app.request(
		`/v1/email/google/callback?code=c&state=${encodeURIComponent(state)}`,
		{ headers: { cookie: oauthBindCookie(nonce, "gmail").split(";")[0] } },
		h.env,
	);
	expect(res.status).toBe(200);
	const insert = h.writes.find((w) => w.sql.includes("INSERT INTO user_api_keys"));
	// `saveConnectorRefreshToken`: (user, provider, account_id, ciphertext, dek, iv, label, granted_scopes).
	return (insert?.binds[7] as string | null) ?? null;
}

describe("the callback never narrows what an account already holds (#718)", () => {
	it("connect with send, elevate for manage-mail that comes back WITHOUT send: the stored grant still has send", async () => {
		const stored = await callback(`openid email ${READ} ${SEND}`, `openid ${READ} ${MODIFY}`);
		expect(stored?.split(" ")).toEqual(expect.arrayContaining([READ, SEND, MODIFY]));
	});

	it("a plain read-only reconnect keeps send and manage-mail an account already had", async () => {
		const stored = await callback(`openid email ${READ} ${SEND} ${MODIFY}`, `openid email ${READ}`);
		expect(stored?.split(" ")).toEqual(expect.arrayContaining([READ, SEND, MODIFY]));
	});

	it("a first connect stores exactly what Google granted", async () => {
		expect(await callback(undefined, `openid email ${READ}`)).toBe(`openid email ${READ}`);
	});

	it("mergeScopes is the union, order kept, no duplicates; null only when both are empty", () => {
		expect(mergeScopes("a b", "b c")).toBe("a b c");
		expect(mergeScopes(null, "a")).toBe("a");
		expect(mergeScopes("a", undefined)).toBe("a");
		expect(mergeScopes(null, "")).toBeNull();
	});
});

describe("GET /v1/connectors — an optional grant not given is an offer, not a shortfall (#718)", () => {
	type Account = { accountId: string; missingScopes: string[] | null; optionalGrants: Array<{ id: string; label: string; held: boolean }> };
	async function gmailRow(rows: Array<{ account_id: string; account_label: string; granted_scopes: string | null }>) {
		const res = await app.request("/v1/connectors", authed, env({ rows }).env);
		const { connectors } = (await res.json()) as { connectors: Array<{ id: string; missingScopes: string[] | null; optionalGrants: Account["optionalGrants"]; accounts: Account[] }> };
		return connectors.find((c) => c.id === "gmail")!;
	}

	it("a read-only account is missing NOTHING, and is offered send and manage-mail by name", async () => {
		const gmail = await gmailRow([{ account_id: "me@x.test", account_label: "me@x.test", granted_scopes: `openid https://www.googleapis.com/auth/userinfo.email ${READ}` }]);
		expect(gmail.missingScopes).toEqual([]);
		expect(gmail.optionalGrants).toEqual([
			{ id: "send", label: "Send and reply as you", held: false },
			{ id: "modify", label: "Archive and mark read", held: false },
		]);
		expect(gmail.accounts[0].missingScopes).toEqual([]);
	});

	it("each account says which it holds", async () => {
		const gmail = await gmailRow([
			{ account_id: "a@x.test", account_label: "a@x.test", granted_scopes: `openid email ${READ} ${SEND}` },
			{ account_id: "b@x.test", account_label: "b@x.test", granted_scopes: `openid email ${MODIFY}` },
		]);
		const held = Object.fromEntries(gmail.accounts.map((a) => [a.accountId, a.optionalGrants.filter((g) => g.held).map((g) => g.id)]));
		expect(held).toEqual({ "a@x.test": ["send"], "b@x.test": ["modify"] });
		// gmail.modify includes reading, so the manage-only account lacks nothing from the baseline.
		expect(gmail.accounts.find((a) => a.accountId === "b@x.test")?.missingScopes).toEqual([]);
	});

	it("a grant that predates the recording holds nothing provable, so both are offered", async () => {
		const gmail = await gmailRow([{ account_id: "", account_label: "old@x.test", granted_scopes: null }]);
		expect(gmail.optionalGrants.every((g) => !g.held)).toBe(true);
		expect(gmail.missingScopes).toBeNull();
	});
});
