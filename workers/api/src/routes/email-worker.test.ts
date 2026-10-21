import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { signSession } from "../lib/session.js";
import { createEmailWorkerFixture } from "../lib/connectors/email-worker.fixture.js";
import { emailWorkerInboundRoutes, emailWorkerInstanceRoutes, emailWorkerRoutes } from "./email-worker.js";

const SECRET = "test-secret";
const KEK = "4".repeat(64);
const EP = "https://mail.example.com";

interface ConnRecord {
	user_id: string;
	endpoint: string;
	account_id: string;
	secret_ciphertext: Uint8Array;
	secret_dek_wrapped: Uint8Array;
	secret_iv: Uint8Array;
	account_label: string | null;
	contract_version: string | null;
	webhook_token: string;
	created_at: string;
	updated_at: string;
}

function testApp(opts: { owned?: boolean; instanceConfig?: Record<string, unknown> } = {}) {
	const conns = new Map<string, ConnRecord>();
	const inboundSeen = new Set<string>();
	const instances = new Map<string, Record<string, unknown>>();
	if (opts.owned !== false) instances.set("i1", { id: "i1", user_id: "u1", config: JSON.stringify(opts.instanceConfig ?? {}) });
	const key = (u: string, e: string, a: string) => `${u}${e}${a}`;

	const DB = {
		prepare(sql: string) {
			return {
				bind(...a: unknown[]) {
					return {
						first: async () => {
							if (sql.includes("FROM email_worker_connections WHERE webhook_token")) {
								const token = String(a[0]);
								for (const r of conns.values()) if (r.webhook_token === token) return r;
								return null;
							}
							if (sql.includes("FROM email_worker_connections")) return conns.get(key(String(a[0]), String(a[1]), String(a[2] ?? ""))) ?? null;
							if (sql.includes("FROM agent_instances")) {
								const row = instances.get(String(a[0]));
								if (!row) return null;
								return sql.includes("SELECT id, agent_id") ? { id: row.id, agent_id: "a1", user_id: row.user_id, status: "active", config: row.config, created_at: "", updated_at: "" } : { config: row.config };
							}
							return null;
						},
						all: async () => {
							if (sql.includes("FROM email_worker_connections")) {
								const uid = String(a[0]);
								return { results: [...conns.values()].filter((r) => r.user_id === uid) };
							}
							return { results: [] };
						},
						run: async () => {
							if (sql.startsWith("INSERT INTO email_worker_connections")) {
								const [user_id, endpoint, account_id, secret_ciphertext, secret_dek_wrapped, secret_iv, account_label, contract_version, webhook_token] = a as never[];
								const now = new Date().toISOString();
								conns.set(key(String(user_id), String(endpoint), String(account_id ?? "")), {
									user_id: String(user_id), endpoint: String(endpoint), account_id: String(account_id ?? ""),
									secret_ciphertext, secret_dek_wrapped, secret_iv,
									account_label: (account_label ?? null) as string | null,
									contract_version: (contract_version ?? null) as string | null,
									webhook_token: String(webhook_token), created_at: now, updated_at: now,
								});
								return { success: true, meta: { changes: 1 } };
							}
							if (sql.startsWith("UPDATE email_worker_connections SET contract_version")) {
								const row = conns.get(key(String(a[0]), String(a[1]), String(a[2] ?? "")));
								if (row) row.contract_version = String(a[3]);
								return { success: true, meta: { changes: row ? 1 : 0 } };
							}
							if (sql.startsWith("DELETE FROM email_worker_connections")) {
								const existed = conns.delete(key(String(a[0]), String(a[1]), String(a[2] ?? "")));
								return { success: true, meta: { changes: existed ? 1 : 0 } };
							}
							if (sql.includes("UPDATE agent_instances")) {
								// patchInstanceConfig's json_set — approximate: merge the key/value in directly,
								// which is all this fixture needs since the route only ever sets ONE key.
								const row = instances.get(String(a[2]));
								if (!row) return { meta: { changes: 0 } };
								const cfg = row.config ? JSON.parse(String(row.config)) : {};
								const path = String(a[0]).replace(/^\$\./, "");
								const value = JSON.parse(String(a[1]));
								cfg[path] = value;
								row.config = JSON.stringify(cfg);
								return { meta: { changes: 1 } };
							}
							if (sql.includes("email_worker_inbound_events")) {
								const dedupeKey = `${a[0]}${a[1]}${a[2]}${a[3]}`;
								if (inboundSeen.has(dedupeKey)) return { success: true, meta: { changes: 0 } };
								inboundSeen.add(dedupeKey);
								return { success: true, meta: { changes: 1 } };
							}
							if (sql.includes("INSERT INTO agent_events")) return { success: true };
							return { success: true, meta: { changes: 0 } };
						},
					};
				},
			};
		},
	};

	const app = new Hono();
	app.route("/v1/email-worker", emailWorkerRoutes);
	app.route("/v1/email-worker/inbound", emailWorkerInboundRoutes);
	app.route("/v1/instances", emailWorkerInstanceRoutes);
	app.onError((err, c) => {
		if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
		throw err;
	});
	const env = { SESSION_SIGNING_KEY: SECRET, KEY_ENCRYPTION_KEY: KEK, DB };
	return { app, env, conns };
}

const tok = (uid: string) => signSession(uid, SECRET, { roles: ["user"] });
const req = (app: Hono, env: unknown, path: string, init: RequestInit, t?: string) =>
	app.request(path, { ...init, headers: { ...(t ? { Authorization: `Bearer ${t}` } : {}), "Content-Type": "application/json", ...(init.headers || {}) } }, env);

const jsonBody = async (res: Response): Promise<Record<string, unknown>> => (await res.json()) as Record<string, unknown>;

beforeEach(() => {
	vi.unstubAllGlobals();
});
afterEach(() => {
	vi.unstubAllGlobals();
});

describe("POST /v1/email-worker/connections", () => {
	it("tests the secret against the adapter before storing it — a bad secret is never saved", async () => {
		const { app, env, conns } = testApp();
		vi.stubGlobal("fetch", createEmailWorkerFixture({ secret: "the-real-secret" }));
		const res = await req(app, env, "/v1/email-worker/connections", { method: "POST", body: JSON.stringify({ endpoint: EP, secret: "wrong" }) }, await tok("u1"));
		expect(res.status).toBe(422);
		expect(conns.size).toBe(0);
	});

	it("stores a connection that identifies itself, and returns the contract version — never the secret", async () => {
		const { app, env } = testApp();
		vi.stubGlobal("fetch", createEmailWorkerFixture({ secret: "s3cr3t", contractVersion: "email-worker/v1", address: "mail@freeappstore.online" }));
		const res = await req(app, env, "/v1/email-worker/connections", { method: "POST", body: JSON.stringify({ endpoint: EP, secret: "s3cr3t" }) }, await tok("u1"));
		expect(res.status).toBe(200);
		const body = await jsonBody(res);
		expect(body.contractVersion).toBe("email-worker/v1");
		expect(JSON.stringify(body)).not.toContain("s3cr3t");
	});

	it("rejects a non-https endpoint", async () => {
		const { app, env } = testApp();
		const res = await req(app, env, "/v1/email-worker/connections", { method: "POST", body: JSON.stringify({ endpoint: "http://mail.example.com", secret: "s" }) }, await tok("u1"));
		expect(res.status).toBe(400);
	});
});

describe("GET /v1/email-worker/connections", () => {
	it("lists connections with a usable webhook URL and no secret material", async () => {
		const { app, env } = testApp();
		vi.stubGlobal("fetch", createEmailWorkerFixture({ secret: "s" }));
		await req(app, env, "/v1/email-worker/connections", { method: "POST", body: JSON.stringify({ endpoint: EP, secret: "s", label: "Support" }) }, await tok("u1"));
		const res = await req(app, env, "/v1/email-worker/connections", { method: "GET" }, await tok("u1"));
		const body = await jsonBody(res);
		const connections = body.connections as Array<Record<string, unknown>>;
		expect(connections).toHaveLength(1);
		expect(connections[0].accountLabel).toBe("Support");
		expect(String(connections[0].webhookUrl)).toMatch(/\/v1\/email-worker\/inbound\//);
	});
});

describe("POST /v1/email-worker/connections/test", () => {
	it("re-tests an existing connection without the owner re-pasting the secret", async () => {
		const { app, env } = testApp();
		vi.stubGlobal("fetch", createEmailWorkerFixture({ secret: "s", contractVersion: "email-worker/v1" }));
		await req(app, env, "/v1/email-worker/connections", { method: "POST", body: JSON.stringify({ endpoint: EP, secret: "s" }) }, await tok("u1"));

		const res = await req(app, env, "/v1/email-worker/connections/test", { method: "POST", body: JSON.stringify({ endpoint: EP }) }, await tok("u1"));
		const body = await jsonBody(res);
		expect(body.ok).toBe(true);
		expect(body.contractVersion).toBe("email-worker/v1");
	});

	it("a bridge that later claims another contract version fails the test as a protocol failure (#1280: exactly email-worker/v1)", async () => {
		const { app, env } = testApp();
		vi.stubGlobal("fetch", createEmailWorkerFixture({ secret: "s", contractVersion: "email-worker/v1" }));
		await req(app, env, "/v1/email-worker/connections", { method: "POST", body: JSON.stringify({ endpoint: EP, secret: "s" }) }, await tok("u1"));
		vi.stubGlobal("fetch", createEmailWorkerFixture({ secret: "s", contractVersion: "email-worker/v2" }));
		const body = await jsonBody(await req(app, env, "/v1/email-worker/connections/test", { method: "POST", body: JSON.stringify({ endpoint: EP }) }, await tok("u1")));
		expect(body).toMatchObject({ ok: false, failureClass: "protocol" });
	});

	it("reports a failed test distinctly, without throwing", async () => {
		const { app, env } = testApp();
		vi.stubGlobal("fetch", async () => new Response("", { status: 503 }));
		const res = await req(app, env, "/v1/email-worker/connections/test", { method: "POST", body: JSON.stringify({ endpoint: EP, secret: "s" }) }, await tok("u1"));
		const body = await jsonBody(res);
		expect(body.ok).toBe(false);
		expect(typeof body.error).toBe("string");
	});
});

describe("DELETE /v1/email-worker/connections", () => {
	it("revokes a connection", async () => {
		const { app, env, conns } = testApp();
		vi.stubGlobal("fetch", createEmailWorkerFixture({ secret: "s" }));
		await req(app, env, "/v1/email-worker/connections", { method: "POST", body: JSON.stringify({ endpoint: EP, secret: "s" }) }, await tok("u1"));
		expect(conns.size).toBe(1);
		const res = await req(app, env, `/v1/email-worker/connections?endpoint=${encodeURIComponent(EP)}`, { method: "DELETE" }, await tok("u1"));
		expect((await jsonBody(res)).removed).toBe(true);
		expect(conns.size).toBe(0);
	});
});

describe("GET/PUT /v1/instances/:id/email-worker/account", () => {
	it("404s when the instance isn't owned", async () => {
		const { app, env } = testApp({ owned: false });
		const res = await req(app, env, "/v1/instances/i1/email-worker/account", {}, await tok("u1"));
		expect(res.status).toBe(404);
	});

	it("reports ambiguous with two connections and no pin", async () => {
		const { app, env } = testApp();
		vi.stubGlobal("fetch", createEmailWorkerFixture({ secret: "s" }));
		await req(app, env, "/v1/email-worker/connections", { method: "POST", body: JSON.stringify({ endpoint: EP, secret: "s" }) }, await tok("u1"));
		await req(app, env, "/v1/email-worker/connections", { method: "POST", body: JSON.stringify({ endpoint: "https://other.example.com", secret: "s" }) }, await tok("u1"));
		const res = await req(app, env, "/v1/instances/i1/email-worker/account", {}, await tok("u1"));
		const body = await jsonBody(res);
		expect(body.resolved).toBeNull();
		expect((body.blocked as Record<string, unknown>).reason).toBe("ambiguous");
	});

	it("pins the instance to one connection, refusing an unknown one at write time", async () => {
		const { app, env } = testApp();
		vi.stubGlobal("fetch", createEmailWorkerFixture({ secret: "s" }));
		await req(app, env, "/v1/email-worker/connections", { method: "POST", body: JSON.stringify({ endpoint: EP, secret: "s" }) }, await tok("u1"));

		const bad = await req(app, env, "/v1/instances/i1/email-worker/account", { method: "PUT", body: JSON.stringify({ endpoint: "https://nope.example.com" }) }, await tok("u1"));
		expect(bad.status).toBe(404);

		const good = await req(app, env, "/v1/instances/i1/email-worker/account", { method: "PUT", body: JSON.stringify({ endpoint: EP }) }, await tok("u1"));
		expect(good.status).toBe(200);

		const res = await req(app, env, "/v1/instances/i1/email-worker/account", {}, await tok("u1"));
		const body = await jsonBody(res);
		expect((body.resolved as Record<string, unknown>).endpoint).toBe(EP);
	});
});

describe("POST /v1/email-worker/inbound/:token — public, no bearer auth", () => {
	it("404s an unrecognised token", async () => {
		const { app, env } = testApp();
		const res = await req(app, env, "/v1/email-worker/inbound/not-a-real-token", { method: "POST", body: JSON.stringify({ type: "message.received", eventId: "e1" }) });
		expect(res.status).toBe(404);
	});

	it("accepts a delivery event and dedupes a retried eventId (AC5)", async () => {
		const { app, env } = testApp();
		vi.stubGlobal("fetch", createEmailWorkerFixture({ secret: "s" }));
		const postRes = await req(app, env, "/v1/email-worker/connections", { method: "POST", body: JSON.stringify({ endpoint: EP, secret: "s" }) }, await tok("u1"));
		const { connection } = await jsonBody(postRes);
		const webhookUrl = (connection as Record<string, unknown>).webhookUrl as string;
		const path = new URL(webhookUrl).pathname;

		const first = await req(app, env, path, { method: "POST", body: JSON.stringify({ type: "message.received", eventId: "evt-1", messageId: "m1" }) });
		expect(first.status).toBe(202);
		expect((await jsonBody(first)).deduped).toBe(false);

		const retry = await req(app, env, path, { method: "POST", body: JSON.stringify({ type: "message.received", eventId: "evt-1", messageId: "m1" }) });
		expect(retry.status).toBe(202);
		expect((await jsonBody(retry)).deduped).toBe(true);
	});

	it("requires an eventId", async () => {
		const { app, env } = testApp();
		vi.stubGlobal("fetch", createEmailWorkerFixture({ secret: "s" }));
		const postRes = await req(app, env, "/v1/email-worker/connections", { method: "POST", body: JSON.stringify({ endpoint: EP, secret: "s" }) }, await tok("u1"));
		const { connection } = await jsonBody(postRes);
		const path = new URL((connection as Record<string, unknown>).webhookUrl as string).pathname;
		const res = await req(app, env, path, { method: "POST", body: JSON.stringify({ type: "message.received" }) });
		expect(res.status).toBe(400);
	});
});
