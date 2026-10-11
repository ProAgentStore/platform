import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { HttpError } from "../lib/auth.js";
import {
	AUDIT_MIGRATION_KEY,
	auditGlobalKey,
	auditIndexKey,
	auditKeyMetadata,
	BACKFILL_BATCH,
	readAuditCoverage,
	runAuditLedgerBackfill,
} from "../lib/mcp-audit-ledger.js";
import { signSession } from "../lib/session.js";
import { adminMcpAuditRoutes } from "./admin-mcp-audit.js";
import { mcpAuditRoutes, readMcpAuditEvents } from "./mcp-audit.js";

/**
 * The MCP audit ledger as the API Worker reads and migrates it (#704, #1016).
 *
 * What #704 asserted is still asserted — a caller reads only their OWN subject, and exempting
 * `session_id` from the key-name redactor did not open a hole. What #1016 adds is the regime the
 * old reader could not survive: more than 1000 lexicographically ordered legacy keys, with the
 * newest events past the thousandth.
 */

const SECRET = "mcp-audit-test-secret";
const NOW = Date.parse("2026-10-11T12:00:00.000Z");

/**
 * KV as it behaves, which is what the old stubs did not model: keys LEXICOGRAPHIC; `list` caps at
 * 1000 and continues with a cursor; listing metadata and absolute expirations come back with each
 * key; an expired key neither lists nor reads; an expiration under 60s away is refused. The cursor
 * is modelled as "after this key name" — so a key written behind it on a later call is not seen
 * and one deleted ahead of it is simply absent, which is the property paging relies on.
 */
function fakeKv() {
	const data = new Map<string, { value: string; expiration?: number; metadata?: unknown }>();
	const clock = { now: NOW };
	const ops = { get: 0, put: 0, list: 0 };
	let failGet: ((name: string) => boolean) | null = null;
	const live = (e: { expiration?: number }) => e.expiration === undefined || e.expiration * 1000 > clock.now;
	const kv = {
		get: async (name: string) => {
			ops.get++;
			if (failGet?.(name)) throw new Error(`KV GET failed: ${name}`);
			const e = data.get(name);
			return e && live(e) ? e.value : null;
		},
		put: async (name: string, value: string, opts: { expiration?: number; expirationTtl?: number; metadata?: unknown } = {}) => {
			ops.put++;
			const nowS = Math.floor(clock.now / 1000);
			const expiration = opts.expiration ?? (opts.expirationTtl ? nowS + opts.expirationTtl : undefined);
			if (expiration !== undefined && expiration < nowS + 60) throw new Error("KV PUT: expiration must be at least 60s ahead");
			data.set(name, { value, expiration, metadata: opts.metadata });
		},
		delete: async (name: string) => {
			data.delete(name);
		},
		list: async ({ prefix = "", limit = 1000, cursor }: { prefix?: string; limit?: number; cursor?: string } = {}) => {
			ops.list++;
			if (limit > 1000) throw new Error("KV LIST: limit is at most 1000");
			const after = cursor ? atob(cursor) : null;
			const names = Array.from(data.keys())
				.filter((n) => n.startsWith(prefix) && live(data.get(n) ?? {}) && (after === null || n > after))
				.sort();
			const page = names.slice(0, limit);
			const complete = names.length <= limit;
			return {
				keys: page.map((name) => ({ name, expiration: data.get(name)?.expiration, metadata: data.get(name)?.metadata })),
				list_complete: complete,
				cursor: complete ? undefined : btoa(page[page.length - 1] ?? ""),
				cacheStatus: null,
			};
		},
	} as unknown as KVNamespace;
	return { kv, data, clock, ops, failGets: (fn: ((name: string) => boolean) | null) => (failGet = fn) };
}

type Fake = ReturnType<typeof fakeKv>;

/** What the MCP Worker's `writeAudit` stores, keyed the ledger way. */
function writeLedger(f: Fake, subject: string, ms: number, id: string, over: Record<string, unknown> = {}) {
	const event = { tool: "coding_session_message", action: "completed", ...over, id, time: new Date(ms).toISOString(), subject };
	const opts = { expiration: Math.floor(ms / 1000) + 90 * 86_400, metadata: auditKeyMetadata(event) };
	const value = JSON.stringify(event);
	f.data.set(auditIndexKey(subject, ms, id), { value, ...opts });
	f.data.set(auditGlobalKey(subject, ms, id), { value, ...opts });
}

/** What the pre-#1016 writer stored. */
function writeLegacy(f: Fake, subject: string, ms: number, id: string, over: Record<string, unknown> = {}, expiration?: number) {
	const time = new Date(ms).toISOString();
	f.data.set(`audit:${subject}:${time}:${id}`, {
		value: JSON.stringify({ time, subject, tool: "coding_session_message", action: "completed", ...over }),
		expiration: expiration ?? Math.floor(ms / 1000) + 90 * 86_400,
	});
}

async function backfillToCompletion(f: Fake) {
	for (let tick = 0; tick < 1000; tick++) {
		const state = await runAuditLedgerBackfill(f.kv, { now: f.clock.now });
		if (state.status === "complete") return { state, ticks: tick + 1 };
	}
	throw new Error("backfill did not complete");
}

function testApp(kv?: KVNamespace) {
	const app = new Hono();
	app.route("/v1", mcpAuditRoutes);
	app.route("/v1/admin", adminMcpAuditRoutes);
	app.onError((err, c) => {
		if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
		throw err;
	});
	const env = {
		SESSION_SIGNING_KEY: SECRET,
		OAUTH_KV: kv,
		DB: {
			prepare(sql: string) {
				return {
					bind: () => ({
						first: async () => {
							if (sql.includes("SELECT suspended FROM users")) return { suspended: 0 };
							if (sql.includes("roles")) return { roles: '["user","admin"]', github_login: null };
							return null;
						},
						run: async () => ({}),
						all: async () => ({ results: [] }),
					}),
				};
			},
		},
	};
	return { app, env };
}

const tokenFor = (uid: string) => signSession(uid, SECRET, { roles: ["user", "admin"] });

interface PageBody {
	count: number;
	events: Array<Record<string, never>>;
	nextCursor: string | null;
	coverage: { complete: boolean; legacyIndex: string; detail: string };
	semantics: string;
}

async function getPage(app: Hono, env: unknown, path: string, uid = "mine") {
	const res = await app.request(path, { headers: { Authorization: `Bearer ${await tokenFor(uid)}` } }, env);
	return { status: res.status, body: (await res.json()) as PageBody };
}

/** Follow `nextCursor` to the end; every event id in order. */
async function readAll(app: Hono, env: unknown, base: string, uid = "mine") {
	const ids: string[] = [];
	const pages: PageBody[] = [];
	let cursor: string | null = null;
	do {
		const sep = base.includes("?") ? "&" : "?";
		const { status, body } = await getPage(app, env, cursor ? `${base}${sep}cursor=${encodeURIComponent(cursor)}` : base, uid);
		expect(status).toBe(200);
		pages.push(body);
		ids.push(...body.events.map((e) => e.id as string));
		cursor = body.nextCursor;
	} while (cursor);
	return { ids, pages };
}

describe("the ledger key layout — the same strings `workers/mcp/src/audit-ledger.test.ts` asserts", () => {
	it("inverts the time so lexicographic order is newest first", () => {
		const ms = Date.parse("2026-10-11T00:00:00.000Z");
		expect(auditIndexKey("u1", ms, "e1")).toBe("audit_idx:u1:8208323199999:e1");
		expect(auditGlobalKey("u1", ms, "e1")).toBe("audit_all:8208323199999:u1:e1");
		expect(auditIndexKey("u1", ms + 1, "e1") < auditIndexKey("u1", ms, "e1")).toBe(true);
	});
});

describe("GET /v1/mcp-audit", () => {
	it("401s an anonymous caller", async () => {
		const { app, env } = testApp(fakeKv().kv);
		expect((await app.request("/v1/mcp-audit", {}, env)).status).toBe(401);
	});

	it("501s with a reason rather than an empty list when the KV is unbound", async () => {
		const { app, env } = testApp(undefined);
		expect((await getPage(app, env, "/v1/mcp-audit")).status).toBe(501);
	});

	it("returns the actual latest events past 1000 legacy keys — before and after the backfill — and pages every retained event once", async () => {
		const f = fakeKv();
		// 1200 legacy events across September (the window the old reader kept returning), then
		// 30 events written by the ledger writer on October 11.
		const legacyStart = Date.parse("2026-09-09T03:00:00.000Z");
		for (let i = 0; i < 1200; i++) writeLegacy(f, "mine", legacyStart + i * 60_000, `legacy-${String(i).padStart(4, "0")}`);
		for (let i = 0; i < 30; i++) writeLedger(f, "mine", Date.parse("2026-10-11T09:00:00.000Z") + i * 1000, `new-${String(i).padStart(2, "0")}`);
		const { app, env } = testApp(f.kv);

		// Before any backfill: the newest page is October, and it says older history is incomplete.
		const first = await getPage(app, env, "/v1/mcp-audit?limit=5");
		expect(first.body.events.map((e) => e.id)).toEqual(["new-29", "new-28", "new-27", "new-26", "new-25"]);
		expect(first.body.coverage).toMatchObject({ complete: false, legacyIndex: "not_started" });

		const { ticks } = await backfillToCompletion(f);
		// Two passes of ceil(1200 / batch) ticks — bounded, and no tick lists past its batch.
		expect(ticks).toBe(2 * Math.ceil(1200 / BACKFILL_BATCH));

		const { ids, pages } = await readAll(app, env, "/v1/mcp-audit?limit=200");
		expect(ids).toHaveLength(1230);
		expect(new Set(ids).size).toBe(1230);
		expect(ids[0]).toBe("new-29");
		expect(ids[29]).toBe("new-00");
		expect(ids[30]).toBe("legacy-1199");
		expect(ids[1229]).toBe("legacy-0000");
		expect(pages.every((p) => p.coverage.complete)).toBe(true);
		expect(pages[pages.length - 1]?.nextCursor).toBeNull();
		// Not purged as a shortcut: every legacy key is still there, expiring on its own TTL.
		expect(Array.from(f.data.keys()).filter((k) => k.startsWith("audit:"))).toHaveLength(1200);
	});

	it("orders tied timestamps by event id and splits them across pages without repeats", async () => {
		const f = fakeKv();
		const ms = Date.parse("2026-10-11T10:00:00.000Z");
		for (const id of ["e", "c", "a", "d", "b"]) writeLedger(f, "mine", ms, id);
		writeLedger(f, "mine", ms + 1, "newest");
		const { app, env } = testApp(f.kv);

		const { ids, pages } = await readAll(app, env, "/v1/mcp-audit?limit=2");
		expect(ids).toEqual(["newest", "a", "b", "c", "d", "e"]);
		expect(pages).toHaveLength(3);
	});

	it("neither repeats nor skips when events are written or deleted at a page boundary", async () => {
		const f = fakeKv();
		const base = Date.parse("2026-10-11T10:00:00.000Z");
		for (let i = 0; i < 10; i++) writeLedger(f, "mine", base + i * 1000, `e${i}`);
		const { app, env } = testApp(f.kv);

		const p1 = await getPage(app, env, "/v1/mcp-audit?limit=4");
		expect(p1.body.events.map((e) => e.id)).toEqual(["e9", "e8", "e7", "e6"]);
		// Between pages: a newer event lands, and one on the NEXT page is deleted.
		writeLedger(f, "mine", base + 60_000, "late");
		f.data.delete(auditIndexKey("mine", base + 4000, "e4"));

		const cursor = encodeURIComponent(p1.body.nextCursor ?? "");
		const p2 = await getPage(app, env, `/v1/mcp-audit?limit=4&cursor=${cursor}`);
		expect(p2.body.events.map((e) => e.id)).toEqual(["e5", "e3", "e2", "e1"]);
		const p3 = await getPage(app, env, `/v1/mcp-audit?limit=4&cursor=${encodeURIComponent(p2.body.nextCursor ?? "")}`);
		expect(p3.body.events.map((e) => e.id)).toEqual(["e0"]);
		expect(p3.body.nextCursor).toBeNull();
		// The late event is on a fresh first page.
		expect((await getPage(app, env, "/v1/mcp-audit?limit=1")).body.events[0]?.id).toBe("late");
	});

	it("drops an event once it expires", async () => {
		const f = fakeKv();
		writeLedger(f, "mine", Date.parse("2026-07-14T00:00:00.000Z"), "old");
		writeLedger(f, "mine", Date.parse("2026-10-11T00:00:00.000Z"), "recent");
		const { app, env } = testApp(f.kv);
		expect((await getPage(app, env, "/v1/mcp-audit")).body.events.map((e) => e.id)).toEqual(["recent", "old"]);

		f.clock.now = Date.parse("2026-10-13T00:00:00.000Z"); // 90 days after July 14 has passed
		expect((await getPage(app, env, "/v1/mcp-audit")).body.events.map((e) => e.id)).toEqual(["recent"]);
	});

	it("answers an empty ledger with no events and no cursor", async () => {
		const { app, env } = testApp(fakeKv().kv);
		const { body } = await getPage(app, env, "/v1/mcp-audit");
		expect(body).toMatchObject({ count: 0, events: [], nextCursor: null });
	});

	it("filters by tool with a cursor that continues through empty pages", async () => {
		const f = fakeKv();
		const base = Date.parse("2026-10-11T10:00:00.000Z");
		writeLedger(f, "mine", base, "match-old", { tool: "delete_agent" });
		for (let i = 1; i <= 6; i++) writeLedger(f, "mine", base + i * 1000, `other-${i}`, { tool: "list_agents" });
		writeLedger(f, "mine", base + 10_000, "match-new", { tool: "delete_agent" });
		const { app, env } = testApp(f.kv);

		const { ids, pages } = await readAll(app, env, "/v1/mcp-audit?limit=3&tool=delete_agent");
		expect(ids).toEqual(["match-new", "match-old"]);
		// The middle page held only other tools: empty, yet it still continued.
		expect(pages.some((p) => p.events.length === 0 && p.nextCursor !== null)).toBe(true);
		// Reads only the matches: listing metadata decides, not a get per key.
		expect(f.ops.get).toBeLessThan(2 + pages.length * 2);
	});

	it("answers 503 — never a short page — when a read fails mid-page", async () => {
		const f = fakeKv();
		for (let i = 0; i < 5; i++) writeLedger(f, "mine", NOW - i * 1000, `e${i}`);
		f.failGets((name) => name.endsWith(":e2"));
		const { app, env } = testApp(f.kv);

		const res = await getPage(app, env, "/v1/mcp-audit");
		expect(res.status).toBe(503);
		expect(res.body.events).toBeNull();
	});

	it("answers 503 when the coverage record cannot be read, rather than claiming coverage", async () => {
		const f = fakeKv();
		writeLedger(f, "mine", NOW, "e0");
		f.failGets((name) => name === AUDIT_MIGRATION_KEY);
		const { app, env } = testApp(f.kv);
		expect((await getPage(app, env, "/v1/mcp-audit")).status).toBe(503);
	});

	it("400s an oversized cursor or tool instead of passing it to storage", async () => {
		const { app, env } = testApp(fakeKv().kv);
		expect((await getPage(app, env, `/v1/mcp-audit?cursor=${"x".repeat(2049)}`)).status).toBe(400);
		expect((await getPage(app, env, `/v1/mcp-audit?tool=${"x".repeat(101)}`)).status).toBe(400);
		expect((await getPage(app, env, `/v1/mcp-audit?receipt=${"x".repeat(201)}`)).status).toBe(400);
	});

	it("correlates by receipt — the event id or a whole id in input/result — across pages, and never by substring", async () => {
		const f = fakeKv();
		writeLedger(f, "mine", NOW - 5000, "q1", { tool: "coding_loop_start", action: "queued", result: { queueEntryId: "run_1" } });
		for (let i = 0; i < 4; i++) writeLedger(f, "mine", NOW - 4000 + i * 1000, `noise${i}`, { input: { instance_id: "inst-2" } });
		writeLedger(f, "mine", NOW, "s1", { tool: "coding_loop_stop", input: { run_id: "run_10", session_id: "csess_abc" } });
		writeLedger(f, "theirs", NOW + 1000, "t1", { result: { queueEntryId: "run_1" } });
		const { app, env } = testApp(f.kv);
		const byReceipt = async (receipt: string) => (await readAll(app, env, `/v1/mcp-audit?limit=2&receipt=${receipt}`)).ids;
		expect(await byReceipt("run_1")).toEqual(["q1"]); // reached through a page of non-matches; not the other owner's
		expect(await byReceipt("run_10")).toEqual(["s1"]);
		expect(await byReceipt("csess_abc")).toEqual(["s1"]); // the session join key survives read-time redaction
		expect(await byReceipt("q1")).toEqual(["q1"]);
		expect(await byReceipt("run_")).toEqual([]);
		const { body } = await getPage(app, env, "/v1/admin/mcp-audit?receipt=run_1", "admin-1");
		expect(body.events.map((e) => e.id)).toEqual(["t1", "q1"]);
	});

	it("says what an event is a receipt of", async () => {
		const { app, env } = testApp(fakeKv().kv);
		expect((await getPage(app, env, "/v1/mcp-audit")).body.semantics).toMatch(/not that the engine turn/);
	});
});

describe("tenant isolation", () => {
	it("returns only the caller's own subject — `?user=` is ignored", async () => {
		const f = fakeKv();
		writeLedger(f, "mine", NOW - 1000, "m1", { tool: "list_agents" });
		writeLedger(f, "theirs", NOW, "t1", { tool: "delete_agent" });
		const { app, env } = testApp(f.kv);

		const { body } = await getPage(app, env, "/v1/mcp-audit?user=theirs");
		expect(body.events.map((e) => e.subject)).toEqual(["mine"]);
	});

	it("keeps a cursor taken from another owner's listing inside the caller's own prefix", async () => {
		const f = fakeKv();
		for (let i = 0; i < 5; i++) writeLedger(f, "aaa", NOW - i * 1000, `a${i}`);
		for (let i = 0; i < 5; i++) writeLedger(f, "zzz", NOW - i * 1000, `z${i}`);
		const { app, env } = testApp(f.kv);

		const theirs = await getPage(app, env, "/v1/mcp-audit?limit=2", "aaa");
		const forged = encodeURIComponent(theirs.body.nextCursor ?? "");
		const { status, body } = await getPage(app, env, `/v1/mcp-audit?limit=10&cursor=${forged}`, "zzz");
		expect(status).toBe(200);
		expect(body.events.length).toBeGreaterThan(0);
		expect(body.events.every((e) => e.subject === "zzz")).toBe(true);
	});
});

describe("read-time redaction of MCP audit events", () => {
	// The exemption is narrow on purpose and this is the test that proves the narrowness:
	// the point is not "session_id survives", it is that a real credential sitting in the
	// same object still does not.
	const withSecrets = {
		instance_id: "bd43f4de-1111-2222-3333-444455556666",
		session_id: "csess_6ce3627a-3c3f-439a-90f3-ff4a6de3167a",
		session_token: "not-a-shape-but-a-secret-name",
		note: "Authorization: Bearer sk-ant-abcdefghijklmnopqrstuvwxyz012345",
		pat: "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
		jwt: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.QWJjRGVmR2hp",
		messageBytes: 1818,
	};

	async function readOne(input: unknown) {
		const f = fakeKv();
		writeLedger(f, "mine", NOW, "e1", { input });
		const { events } = await readMcpAuditEvents(f.kv, { prefix: "audit_idx:mine:", limit: 10 });
		return events[0]?.input as Record<string, string | number>;
	}

	it("keeps session_id — the only join key to what was typed into the engine", async () => {
		const input = await readOne(withSecrets);
		expect(input.session_id).toBe("csess_6ce3627a-3c3f-439a-90f3-ff4a6de3167a");
		expect(input.instance_id).toBe("bd43f4de-1111-2222-3333-444455556666");
		expect(input.messageBytes).toBe(1818);
	});

	it("still redacts a genuine secret in the same object", async () => {
		const input = await readOne(withSecrets);
		// Key-name rule: `session_token` is NOT what was exempted.
		expect(input.session_token).toBe("[redacted]");
		expect(input.pat).toBe("[redacted]");
		expect(input.jwt).toBe("[redacted]");
		// Value-shape net, under an innocent key name: it masks the secret substring and
		// leaves the surrounding prose, so assert the credential is gone, not the whole field.
		expect(input.note).toBe("Authorization: [redacted]");
		expect(JSON.stringify(input)).not.toContain("sk-ant-");
		expect(JSON.stringify(input)).not.toContain("ghp_");
	});

	it("redacts a secret-SHAPED value even when it hides under the exempted key", async () => {
		// The exemption skips the key-NAME rule only. A caller that stuffed a token into a
		// field called `session_id` is still covered by the value-shape net.
		expect((await readOne({ session_id: "ghp_abcdefghijklmnopqrstuvwxyz0123456789" })).session_id).toBe("[redacted]");
	});

	it("redacts a secret a LEGACY event carried through the backfill too", async () => {
		const f = fakeKv();
		writeLegacy(f, "mine", NOW - 1000, "l1", { input: { pat: "ghp_abcdefghijklmnopqrstuvwxyz0123456789" } });
		await backfillToCompletion(f);
		const { events } = await readMcpAuditEvents(f.kv, { prefix: "audit_idx:mine:", limit: 10 });
		expect(JSON.stringify(events)).not.toContain("ghp_");
	});
});

describe("GET /v1/admin/mcp-audit", () => {
	it("orders a cross-subject sweep by time, not by subject name", async () => {
		const f = fakeKv();
		writeLedger(f, "aaa", Date.parse("2026-10-11T09:00:00.000Z"), "a");
		writeLedger(f, "zzz", Date.parse("2026-10-11T01:00:00.000Z"), "z");
		const { app, env } = testApp(f.kv);

		const { status, body } = await getPage(app, env, "/v1/admin/mcp-audit?limit=1", "admin-1");
		expect(status).toBe(200);
		expect(body.events.map((e) => e.subject)).toEqual(["aaa"]);
		expect(body.nextCursor).not.toBeNull();
	});

	it("narrows to one subject's index with ?user=", async () => {
		const f = fakeKv();
		writeLedger(f, "aaa", NOW, "a");
		writeLedger(f, "zzz", NOW - 1000, "z");
		const { app, env } = testApp(f.kv);
		const { body } = await getPage(app, env, "/v1/admin/mcp-audit?user=zzz", "admin-1");
		expect(body.events.map((e) => e.id)).toEqual(["z"]);
	});
});

describe("the legacy backfill", () => {
	it("is bounded per tick and resumable after a failed batch, without moving the cursor", async () => {
		const f = fakeKv();
		for (let i = 0; i < 250; i++) writeLegacy(f, "mine", NOW - 86_400_000 + i * 1000, `l${String(i).padStart(3, "0")}`);

		await runAuditLedgerBackfill(f.kv, { now: f.clock.now });
		const afterFirst = JSON.parse(f.data.get(AUDIT_MIGRATION_KEY)?.value ?? "{}");
		expect(afterFirst).toMatchObject({ status: "running", pass: 0, scanned: BACKFILL_BATCH, copied: BACKFILL_BATCH });

		f.failGets((name) => name.endsWith(":l150"));
		await expect(runAuditLedgerBackfill(f.kv, { now: f.clock.now })).rejects.toThrow(/KV GET failed/);
		expect(JSON.parse(f.data.get(AUDIT_MIGRATION_KEY)?.value ?? "{}").cursor).toBe(afterFirst.cursor);

		f.failGets(null);
		const { state } = await backfillToCompletion(f);
		expect(state).toMatchObject({ status: "complete", pass: 2 });
		expect(Array.from(f.data.keys()).filter((k) => k.startsWith("audit_idx:mine:"))).toHaveLength(250);
		expect(Array.from(f.data.keys()).filter((k) => k.startsWith("audit_all:"))).toHaveLength(250);
	});

	it("is idempotent: a rerun over already-indexed keys creates nothing new", async () => {
		const f = fakeKv();
		for (let i = 0; i < 30; i++) writeLegacy(f, "mine", NOW - i * 1000, `l${i}`);
		await backfillToCompletion(f);
		const before = new Map(f.data);

		f.data.delete(AUDIT_MIGRATION_KEY);
		await backfillToCompletion(f);
		const indexKeys = (m: Map<string, unknown>) => Array.from(m.keys()).filter((k) => k.startsWith("audit_"));
		expect(indexKeys(f.data).sort()).toEqual(indexKeys(before).sort());
	});

	it("keeps each legacy event's own expiry, and skips one that is about to lapse", async () => {
		const f = fakeKv();
		const nowS = Math.floor(NOW / 1000);
		writeLegacy(f, "mine", NOW - 5000, "keeps", {}, nowS + 3600);
		writeLegacy(f, "mine", NOW - 4000, "lapsing", {}, nowS + 30);
		const { state } = await backfillToCompletion(f);

		expect(f.data.get(auditIndexKey("mine", NOW - 5000, "keeps"))?.expiration).toBe(nowS + 3600);
		expect(f.data.has(auditIndexKey("mine", NOW - 4000, "lapsing"))).toBe(false);
		expect(state.expired).toBeGreaterThan(0);
	});

	it("counts an event it cannot place instead of inventing a time for it", async () => {
		const f = fakeKv();
		f.data.set("audit:mine:not-a-time:bad", { value: JSON.stringify({ tool: "x" }), expiration: Math.floor(NOW / 1000) + 3600 });
		f.data.set("audit:mine:2026-10-11T00:00:00.000Z:junk", { value: "{not json", expiration: Math.floor(NOW / 1000) + 3600 });
		const { state } = await backfillToCompletion(f);
		// Two DISTINCT records, however many passes listed them — never 4 after two passes.
		expect(state).toMatchObject({ status: "complete", pass: 2, unplaceable: 2 });
		expect(Array.from(f.data.keys()).some((k) => k.startsWith("audit_idx:"))).toBe(false);
		// The scan finished, but the history is NOT whole: two records were never indexed, and every
		// read says so rather than claiming every event is indexed.
		const coverage = await readAuditCoverage(f.kv);
		expect(coverage).toMatchObject({ complete: false, legacyIndex: "complete" });
		expect(coverage.detail).toMatch(/2 unplaceable legacy records could not be indexed/i);
		const { app, env } = testApp(f.kv);
		expect((await getPage(app, env, "/v1/mcp-audit")).body.coverage).toMatchObject({ complete: false, legacyIndex: "complete" });
	});

	it("collects, on its second pass, a legacy key an old writer added behind the first pass's cursor", async () => {
		const f = fakeKv();
		for (let i = 0; i < 5; i++) writeLegacy(f, "zzz", NOW - i * 1000, `z${i}`);
		// Finish pass one.
		let state = await runAuditLedgerBackfill(f.kv, { now: f.clock.now });
		expect(state.pass).toBe(1);
		// An MCP isolate still on the old writer records one more, for a subject the pass is past.
		writeLegacy(f, "aaa", NOW, "straggler");
		state = await runAuditLedgerBackfill(f.kv, { now: f.clock.now });
		expect(state.status).toBe("complete");
		expect(f.data.has(auditIndexKey("aaa", NOW, "straggler"))).toBe(true);
	});

	describe("resuming a record the writer before ac253dd9 left", () => {
		// That writer summed `unplaceable` over passes and never wrote `passUnplaceable`.
		const seedState = (f: Fake, state: Record<string, unknown>) =>
			f.data.set(AUDIT_MIGRATION_KEY, { value: JSON.stringify({ scanned: 0, copied: 0, expired: 0, startedAt: "x", updatedAt: "x", ...state }) });
		const readState = (f: Fake) => JSON.parse(f.data.get(AUDIT_MIGRATION_KEY)?.value ?? "{}");
		const exp = Math.floor(NOW / 1000) + 3600;
		/** Two unplaceable records that sort BEFORE `audit:mmm:…`, and one good record after it. */
		function seedKeys(f: Fake) {
			f.data.set("audit:aaa:not-a-time:bad1", { value: JSON.stringify({ tool: "x" }), expiration: exp });
			f.data.set("audit:bbb:2026-10-11T00:00:00.000Z:bad2", { value: "{not json", expiration: exp });
			writeLegacy(f, "zzz", NOW - 1000, "good");
		}
		const cursorAfterBad = btoa("audit:bbb:2026-10-11T00:00:00.000Z:bad2");

		it("mid-second-pass: recounts instead of dropping what it saw behind the cursor", async () => {
			const f = fakeKv();
			seedKeys(f);
			// Pass 0 saw both bad records (2), pass 1 saw them again (4); only the good one is left.
			seedState(f, { status: "running", pass: 1, cursor: cursorAfterBad, unplaceable: 4 });
			expect(await readAuditCoverage(f.kv)).toMatchObject({ complete: false, legacyIndex: "in_progress" });

			// Resuming at the cursor would end this pass with 0 and call the history whole.
			const first = await runAuditLedgerBackfill(f.kv, { now: f.clock.now, batch: 1 });
			expect(first).toMatchObject({ status: "running", pass: 1, passUnplaceable: 1 });
			expect(await readAuditCoverage(f.kv)).toMatchObject({ complete: false, legacyIndex: "in_progress" });

			const { state } = await backfillToCompletion(f);
			expect(state).toMatchObject({ status: "complete", pass: 2, unplaceable: 2, passUnplaceable: 0 });
			const coverage = await readAuditCoverage(f.kv);
			expect(coverage).toMatchObject({ complete: false, legacyIndex: "complete" });
			expect(coverage.detail).toMatch(/2 unplaceable legacy records could not be indexed/i);
			expect(f.data.has(auditIndexKey("zzz", NOW - 1000, "good"))).toBe(true);
		});

		it("mid-first-pass: ends with the distinct count", async () => {
			const f = fakeKv();
			seedKeys(f);
			seedState(f, { status: "running", pass: 0, cursor: cursorAfterBad, unplaceable: 2 });
			const { state } = await backfillToCompletion(f);
			expect(state).toMatchObject({ status: "complete", pass: 2, unplaceable: 2 });
		});

		it("finished with a doubled count: reopens one pass and replaces it with the distinct count", async () => {
			const f = fakeKv();
			seedKeys(f);
			seedState(f, { status: "complete", pass: 2, unplaceable: 4, completedAt: "x" });
			const before = await readAuditCoverage(f.kv);
			expect(before).toMatchObject({ complete: false, legacyIndex: "in_progress" });
			expect(before.detail).not.toMatch(/4 unplaceable/);

			const state = await runAuditLedgerBackfill(f.kv, { now: f.clock.now });
			expect(state).toMatchObject({ status: "complete", pass: 2, unplaceable: 2, passUnplaceable: 0 });
			expect((await readAuditCoverage(f.kv)).detail).toMatch(/2 unplaceable legacy records/i);
		});

		it("a failed recount tick leaves the old record as it was, still partial, and the next tick redoes it", async () => {
			const f = fakeKv();
			seedKeys(f);
			seedState(f, { status: "complete", pass: 2, unplaceable: 4 });
			const stored = f.data.get(AUDIT_MIGRATION_KEY)?.value;
			f.failGets((name) => name.endsWith(":good"));
			await expect(runAuditLedgerBackfill(f.kv, { now: f.clock.now })).rejects.toThrow(/KV GET failed/);
			expect(f.data.get(AUDIT_MIGRATION_KEY)?.value).toBe(stored);
			expect(await readAuditCoverage(f.kv)).toMatchObject({ complete: false, legacyIndex: "in_progress" });

			f.failGets(null);
			const { state } = await backfillToCompletion(f);
			expect(state).toMatchObject({ status: "complete", unplaceable: 2 });
		});

		it("recounts once: the recounted record is finished, and further ticks only read it", async () => {
			const f = fakeKv();
			seedKeys(f);
			seedState(f, { status: "complete", pass: 2, unplaceable: 4 });
			await runAuditLedgerBackfill(f.kv, { now: f.clock.now });
			const stored = readState(f);
			const before = { ...f.ops };
			expect(await runAuditLedgerBackfill(f.kv, { now: f.clock.now })).toEqual(stored);
			expect(f.ops).toEqual({ ...before, get: before.get + 1 });
		});

		it("takes an old finished record with nothing unplaceable as it stands", async () => {
			const f = fakeKv();
			seedKeys(f);
			seedState(f, { status: "complete", pass: 2, unplaceable: 0 });
			const before = { ...f.ops };
			expect(await runAuditLedgerBackfill(f.kv, { now: f.clock.now })).toMatchObject({ status: "complete", unplaceable: 0 });
			expect(f.ops).toEqual({ ...before, get: before.get + 1 });
		});
	});

	it("costs one read per tick once it has finished", async () => {
		const f = fakeKv();
		await backfillToCompletion(f);
		const before = { ...f.ops };
		await runAuditLedgerBackfill(f.kv, { now: f.clock.now });
		expect(f.ops).toEqual({ ...before, get: before.get + 1 });
	});
});
