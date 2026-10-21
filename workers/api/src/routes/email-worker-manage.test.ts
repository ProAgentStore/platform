/**
 * #1277 — managing a worker-backed Cloudflare mail connection from MCP, end to end through the routes against the REAL
 * migrated schema and the REAL bridge template. The cases the issue names: secure enrollment (the secret is typed by the
 * owner and never crosses a route), the distinct reasons mail cannot flow, pin and sender approval, and isolation between
 * owners. Every assertion about secrecy checks the whole response body, not a chosen field.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type BridgeEnv, handleRequest, type StoreBinding } from "../../../../templates/cloudflare-email-bridge/src/bridge.js";
import { HttpError } from "../lib/auth.js";
import { type RealSchemaD1, realSchemaD1, seedTenant } from "../lib/d1-sqlite.js";
import { resolveEmailWorkerSecret } from "../lib/email-worker-connections.js";
import { consumeSecureInput, storeSecretValue } from "../lib/secure-input.js";
import type { Env } from "../types.js";
import { emailWorkerInstanceRoutes, emailWorkerRoutes } from "./email-worker.js";
import { emailWorkerManageRoutes } from "./email-worker-manage.js";

vi.mock("../lib/auth.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/auth.js")>("../lib/auth.js");
	return { ...actual, requireUser: async (c: { req: { header: (n: string) => string | undefined } }) => ({ uid: c.req.header("x-test-uid") ?? "u1", roles: [] }) };
});

const KEK = "6".repeat(64);
const SECRET = "bridge-bearer-PLAINTEXT-ABCDEF0123";
const BRIDGE = "https://bridge.example.com";
const OTHER = "https://other-bridge.example.com";

const kv = (): StoreBinding => {
	const data = new Map<string, string>();
	return {
		get: async (k) => data.get(k) ?? null,
		put: async (k, v) => void data.set(k, v),
		list: async ({ prefix }) => ({ keys: [...data.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }),
	};
};
const bridgeEnv = (secret = SECRET): BridgeEnv => ({
	BRIDGE_SECRET: secret,
	DOMAINS: "freeappstore.online",
	SENDERS: "admin@freeappstore.online",
	REPLY_IDENTITIES: "admin@freeappstore.online",
	ROUTES: "admin@freeappstore.online=ops@verified.example,info@freeappstore.online=ops@verified.example",
	EMAIL: { send: async () => ({ messageId: "never" }) },
	MAIL: kv(),
});

let d1: RealSchemaD1;
let env: Env;
let app: Hono<{ Bindings: Env }>;
let bridges: Map<string, { env: BridgeEnv; down: boolean; calls: number }>;

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["inst-1", "inst-2"] });
	seedTenant(d1, { userId: "u2", instanceIds: ["inst-3"] });
	env = { DB: d1.DB, KEY_ENCRYPTION_KEY: KEK } as unknown as Env;
	app = new Hono<{ Bindings: Env }>();
	app.route("/v1/email-worker", emailWorkerRoutes);
	app.route("/v1/instances", emailWorkerInstanceRoutes);
	app.route("/v1/instances", emailWorkerManageRoutes);
	app.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500)));
	bridges = new Map([[new URL(BRIDGE).host, { env: bridgeEnv(), down: false, calls: 0 }]]);
	vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
		const req = new Request(input instanceof Request ? input : String(input), init);
		const b = bridges.get(new URL(req.url).host);
		if (!b) return new Response("no such host", { status: 502 });
		b.calls++;
		if (b.down) return new Response(JSON.stringify({ error: { code: "down", message: "Simulated outage" } }), { status: 503 });
		return handleRequest(req, b.env);
	});
});
afterEach(() => {
	vi.unstubAllGlobals();
	d1.close();
});

async function call(method: string, path: string, body?: unknown, uid = "u1") {
	const res = await app.request(path, { method, headers: { "content-type": "application/json", "x-test-uid": uid }, body: body === undefined ? undefined : JSON.stringify(body) }, env);
	const raw = await res.text();
	// biome-ignore lint/suspicious/noExplicitAny: the test reads loose response JSON
	return { status: res.status, raw, json: JSON.parse(raw) as Record<string, any> };
}
const status = (id = "inst-1", q = "") => call("GET", `/v1/instances/${id}/email-worker/status${q}`);
const begin = (body: Record<string, unknown> = { endpoint: BRIDGE }, id = "inst-1", uid = "u1") => call("POST", `/v1/instances/${id}/email-worker/enrollments`, body, uid);
const complete = (eid: string, id = "inst-1", uid = "u1") => call("POST", `/v1/instances/${id}/email-worker/enrollments/${eid}/complete`, undefined, uid);
/** What the console does when the owner presses Submit on the secure-input page. */
const ownerTypes = (eid: string, value = SECRET, instance = "inst-1", uid = "u1") => storeSecretValue(env, eid, instance, uid, value);
const consent = (mode: "always" | "ask" | null, instanceId = "inst-1") => {
	d1.sqlite.prepare("DELETE FROM instance_connector_consent WHERE instance_id = ? AND connector = 'email-worker'").run(instanceId);
	if (mode) d1.sqlite.prepare("INSERT INTO instance_connector_consent (instance_id, user_id, connector, scope, mode) VALUES (?, 'u1', 'email-worker', 'write', ?)").run(instanceId, mode);
};
async function enrolled(endpoint = BRIDGE): Promise<string> {
	const b = await begin({ endpoint });
	expect(await ownerTypes(b.json.enrollmentId)).toBe(true);
	expect((await complete(b.json.enrollmentId)).status).toBe(200);
	return b.json.enrollmentId;
}
const codes = (s: { json: object }) => ((s.json as { blockers: Array<{ code: string }> }).blockers).map((b) => b.code);

describe("secure enrollment — the secret is typed by the owner and never crosses a route", () => {
	it("opens a request bound to one endpoint and returns only a console link", async () => {
		const b = await begin({ endpoint: `${BRIDGE}/`, accountId: "hiring", label: "Hiring Comms" });
		expect(b.status).toBe(201);
		expect(b.json.consoleUrl).toBe(`/instances/inst-1/secure-inputs/${b.json.enrollmentId}`);
		expect(b.json.endpoint).toBe(BRIDGE);
		const row = d1.sqlite.prepare("SELECT status, purpose, destination_scope FROM secure_input_requests WHERE id = ?").get(b.json.enrollmentId);
		expect(row).toMatchObject({ status: "pending", purpose: "email-worker-enrollment", destination_scope: "env" });
		expect((await status("inst-1", `?enrollment=${b.json.enrollmentId}`)).json.enrollment).toMatchObject({ state: "pending", endpoint: BRIDGE, accountId: "hiring", label: "Hiring Comms" });
	});

	it("refuses a body that carries a secret, a non-https endpoint, and an over-long label — creating nothing", async () => {
		expect((await begin({ endpoint: BRIDGE, secret: SECRET })).status).toBe(400);
		expect((await begin({ endpoint: "http://bridge.example.com" })).status).toBe(400);
		expect((await begin({ endpoint: BRIDGE, label: "x".repeat(121) })).status).toBe(400);
		expect((await begin({})).status).toBe(400);
		expect(d1.sqlite.prepare("SELECT COUNT(*) AS n FROM email_worker_enrollments").get()).toEqual({ n: 0 });
	});

	it("completing before the owner has typed it is `not_entered`: nothing consumed, nothing stored, the bridge never called", async () => {
		const b = await begin();
		const r = await complete(b.json.enrollmentId);
		expect(r.status).toBe(409);
		expect(r.json).toMatchObject({ ok: false, code: "not_entered" });
		expect(bridges.get(new URL(BRIDGE).host)?.calls).toBe(0);
		expect(d1.sqlite.prepare("SELECT COUNT(*) AS n FROM email_worker_connections").get()).toEqual({ n: 0 });
	});

	it("completes: the connection is stored with the owner's secret, the one-shot value is spent, and no response carries the secret", async () => {
		const b = await begin({ endpoint: BRIDGE, label: "Hiring Comms" });
		expect((await status("inst-1", `?enrollment=${b.json.enrollmentId}`)).json.enrollment.state).toBe("pending");
		await ownerTypes(b.json.enrollmentId);
		const ready = await status("inst-1", `?enrollment=${b.json.enrollmentId}`);
		expect(ready.json.enrollment).toMatchObject({ state: "ready", secretLength: SECRET.length });
		const done = await complete(b.json.enrollmentId);
		expect(done.status).toBe(200);
		expect(done.json).toMatchObject({ ok: true, contractVersion: "email-worker/v1", enrollment: { state: "connected" } });
		expect(await resolveEmailWorkerSecret(env, "u1", BRIDGE, "")).toBe(SECRET);
		for (const r of [b, ready, done, await status()]) expect(r.raw).not.toContain(SECRET);
		// spent: a second completion is refused, and the secure-input row holds no ciphertext
		expect((await complete(b.json.enrollmentId)).json).toMatchObject({ code: "already_connected" });
		expect(d1.sqlite.prepare("SELECT status, secret_ciphertext FROM secure_input_requests WHERE id = ?").get(b.json.enrollmentId)).toMatchObject({ status: "consumed", secret_ciphertext: null });
	});

	it("a wrong secret is `probe_failed` (auth): no connection is stored, and the value is kept so the owner need not retype it once the Worker is fixed", async () => {
		const b = await begin();
		await ownerTypes(b.json.enrollmentId, "the-wrong-secret-value");
		const bad = await complete(b.json.enrollmentId);
		expect(bad.status).toBe(422);
		expect(bad.json).toMatchObject({ ok: false, code: "probe_failed", failureClass: "auth" });
		expect(bad.raw).not.toContain("the-wrong-secret-value");
		expect(d1.sqlite.prepare("SELECT COUNT(*) AS n FROM email_worker_connections").get()).toEqual({ n: 0 });
		expect((await status("inst-1", `?enrollment=${b.json.enrollmentId}`)).json.enrollment).toMatchObject({ state: "probe_failed", failureClass: "auth" });
		// the owner fixes the Worker's secret instead of retyping; the SAME enrollment now completes
		bridges.set(new URL(BRIDGE).host, { env: bridgeEnv("the-wrong-secret-value"), down: false, calls: 0 });
		expect((await complete(b.json.enrollmentId)).status).toBe(200);
		expect(await resolveEmailWorkerSecret(env, "u1", BRIDGE, "")).toBe("the-wrong-secret-value");
	});

	it("a bridge outage is `probe_failed` bridge_unavailable — distinct from a bad secret", async () => {
		const b = await begin();
		await ownerTypes(b.json.enrollmentId);
		const host = bridges.get(new URL(BRIDGE).host);
		if (host) host.down = true;
		expect((await complete(b.json.enrollmentId)).json).toMatchObject({ code: "probe_failed", failureClass: "bridge_unavailable" });
		if (host) host.down = false;
		expect((await complete(b.json.enrollmentId)).status).toBe(200);
	});

	it("only the enrollment can spend the value: the agent-reachable consume paths (tmux_secure_get, inject) get nothing", async () => {
		const b = await begin();
		await ownerTypes(b.json.enrollmentId);
		expect(await consumeSecureInput(env, b.json.enrollmentId, null, "u1", { consumedNode: "dell-laptop" })).toBeNull();
		expect(await consumeSecureInput(env, b.json.enrollmentId, "inst-1", "u1")).toBeNull();
		// still ready, still completable
		expect((await complete(b.json.enrollmentId)).status).toBe(200);
	});

	it("is owner-isolated: another owner, or another of the owner's instances, cannot see or complete an enrollment", async () => {
		const b = await begin();
		await ownerTypes(b.json.enrollmentId);
		expect((await complete(b.json.enrollmentId, "inst-1", "u2")).status).toBe(404); // not u2's instance
		expect((await complete(b.json.enrollmentId, "inst-2", "u1")).json).toMatchObject({ code: "not_found" }); // u1's other instance
		expect((await status("inst-2", `?enrollment=${b.json.enrollmentId}`)).json.enrollment).toBeNull();
		expect((await status("inst-1", `?enrollment=${b.json.enrollmentId}`)).json.enrollment.state).toBe("ready");
		expect(d1.sqlite.prepare("SELECT COUNT(*) AS n FROM email_worker_connections").get()).toEqual({ n: 0 });
	});
});

describe("status — each reason mail cannot flow is a different, named blocker", () => {
	it("absent: no connection exists", async () => {
		const s = await status();
		expect(s.json).toMatchObject({ state: "absent", readyToRead: false, readyToSend: false, resolved: null });
		expect(codes(s)).toEqual(["no_connection"]);
	});

	it("connected but nothing approved: no_approved_sender, and write consent off is reported separately", async () => {
		await enrolled();
		const s = await status();
		expect(s.json).toMatchObject({ state: "connected", readyToRead: true, readyToSend: false, writeConsent: "off", resolved: { endpoint: BRIDGE } });
		expect(codes(s).sort()).toEqual(["no_approved_sender", "write_consent_off"]);
		expect(s.json.connections[0].identities.routes).toEqual(expect.arrayContaining([{ address: "info@freeappstore.online", destination: "ops@verified.example", canSend: false }]));
	});

	it("approving senders and a reply identity, through the existing service, clears them; consent `ask` gates, `always` opens", async () => {
		await enrolled();
		const ok = await call("PUT", "/v1/email-worker/connections/identities", { endpoint: BRIDGE, approvedSenders: ["admin@freeappstore.online"], replyIdentity: "admin@freeappstore.online" });
		expect(ok.status).toBe(200);
		consent("ask");
		let s = await status();
		expect(codes(s)).toEqual(["write_consent_ask"]);
		expect(s.json).toMatchObject({ readyToRead: true, readyToSend: true, writeConsent: "ask" });
		consent("always");
		s = await status();
		expect(s.json.blockers).toEqual([]);
		expect(s.json.connections[0].identities.senders).toEqual([{ address: "admin@freeappstore.online", approved: true, replyIdentity: true }]);
	});

	it("a routed-only alias cannot be approved as a sender — it never becomes send-capable", async () => {
		await enrolled();
		const r = await call("PUT", "/v1/email-worker/connections/identities", { endpoint: BRIDGE, approvedSenders: ["info@freeappstore.online"] });
		expect(r.status).toBe(400);
		expect((await status()).json.connections[0].identities.senders[0]).toMatchObject({ approved: false });
	});

	it("an approved sender without a reply identity is no_reply_identity", async () => {
		await enrolled();
		await call("PUT", "/v1/email-worker/connections/identities", { endpoint: BRIDGE, approvedSenders: ["admin@freeappstore.online"] });
		consent("always");
		expect(codes(await status())).toEqual(["no_reply_identity"]);
	});

	it("two connections and no pin is ambiguous; the pin resolves it; revoking the pinned one is a STALE pin, never a silent switch", async () => {
		bridges.set(new URL(OTHER).host, { env: bridgeEnv(), down: false, calls: 0 });
		await enrolled();
		await enrolled(OTHER);
		let s = await status();
		expect(s.json).toMatchObject({ state: "ambiguous", resolved: null, readyToRead: false });
		expect(codes(s)).toEqual(["ambiguous_connection"]);

		const pin = await call("PUT", "/v1/instances/inst-1/email-worker/account", { endpoint: BRIDGE });
		expect(pin.json).toMatchObject({ success: true, pinned: { endpoint: BRIDGE, accountId: "" } });
		s = await status();
		expect(s.json).toMatchObject({ state: "connected", pinned: { endpoint: BRIDGE }, resolved: { endpoint: BRIDGE } });
		expect(s.json.connections.find((c: { endpoint: string }) => c.endpoint === BRIDGE).pinnedToThisInstance).toBe(true);
		// another instance of the same owner is untouched by this pin
		expect((await status("inst-2")).json.state).toBe("ambiguous");

		await call("DELETE", `/v1/email-worker/connections?endpoint=${encodeURIComponent(BRIDGE)}`);
		s = await status();
		expect(s.json).toMatchObject({ state: "stale_pin", resolved: null });
		expect(codes(s)).toEqual(["stale_pin"]);
	});

	it("pinning a connection that was never stored is refused", async () => {
		expect((await call("PUT", "/v1/instances/inst-1/email-worker/account", { endpoint: BRIDGE })).status).toBe(404);
	});

	it("another owner's connections are invisible and cannot be pinned", async () => {
		await enrolled();
		expect((await call("GET", "/v1/instances/inst-3/email-worker/status", undefined, "u2")).json).toMatchObject({ state: "absent", connections: [] });
		expect((await call("PUT", "/v1/instances/inst-3/email-worker/account", { endpoint: BRIDGE }, "u2")).status).toBe(404);
		expect((await call("GET", "/v1/instances/inst-3/email-worker/status")).status).toBe(404); // u1 asking about u2's instance
	});
});

describe("test — the stored credential, never a supplied one", () => {
	it("refuses a secret in the body, and answers no_connection / ambiguous distinctly", async () => {
		expect((await call("POST", "/v1/instances/inst-1/email-worker/test", { endpoint: BRIDGE, secret: SECRET })).status).toBe(400);
		expect((await call("POST", "/v1/instances/inst-1/email-worker/test", {})).json).toMatchObject({ ok: false, code: "not_connected" });
		expect((await call("POST", "/v1/instances/inst-1/email-worker/test", { endpoint: BRIDGE })).json).toMatchObject({ ok: false, code: "no_connection" });
	});

	it("tests the connection the instance resolves to and records the health an outage then a recovery produce", async () => {
		await enrolled();
		const ok = await call("POST", "/v1/instances/inst-1/email-worker/test", {});
		expect(ok.json).toMatchObject({ ok: true, endpoint: BRIDGE, provider: "cloudflare", contractVersion: "email-worker/v1" });
		expect(ok.raw).not.toContain(SECRET);

		const host = bridges.get(new URL(BRIDGE).host);
		if (host) host.down = true;
		const down = await call("POST", "/v1/instances/inst-1/email-worker/test", {});
		expect(down.json).toMatchObject({ ok: false, code: "bridge_failure", failureClass: "bridge_unavailable" });
		const s = await status();
		expect(codes(s)).toContain("bridge_unreachable");
		expect(s.json.blockers.find((b: { code: string }) => b.code === "bridge_unreachable").failureClass).toBe("bridge_unavailable");
		expect(s.json.readyToRead).toBe(false);

		if (host) host.down = false;
		await call("POST", "/v1/instances/inst-1/email-worker/test", {});
		expect(codes(await status())).not.toContain("bridge_unreachable");
	});

	it("a bridge that rejects the stored credential is an auth failure, not an outage", async () => {
		await enrolled();
		bridges.set(new URL(BRIDGE).host, { env: bridgeEnv("rotated-at-the-worker"), down: false, calls: 0 });
		expect((await call("POST", "/v1/instances/inst-1/email-worker/test", {})).json).toMatchObject({ ok: false, failureClass: "auth" });
	});
});
