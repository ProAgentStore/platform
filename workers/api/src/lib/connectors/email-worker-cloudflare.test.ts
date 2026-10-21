/**
 * #1270 — native Cloudflare Email Sending + Email Routing, through the worker-backed email connector.
 *
 * Runs the REAL connector, routes and bridge template (templates/cloudflare-email-bridge) against the
 * REAL migrated schema, with in-memory Cloudflare bindings (a send recorder and a KV). Nothing here
 * is a string-matching D1 stub, so an index, trigger or column the SQL relies on has to exist.
 *
 * The cases the issue names: sender denial, wrong-domain isolation, inbound replay, outbound
 * idempotency, per-instance pinning, consent/approval denial and bridge unavailability — each asserts
 * the same thing a refusal test asserts, that nothing reached the wire.
 */
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type BridgeEnv, handleInbound, handleRequest, type RoutedEmail, type StoreBinding } from "../../../../../templates/cloudflare-email-bridge/src/bridge.js";
import { emailWorkerInboundRoutes, emailWorkerRoutes } from "../../routes/email-worker.js";
import type { Env } from "../../types.js";
import { HttpError } from "../auth.js";
import { type RealSchemaD1, realSchemaD1, seedTenant } from "../d1-sqlite.js";
import { saveEmailWorkerConnection } from "../email-worker-connections.js";
import { describeIdentities, probeEmailWorkerIdentity, EMAIL_WORKER_CONNECTOR } from "./email-worker.js";
import { loadProfile, normalizeAddress, parseIdentity, recordProbeSuccess, routeDecision, saveApproval, senderDecision, validateApproval } from "../email-worker-identities.js";
import { listReceipts } from "../email-worker-receipts.js";
import { renderToolContent, runRegistryTool } from "../tool-registry.js";
import type { RegistryToolCtx } from "./types.js";

vi.mock("../auth.js", async () => {
	const actual = await vi.importActual<typeof import("../auth.js")>("../auth.js");
	return { ...actual, requireUser: async (c: { req: { header: (n: string) => string | undefined } }) => ({ uid: c.req.header("x-test-uid") ?? "u1", roles: [] }) };
});

const KEK = "5".repeat(64);
const SECRET = "bridge-bearer-PLAINTEXT-0123456789";
const BRIDGE = "https://bridge.example.com";
const OTHER_BRIDGE = "https://other-bridge.example.com";
const INBOUND_ORIGIN = "https://api.proagentstore.online";

const kv = (): StoreBinding & { data: Map<string, string> } => {
	const data = new Map<string, string>();
	return {
		data,
		get: async (k) => data.get(k) ?? null,
		put: async (k, v) => void data.set(k, v),
		list: async ({ prefix }) => ({ keys: [...data.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }),
	};
};

interface Bridge {
	env: BridgeEnv;
	sent: Array<{ from: string; to: string | string[]; subject: string; text: string }>;
	requests: Array<{ path: string; authorized: boolean }>;
	down: { status: number | null };
}

function makeBridge(over: Partial<BridgeEnv> = {}): Bridge {
	const sent: Bridge["sent"] = [];
	const bridge: Bridge = {
		sent,
		requests: [],
		down: { status: null },
		env: {
			BRIDGE_SECRET: SECRET,
			DOMAINS: "freeappstore.online",
			SENDERS: "admin@freeappstore.online,noreply@freeappstore.online",
			REPLY_IDENTITIES: "admin@freeappstore.online",
			// info@ is a ROUTE only: it receives, it does not send.
			ROUTES: "admin@freeappstore.online=ops@verified.example,info@freeappstore.online=ops@verified.example",
			EMAIL: {
				send: async (m) => {
					sent.push({ from: m.from, to: m.to, subject: m.subject, text: m.text });
					return { messageId: `cf-${sent.length}` };
				},
			},
			MAIL: kv(),
			...over,
		},
	};
	return bridge;
}

interface World {
	d1: RealSchemaD1;
	env: Env;
	app: Hono<{ Bindings: Env }>;
	bridge: Bridge;
	ctx: (o?: Partial<RegistryToolCtx>) => RegistryToolCtx;
	connect: (o?: { endpoint?: string; userId?: string; bridge?: Bridge; approve?: boolean }) => Promise<void>;
	pin: (endpoint: string | null, instanceId?: string) => void;
	consent: (instanceId?: string) => void;
	receipts: () => Array<Record<string, unknown>>;
	token: (endpoint?: string) => string;
	inbound: (token: string, body: Record<string, unknown>) => Promise<{ status: number; json: Record<string, unknown> }>;
}

function world(bridgeOver: Partial<BridgeEnv> = {}): World {
	const d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["inst-1", "inst-2"] });
	seedTenant(d1, { userId: "u2", instanceIds: ["inst-3"] });
	const env = { DB: d1.DB, KEY_ENCRYPTION_KEY: KEK } as unknown as Env;
	const app = new Hono<{ Bindings: Env }>();
	app.route("/v1/email-worker", emailWorkerRoutes);
	app.route("/v1/email-worker/inbound", emailWorkerInboundRoutes);
	app.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500)));

	const bridge = makeBridge(bridgeOver);
	const bridges = new Map<string, Bridge>([[new URL(BRIDGE).host, bridge]]);
	vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
		const req = new Request(input instanceof Request ? input : String(input), init);
		const url = new URL(req.url);
		if (url.origin === INBOUND_ORIGIN) return app.request(req, undefined, env);
		const b = bridges.get(url.host);
		if (!b) return new Response("no such host", { status: 502 });
		b.requests.push({ path: url.pathname, authorized: req.headers.get("authorization") === `Bearer ${SECRET}` });
		if (b.down.status) return new Response(JSON.stringify({ error: { code: "down", message: "Simulated outage" } }), { status: b.down.status });
		return handleRequest(req, b.env);
	});

	const w: World = {
		d1,
		env,
		app,
		bridge,
		ctx: (o = {}) => ({ env, userId: "u1", instanceId: "inst-1", ...o }) as RegistryToolCtx,
		connect: async (o = {}) => {
			const endpoint = o.endpoint ?? BRIDGE;
			if (o.bridge) bridges.set(new URL(endpoint).host, o.bridge);
			const userId = o.userId ?? "u1";
			const probe = await probeEmailWorkerIdentity(endpoint, SECRET);
			if (!probe.ok) throw new Error(`probe failed: ${probe.error}`);
			await saveEmailWorkerConnection(env, { userId, endpoint, secret: SECRET, contractVersion: probe.contractVersion });
			await recordProbeSuccess(env, userId, endpoint, "", probe.snapshot);
			if (o.approve !== false) await saveApproval(env, userId, endpoint, "", ["admin@freeappstore.online"], "admin@freeappstore.online");
			// The connect-time probe is setup, not the call under test: tests assert on what happens AFTER it.
			(o.bridge ?? bridge).requests.length = 0;
		},
		pin: (endpoint, instanceId = "inst-1") => {
			const config = endpoint ? JSON.stringify({ emailWorkerAccount: { endpoint, accountId: "" } }) : null;
			d1.sqlite.prepare("UPDATE agent_instances SET config = ? WHERE id = ?").run(config, instanceId);
		},
		consent: (instanceId = "inst-1") => {
			d1.sqlite.prepare("INSERT OR REPLACE INTO instance_connector_consent (instance_id, user_id, connector, scope, mode) VALUES (?, 'u1', 'email-worker', 'write', 'always')").run(instanceId);
		},
		receipts: () => d1.sqlite.prepare("SELECT * FROM email_worker_receipts ORDER BY created_at, rowid").all() as Array<Record<string, unknown>>,
		token: (endpoint = BRIDGE) => (d1.sqlite.prepare("SELECT webhook_token FROM email_worker_connections WHERE endpoint = ?").get(endpoint) as { webhook_token: string }).webhook_token,
		inbound: async (token, body) => {
			const res = await app.request(`/v1/email-worker/inbound/${token}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, env);
			return { status: res.status, json: (await res.json()) as Record<string, unknown> };
		},
	};
	return w;
}

const tool = (name: string) => {
	const t = EMAIL_WORKER_CONNECTOR.tools.find((x) => x.name === name);
	if (!t?.handler) throw new Error(`no tool ${name}`);
	return t;
};
const run = (name: string, ctx: RegistryToolCtx, input: Record<string, unknown>) => tool(name).handler(ctx, input);
const dispatched = async (name: string, ctx: RegistryToolCtx, input: Record<string, unknown>) => {
	const t = tool(name);
	const r = await t.handler(ctx, input);
	return { ...r, content: renderToolContent(t, r) };
};
const SEND = { to: "candidate@example.org", subject: "Interview", body: "Hello — are you free Tuesday?" };

let w: World;
beforeEach(() => {
	vi.unstubAllGlobals();
	w = world();
});

describe("identity — what the bridge reports, and that a route is not a sender", () => {
	it("parses senders, routes and domains, dropping anything outside the reported domains", () => {
		const snap = parseIdentity({
			provider: "cloudflare",
			domains: ["Example.com"],
			senders: ["Admin@Example.com", "x@elsewhere.org", "not-an-address"],
			replyIdentities: ["admin@example.com"],
			routes: [{ address: "info@example.com", destination: "me@v.example" }, { address: "evil@elsewhere.org", destination: "x@y.example" }],
			account: { address: "admin@example.com" },
		});
		expect(snap).toMatchObject({ provider: "cloudflare", domains: ["example.com"], senders: ["admin@example.com"], routes: [{ address: "info@example.com", destination: "me@v.example" }], accountAddress: "admin@example.com" });
	});

	it("treats a reply with no provider as a generic worker with no sender policy", () => {
		expect(parseIdentity({ contractVersion: "email-worker/v1" })).toMatchObject({ provider: "generic", senders: [], routes: [] });
	});

	it("normalizes plain addresses only", () => {
		expect(normalizeAddress(" Admin@Example.COM ")).toBe("admin@example.com");
		expect(normalizeAddress("Name <a@b.com>")).toBeNull();
		expect(normalizeAddress("a@b")).toBeNull();
		expect(normalizeAddress(42)).toBeNull();
	});

	it("connecting records the bridge's own report and shows it explicitly: senders, routes with destinations, health", async () => {
		await w.connect();
		const shown = describeIdentities(await loadProfile(w.env, "u1", BRIDGE, ""));
		expect(shown).toMatchObject({
			provider: "cloudflare",
			domains: ["freeappstore.online"],
			health: { reachable: true, lastFailureClass: null },
			senders: [
				{ address: "admin@freeappstore.online", approved: true, replyIdentity: true },
				{ address: "noreply@freeappstore.online", approved: false, replyIdentity: false },
			],
			routes: [
				{ address: "admin@freeappstore.online", destination: "ops@verified.example", canSend: true },
				{ address: "info@freeappstore.online", destination: "ops@verified.example", canSend: false },
			],
		});
	});
});

describe("sender allowlist — a routed-only alias is refused for sending", () => {
	beforeEach(async () => {
		await w.connect();
		w.pin(BRIDGE);
	});

	it("sends from the default approved sender and records a provider receipt id", async () => {
		const r = await run("email_worker_send", w.ctx(), SEND);
		expect(r.success).toBe(true);
		expect(JSON.parse(r.content)).toMatchObject({ sent: true, from: "admin@freeappstore.online", to: "candidate@example.org", provider_receipt_id: "cf-1" });
		expect(w.bridge.sent).toEqual([{ from: "admin@freeappstore.online", to: "candidate@example.org", subject: "Interview", text: SEND.body }]);
		expect(w.receipts()).toMatchObject([{ kind: "send", outcome: "sent", provider_receipt_id: "cf-1", from_address: "admin@freeappstore.online", to_address: "candidate@example.org" }]);
	});

	it("REFUSES a routed-only alias — and says why — without calling the bridge", async () => {
		const r = await run("email_worker_send", w.ctx(), { ...SEND, from: "info@freeappstore.online" });
		expect(r.success).toBe(false);
		expect(r.content).toMatch(/Email Routing address only/);
		expect(w.bridge.requests).toHaveLength(0);
		expect(w.bridge.sent).toHaveLength(0);
		expect(w.receipts()).toMatchObject([{ kind: "send", outcome: "refused", failure_class: "sender_routed_only", from_address: "info@freeappstore.online" }]);
	});

	it("refuses a real sender the owner has not approved", async () => {
		const r = await run("email_worker_send", w.ctx(), { ...SEND, from: "noreply@freeappstore.online" });
		expect(r.success).toBe(false);
		expect(r.content).toMatch(/not approved/);
		expect(w.bridge.sent).toHaveLength(0);
		expect(w.receipts()[0]).toMatchObject({ outcome: "refused", failure_class: "sender_not_approved" });
	});

	it("refuses an address the bridge does not report at all", async () => {
		const r = await run("email_worker_send", w.ctx(), { ...SEND, from: "ceo@freeappstore.online" });
		expect(r.content).toMatch(/not a sender identity the Cloudflare bridge reports/);
		expect(w.receipts()[0]).toMatchObject({ failure_class: "sender_not_reported" });
		expect(w.bridge.requests).toHaveLength(0);
	});

	it("refuses an address on another domain (wrong-domain isolation)", async () => {
		const r = await run("email_worker_send", w.ctx(), { ...SEND, from: "admin@someone-elses.com" });
		expect(r.content).toMatch(/not on a domain/);
		expect(w.receipts()[0]).toMatchObject({ failure_class: "sender_wrong_domain" });
		expect(w.bridge.requests).toHaveLength(0);
	});

	it("refuses a malformed from (a display name is not an identity)", async () => {
		const r = await run("email_worker_send", w.ctx(), { ...SEND, from: "Admin <admin@freeappstore.online>" });
		expect(r.success).toBe(false);
		expect(w.receipts()[0]).toMatchObject({ failure_class: "sender_invalid_address" });
	});

	it("sends nothing when no sender has been approved — it does not guess", async () => {
		const fresh = world();
		await fresh.connect({ approve: false });
		fresh.pin(BRIDGE);
		const r = await run("email_worker_send", fresh.ctx(), SEND);
		expect(r.success).toBe(false);
		expect(r.content).toMatch(/No sender is approved/);
		expect(fresh.bridge.sent).toHaveLength(0);
		expect(fresh.receipts()[0]).toMatchObject({ failure_class: "sender_no_approved_sender" });
	});

	it("the bridge ALSO refuses a routed-only sender, so the check is not only PAGS's", async () => {
		const res = await handleRequest(
			new Request(`${BRIDGE}/v1/email-worker/messages/send`, { method: "POST", headers: { authorization: `Bearer ${SECRET}` }, body: JSON.stringify({ from: "info@freeappstore.online", to: "a@b.org", subject: "s", body: "b", idempotencyKey: "k-12345678" }) }),
			w.bridge.env,
		);
		expect(res.status).toBe(403);
		expect(await res.json()).toMatchObject({ error: { code: "sender_not_allowed" } });
		expect(w.bridge.sent).toHaveLength(0);
	});

	it("an approval is dropped when the bridge stops reporting the address as a sender", async () => {
		w.bridge.env.SENDERS = "noreply@freeappstore.online";
		const probe = await probeEmailWorkerIdentity(BRIDGE, SECRET);
		if (!probe.ok) throw new Error("probe");
		await recordProbeSuccess(w.env, "u1", BRIDGE, "", probe.snapshot);
		const profile = await loadProfile(w.env, "u1", BRIDGE, "");
		expect(profile.approvedSenders).toEqual([]);
		expect(profile.replyIdentity).toBeNull();
		expect(senderDecision(profile, "admin@freeappstore.online")).toMatchObject({ ok: false });
	});
});

describe("owner approval — can only narrow what the bridge reports", () => {
	it("refuses to approve a routed-only alias, with the reason", async () => {
		await w.connect({ approve: false });
		const res = await w.app.request(
			"/v1/email-worker/connections/identities",
			{ method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: BRIDGE, approvedSenders: ["info@freeappstore.online"] }) },
			w.env,
		);
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toMatch(/Email Routing address only/);
		expect((await loadProfile(w.env, "u1", BRIDGE, "")).approvedSenders).toEqual([]);
	});

	it("approves a reported sender and a reply identity that is one of them", async () => {
		await w.connect({ approve: false });
		const ok = await w.app.request(
			"/v1/email-worker/connections/identities",
			{ method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: BRIDGE, approvedSenders: ["noreply@freeappstore.online", "admin@freeappstore.online"], replyIdentity: "admin@freeappstore.online" }) },
			w.env,
		);
		expect(ok.status).toBe(200);
		expect(((await ok.json()) as { identities: { senders: Array<{ approved: boolean }> } }).identities.senders.every((s) => s.approved)).toBe(true);
	});

	it("validateApproval rejects a reply identity that is not approved, a non-list, and a non-cloudflare connection", async () => {
		await w.connect({ approve: false });
		const snap = (await loadProfile(w.env, "u1", BRIDGE, "")).snapshot;
		expect(validateApproval(snap, { approvedSenders: ["admin@freeappstore.online"], replyIdentity: "noreply@freeappstore.online" })).toMatchObject({ ok: false });
		expect(validateApproval(snap, { approvedSenders: "admin@freeappstore.online", replyIdentity: null })).toMatchObject({ ok: false });
		expect(validateApproval(null, { approvedSenders: [], replyIdentity: null })).toMatchObject({ ok: false });
	});

	it("is owner-scoped: another owner cannot approve on this connection", async () => {
		await w.connect({ approve: false });
		const res = await w.app.request(
			"/v1/email-worker/connections/identities",
			{ method: "PUT", headers: { "content-type": "application/json", "x-test-uid": "u2" }, body: JSON.stringify({ endpoint: BRIDGE, approvedSenders: ["admin@freeappstore.online"] }) },
			w.env,
		);
		expect(res.status).toBe(404);
		expect((await loadProfile(w.env, "u1", BRIDGE, "")).approvedSenders).toEqual([]);
	});
});

describe("replies — from the reply identity, to the original sender", () => {
	beforeEach(async () => {
		await w.connect();
		w.pin(BRIDGE);
		await w.inbound(w.token(), { type: "message.received", eventId: "e1", messageId: "<in-1@x.org>", threadId: "t-9", from: "kelly@x.org", to: "admin@freeappstore.online" });
		await handleInbound(
			{ from: "kelly@x.org", to: "admin@freeappstore.online", headers: { get: (n) => ({ "message-id": "<in-1@x.org>", subject: "Application" })[n.toLowerCase()] ?? null }, raw: new Response("Hi\r\n\r\nPlease advise.").body, forward: async () => undefined },
			{ ...w.bridge.env, PAGS_INBOUND_URL: undefined },
		);
	});

	it("replies from the configured reply identity to the parent's sender; the model supplies neither", async () => {
		const r = await run("email_worker_reply", w.ctx(), { message_id: "<in-1@x.org>", body: "Thanks — Tuesday works.", from: "noreply@freeappstore.online", to: "attacker@evil.org" });
		expect(r.success).toBe(true);
		expect(w.bridge.sent).toMatchObject([{ from: "admin@freeappstore.online", to: "kelly@x.org", subject: "Re: Application" }]);
		const last = w.receipts().at(-1);
		expect(last).toMatchObject({ kind: "reply", outcome: "sent", from_address: "admin@freeappstore.online", provider_receipt_id: "cf-1" });
	});

	it("refuses to reply when no reply identity is configured", async () => {
		await saveApproval(w.env, "u1", BRIDGE, "", ["admin@freeappstore.online"], null);
		const r = await run("email_worker_reply", w.ctx(), { message_id: "<in-1@x.org>", body: "hi" });
		expect(r.success).toBe(false);
		expect(r.content).toMatch(/No reply identity/);
		expect(w.bridge.sent).toHaveLength(0);
	});

	it("the bridge refuses a reply that names a recipient", async () => {
		const res = await handleRequest(
			new Request(`${BRIDGE}/v1/email-worker/messages/reply`, { method: "POST", headers: { authorization: `Bearer ${SECRET}` }, body: JSON.stringify({ messageId: "<in-1@x.org>", to: "attacker@evil.org", body: "x", idempotencyKey: "k-reply-123" }) }),
			w.bridge.env,
		);
		expect(res.status).toBe(400);
		expect(w.bridge.sent).toHaveLength(0);
	});
});

describe("outbound idempotency", () => {
	beforeEach(async () => {
		await w.connect();
		w.pin(BRIDGE);
	});

	it("a retried send is one delivery: the second is answered from the first receipt without reaching the bridge", async () => {
		const first = JSON.parse((await run("email_worker_send", w.ctx(), SEND)).content);
		const callsAfterFirst = w.bridge.requests.length;
		const second = JSON.parse((await run("email_worker_send", w.ctx(), SEND)).content);
		expect(second).toMatchObject({ sent: true, deduped: true, message_id: first.message_id, thread_id: first.thread_id, provider_receipt_id: first.provider_receipt_id });
		expect(w.bridge.requests).toHaveLength(callsAfterFirst);
		expect(w.bridge.sent).toHaveLength(1);
		expect(w.receipts().map((r) => r.outcome)).toEqual(["sent", "deduped"]);
	});

	it("the key is stable (not random per call) and rides to the bridge", async () => {
		await run("email_worker_send", w.ctx(), SEND);
		await run("email_worker_send", w.ctx(), { ...SEND, body: "A different body." });
		const keys = w.receipts().map((r) => r.idempotency_key as string);
		expect(keys[0]).toMatch(/^auto_[0-9a-f]{64}$/);
		expect(keys[1]).not.toBe(keys[0]);
	});

	it("an explicit different key is a deliberate second send", async () => {
		await run("email_worker_send", w.ctx(), { ...SEND, idempotency_key: "intent-aaaaaaaa" });
		await run("email_worker_send", w.ctx(), { ...SEND, idempotency_key: "intent-bbbbbbbb" });
		expect(w.bridge.sent).toHaveLength(2);
	});

	it("the bridge itself treats a repeated key as one send (a lost reply cannot double-deliver)", async () => {
		const body = JSON.stringify({ from: "admin@freeappstore.online", to: "a@b.org", subject: "s", body: "b", idempotencyKey: "intent-12345678" });
		const call = () => handleRequest(new Request(`${BRIDGE}/v1/email-worker/messages/send`, { method: "POST", headers: { authorization: `Bearer ${SECRET}` }, body }), w.bridge.env);
		const a = await (await call()).json();
		const b = await (await call()).json();
		expect(b).toEqual(a);
		expect(w.bridge.sent).toHaveLength(1);
	});

	it("rejects a malformed idempotency_key before calling anything", async () => {
		const r = await run("email_worker_send", w.ctx(), { ...SEND, idempotency_key: "bad key!" });
		expect(r.success).toBe(false);
		expect(w.bridge.requests).toHaveLength(0);
	});

	it("the database allows exactly one accepted receipt per intent", async () => {
		await run("email_worker_send", w.ctx(), SEND);
		const row = w.receipts()[0];
		expect(() =>
			w.d1.sqlite.prepare("INSERT INTO email_worker_receipts (id, user_id, endpoint, account_id, kind, outcome, idempotency_key) VALUES ('dup', 'u1', ?, '', 'send', 'sent', ?)").run(row.endpoint, row.idempotency_key),
		).toThrow(/UNIQUE/);
	});
});

describe("per-instance pinning", () => {
	it("refuses with two connections and no pin, and calls nothing", async () => {
		await w.connect();
		await w.connect({ endpoint: OTHER_BRIDGE, bridge: makeBridge() });
		const r = await run("email_worker_send", w.ctx(), SEND);
		expect(r.success).toBe(false);
		expect(r.content).toMatch(/2 worker-backed email connections/);
		expect(w.bridge.requests).toHaveLength(0);
		expect(w.receipts()[0]).toMatchObject({ outcome: "refused", failure_class: "pin_ambiguous" });
	});

	it("uses the pinned connection; another instance pinned elsewhere is unaffected", async () => {
		const other = makeBridge();
		await w.connect();
		await w.connect({ endpoint: OTHER_BRIDGE, bridge: other });
		w.pin(BRIDGE, "inst-1");
		w.pin(OTHER_BRIDGE, "inst-2");
		await run("email_worker_send", w.ctx({ instanceId: "inst-1" }), SEND);
		await run("email_worker_send", w.ctx({ instanceId: "inst-2" }), { ...SEND, subject: "Second" });
		// Each instance sent through ITS OWN pinned connection, and only that one.
		expect(w.bridge.sent.map((m) => m.subject)).toEqual(["Interview"]);
		expect(other.sent.map((m) => m.subject)).toEqual(["Second"]);
	});

	it("refuses a stale pin rather than falling back", async () => {
		await w.connect();
		await w.connect({ endpoint: OTHER_BRIDGE, bridge: makeBridge() });
		w.pin("https://revoked.example.com");
		const r = await run("email_worker_send", w.ctx(), SEND);
		expect(r.content).toMatch(/no longer connected/);
		expect(w.bridge.requests).toHaveLength(0);
	});

	it("never resolves another owner's connection", async () => {
		await w.connect({ userId: "u2" });
		const r = await run("email_worker_send", w.ctx(), SEND);
		expect(r.success).toBe(false);
		expect(r.content).toMatch(/No worker-backed email connection/);
		expect(w.bridge.requests).toHaveLength(0);
	});
});

describe("consent and approval — a denied grant never reaches the bridge", () => {
	beforeEach(async () => {
		await w.connect();
		w.pin(BRIDGE);
	});

	it("a send with no write consent is refused by the dispatcher", async () => {
		const r = await runRegistryTool("email_worker_send", w.ctx(), SEND);
		expect(r.success).toBe(false);
		expect(w.bridge.requests).toHaveLength(0);
		expect(w.receipts()).toHaveLength(0);
	});

	it("with consent 'always' the same send goes through", async () => {
		w.consent();
		const r = await runRegistryTool("email_worker_send", w.ctx(), SEND);
		expect(JSON.parse(r.content)).toMatchObject({ sent: true });
		expect(w.bridge.sent).toHaveLength(1);
	});

	it("consent 'ask' queues the call for approval instead of sending", async () => {
		w.d1.sqlite.prepare("INSERT INTO instance_connector_consent (instance_id, user_id, connector, scope, mode) VALUES ('inst-1','u1','email-worker','write','ask')").run();
		const r = await runRegistryTool("email_worker_send", w.ctx(), SEND);
		expect(w.bridge.sent).toHaveLength(0);
		expect(w.bridge.requests).toHaveLength(0);
		expect(typeof r.content).toBe("string");
	});

	it("a tool outside the agent's declared tools is refused, even with consent", async () => {
		w.consent();
		const r = await runRegistryTool("email_worker_send", w.ctx({ declaredTools: ["email_worker_read_message"] }), SEND);
		expect(r.success).toBe(false);
		expect(w.bridge.requests).toHaveLength(0);
	});

	it("reads need no write consent", async () => {
		const r = await runRegistryTool("email_worker_identities", w.ctx({ declaredTools: ["email_worker_identities"] }), {});
		expect(r.success).toBe(true);
	});
});

describe("inbound — original sender and recipient, correlated to a route, replay-safe", () => {
	beforeEach(async () => {
		await w.connect();
		w.pin(BRIDGE);
	});
	const event = { type: "message.received", eventId: "in:<m1@x.org>", messageId: "<m1@x.org>", threadId: "t1", from: "Kelly@X.org", to: "Admin@FreeAppStore.online" };

	it("records the message with the ORIGINAL sender and recipient, correlated to its route", async () => {
		const r = await w.inbound(w.token(), event);
		expect(r).toEqual({ status: 202, json: { ok: true, deduped: false } });
		expect(w.receipts()).toMatchObject([{ kind: "inbound", outcome: "ok", message_id: "<m1@x.org>", thread_id: "t1", event_id: "in:<m1@x.org>", from_address: "kelly@x.org", to_address: "admin@freeappstore.online" }]);
	});

	it("an inbound replay is acknowledged once and never processed twice", async () => {
		await w.inbound(w.token(), event);
		const again = await w.inbound(w.token(), event);
		const third = await w.inbound(w.token(), event);
		expect(again.json).toEqual({ ok: true, deduped: true });
		expect(third.json).toEqual({ ok: true, deduped: true });
		expect(w.receipts().map((r) => r.outcome)).toEqual(["ok", "deduped", "deduped"]);
		expect((w.d1.sqlite.prepare("SELECT COUNT(*) AS n FROM email_worker_inbound_events").get() as { n: number }).n).toBe(1);
		const events = w.d1.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_events WHERE event = 'email.inbound'").get() as { n: number };
		expect(events.n).toBe(1);
	});

	it("a recipient on another domain is a routing failure, never mail received (wrong-domain isolation)", async () => {
		const r = await w.inbound(w.token(), { ...event, eventId: "e-other", to: "admin@someone-elses.com" });
		expect(r.status).toBe(422);
		expect(r.json).toMatchObject({ ok: false, error: "route_unknown_domain" });
		expect(w.receipts()).toMatchObject([{ kind: "routing_failure", outcome: "refused", failure_class: "route_unknown_domain", to_address: "admin@someone-elses.com" }]);
	});

	it("a recipient on our domain with no route is a routing failure too", async () => {
		const r = await w.inbound(w.token(), { ...event, eventId: "e-unrouted", to: "sales@freeappstore.online" });
		expect(r.status).toBe(422);
		expect(w.receipts()[0]).toMatchObject({ kind: "routing_failure", failure_class: "route_unrouted_recipient" });
	});

	it("an inbound with no sender is refused", async () => {
		const { from: _f, ...noFrom } = event;
		const r = await w.inbound(w.token(), { ...noFrom, eventId: "e-nofrom" });
		expect(r.status).toBe(422);
		expect(w.receipts()[0]).toMatchObject({ failure_class: "missing_sender" });
	});

	it("one connection's token cannot land mail on another's route", async () => {
		const other = makeBridge({ DOMAINS: "other.example", SENDERS: "x@other.example", REPLY_IDENTITIES: "x@other.example", ROUTES: "x@other.example=o@v.example" });
		await w.connect({ endpoint: OTHER_BRIDGE, bridge: other, approve: false });
		const r = await w.inbound(w.token(OTHER_BRIDGE), event); // freeappstore.online recipient on the OTHER domain's connection
		expect(r.status).toBe(422);
		expect(r.json).toMatchObject({ error: "route_unknown_domain" });
	});

	it("an unknown or revoked token is a 404 and records nothing", async () => {
		const r = await w.inbound("not-a-token", event);
		expect(r.status).toBe(404);
		expect(w.receipts()).toHaveLength(0);
	});

	it("delivery outcomes: a bounce is a failure, a delivery is ok, both with the provider receipt id", async () => {
		await w.inbound(w.token(), { type: "delivery.delivered", eventId: "d1", messageId: "out_1", providerReceiptId: "cf-1" });
		await w.inbound(w.token(), { type: "delivery.bounced", eventId: "d2", messageId: "out_2", providerReceiptId: "cf-2" });
		expect(w.receipts()).toMatchObject([
			{ kind: "delivery", outcome: "ok", provider_receipt_id: "cf-1" },
			{ kind: "delivery", outcome: "failed", failure_class: "bounced", provider_receipt_id: "cf-2" },
		]);
	});

	it("a bridge-reported failure is recorded as one and shows in connection health", async () => {
		await w.inbound(w.token(), { type: "bridge.failure", eventId: "f1", failureClass: "send_quota_exceeded" });
		expect(w.receipts()[0]).toMatchObject({ kind: "bridge_failure", outcome: "failed", failure_class: "send_quota_exceeded" });
		const profile = await loadProfile(w.env, "u1", BRIDGE, "");
		expect(profile.health).toMatchObject({ lastProbeOk: false, lastFailureClass: "send_quota_exceeded" });
	});

	it("routeDecision is pure: route, unknown domain, unrouted, and no snapshot", async () => {
		const profile = await loadProfile(w.env, "u1", BRIDGE, "");
		expect(routeDecision(profile, "info@freeappstore.online")).toMatchObject({ ok: true, route: { destination: "ops@verified.example" } });
		expect(routeDecision(profile, "x@nowhere.org")).toMatchObject({ ok: false, reason: "unknown_domain" });
		expect(routeDecision(profile, "x@freeappstore.online")).toMatchObject({ ok: false, reason: "unrouted_recipient" });
		expect(routeDecision({ ...profile, snapshot: null }, "info@freeappstore.online")).toMatchObject({ ok: false, reason: "no_snapshot" });
	});
});

describe("the bridge template end to end — Email Routing event → PAGS", () => {
	it("stores the mail, forwards to the route destination, and notifies PAGS with the original recipient", async () => {
		await w.connect();
		w.pin(BRIDGE);
		const forwarded: string[] = [];
		const msg: RoutedEmail = {
			from: "Kelly@X.org",
			to: "info@freeappstore.online",
			headers: { get: (n) => ({ "message-id": "<e2e-1@x.org>", subject: "Hello" })[n.toLowerCase()] ?? null },
			raw: new Response("Subject: Hello\r\n\r\nBody text here").body,
			forward: async (d) => void forwarded.push(d),
		};
		const env = { ...w.bridge.env, PAGS_INBOUND_URL: `${INBOUND_ORIGIN}/v1/email-worker/inbound/${w.token()}` };
		expect(await handleInbound(msg, env)).toEqual({ stored: true, notified: true });
		expect(forwarded).toEqual(["ops@verified.example"]);
		expect(w.receipts()).toMatchObject([{ kind: "inbound", outcome: "ok", message_id: "<e2e-1@x.org>", from_address: "kelly@x.org", to_address: "info@freeappstore.online" }]);

		// …and the agent can read it, with the original sender and recipient intact.
		const list = JSON.parse((await run("email_worker_list_messages", w.ctx(), {})).content);
		expect(list.messages).toMatchObject([{ id: "<e2e-1@x.org>", from: "kelly@x.org", to: "info@freeappstore.online" }]);
		const read = await dispatched("email_worker_read_message", w.ctx(), { message_id: "<e2e-1@x.org>" });
		expect(read.success).toBe(true);
		expect(read.content).toContain("Body text here");
		expect(read.content).toContain("The following came from");
	});

	it("a redelivered mail is the same event: stable id, deduped at PAGS", async () => {
		await w.connect();
		const make = (): RoutedEmail => ({
			from: "kelly@x.org",
			to: "info@freeappstore.online",
			headers: { get: (n) => ({ subject: "No id" })[n.toLowerCase()] ?? null },
			raw: null,
			forward: async () => undefined,
		});
		const env = { ...w.bridge.env, PAGS_INBOUND_URL: `${INBOUND_ORIGIN}/v1/email-worker/inbound/${w.token()}` };
		await handleInbound(make(), env);
		await handleInbound(make(), env);
		expect(w.receipts().map((r) => r.outcome)).toEqual(["ok", "deduped"]);
	});

	it("a PAGS outage does not lose the mail: it is stored and forwarded first", async () => {
		const env = { ...w.bridge.env, PAGS_INBOUND_URL: "https://down.example.net/inbound" };
		const forwarded: string[] = [];
		const out = await handleInbound({ from: "a@b.org", to: "info@freeappstore.online", headers: { get: () => null }, raw: null, forward: async (d) => void forwarded.push(d) }, env, async () => {
			throw new Error("unreachable");
		});
		expect(out).toEqual({ stored: true, notified: false });
		expect(forwarded).toEqual(["ops@verified.example"]);
		expect([...(env.MAIL as ReturnType<typeof kv>).data.keys()].some((k) => k.startsWith("msg:"))).toBe(true);
	});

	it("the bridge rejects a bad bearer, a GET, and unknown paths", async () => {
		const call = (init: RequestInit, path = "/v1/email-worker/identity") => handleRequest(new Request(`${BRIDGE}${path}`, init), w.bridge.env);
		expect((await call({ method: "POST", headers: { authorization: "Bearer wrong" }, body: "{}" })).status).toBe(401);
		expect((await call({ method: "POST", body: "{}" })).status).toBe(401);
		expect((await call({ method: "GET" })).status).toBe(405);
		expect((await call({ method: "POST", headers: { authorization: `Bearer ${SECRET}` }, body: "{}" }, "/v1/email-worker/nope")).status).toBe(404);
	});
});

describe("bridge unavailability", () => {
	beforeEach(async () => {
		await w.connect();
		w.pin(BRIDGE);
	});

	it("a down bridge fails the send, records it as unavailable in health and receipts, and never records a 'sent'", async () => {
		w.bridge.down.status = 503;
		const r = await run("email_worker_send", w.ctx(), SEND);
		expect(r.success).toBe(false);
		expect(r.content).toMatch(/Send failed/);
		expect(w.receipts()).toMatchObject([{ kind: "send", outcome: "failed", failure_class: "bridge_unavailable" }]);
		expect((await loadProfile(w.env, "u1", BRIDGE, "")).health).toMatchObject({ lastProbeOk: false, lastFailureClass: "bridge_unavailable" });
		const shown = JSON.parse((await run("email_worker_identities", w.ctx(), {})).content);
		expect(shown.health).toMatchObject({ reachable: false, lastFailureClass: "bridge_unavailable" });
	});

	it("after the bridge recovers, the same send really sends (a failure is not an acceptance)", async () => {
		w.bridge.down.status = 503;
		await run("email_worker_send", w.ctx(), SEND);
		w.bridge.down.status = null;
		const r = JSON.parse((await run("email_worker_send", w.ctx(), SEND)).content);
		expect(r).toMatchObject({ sent: true });
		expect(r.deduped).toBeUndefined();
		expect(w.bridge.sent).toHaveLength(1);
		expect(w.receipts().map((x) => x.outcome)).toEqual(["failed", "sent"]);
	});

	it("a rejected credential is classified auth, not unavailable", async () => {
		w.bridge.env.BRIDGE_SECRET = "rotated-on-the-bridge-side";
		const r = await run("email_worker_list_messages", w.ctx(), {});
		expect(r.success).toBe(false);
		expect(w.receipts()[0]).toMatchObject({ outcome: "failed", failure_class: "auth" });
	});

	it("testing the connection through the API shows an unreachable bridge", async () => {
		w.bridge.down.status = 500;
		const res = await w.app.request("/v1/email-worker/connections/test", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: BRIDGE }) }, w.env);
		expect(await res.json()).toMatchObject({ ok: false, failureClass: "bridge_unavailable" });
		const list = (await (await w.app.request("/v1/email-worker/connections", {}, w.env)).json()) as { connections: Array<{ identities: { health: { reachable: boolean } } }> };
		expect(list.connections[0].identities.health.reachable).toBe(false);
	});
});

describe("connecting and listing — through the API", () => {
	it("connects a Cloudflare bridge, reports its identities, and returns no secret", async () => {
		const res = await w.app.request("/v1/email-worker/connections", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: BRIDGE, secret: SECRET, label: "Free App Store" }) }, w.env);
		const raw = await res.text();
		expect(res.status).toBe(200);
		const body = JSON.parse(raw);
		expect(body).toMatchObject({ success: true, provider: "cloudflare", identities: { provider: "cloudflare" } });
		// Nothing is approved until the owner approves it: connecting does not make a sender usable.
		expect(body.identities.senders.map((x: { address: string; approved: boolean }) => [x.address, x.approved])).toEqual([["admin@freeappstore.online", false], ["noreply@freeappstore.online", false]]);
		expect(body.connection.webhookUrl).toContain("/v1/email-worker/inbound/");
		expect(raw).not.toContain(SECRET);
		const list = await (await w.app.request("/v1/email-worker/connections", {}, w.env)).text();
		expect(list).not.toContain(SECRET);
	});

	it("does not save a bridge that cannot identify itself", async () => {
		w.bridge.down.status = 502;
		const res = await w.app.request("/v1/email-worker/connections", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: BRIDGE, secret: SECRET }) }, w.env);
		expect(res.status).toBe(422);
		expect((w.d1.sqlite.prepare("SELECT COUNT(*) AS n FROM email_worker_connections").get() as { n: number }).n).toBe(0);
	});

	it("a generic worker still connects, reports no sender policy, and sends as before", async () => {
		const generic = makeBridge();
		// A worker that omits the Cloudflare fields entirely:
		vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
			const req = new Request(input instanceof Request ? input : String(input), init);
			if (req.url.endsWith("/identity")) return Response.json({ contractVersion: "email-worker/v1", account: { address: "me@plain.example" } });
			if (req.url.endsWith("/messages/send")) return Response.json({ id: "m1", threadId: "t1" });
			return handleRequest(req, generic.env);
		});
		const probe = await probeEmailWorkerIdentity("https://plain.example.com", SECRET);
		if (!probe.ok) throw new Error("probe");
		await saveEmailWorkerConnection(w.env, { userId: "u1", endpoint: "https://plain.example.com", secret: SECRET, contractVersion: probe.contractVersion });
		await recordProbeSuccess(w.env, "u1", "https://plain.example.com", "", probe.snapshot);
		w.pin("https://plain.example.com");
		expect((await loadProfile(w.env, "u1", "https://plain.example.com", "")).provider).toBe("generic");
		const r = await run("email_worker_send", w.ctx(), { ...SEND, from: "anyone@anywhere.org" });
		expect(r.success).toBe(true);
	});
});

describe("receipts — append-only, secret-free, owner-scoped", () => {
	beforeEach(async () => {
		await w.connect();
		w.pin(BRIDGE);
	});

	it("aborts UPDATE and DELETE at the database", async () => {
		await run("email_worker_send", w.ctx(), SEND);
		expect(() => w.d1.sqlite.prepare("UPDATE email_worker_receipts SET outcome = 'ok'").run()).toThrow(/append-only/);
		expect(() => w.d1.sqlite.prepare("DELETE FROM email_worker_receipts").run()).toThrow(/append-only/);
	});

	it("survives revoking the connection", async () => {
		await run("email_worker_send", w.ctx(), SEND);
		const res = await w.app.request(`/v1/email-worker/connections?endpoint=${encodeURIComponent(BRIDGE)}`, { method: "DELETE" }, w.env);
		expect(res.status).toBe(200);
		expect(w.receipts()).toHaveLength(1);
	});

	it("has no column that could hold a body, subject or secret, and none ever contains one", async () => {
		const cols = (w.d1.sqlite.prepare("PRAGMA table_info(email_worker_receipts)").all() as Array<{ name: string }>).map((c) => c.name).join(" ");
		expect(cols).not.toMatch(/body|subject|content|secret|token|text/);
		await run("email_worker_send", w.ctx(), SEND);
		await run("email_worker_list_messages", w.ctx(), {});
		await w.inbound(w.token(), { type: "message.received", eventId: "e1", messageId: "m1", from: "a@b.org", to: "admin@freeappstore.online", body: "PRIVATE BODY", subject: "PRIVATE SUBJECT" });
		const stored = JSON.stringify(w.receipts());
		expect(stored).not.toMatch(/PRIVATE|Hello — are you free|Interview/);
		expect(stored).not.toContain(SECRET);
	});

	it("never lets the bearer reach a result, a receipt, an event log or any stored cell in the clear", async () => {
		const outputs = [
			(await dispatched("email_worker_send", w.ctx(), SEND)).content,
			(await dispatched("email_worker_identities", w.ctx(), {})).content,
			(await dispatched("email_worker_list_events", w.ctx(), {})).content,
			(await dispatched("email_worker_list_messages", w.ctx(), {})).content,
		];
		const cells: string[] = [];
		for (const t of w.d1.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>) {
			for (const row of w.d1.sqlite.prepare(`SELECT * FROM "${t.name}"`).all() as Array<Record<string, unknown>>) {
				for (const v of Object.values(row)) cells.push(v instanceof Uint8Array ? Buffer.from(v).toString("latin1") : String(v));
			}
		}
		expect([...outputs, ...cells].join("\n")).not.toContain(SECRET);
	});

	it("the events tool lists inbound and outbound events, newest first, with ids and no bodies", async () => {
		await w.inbound(w.token(), { type: "message.received", eventId: "e1", messageId: "m1", threadId: "t1", from: "a@b.org", to: "admin@freeappstore.online" });
		await run("email_worker_send", w.ctx(), SEND);
		const out = await dispatched("email_worker_list_events", w.ctx(), { limit: 10 });
		expect(out.content).toContain("The following came from");
		const body = JSON.parse(out.content.slice(out.content.indexOf("{"), out.content.lastIndexOf("}") + 1));
		expect(body.events.map((e: { kind: string }) => e.kind)).toEqual(["send", "inbound"]);
		expect(body.events[1]).toMatchObject({ messageId: "m1", threadId: "t1", fromAddress: "a@b.org", toAddress: "admin@freeappstore.online" });
		expect(JSON.stringify(body)).not.toMatch(/idempotencyKey|Interview/);
	});

	it("the owner's receipts endpoint is owner-scoped and filterable, and pages stably", async () => {
		await run("email_worker_send", w.ctx(), SEND);
		await run("email_worker_send", w.ctx(), { ...SEND, subject: "Two" });
		await w.inbound(w.token(), { type: "message.received", eventId: "e1", messageId: "m1", from: "a@b.org", to: "admin@freeappstore.online" });
		const get = async (qs: string, uid = "u1") => (await (await w.app.request(`/v1/email-worker/receipts${qs}`, { headers: { "x-test-uid": uid } }, w.env)).json()) as { receipts: Array<{ kind: string; id: string }>; nextBefore: string | null };
		expect((await get("")).receipts).toHaveLength(3);
		expect((await get("?kind=send")).receipts).toHaveLength(2);
		expect((await get("", "u2")).receipts).toEqual([]);
		const page1 = await get("?limit=2");
		expect(page1.receipts).toHaveLength(2);
		const page2 = await get(`?limit=2&before=${encodeURIComponent(page1.nextBefore ?? "")}`);
		expect(page2.receipts).toHaveLength(1);
		expect(new Set([...page1.receipts, ...page2.receipts].map((r) => r.id)).size).toBe(3);
		expect((await listReceipts(w.env, { userId: "u1", outcome: "sent" })).receipts).toHaveLength(2);
	});
});

describe("the declaration", () => {
	it("keeps the sends write-scoped and the new tools read-only", () => {
		for (const n of ["email_worker_send", "email_worker_reply"]) expect(tool(n)).toMatchObject({ scope: "write", mutates: true, untrustedOutput: false });
		for (const n of ["email_worker_identities", "email_worker_list_events"]) expect(tool(n)).toMatchObject({ scope: "read", mutates: false });
		expect(tool("email_worker_list_events").untrustedOutput).toBe(true);
	});

	it("gives the model no way to name a credential, endpoint or connection", () => {
		for (const t of EMAIL_WORKER_CONNECTOR.tools) expect(Object.keys(t.jsonSchema.properties).join(" "), t.name).not.toMatch(/secret|token|bearer|endpoint|account|api_?key|password|smtp/i);
	});
});
