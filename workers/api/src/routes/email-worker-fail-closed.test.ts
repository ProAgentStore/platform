/**
 * #1280 — worker-mail fails CLOSED. Against the real migrated schema and the real routes/tools, with a programmable bridge:
 * malformed and credential-echoing replies are never stored or returned, an unreadable sender policy refuses (and is never replaced
 * by a generic profile that has no sender policy), and a legitimately absent profile still works. No live bridge, no real send.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type BridgeEnv, handleRequest, type StoreBinding } from "../../../../templates/cloudflare-email-bridge/src/bridge.js";
import { EMAIL_WORKER_CONNECTOR } from "../lib/connectors/email-worker.js";
import type { RegistryToolCtx } from "../lib/connectors/types.js";
import { HttpError } from "../lib/auth.js";
import { type RealSchemaD1, realSchemaD1, seedTenant } from "../lib/d1-sqlite.js";
import { GENERIC_PROFILE, loadProfile, PolicyReadError, profileFromRow } from "../lib/email-worker-identities.js";
import { resolveEmailWorkerSecret } from "../lib/email-worker-connections.js";
import { storeSecretValue } from "../lib/secure-input.js";
import type { Env } from "../types.js";
import { emailWorkerInboundRoutes, emailWorkerInstanceRoutes, emailWorkerRoutes } from "./email-worker.js";
import { emailWorkerManageRoutes } from "./email-worker-manage.js";

vi.mock("../lib/auth.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/auth.js")>("../lib/auth.js");
	return { ...actual, requireUser: async () => ({ uid: "u1", roles: [] }) };
});

const KEK = "8".repeat(64);
const SECRET = "bridge-bearer-PLAINTEXT-ABCDEF9876";
const BRIDGE = "https://bridge.example.com";
const ADMIN = "admin@freeappstore.online";

const kv = (): StoreBinding => {
	const data = new Map<string, string>();
	return {
		get: async (k) => data.get(k) ?? null,
		put: async (k, v) => void data.set(k, v),
		list: async ({ prefix }) => ({ keys: [...data.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }),
	};
};
const realBridge = (): BridgeEnv => ({ BRIDGE_SECRET: SECRET, DOMAINS: "freeappstore.online", SENDERS: ADMIN, REPLY_IDENTITIES: ADMIN, ROUTES: `${ADMIN}=ops@verified.example`, MAILBOX: ADMIN, EMAIL: { send: async () => ({ messageId: "x" }) }, MAIL: kv() });

let d1: RealSchemaD1;
let env: Env;
let app: Hono<{ Bindings: Env }>;
/** When set, the bridge answers this body to `/identity` instead of the real one. */
let identityOverride: unknown;
let failProfileReads: boolean;
let sends: number;

beforeEach(() => {
	identityOverride = undefined;
	failProfileReads = false;
	sends = 0;
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["inst-1"] });
	// A database that can be made to fail the policy read, and only that.
	const real = d1.DB;
	const DB = new Proxy(real, {
		get(target, prop, receiver) {
			if (prop !== "prepare") return Reflect.get(target, prop, receiver);
			return (sql: string) => {
				const stmt = target.prepare(sql);
				if (failProfileReads && sql.includes("provider, identity_snapshot, approved_senders")) return { bind: () => ({ first: async () => { throw new Error("D1 unavailable"); } }) };
				return stmt;
			};
		},
	});
	env = { DB, KEY_ENCRYPTION_KEY: KEK } as unknown as Env;
	app = new Hono<{ Bindings: Env }>();
	app.route("/v1/email-worker", emailWorkerRoutes);
	app.route("/v1/email-worker/inbound", emailWorkerInboundRoutes);
	app.route("/v1/instances", emailWorkerInstanceRoutes);
	app.route("/v1/instances", emailWorkerManageRoutes);
	app.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500)));
	const bridge = realBridge();
	vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
		const req = new Request(input instanceof Request ? input : String(input), init);
		if (req.url.endsWith("/messages/send") || req.url.endsWith("/messages/reply")) sends++;
		if (req.url.endsWith("/identity") && identityOverride !== undefined) return new Response(JSON.stringify(identityOverride), { status: 200 });
		return handleRequest(req, bridge);
	});
});
afterEach(() => {
	vi.unstubAllGlobals();
	d1.close();
});

async function call(method: string, path: string, body?: unknown) {
	const res = await app.request(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }, env);
	const raw = await res.text();
	// biome-ignore lint/suspicious/noExplicitAny: loose JSON
	return { status: res.status, raw, json: (() => { try { return JSON.parse(raw); } catch { return {}; } })() as Record<string, any> };
}
const connect = (secret = SECRET) => call("POST", "/v1/email-worker/connections", { endpoint: BRIDGE, secret });
const connections = () => (d1.sqlite.prepare("SELECT COUNT(*) AS n FROM email_worker_connections").get() as { n: number }).n;
const pin = () => d1.sqlite.prepare("UPDATE agent_instances SET config = ? WHERE id = 'inst-1'").run(JSON.stringify({ emailWorkerAccount: { endpoint: BRIDGE, accountId: "" } }));
const ctx = (): RegistryToolCtx => ({ env, userId: "u1", instanceId: "inst-1", traceId: "run-1" }) as RegistryToolCtx;
const tool = (name: string) => {
	const t = EMAIL_WORKER_CONNECTOR.tools.find((x) => x.name === name);
	if (!t?.handler) throw new Error(`no tool ${name}`);
	return t.handler;
};

describe("malformed identity replies are never stored", () => {
	it.each([
		["HTTP 200 {}", {}],
		["another contract version", { contractVersion: "email-worker/v2" }],
		["an unknown provider", { contractVersion: "email-worker/v1", provider: "sendgrid" }],
		["an account that is a string", { contractVersion: "email-worker/v1", account: "x@y.com" }],
		["a Cloudflare identity with domains of the wrong type", { contractVersion: "email-worker/v1", provider: "cloudflare", domains: "freeappstore.online" }],
		["a Cloudflare identity with a malformed sender", { contractVersion: "email-worker/v1", provider: "cloudflare", domains: ["freeappstore.online"], senders: ["admin"] }],
	])("add connection: %s → 422, nothing stored", async (_why, body) => {
		identityOverride = body;
		const r = await connect();
		expect(r.status).toBe(422);
		expect(connections()).toBe(0);
		expect(r.raw).not.toContain(SECRET);
	});

	it("enrollment: a malformed reply is probe_failed (protocol), the value is kept, and no connection is stored", async () => {
		identityOverride = {};
		const b = await call("POST", "/v1/instances/inst-1/email-worker/enrollments", { endpoint: BRIDGE });
		await storeSecretValue(env, b.json.enrollmentId, "inst-1", "u1", SECRET);
		const done = await call("POST", `/v1/instances/inst-1/email-worker/enrollments/${b.json.enrollmentId}/complete`);
		expect(done.status).toBe(422);
		expect(done.json).toMatchObject({ code: "probe_failed", failureClass: "protocol" });
		expect(connections()).toBe(0);
		identityOverride = undefined; // the owner fixes the bridge; the SAME enrollment completes, bound to the same owner/instance/endpoint
		const ok = await call("POST", `/v1/instances/inst-1/email-worker/enrollments/${b.json.enrollmentId}/complete`);
		expect(ok.status).toBe(200);
		expect(await resolveEmailWorkerSecret(env, "u1", BRIDGE, "")).toBe(SECRET);
	});
});

describe("a bridge that echoes the credential is rejected on every path", () => {
	const echoes: Array<[string, unknown]> = [
		["account.address", { contractVersion: "email-worker/v1", account: { address: `${SECRET}@example.com` } }],
		["contractVersion", { contractVersion: SECRET }],
		["a nested key", { contractVersion: "email-worker/v1", meta: { [SECRET]: 1 } }],
		["a deep value", { contractVersion: "email-worker/v1", provider: "cloudflare", domains: ["freeappstore.online"], routes: [{ address: ADMIN, note: SECRET }] }],
	];

	it.each(echoes)("add connection (%s): rejected with the fixed message, nothing stored, the secret nowhere in the response", async (_w, body) => {
		identityOverride = body;
		const r = await connect();
		expect(r.status).toBe(422);
		expect(r.raw).toContain("Bridge echoed credential");
		expect(r.raw).not.toContain(SECRET);
		expect(connections()).toBe(0);
	});

	it.each(echoes)("test route (%s): rejected, nothing returned or recorded from the reply", async (_w, body) => {
		expect((await connect()).status).toBe(200);
		identityOverride = body;
		const viaConnections = await call("POST", "/v1/email-worker/connections/test", { endpoint: BRIDGE });
		const viaInstance = await call("POST", "/v1/instances/inst-1/email-worker/test", { endpoint: BRIDGE });
		for (const r of [viaConnections, viaInstance]) {
			expect(r.json.ok).toBe(false);
			expect(r.raw).not.toContain(SECRET);
		}
		expect(JSON.stringify(d1.sqlite.prepare("SELECT * FROM email_worker_connections").all())).not.toContain(SECRET.toLowerCase());
	});

	it("enrollment: an echo is probe_failed with the fixed message and the secret is in no response", async () => {
		identityOverride = echoes[0][1];
		const b = await call("POST", "/v1/instances/inst-1/email-worker/enrollments", { endpoint: BRIDGE });
		await storeSecretValue(env, b.json.enrollmentId, "inst-1", "u1", SECRET);
		const done = await call("POST", `/v1/instances/inst-1/email-worker/enrollments/${b.json.enrollmentId}/complete`);
		expect(done.status).toBe(422);
		expect(done.raw).not.toContain(SECRET);
		expect(connections()).toBe(0);
	});

	it("a bridge ERROR body that echoes the credential is scrubbed before it can be returned", async () => {
		vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: { code: "bad", message: `your key ${SECRET} is wrong` } }), { status: 400 }));
		const r = await connect();
		expect(r.status).toBe(422);
		expect(r.raw).not.toContain(SECRET);
		expect(r.raw).toContain("[redacted]");
	});

	it("an echo in a later call (list) is refused too — it never reaches the model", async () => {
		expect((await connect()).status).toBe(200);
		pin();
		vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ messages: [{ id: "m", subject: SECRET }], nextCursor: null }), { status: 200 }));
		const r = await tool("email_worker_list_messages")(ctx(), {});
		expect(r.success).toBe(false);
		expect(r.content).not.toContain(SECRET);
	});
});

describe("an unreadable sender policy fails closed", () => {
	beforeEach(async () => {
		expect((await connect()).status).toBe(200);
		await call("PUT", "/v1/email-worker/connections/identities", { endpoint: BRIDGE, approvedSenders: [ADMIN], replyIdentity: ADMIN });
		pin();
		d1.sqlite.prepare("INSERT INTO instance_connector_consent (instance_id, user_id, connector, scope, mode) VALUES ('inst-1', 'u1', 'email-worker', 'write', 'always')").run();
	});

	it("loadProfile: absent row is the legitimate generic profile; a database error and a malformed row are errors, never GENERIC_PROFILE", async () => {
		expect(await loadProfile(env, "u1", "https://nobody.example.com", "")).toBe(GENERIC_PROFILE);
		expect(profileFromRow(null)).toBe(GENERIC_PROFILE);
		failProfileReads = true;
		await expect(loadProfile(env, "u1", BRIDGE, "")).rejects.toBeInstanceOf(PolicyReadError);
		failProfileReads = false;
		for (const bad of ["{not json", '{"provider":"mystery"}', '{"provider":"cloudflare","domains":"x"}', "[]"]) {
			d1.sqlite.prepare("UPDATE email_worker_connections SET identity_snapshot = ?").run(bad);
			await expect(loadProfile(env, "u1", BRIDGE, ""), bad).rejects.toBeInstanceOf(PolicyReadError);
		}
		d1.sqlite.prepare("UPDATE email_worker_connections SET provider = 'cloudflare', approved_senders = '{\"a\":1}'").run();
		await expect(loadProfile(env, "u1", BRIDGE, "")).rejects.toBeInstanceOf(PolicyReadError);
		d1.sqlite.prepare("UPDATE email_worker_connections SET approved_senders = '[\"a@b.com\"]', provider = 'weird'").run();
		await expect(loadProfile(env, "u1", BRIDGE, "")).rejects.toBeInstanceOf(PolicyReadError);
	});

	it("sends, replies, reads and lists refuse with policy_unreadable and a receipt — nothing reaches the bridge", async () => {
		failProfileReads = true;
		const before = sends;
		for (const [name, input] of [
			["email_worker_send", { to: "candidate@candidate.example", subject: "Hi", body: "hello" }],
			["email_worker_reply", { message_id: "m1", body: "hi" }],
			["email_worker_read_message", { message_id: "m1" }],
			["email_worker_list_messages", {}],
			["email_worker_identities", {}],
		] as const) {
			const r = await tool(name)(ctx(), input);
			expect(r.success, name).toBe(false);
			expect(r.content, name).toMatch(/policy_unreadable/);
		}
		expect(sends).toBe(before);
		const receipts = d1.sqlite.prepare("SELECT failure_class FROM email_worker_receipts WHERE outcome = 'refused'").all() as Array<{ failure_class: string }>;
		expect(receipts.filter((r) => r.failure_class === "policy_unreadable").length).toBeGreaterThanOrEqual(5);
	});

	it("a malformed stored snapshot refuses a send exactly the same way (the generic fallback would have sent as anyone)", async () => {
		d1.sqlite.prepare("UPDATE email_worker_connections SET identity_snapshot = '{broken'").run();
		const r = await tool("email_worker_send")(ctx(), { to: "candidate@candidate.example", subject: "Hi", body: "hello", from: "attacker@evil.example" });
		expect(r.success).toBe(false);
		expect(r.content).toMatch(/policy_unreadable/);
		expect(sends).toBe(0);
	});

	it("status is blocked/policy_unreadable and not ready — never 'connected and ready'", async () => {
		const healthy = await call("GET", "/v1/instances/inst-1/email-worker/status");
		expect(healthy.json.state).toBe("connected");
		failProfileReads = true;
		const s = await call("GET", "/v1/instances/inst-1/email-worker/status");
		expect(s.status).toBe(200);
		expect(s.json).toMatchObject({ state: "blocked", status: "blocked", reason: "policy_unreadable", readyToRead: false, readyToSend: false });
		expect(s.json.blockers.map((b: { code: string }) => b.code)).toContain("policy_unreadable");
	});

	it("the owner-facing routes answer 503 policy_unreadable", async () => {
		failProfileReads = true;
		for (const [method, path, body] of [
			["GET", "/v1/email-worker/connections", undefined],
			["POST", "/v1/email-worker/connections/test", { endpoint: BRIDGE }],
			["PUT", "/v1/email-worker/connections/identities", { endpoint: BRIDGE, approvedSenders: [ADMIN] }],
			["POST", "/v1/instances/inst-1/email-worker/test", { endpoint: BRIDGE }],
		] as const) {
			const r = await call(method, path, body);
			expect(r.status, `${method} ${path}`).toBe(503);
			expect(r.raw, path).toContain("policy_unreadable");
		}
	});

	it("an inbound event is answered 503 and NOT marked seen, so the bridge redelivers instead of the mail being lost", async () => {
		const token = (d1.sqlite.prepare("SELECT webhook_token FROM email_worker_connections").get() as { webhook_token: string }).webhook_token;
		failProfileReads = true;
		const event = { type: "message.received", eventId: "in:<e1@x>", messageId: "<e1@x>", from: "k@candidate.example", to: ADMIN };
		const r = await call("POST", `/v1/email-worker/inbound/${token}`, event);
		expect(r.status).toBe(503);
		failProfileReads = false;
		const again = await call("POST", `/v1/email-worker/inbound/${token}`, event);
		expect(again.json.deduped).not.toBe(true); // processed now, not deduped away
		expect(again.status).toBe(202);
	});
});

describe("legitimate absent and generic profiles still work", () => {
	it("a generic email-worker/v1 provider (no provider field, no policy) connects, lists and is judged generic", async () => {
		identityOverride = { contractVersion: "email-worker/v1", account: { address: "support@example.com" } };
		const r = await connect();
		expect(r.status).toBe(200);
		expect(r.json).toMatchObject({ contractVersion: "email-worker/v1", provider: "generic" });
		expect(await loadProfile(env, "u1", BRIDGE, "")).toMatchObject({ provider: "generic", approvedSenders: [] });
		const status = await call("GET", "/v1/instances/inst-1/email-worker/status");
		expect(status.json.state).not.toBe("blocked");
	});
});
