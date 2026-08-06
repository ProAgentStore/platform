import { describe, expect, it, vi } from "vitest";
import type { Env } from "../types.js";
import { saveMcpCredential } from "./mcp-credentials.js";
import { claimFlow, completeFlow, ensureMcpAccessToken, getOrRegisterClient, readClientRegistration, saveFlow } from "./mcp-oauth-store.js";

vi.mock("./connectors/dcr.js", async (orig) => {
	const actual = (await orig()) as Record<string, unknown>;
	return { ...actual, registerClient: vi.fn(async (input: { redirectUri: string }) => ({ clientId: `cid-${++registrations}`, clientSecret: null, redirectUri: input.redirectUri })) };
});
let registrations = 0;

const KEK = "1".repeat(64);
const REDIRECT = "https://api.example/v1/mcp/oauth/callback";
const ENDPOINT = "https://a.example/mcp";
const ISSUER = "https://as.example";

/**
 * A fake D1 holding the three tables this module touches. A real store rather than per-statement
 * stubs on purpose: every property under test here is about rows interacting — a flow claimed
 * once, a registration reused, a refresh token preserved across an update — and stubs that answer
 * each query independently cannot fail the way the table would.
 */
function fakeDb() {
	const clients = new Map<string, Record<string, unknown>>();
	const flows = new Map<string, Record<string, unknown>>();
	const creds = new Map<string, Record<string, unknown>>();
	const k = (a: unknown, b: unknown) => `${String(a)} ${String(b)}`;

	const prepare = (sql: string) => {
		let a: unknown[] = [];
		const stmt = {
			bind(...args: unknown[]) {
				a = args;
				return stmt;
			},
			async run() {
				if (sql.includes("INSERT INTO mcp_oauth_clients")) {
					clients.set(k(a[0], a[1]), { user_id: a[0], issuer: a[1], client_id: a[2], redirect_uri: a[3], secret_ciphertext: a[4], secret_dek_wrapped: a[5], secret_iv: a[6] });
				} else if (sql.includes("INSERT INTO mcp_oauth_flows")) {
					flows.set(String(a[0]), {
						id: a[0],
						user_id: a[1],
						endpoint: a[2],
						issuer: a[3],
						token_endpoint: a[4],
						client_id: a[5],
						redirect_uri: a[6],
						scope: a[7],
						verifier_ciphertext: a[8],
						verifier_dek_wrapped: a[9],
						verifier_iv: a[10],
						expires_at: a[11],
					});
				} else if (sql.includes("DELETE FROM mcp_oauth_flows")) {
					for (const [id, f] of flows) if (Date.parse(String(f.expires_at)) <= Date.now()) flows.delete(id);
				} else if (sql.includes("INSERT INTO mcp_credentials")) {
					creds.set(k(a[0], a[1]), {
						user_id: a[0],
						endpoint: a[1],
						auth_mode: a[2],
						issuer: a[3],
						scopes: a[4],
						expires_at: a[5],
						key_ciphertext: a[6],
						dek_wrapped: a[7],
						iv: a[8],
						account_label: a[9],
						token_endpoint: a[10],
						refresh_ciphertext: a[11],
						refresh_dek_wrapped: a[12],
						refresh_iv: a[13],
						created_at: "now",
						updated_at: "now",
					});
				} else if (sql.includes("UPDATE mcp_credentials")) {
					const row = creds.get(k(a[0], a[1]));
					if (row) {
						row.key_ciphertext = a[2];
						row.dek_wrapped = a[3];
						row.iv = a[4];
						row.expires_at = a[5];
						// Mirrors the COALESCE in the statement: only overwrite when a new value came back.
						if (a[6] != null) row.scopes = a[6];
						if (a[7] != null) {
							row.refresh_ciphertext = a[7];
							row.refresh_dek_wrapped = a[8];
							row.refresh_iv = a[9];
						}
					}
				}
				return {};
			},
			async first<T>(): Promise<T | null> {
				if (sql.includes("FROM mcp_oauth_clients")) return (clients.get(k(a[0], a[1])) ?? null) as T | null;
				if (sql.includes("DELETE FROM mcp_oauth_flows") && sql.includes("RETURNING")) {
					const f = flows.get(String(a[0]));
					if (!f || f.user_id !== a[1] || Date.parse(String(f.expires_at)) <= Date.now()) return null;
					flows.delete(String(a[0]));
					return f as T;
				}
				if (sql.includes("FROM mcp_credentials")) return (creds.get(k(a[0], a[1])) ?? null) as T | null;
				if (sql.includes("FROM user_api_keys")) return null;
				return null;
			},
			async all<T>() {
				return { results: [] as T[] };
			},
		};
		return stmt;
	};
	return { db: { prepare } as unknown as Env["DB"], creds, flows };
}

const envFor = (db: Env["DB"]) => ({ DB: db, KEY_ENCRYPTION_KEY: KEK }) as Env;

const tokenRes = (body: Record<string, unknown>, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("client registration cache", () => {
	it("registers once per (user, issuer) and reuses it", async () => {
		// Reuse is correctness, not economy: a refresh months later must present the SAME client_id
		// the grant was issued to, so re-registering per flow would strand every stored credential.
		const { db } = fakeDb();
		registrations = 0;
		const first = await getOrRegisterClient(envFor(db), "u1", ISSUER, "https://as.example/register", REDIRECT);
		const second = await getOrRegisterClient(envFor(db), "u1", ISSUER, "https://as.example/register", REDIRECT);
		expect(second.clientId).toBe(first.clientId);
		expect(registrations).toBe(1);
	});

	it("re-registers when our callback URL changed", async () => {
		// The redirect is part of what the server validates. A cached registration for an old
		// callback fails the authorize request with an error the user cannot act on.
		const { db } = fakeDb();
		registrations = 0;
		await getOrRegisterClient(envFor(db), "u1", ISSUER, "https://as.example/register", REDIRECT);
		await getOrRegisterClient(envFor(db), "u1", ISSUER, "https://as.example/register", "https://api.example/v2/cb");
		expect(registrations).toBe(2);
	});

	it("keeps one account's registration out of another's", async () => {
		const { db } = fakeDb();
		registrations = 0;
		const a = await getOrRegisterClient(envFor(db), "u1", ISSUER, "https://as.example/register", REDIRECT);
		const b = await getOrRegisterClient(envFor(db), "u2", ISSUER, "https://as.example/register", REDIRECT);
		expect(b.clientId).not.toBe(a.clientId);
		expect(await readClientRegistration(envFor(db), "u2", ISSUER)).toMatchObject({ clientId: b.clientId });
	});

	it("refuses rather than guessing when the server will not register clients", async () => {
		// There is nothing to fall back to: no operator can pre-register for a URL they have never
		// seen, so the honest answer is "store a token for this one".
		const { db } = fakeDb();
		await expect(getOrRegisterClient(envFor(db), "u1", ISSUER, undefined, REDIRECT)).rejects.toThrow(/dynamic client registration/i);
	});
});

describe("in-flight authorizations", () => {
	const flow = {
		id: "f1",
		userId: "u1",
		endpoint: ENDPOINT,
		issuer: ISSUER,
		tokenEndpoint: "https://as.example/token",
		clientId: "cid",
		redirectUri: REDIRECT,
		scope: "read",
		verifier: "verifier-value",
	};

	it("returns the decrypted verifier exactly once", async () => {
		// An authorization code is single-use at the server too, so a replayed callback has to lose
		// the race HERE rather than reach the token endpoint a second time.
		const { db } = fakeDb();
		await saveFlow(envFor(db), flow);
		expect((await claimFlow(envFor(db), "f1", "u1"))?.verifier).toBe("verifier-value");
		expect(await claimFlow(envFor(db), "f1", "u1")).toBeNull();
	});

	it("never stores the PKCE verifier in the clear", async () => {
		// A plaintext verifier in D1 would make the row as good as the code it protects.
		const { db, flows } = fakeDb();
		await saveFlow(envFor(db), flow);
		const stored = JSON.stringify([...flows.values()][0]);
		expect(stored).not.toContain("verifier-value");
	});

	it("will not hand one account's flow to another, or honour an expired one", async () => {
		const { db } = fakeDb();
		await saveFlow(envFor(db), flow);
		expect(await claimFlow(envFor(db), "f1", "u2")).toBeNull();
		const { db: db2 } = fakeDb();
		await saveFlow(envFor(db2), flow, -1); // already expired
		expect(await claimFlow(envFor(db2), "f1", "u1")).toBeNull();
	});

	it("stores the exchanged token under the flow's endpoint, as an oauth credential", async () => {
		// The credential must land on the SAME normalized endpoint consent and the connector key
		// on, and be marked `oauth` — that mark is what later tells the resolver an expiry is
		// renewable rather than terminal.
		const { db, creds } = fakeDb();
		await saveFlow(envFor(db), flow);
		const claimed = await claimFlow(envFor(db), "f1", "u1");
		const fetchImpl = vi.fn(async () => tokenRes({ access_token: "at-1", refresh_token: "rt-1", expires_in: 3600, scope: "read" }));
		await completeFlow(envFor(db), claimed!, "the-code", fetchImpl);
		const row = creds.get(`u1 ${ENDPOINT}`);
		expect(row?.auth_mode).toBe("oauth");
		expect(row?.token_endpoint).toBe("https://as.example/token");
		expect(row?.refresh_ciphertext).toBeTruthy();
		// The code and the verifier go to the token endpoint, and the request is form-encoded.
		const body = String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body);
		expect(body).toContain("code=the-code");
		expect(body).toContain("code_verifier=verifier-value");
		expect(body).toContain(`resource=${encodeURIComponent(ENDPOINT)}`);
	});
});

describe("unattended renewal", () => {
	const seedOauth = async (db: Env["DB"], expiresAt: string | null, refreshToken: string | null = "rt-1") => {
		await saveMcpCredential(envFor(db), {
			userId: "u1",
			endpoint: ENDPOINT,
			token: "at-old",
			authMode: "oauth",
			issuer: ISSUER,
			expiresAt,
			refreshToken,
			tokenEndpoint: "https://as.example/token",
		});
		await getOrRegisterClient(envFor(db), "u1", ISSUER, "https://as.example/register", REDIRECT);
	};

	it("renews an expired credential with nobody present", async () => {
		// THE point of the feature. Without this a 24h token turns every cron-fired chain into a
		// daily outage that only a human at a browser can clear.
		const { db } = fakeDb();
		await seedOauth(db, new Date(Date.now() - 60_000).toISOString());
		const fetchImpl = vi.fn(async () => tokenRes({ access_token: "at-new", expires_in: 3600 }));
		const r = await ensureMcpAccessToken(envFor(db), "u1", ENDPOINT, fetchImpl);
		expect(r).toMatchObject({ status: "ok", token: "at-new", authMode: "oauth" });
		expect(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body)).toContain("grant_type=refresh_token");
	});

	it("renews inside the skew, before a call can die mid-flight", async () => {
		const { db } = fakeDb();
		await seedOauth(db, new Date(Date.now() + 20_000).toISOString());
		const fetchImpl = vi.fn(async () => tokenRes({ access_token: "at-new", expires_in: 3600 }));
		expect(await ensureMcpAccessToken(envFor(db), "u1", ENDPOINT, fetchImpl)).toMatchObject({ token: "at-new" });
	});

	it("does not touch a credential that is still comfortably valid", async () => {
		// A refresh on every call would spend a network round trip per tool call and rotate tokens
		// far more often than any server expects.
		const { db } = fakeDb();
		await seedOauth(db, new Date(Date.now() + 3_600_000).toISOString());
		const fetchImpl = vi.fn(async () => tokenRes({ access_token: "at-new" }));
		expect(await ensureMcpAccessToken(envFor(db), "u1", ENDPOINT, fetchImpl)).toMatchObject({ token: "at-old" });
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("keeps the existing refresh token when the server rotates nothing", async () => {
		// Overwriting with NULL would throw away the only thing that can renew this credential,
		// turning a working unattended chain into one that dies at the NEXT expiry — a failure that
		// looks like the refresh never worked at all.
		const { db, creds } = fakeDb();
		await seedOauth(db, new Date(Date.now() - 60_000).toISOString());
		const before = creds.get(`u1 ${ENDPOINT}`)?.refresh_ciphertext;
		await ensureMcpAccessToken(envFor(db), "u1", ENDPOINT, async () => tokenRes({ access_token: "at-new", expires_in: 3600 }));
		expect(creds.get(`u1 ${ENDPOINT}`)?.refresh_ciphertext).toBe(before);
	});

	it("reports the original expiry when renewal fails, rather than a new error class", async () => {
		// A revoked grant genuinely needs a human, and a transient server outage must not be
		// reported as "your authorization was revoked" — both surface as the existing `expired`,
		// whose denial text already says how to reconnect.
		const { db } = fakeDb();
		await seedOauth(db, new Date(Date.now() - 60_000).toISOString());
		const r = await ensureMcpAccessToken(envFor(db), "u1", ENDPOINT, async () => tokenRes({ error: "invalid_grant" }, 400));
		expect(r.status).toBe("expired");
	});

	it("leaves a pasted bearer alone", async () => {
		// Nothing to renew, and attempting one would spend a request per call against a token
		// endpoint that does not exist for this credential.
		const { db } = fakeDb();
		await saveMcpCredential(envFor(db), { userId: "u1", endpoint: ENDPOINT, token: "pasted", authMode: "bearer" });
		const fetchImpl = vi.fn(async () => tokenRes({ access_token: "nope" }));
		expect(await ensureMcpAccessToken(envFor(db), "u1", ENDPOINT, fetchImpl)).toMatchObject({ status: "ok", token: "pasted", authMode: "bearer" });
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("cannot renew an oauth credential whose client registration is gone", async () => {
		// The refresh must present the client_id the grant was issued to; without it the only
		// honest answer is "reconnect", not a request the server will reject.
		const { db } = fakeDb();
		await saveMcpCredential(envFor(db), {
			userId: "u1",
			endpoint: ENDPOINT,
			token: "at-old",
			authMode: "oauth",
			issuer: ISSUER,
			expiresAt: new Date(Date.now() - 60_000).toISOString(),
			refreshToken: "rt-1",
			tokenEndpoint: "https://as.example/token",
		});
		const fetchImpl = vi.fn(async () => tokenRes({ access_token: "at-new" }));
		expect((await ensureMcpAccessToken(envFor(db), "u1", ENDPOINT, fetchImpl)).status).toBe("expired");
		expect(fetchImpl).not.toHaveBeenCalled();
	});
});
