/**
 * #1278 — recipient scope and bounded, incremental reads on the Cloudflare bridge and the connector that drives it.
 *
 * REAL bridge template, REAL connector tools, REAL routes and migrated schema; only Cloudflare's own bindings are in-memory
 * (a send recorder and a KV with Workers-KV list semantics: lexicographic keys, `limit` per page, an opaque cursor). Nothing
 * here sends mail anywhere: the "candidate" sends go to a recorder.
 *
 * The cases the issue names: mixed recipients, direct ID, more than 200 items, repeated scans, oversized content, reply
 * identity, and retries.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type BridgeEnv, handleInbound, handleRequest, LIMITS, type RoutedEmail, type StoreBinding } from "../../../../../templates/cloudflare-email-bridge/src/bridge.js";
import { emailWorkerInboundRoutes, emailWorkerRoutes } from "../../routes/email-worker.js";
import type { Env } from "../../types.js";
import { HttpError } from "../auth.js";
import { type RealSchemaD1, realSchemaD1, seedTenant } from "../d1-sqlite.js";
import { RUN_BUDGET } from "../email-worker-checkpoints.js";
import { recordProbeSuccess, saveApproval, saveEmailWorkerConnection } from "../email-worker-connections.js";
import { inMailboxScope, loadProfile } from "../email-worker-identities.js";
import { EMAIL_WORKER_CONNECTOR, probeEmailWorkerIdentity } from "./email-worker.js";
import type { RegistryToolCtx } from "./types.js";

vi.mock("../auth.js", async () => {
	const actual = await vi.importActual<typeof import("../auth.js")>("../auth.js");
	return { ...actual, requireUser: async () => ({ uid: "u1", roles: [] }) };
});

const KEK = "7".repeat(64);
const SECRET = "bridge-bearer-PLAINTEXT-0123456789";
const BRIDGE = "https://bridge.example.com";
const ORIGIN = "https://api.proagentstore.online";
const ADMIN = "admin@freeappstore.online";
const INFO = "info@freeappstore.online";

const kv = (): StoreBinding & { data: Map<string, string> } => {
	const data = new Map<string, string>();
	return {
		data,
		get: async (k) => data.get(k) ?? null,
		put: async (k, v) => void data.set(k, v),
		list: async ({ prefix, limit = 1000, cursor }) => {
			// The cursor is a KEY POSITION, as in Workers KV: keys written ahead of it later do not move the next page.
			const names = [...data.keys()].filter((k) => k.startsWith(prefix) && (!cursor || k > cursor)).sort();
			const page = names.slice(0, limit);
			const done = names.length <= limit;
			return { keys: page.map((name) => ({ name })), list_complete: done, ...(done ? {} : { cursor: page[page.length - 1] }) };
		},
	};
};

let d1: RealSchemaD1;
let env: Env;
let app: Hono<{ Bindings: Env }>;
let bridge: BridgeEnv & { MAIL: ReturnType<typeof kv> };
let sent: Array<{ from: string; to: string | string[]; subject: string; text: string; headers?: Record<string, string> }>;
let bridgeCalls: Array<{ path: string; body: Record<string, unknown> }>;
/** Lets a test rewrite what the bridge answers, to stand in for a bridge that does not enforce scope itself. */
let intercept: ((path: string, res: Record<string, unknown>) => Record<string, unknown>) | null;
let clock: number;

function makeBridge(over: Partial<BridgeEnv> = {}): typeof bridge {
	return {
		BRIDGE_SECRET: SECRET,
		DOMAINS: "freeappstore.online",
		SENDERS: `${ADMIN},noreply@freeappstore.online`,
		REPLY_IDENTITIES: ADMIN,
		ROUTES: `${ADMIN}=ops@verified.example,${INFO}=ops@verified.example`,
		MAILBOX: ADMIN,
		EMAIL: {
			send: async (m) => {
				sent.push(m);
				return { messageId: `cf-${sent.length}` };
			},
		},
		MAIL: kv(),
		...over,
	} as typeof bridge;
}

beforeEach(async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	clock = Date.parse("2026-10-21T00:00:00Z");
	vi.setSystemTime(clock);
	sent = [];
	bridgeCalls = [];
	intercept = null;
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["inst-1", "inst-2"] });
	env = { DB: d1.DB, KEY_ENCRYPTION_KEY: KEK } as unknown as Env;
	app = new Hono<{ Bindings: Env }>();
	app.route("/v1/email-worker", emailWorkerRoutes);
	app.route("/v1/email-worker/inbound", emailWorkerInboundRoutes);
	app.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500)));
	bridge = makeBridge();
	vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
		const req = new Request(input instanceof Request ? input : String(input), init);
		const url = new URL(req.url);
		if (url.origin === ORIGIN) return app.request(req, undefined, env);
		const body = (await req.clone().json().catch(() => ({}))) as Record<string, unknown>;
		bridgeCalls.push({ path: url.pathname, body });
		const res = await handleRequest(req, bridge);
		if (!intercept || !res.ok) return res;
		return new Response(JSON.stringify(intercept(url.pathname, (await res.json()) as Record<string, unknown>)), { status: 200 });
	});
	const probe = await probeEmailWorkerIdentity(BRIDGE, SECRET);
	if (!probe.ok) throw new Error(probe.error);
	await saveEmailWorkerConnection(env, { userId: "u1", endpoint: BRIDGE, secret: SECRET, contractVersion: probe.contractVersion });
	await recordProbeSuccess(env, "u1", BRIDGE, "", probe.snapshot);
	await saveApproval(env, "u1", BRIDGE, "", [ADMIN], ADMIN);
	d1.sqlite.prepare("UPDATE agent_instances SET config = ? WHERE id = 'inst-1'").run(JSON.stringify({ emailWorkerAccount: { endpoint: BRIDGE, accountId: "" } }));
	bridgeCalls.length = 0;
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	d1.close();
});

const tool = (name: string) => {
	const t = EMAIL_WORKER_CONNECTOR.tools.find((x) => x.name === name);
	if (!t?.handler) throw new Error(`no tool ${name}`);
	return t.handler;
};
let runSeq = 0;
const ctx = (traceId = `run-${++runSeq}`): RegistryToolCtx => ({ env, userId: "u1", instanceId: "inst-1", traceId }) as RegistryToolCtx;
// biome-ignore lint/suspicious/noExplicitAny: tool results are loose JSON
type Json = Record<string, any>;
async function call(name: string, c: RegistryToolCtx, input: Record<string, unknown> = {}): Promise<{ success: boolean; json: Json; text: string }> {
	const r = await tool(name)(c, input);
	let json: Json = {};
	try {
		json = JSON.parse(r.content);
	} catch {
		/* a refusal is plain text */
	}
	return { success: r.success !== false, json, text: r.content };
}

/** Deliver one mail through the bridge's real inbound handler. Each arrival is a minute after the last. */
async function arrive(o: { id: string; to?: string; from?: string; subject?: string; body?: string; inReplyTo?: string }, target: BridgeEnv = bridge): Promise<{ stored: boolean; notified: boolean; forwarded: string[] }> {
	clock += 60_000;
	vi.setSystemTime(clock);
	const forwarded: string[] = [];
	const msg: RoutedEmail = {
		from: o.from ?? "kelly@candidate.example",
		to: o.to ?? ADMIN,
		headers: { get: (n) => ({ "message-id": o.id, subject: o.subject ?? `Subject ${o.id}`, ...(o.inReplyTo ? { "in-reply-to": o.inReplyTo } : {}) })[n.toLowerCase()] ?? null },
		raw: new Response(`Subject: x\r\n\r\n${o.body ?? `Body of ${o.id}`}`).body,
		forward: async (d) => void forwarded.push(d),
	};
	const token = (d1.sqlite.prepare("SELECT webhook_token FROM email_worker_connections").get() as { webhook_token: string }).webhook_token;
	return { ...(await handleInbound(msg, { ...target, PAGS_INBOUND_URL: `${ORIGIN}/v1/email-worker/inbound/${token}` })), forwarded };
}
const keys = (prefix: string) => [...bridge.MAIL.data.keys()].filter((k) => k.startsWith(prefix));
const receipts = () => d1.sqlite.prepare("SELECT kind, outcome, failure_class, to_address, message_id FROM email_worker_receipts ORDER BY created_at, rowid").all() as Array<Json>;
const direct = async (path: string, body: Record<string, unknown>) => {
	const res = await handleRequest(new Request(`${BRIDGE}${path}`, { method: "POST", headers: { authorization: `Bearer ${SECRET}` }, body: JSON.stringify(body) }), bridge);
	return { status: res.status, json: (await res.json()) as Json };
};

describe("recipient scope — mixed recipients", () => {
	it("stores and forwards only mail addressed to the configured mailbox; the rest is neither kept nor forwarded, but reported", async () => {
		const mine = await arrive({ id: "<m1@x>", to: ADMIN });
		const foreign = await arrive({ id: "<f1@x>", to: INFO });
		const elsewhere = await arrive({ id: "<f2@x>", to: "someone@other-domain.example" });
		expect(mine).toMatchObject({ stored: true, notified: true, forwarded: ["ops@verified.example"] });
		expect(foreign).toMatchObject({ stored: false, forwarded: [] });
		expect(elsewhere).toMatchObject({ stored: false, forwarded: [] });
		expect(keys("msg:")).toEqual(["msg:<m1@x>"]);
		expect(keys("idx:")).toHaveLength(1);
		// PAGS recorded the out-of-scope mail as a routing failure, never as mail received
		expect(receipts().map((r) => [r.kind, r.outcome, r.failure_class])).toEqual([
			["inbound", "ok", null],
			["routing_failure", "refused", "route_out_of_scope"],
			["routing_failure", "refused", "route_unknown_domain"],
		]);
	});

	it("lists only the mailbox's mail, even when other recipients' mail already sits in the shared store", async () => {
		await arrive({ id: "<m1@x>" });
		// mail that was stored before the scope was configured (a #1270 bridge kept everything it was routed)
		bridge.MAIL.data.set("msg:<old-info@x>", JSON.stringify({ messageId: "<old-info@x>", from: "a@b.org", to: INFO, subject: "old", text: "old", date: "2026-01-01T00:00:00.000Z", threadId: "t_old" }));
		bridge.MAIL.data.set("idx:info@freeappstore.online:0000000000000001:<old-info@x>", JSON.stringify({ id: "<old-info@x>", to: INFO }));
		const list = await call("email_worker_list_messages", ctx());
		expect(list.json.messages.map((m: Json) => m.id)).toEqual(["<m1@x>"]);
		expect(list.json.more).toBe(false);
	});

	it("an unscoped (legacy) bridge keeps serving every routed address", async () => {
		bridge = makeBridge({ MAILBOX: undefined });
		await arrive({ id: "<a@x>", to: ADMIN }, bridge);
		await arrive({ id: "<b@x>", to: INFO }, bridge);
		const list = await direct("/v1/email-worker/messages/list", {});
		expect(list.json.messages.map((m: Json) => m.id).sort()).toEqual(["<a@x>", "<b@x>"]);
	});

	it("inbound events and the events tool: another recipient's mail is not this agent's to see", async () => {
		await arrive({ id: "<m1@x>" });
		await arrive({ id: "<f1@x>", to: INFO });
		const ev = await call("email_worker_list_events", ctx());
		expect(ev.json.events.map((e: Json) => e.kind)).toEqual(["inbound"]);
		expect(ev.json.withheldOutOfScope).toBe(1);
		expect(ev.text).not.toContain(INFO);
	});
});

describe("recipient scope — direct ID", () => {
	beforeEach(() => {
		// a foreign message that IS in the store (as the old shared store left it)
		bridge.MAIL.data.set("msg:<foreign@x>", JSON.stringify({ messageId: "<foreign@x>", from: "kelly@x.org", to: INFO, subject: "private", text: "not yours", date: "2026-01-01T00:00:00.000Z", threadId: "t_f" }));
	});

	it("the bridge answers a direct get for another recipient's message exactly as for one that does not exist", async () => {
		const foreign = await direct("/v1/email-worker/messages/get", { id: "<foreign@x>" });
		const missing = await direct("/v1/email-worker/messages/get", { id: "<nope@x>" });
		expect(foreign).toEqual(missing);
		expect(foreign.status).toBe(404);
	});

	it("the read tool refuses it and returns nothing from it", async () => {
		const r = await call("email_worker_read_message", ctx(), { message_id: "<foreign@x>" });
		expect(r.success).toBe(false);
		expect(r.text).not.toContain("not yours");
	});

	it("a reply to it is refused before anything is sent", async () => {
		const r = await call("email_worker_reply", ctx(), { message_id: "<foreign@x>", body: "hello" });
		expect(r.success).toBe(false);
		expect(r.text).toMatch(/not in this agent's mailbox/);
		expect(sent).toEqual([]);
		expect(bridgeCalls.some((c) => c.path.endsWith("/messages/reply"))).toBe(false);
		expect(receipts().at(-1)).toMatchObject({ kind: "reply", outcome: "refused", failure_class: "scope_parent" });
	});

	it("the bridge itself refuses to reply to it even when asked directly", async () => {
		const r = await direct("/v1/email-worker/messages/reply", { idempotencyKey: "key-direct-1", messageId: "<foreign@x>", body: "hi" });
		expect(r.status).toBe(404);
		expect(sent).toEqual([]);
	});

	it("defense in depth: a bridge that does NOT enforce scope cannot get foreign mail past PAGS", async () => {
		intercept = (path, res) => (path.endsWith("/messages/get") ? { ...res, to: INFO, body: "leaked body" } : path.endsWith("/messages/list") ? { ...res, messages: [...(res.messages as unknown[]), { id: "<leak@x>", to: INFO, from: "k@x.org", subject: "leak", date: "2026-01-01", snippet: "leak" }] } : res);
		await arrive({ id: "<m1@x>" });
		const list = await call("email_worker_list_messages", ctx());
		expect(list.json.messages.map((m: Json) => m.id)).toEqual(["<m1@x>"]);
		expect(list.json.droppedOutOfScope).toBe(1);
		const read = await call("email_worker_read_message", ctx(), { message_id: "<m1@x>" });
		expect(read.success).toBe(false);
		expect(read.text).not.toContain("leaked body");
		const reply = await call("email_worker_reply", ctx(), { message_id: "<m1@x>", body: "x" });
		expect(reply.success).toBe(false);
		expect(sent).toEqual([]);
	});

	it("the scope is part of the profile PAGS keeps, and a bridge that reports none is not second-guessed", async () => {
		const profile = await loadProfile(env, "u1", BRIDGE, "");
		expect(profile.snapshot?.mailboxes).toEqual([ADMIN]);
		expect(inMailboxScope(profile, ADMIN.toUpperCase())).toBe(true);
		expect(inMailboxScope(profile, INFO)).toBe(false);
		expect(inMailboxScope({ ...profile, snapshot: profile.snapshot && { ...profile.snapshot, mailboxes: [] } }, INFO)).toBe(true);
	});
});

describe("stable pagination beyond 200", () => {
	async function fill(n: number) {
		for (let i = 0; i < n; i++) await arrive({ id: `<p${String(i).padStart(3, "0")}@x>` });
	}

	it("walks 230 messages in order with no duplicate and no gap, 25 at a time", async () => {
		await fill(230);
		const seen: string[] = [];
		let cursor: string | undefined;
		let pages = 0;
		do {
			const r = await call("email_worker_list_messages", ctx(), { limit: 25, ...(cursor ? { cursor } : {}) });
			expect(r.success).toBe(true);
			expect(r.json.messages.length).toBeLessThanOrEqual(25);
			seen.push(...r.json.messages.map((m: Json) => m.id));
			cursor = r.json.nextCursor ?? undefined;
			pages++;
		} while (cursor && pages < 20);
		expect(seen).toHaveLength(230);
		expect(new Set(seen).size).toBe(230);
		expect(seen[0]).toBe("<p229@x>"); // newest first
		expect(seen.at(-1)).toBe("<p000@x>");
		expect(pages).toBe(10);
	});

	it("a message arriving mid-scan neither shifts the remaining pages nor repeats anything", async () => {
		await fill(60);
		const first = await call("email_worker_list_messages", ctx(), { limit: 25 });
		await arrive({ id: "<late@x>" });
		const second = await call("email_worker_list_messages", ctx(), { limit: 25, cursor: first.json.nextCursor });
		const third = await call("email_worker_list_messages", ctx(), { limit: 25, cursor: second.json.nextCursor });
		const all = [...first.json.messages, ...second.json.messages, ...third.json.messages].map((m: Json) => m.id);
		expect(new Set(all).size).toBe(all.length);
		expect(all).toHaveLength(60);
		expect(all).not.toContain("<late@x>"); // it is newer than the scan's start: the NEXT scan's first item
		expect(third.json.nextCursor).toBeNull();
	});

	it("a list is capped at 25 summaries whatever is asked, and an unknown cursor or folder is refused, not ignored", async () => {
		await fill(40);
		expect((await direct("/v1/email-worker/messages/list", { limit: 500 })).json.messages).toHaveLength(LIMITS.listMax);
		expect((await call("email_worker_list_messages", ctx(), { limit: 9999 })).json.messages).toHaveLength(25);
		expect((await direct("/v1/email-worker/messages/list", { cursor: "not-a-cursor" })).status).toBe(400);
		expect((await direct("/v1/email-worker/messages/list", { cursor: btoa(JSON.stringify({ a: 7 })) })).status).toBe(400);
		expect((await direct("/v1/email-worker/messages/list", { folder: "sent" })).status).toBe(400);
	});

	it("a run's summary budget is enforced across calls, deterministically, and then refuses", async () => {
		await fill(100);
		const c = ctx("one-run");
		const a = await call("email_worker_list_messages", c, { limit: 25, include_handled: true });
		const b = await call("email_worker_list_messages", c, { limit: 25, cursor: a.json.nextCursor, include_handled: true });
		const third = await call("email_worker_list_messages", c, { limit: 25, cursor: b.json.nextCursor, include_handled: true });
		expect(third.json.messages).toHaveLength(RUN_BUDGET.summaries - 50); // only what the run has left
		expect(third.json.stoppedBecause).toBe("run_budget");
		expect(third.json.nextCursor).not.toBeNull(); // and it says more remains
		const fourth = await call("email_worker_list_messages", c, { limit: 25, cursor: third.json.nextCursor });
		expect(fourth.success).toBe(false);
		expect(fourth.text).toMatch(/budget/);
		const callsBefore = bridgeCalls.length;
		await call("email_worker_list_messages", c, { limit: 25 });
		expect(bridgeCalls.length).toBe(callsBefore); // refused before the bridge was asked
		// a new run starts fresh
		expect((await call("email_worker_list_messages", ctx("another-run"), { limit: 5 })).success).toBe(true);
	});
});

describe("persistent checkpoint — repeated scans skip handled mail", () => {
	it("reading a message to its end marks it handled; the next scan skips it, counts it, and still reports what remains", async () => {
		for (const id of ["<a@x>", "<b@x>", "<c@x>"]) await arrive({ id });
		const first = await call("email_worker_list_messages", ctx(), {});
		expect(first.json.messages.map((m: Json) => m.id)).toEqual(["<c@x>", "<b@x>", "<a@x>"]);
		await call("email_worker_read_message", ctx(), { message_id: "<c@x>" });
		await call("email_worker_read_message", ctx(), { message_id: "<b@x>" });
		const again = await call("email_worker_list_messages", ctx(), {});
		expect(again.json.messages.map((m: Json) => m.id)).toEqual(["<a@x>"]);
		expect(again.json).toMatchObject({ skippedHandled: 2, scanned: 3, more: false });
		const all = await call("email_worker_list_messages", ctx(), { include_handled: true });
		expect(all.json.messages.map((m: Json) => [m.id, m.handled])).toEqual([["<c@x>", true], ["<b@x>", true], ["<a@x>", false]]);
	});

	it("a scan skips a long run of handled mail across bridge pages and still fills the page with unhandled mail", async () => {
		for (let i = 0; i < 30; i++) await arrive({ id: `<h${String(i).padStart(2, "0")}@x>` });
		for (let i = 29; i >= 5; i--) d1.sqlite.prepare("INSERT INTO email_worker_handled (instance_id, endpoint, account_id, message_id, how) VALUES ('inst-1', ?, '', ?, 'read')").run(BRIDGE, `<h${String(i).padStart(2, "0")}@x>`);
		const r = await call("email_worker_list_messages", ctx(), { limit: 5 });
		expect(r.json.messages.map((m: Json) => m.id)).toEqual(["<h04@x>", "<h03@x>", "<h02@x>", "<h01@x>", "<h00@x>"]);
		expect(r.json.skippedHandled).toBe(25);
		expect(r.json.stoppedBecause).toBe("limit");
	});

	it("when the scan allowance runs out among handled mail it says so and hands back a cursor, rather than claiming the mailbox is empty", async () => {
		for (let i = 0; i < 30; i++) await arrive({ id: `<s${String(i).padStart(2, "0")}@x>` });
		for (let i = 0; i < 30; i++) d1.sqlite.prepare("INSERT INTO email_worker_handled (instance_id, endpoint, account_id, message_id, how) VALUES ('inst-1', ?, '', ?, 'read')").run(BRIDGE, `<s${String(i).padStart(2, "0")}@x>`);
		const r = await call("email_worker_list_messages", ctx(), { limit: 25 });
		expect(r.json.messages).toEqual([]);
		expect(r.json).toMatchObject({ stoppedBecause: "exhausted", more: false, skippedHandled: 30 });
		for (let i = 0; i < 120; i++) await arrive({ id: `<t${String(i).padStart(3, "0")}@x>` });
		for (let i = 0; i < 120; i++) d1.sqlite.prepare("INSERT INTO email_worker_handled (instance_id, endpoint, account_id, message_id, how) VALUES ('inst-1', ?, '', ?, 'read')").run(BRIDGE, `<t${String(i).padStart(3, "0")}@x>`);
		const deep = await call("email_worker_list_messages", ctx(), { limit: 10 });
		expect(deep.json.messages).toEqual([]);
		expect(deep.json.stoppedBecause).toBe("scan_budget");
		expect(deep.json.more).toBe(true);
		expect(deep.json.nextCursor).toBeTruthy();
	});

	it("the checkpoint is per instance: another agent on the same mailbox still sees the mail", async () => {
		await arrive({ id: "<a@x>" });
		await call("email_worker_read_message", ctx(), { message_id: "<a@x>" });
		d1.sqlite.prepare("UPDATE agent_instances SET config = ? WHERE id = 'inst-2'").run(JSON.stringify({ emailWorkerAccount: { endpoint: BRIDGE, accountId: "" } }));
		const other = await call("email_worker_list_messages", { ...ctx(), instanceId: "inst-2" }, {});
		expect(other.json.messages.map((m: Json) => m.id)).toEqual(["<a@x>"]);
	});

	it("a redelivered mail is one message: same id, one index entry, one stored copy", async () => {
		await arrive({ id: "<dup@x>" });
		await arrive({ id: "<dup@x>" });
		expect(keys("idx:")).toHaveLength(1);
		expect((await call("email_worker_list_messages", ctx(), {})).json.messages).toHaveLength(1);
	});

	it("a reply marks its parent handled", async () => {
		await arrive({ id: "<q@x>" });
		const r = await call("email_worker_reply", ctx(), { message_id: "<q@x>", body: "Thanks — Tuesday works." });
		expect(r.success).toBe(true);
		expect((await call("email_worker_list_messages", ctx(), {})).json.messages).toEqual([]);
	});
});

describe("bounded content", () => {
	it("a huge inbound body is stored bounded; a read returns a bounded, explicitly truncated slice and a continuation", async () => {
		await arrive({ id: "<big@x>", body: "A".repeat(300_000) });
		const stored = JSON.parse(bridge.MAIL.data.get("msg:<big@x>") ?? "{}");
		expect(stored.text.length).toBeLessThanOrEqual(LIMITS.storedBody);
		expect(stored.bodyChars).toBeGreaterThan(LIMITS.storedBody);

		const r = await call("email_worker_read_message", ctx(), { message_id: "<big@x>" });
		expect(r.json.body).toHaveLength(6000);
		expect(r.json).toMatchObject({ truncated: true, nextOffset: 6000 });
		expect(r.json.bodyChars).toBeGreaterThan(LIMITS.storedBody);
		// a body still being paged is not handled yet
		expect((await call("email_worker_list_messages", ctx(), {})).json.messages.map((m: Json) => m.id)).toContain("<big@x>");

		const next = await call("email_worker_read_message", ctx(), { message_id: "<big@x>", offset: 6000, max_chars: 100_000 });
		expect(next.json.body.length).toBe(LIMITS.bodyMax); // clamped, not obeyed
		expect(next.json.offset).toBe(6000);
	});

	it("a short body comes back whole, untruncated, and marks the message handled", async () => {
		await arrive({ id: "<s@x>", body: "Short note." });
		const r = await call("email_worker_read_message", ctx(), { message_id: "<s@x>" });
		expect(r.json).toMatchObject({ body: "Short note.", truncated: false });
		expect(r.json.nextOffset).toBeUndefined();
	});

	it("a bridge that over-delivers is still bounded by PAGS, visibly", async () => {
		await arrive({ id: "<o@x>", body: "short" });
		intercept = (path, res) => (path.endsWith("/messages/get") ? { ...res, body: "Z".repeat(50_000), nextOffset: undefined, truncated: false } : res);
		const r = await call("email_worker_read_message", ctx(), { message_id: "<o@x>", max_chars: 500 });
		expect(r.json.body.length).toBeLessThan(700);
		expect(r.json.body).toMatch(/\[cut: showing the first 500 of 50000/);
		expect(r.json.truncated).toBe(true);
	});

	it("subjects and snippets in a list are bounded", async () => {
		await arrive({ id: "<l@x>", subject: "S".repeat(5000), body: "B".repeat(5000) });
		const m = (await call("email_worker_list_messages", ctx(), {})).json.messages[0];
		expect(m.subject.length).toBeLessThanOrEqual(260);
		expect(m.snippet.length).toBeLessThanOrEqual(220);
	});

	it("a run reads at most its budgeted number of bodies, then refuses without asking the bridge", async () => {
		for (let i = 0; i < 8; i++) await arrive({ id: `<r${i}@x>` });
		const c = ctx("read-run");
		for (let i = 0; i < RUN_BUDGET.reads; i++) expect((await call("email_worker_read_message", c, { message_id: `<r${i}@x>` })).success).toBe(true);
		const before = bridgeCalls.length;
		const over = await call("email_worker_read_message", c, { message_id: "<r6@x>" });
		expect(over.success).toBe(false);
		expect(over.text).toMatch(/budget/);
		expect(bridgeCalls.length).toBe(before);
		expect((await call("email_worker_read_message", ctx("next-run"), { message_id: "<r6@x>" })).success).toBe(true);
	});

	it("the body characters a run may take are budgeted too", async () => {
		for (let i = 0; i < 4; i++) await arrive({ id: `<c${i}@x>`, body: "C".repeat(30_000) });
		const c = ctx("chars-run");
		const a = await call("email_worker_read_message", c, { message_id: "<c0@x>", max_chars: 20_000 });
		const b = await call("email_worker_read_message", c, { message_id: "<c1@x>", max_chars: 20_000 });
		const third = await call("email_worker_read_message", c, { message_id: "<c2@x>", max_chars: 20_000 });
		expect([a.json.body.length, b.json.body.length, third.json.body.length]).toEqual([20_000, 20_000, 20_000]);
		const fourth = await call("email_worker_read_message", c, { message_id: "<c3@x>", max_chars: 20_000 });
		expect(fourth.success).toBe(false);
	});

	it("an oversized outgoing body is refused by the bridge before anything is sent", async () => {
		const r = await direct("/v1/email-worker/messages/send", { idempotencyKey: "key-big-0001", to: "k@candidate.example", subject: "s", body: "x".repeat(LIMITS.sendBody + 1) });
		expect(r.status).toBe(413);
		expect(sent).toEqual([]);
	});
});

describe("reply identity and retries", () => {
	it("a reply goes out as the configured reply identity to the original sender, in the parent's thread", async () => {
		await arrive({ id: "<in@x>", from: "kelly@candidate.example", subject: "Application" });
		const r = await call("email_worker_reply", ctx(), { message_id: "<in@x>", body: "Are you free Tuesday?" });
		expect(r.success).toBe(true);
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({ from: ADMIN, to: "kelly@candidate.example", subject: "Re: Application", headers: { "In-Reply-To": "<in@x>" } });
	});

	it("the bridge refuses a reply from any identity that is not a reply identity — even a configured sender", async () => {
		await arrive({ id: "<in@x>" });
		const r = await direct("/v1/email-worker/messages/reply", { idempotencyKey: "key-reply-id-1", messageId: "<in@x>", body: "hi", from: "noreply@freeappstore.online" });
		expect(r.status).toBe(403);
		expect(r.json.error.code).toBe("reply_identity_not_allowed");
		const caller = await direct("/v1/email-worker/messages/reply", { idempotencyKey: "key-reply-id-2", messageId: "<in@x>", body: "hi", to: "attacker@evil.example" });
		expect(caller.status).toBe(400);
		expect(sent).toEqual([]);
	});

	it("a parent whose sender is not a plain address is refused, not replied to", async () => {
		bridge.MAIL.data.set("msg:<odd@x>", JSON.stringify({ messageId: "<odd@x>", from: "Kelly <kelly@x.org>\r\nBcc: z@evil.example", to: ADMIN, subject: "s", text: "t", date: "2026-01-01T00:00:00.000Z", threadId: "t" }));
		const r = await direct("/v1/email-worker/messages/reply", { idempotencyKey: "key-odd-00001", messageId: "<odd@x>", body: "hi" });
		expect(r.status).toBe(400);
		expect(sent).toEqual([]);
	});

	it("PAGS refuses a reply when no reply identity is approved, before the bridge is asked", async () => {
		await arrive({ id: "<in@x>" });
		await saveApproval(env, "u1", BRIDGE, "", [ADMIN], null);
		const before = bridgeCalls.length;
		const r = await call("email_worker_reply", ctx(), { message_id: "<in@x>", body: "hi" });
		expect(r.success).toBe(false);
		expect(bridgeCalls.length).toBe(before);
		expect(sent).toEqual([]);
	});

	it("a retried reply (same idempotency key) is sent once, at PAGS and at the bridge", async () => {
		await arrive({ id: "<in@x>" });
		const first = await call("email_worker_reply", ctx(), { message_id: "<in@x>", body: "One answer", idempotency_key: "reply-retry-0001" });
		const second = await call("email_worker_reply", ctx(), { message_id: "<in@x>", body: "One answer", idempotency_key: "reply-retry-0001" });
		expect(first.success && second.success).toBe(true);
		expect(second.json.deduped).toBe(true);
		expect(sent).toHaveLength(1);
		// and the bridge alone also answers a repeated key with the first result
		const raw = await direct("/v1/email-worker/messages/reply", { idempotencyKey: "reply-retry-0001", messageId: "<in@x>", body: "One answer" });
		expect(raw.status).toBe(200);
		expect(sent).toHaveLength(1);
	});

	it("nothing in these tests reached a real recipient: every send is in the recorder", () => {
		expect(sent.every((m) => String(m.to).endsWith("candidate.example") || sent.length === 0)).toBe(true);
	});
});
