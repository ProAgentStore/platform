/**
 * Reprocessing historical Gmail Scout mail (#1052), on the real migrated schema, through the scan's own
 * intake. Only the mailbox and provider fetches are faked, and the Scout's DO is a small in-memory stand-in
 * for its permission state and `job_leads` store. No real mailbox is read and nothing is handed downstream.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "../../d1-sqlite.js";
import { HttpError } from "../../auth.js";
import { signSession } from "../../session.js";
import { GMAIL_SCOUT_PINNED_EMAIL } from "../config.js";
import { listGmailScoutReceipts } from "../receipts.js";
import { type GmailScoutMailbox, type GmailScoutMailboxFactory, gmailScoutReprocessQuery, parseReprocessInput, REPROCESS_MAX_MESSAGES, reprocessGmailScout, scanGmailScout, setGmailScoutMailboxForTest } from "../scan.js";
import type { GmailMessage } from "../../gmail.js";
import type { Env } from "../../../types.js";
import type { GmailScoutScanResult } from "../../../agent-types.js";

const SECRET = "gmail-scout-reprocess-secret";
const DAY = 86_400_000;
let d1: RealSchemaD1;
let env: Env;
let leads: Array<{ id: string; data: Record<string, unknown> }>;
let email: boolean;

const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toUTCString();
const msg = (id: string, subject: string, text: string, date = daysAgo(10), from = "Acme Careers <careers@acme.example>"): GmailMessage =>
	({ id, threadId: `t-${id}`, from, to: GMAIL_SCOUT_PINNED_EMAIL, cc: "", subject, date, messageId: "", references: "", snippet: "", text, attachments: [] }) as unknown as GmailMessage;

const JOB = msg("m-job", "Platform Engineer at Acme", "Company: Acme Pty Ltd\nhttps://jobs.example.com/job/42?utm_source=alert");
const LI_ID = "4012345678";
const LINKEDIN = msg("m-li", "Platform Engineer at Acme", `<a href="https://www.linkedin.com/comm/jobs/view/${LI_ID}/?trackingId=SECRET&amp;refId=SECRET">Platform Engineer</a>`, daysAgo(12), "LinkedIn Job Alerts <jobalerts-noreply@linkedin.com>");
const DIGEST = msg("m-digest", "20 new jobs for Platform Engineer", "https://jobs.example.com/job/1");
const MULTI = msg("m-multi", "Two roles at Acme", "https://jobs.example.com/job/3 and https://jobs.example.com/job/4");
const SEARCH = msg("m-search", "Engineer roles at Acme", "https://jobs.example.com/jobs/search?q=engineer");
const ANCIENT = msg("m-ancient", "Data Engineer at Acme", "https://jobs.example.com/job/77", daysAgo(45));

function fakeMailbox(messages: GmailMessage[]) {
	const calls = { factory: 0, queries: [] as string[], read: [] as string[] };
	const factory: GmailScoutMailboxFactory = async () => {
		calls.factory++;
		const box: GmailScoutMailbox = {
			list: async (query) => {
				calls.queries.push(query);
				return messages.map((m) => ({ id: m.id }));
			},
			read: async (id) => {
				calls.read.push(id);
				const found = messages.find((m) => m.id === id);
				if (!found) throw new Error(`Gmail API 404: ${id}`);
				return found;
			},
		};
		return box;
	};
	return { factory, calls };
}

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["scout", "tailor"] });
	d1.exec(`UPDATE agent_instances SET config = '{"source_mode":"gmail"}' WHERE id = 'scout'`);
	d1.exec(`INSERT INTO user_api_keys (user_id, provider, account_id, key_ciphertext, dek_wrapped, iv, account_label) VALUES ('u1', 'gmail', '${GMAIL_SCOUT_PINNED_EMAIL}', X'00', X'00', X'00', '${GMAIL_SCOUT_PINNED_EMAIL}')`);
	d1.exec(`INSERT INTO gmail_scout_configs (id, instance_id, pinned_email, enabled) VALUES ('cfg', 'scout', '${GMAIL_SCOUT_PINNED_EMAIL}', 1)`);
	d1.exec(`INSERT INTO gmail_scout_scan_state (instance_id, last_scan_at, last_message_id_cursor, candidate_count, dedupe_count, failure_count) VALUES ('scout', '2026-10-01 00:00:00', '{"after":"2026-10-01T00:00:00.000Z","messageId":"m-cursor"}', 3, 1, 0)`);
	leads = [];
	email = true;
	const agent = {
		idFromName: (n: string) => n,
		get: () => ({
			fetch: async (req: Request) => {
				const url = new URL(req.url);
				if (url.pathname === "/state") return Response.json({ permissions: { email } });
				if (url.pathname === "/collections/job_leads") return leads.length ? Response.json({ name: "job_leads" }) : new Response("{}", { status: 404 });
				if (url.pathname === "/collections/job_leads/records" && req.method === "GET") return Response.json({ records: leads });
				if (url.pathname === "/collections/job_leads/records" && req.method === "POST") {
					const { data } = (await req.json()) as { data: Record<string, unknown> };
					const id = `lead-${leads.length}`;
					leads.push({ id, data });
					return Response.json({ id, created: true });
				}
				return Response.json({});
			},
		}),
	};
	env = { DB: d1.DB, AGENT: agent, SESSION_SIGNING_KEY: SECRET } as unknown as Env;
	// LinkedIn refuses an unauthenticated server fetch (999): the posting must be checked in a browser.
	vi.stubGlobal("fetch", async () => new Response("", { status: 999 }));
});
afterEach(() => {
	vi.unstubAllGlobals();
	setGmailScoutMailboxForTest(null);
	d1.close();
});

const scanState = () => d1.sqlite.prepare("SELECT last_scan_at AS at, last_message_id_cursor AS cursor, candidate_count AS candidates, failure_count AS failures FROM gmail_scout_scan_state WHERE instance_id = 'scout'").get();
const verifications = () => d1.sqlite.prepare("SELECT lead_id AS leadId, work_key AS workKey, canonical_url AS url, state FROM job_lead_browser_verifications WHERE instance_id = 'scout'").all();
const deliveries = () => (d1.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_connection_deliveries").get() as { n: number }).n;
const application = (workKey: string, extra: string) =>
	d1.exec(`INSERT INTO job_applications (id, instance_id, user_id, source_instance_id, lead_id, lifecycle_version, idempotency_key, lead, work_key, created_at, updated_at, ${extra.split("=")[0]})
		VALUES ('app-1', 'tailor', 'u1', 'scout', 'gone-lead', 1, 'idem-1', '{}', '${workKey}', datetime('now'), datetime('now'), ${extra.split("=")[1]})`);

describe("reprocessing owner-selected historical messages", () => {
	it("materializes a past-cursor posting with its ORIGINAL Gmail provenance, and never moves the scan cursor", async () => {
		const before = scanState();
		// The ordinary scan would refuse this 10-day-old alert: only a reprocess widens the age bound.
		await scanGmailScout(env, "scout", "u1", { trigger: "on_demand", mailbox: fakeMailbox([JOB]).factory });
		expect(leads).toHaveLength(0);
		d1.exec(`UPDATE gmail_scout_scan_state SET last_scan_at = '2026-10-01 00:00:00', last_message_id_cursor = '{"after":"2026-10-01T00:00:00.000Z","messageId":"m-cursor"}', candidate_count = 3, dedupe_count = 1 WHERE instance_id = 'scout'`);

		const box = fakeMailbox([JOB]);
		const result = await reprocessGmailScout(env, "scout", "u1", { messageIds: ["m-job"] }, { mailbox: box.factory });
		expect(result).toMatchObject({ candidates: 1, added: 1, deduped: 0, rejected: {}, reused: false, handoff: "none" });
		expect(box.calls).toMatchObject({ queries: [], read: ["m-job"] }); // read exactly what was selected; no search
		expect(result.receipt).toMatchObject({ trigger: "reprocess", triggeredBy: "u1", status: "completed", hits: 1, added: 1, handoff: "none" });
		expect(leads[0].data).toMatchObject({
			url: "https://jobs.example.com/job/42",
			status: "unverified",
			verification: { state: "unverified", canonical_job_url: "https://jobs.example.com/job/42" },
			gmail_message_id: "m-job",
			gmail_date: JOB.date,
			gmail_provenance: { provider: "gmail", message_id: "m-job", received_at: JOB.date, source_domain: "jobs.example.com" },
			materialized_via: { mode: "reprocess", receipt_id: result.receipt.id },
		});
		expect(leads[0].data).not.toHaveProperty("apply_handoff");
		expect(deliveries()).toBe(0);
		expect(scanState()).toEqual(before);
	});

	it("is idempotent: reprocessing the same message again adds nothing", async () => {
		const box = fakeMailbox([JOB]);
		await reprocessGmailScout(env, "scout", "u1", { messageIds: ["m-job"] }, { mailbox: box.factory });
		const again = await reprocessGmailScout(env, "scout", "u1", { messageIds: ["m-job"] }, { mailbox: box.factory });
		expect(again).toMatchObject({ candidates: 1, added: 0, deduped: 1 });
		expect(leads).toHaveLength(1);
	});

	it("keeps ambiguous, digest and non-canonical mail fail-closed, and refuses mail beyond 30 days", async () => {
		const box = fakeMailbox([DIGEST, MULTI, SEARCH, ANCIENT]);
		const result = await reprocessGmailScout(env, "scout", "u1", { messageIds: ["m-digest", "m-multi", "m-search", "m-ancient"] }, { mailbox: box.factory });
		expect(result).toMatchObject({ added: 0, rejected: { posting_unverifiable: 3, no_specific_job_url: 1, stale: 1 } });
		expect(leads).toHaveLength(0);
	});

	it.each([
		["a submit was attempted (outcome uncertain)", "submit_attempted_at=1760000000000"],
		["it was submitted", "status='submitted'"],
		["it is still being filled", "status='filling'"],
	])("never replays a job that already has an application — %s — even with its lead gone", async (_label, extra) => {
		application("url:https://jobs.example.com/job/42", extra);
		const result = await reprocessGmailScout(env, "scout", "u1", { messageIds: ["m-job"] }, { mailbox: fakeMailbox([JOB]).factory });
		expect(result).toMatchObject({ candidates: 1, added: 0, rejected: { prior_application: 1 } });
		expect(result.receipt.rejected).toEqual({ prior_application: 1 });
		expect(leads).toHaveLength(0);
	});

	it("routes a LinkedIn posting through the #1050 canonical link and the #1030/#1049 browser verification queue", async () => {
		const result = await reprocessGmailScout(env, "scout", "u1", { messageIds: ["m-li"] }, { mailbox: fakeMailbox([LINKEDIN]).factory });
		const canonical = `https://www.linkedin.com/jobs/view/${LI_ID}`;
		expect(result).toMatchObject({ added: 1, receipt: { awaitingBrowserVerification: 1 } });
		expect(leads[0].data).toMatchObject({ url: canonical, status: "awaiting_browser_verification", gmail_message_id: "m-li", materialized_via: { mode: "reprocess" } });
		expect(JSON.stringify(leads[0].data)).not.toContain("SECRET");
		expect(verifications()).toEqual([{ leadId: "lead-0", workKey: `url:${canonical}`, url: canonical, state: "awaiting" }]);
	});
});

describe("reprocessing a bounded window", () => {
	it("searches with the scan's alert filter between epoch bounds — never the 2-day scan window", async () => {
		const box = fakeMailbox([JOB]);
		const after = new Date(Date.now() - 14 * DAY).toISOString();
		const result = await reprocessGmailScout(env, "scout", "u1", { after, before: new Date().toISOString() }, { mailbox: box.factory });
		expect(result.added).toBe(1);
		expect(box.calls.queries).toHaveLength(1);
		expect(box.calls.queries[0]).toContain(`after:${Math.floor(Date.parse(after) / 1000)}`);
		expect(box.calls.queries[0]).not.toContain("newer_than");
		expect(gmailScoutReprocessQuery({ after })).toMatch(/^\(subject:.*\) after:\d+$/);
	});
});

describe("reprocess refusals", () => {
	it("a disabled Scout refuses before any mailbox read, and the receipt says so", async () => {
		d1.exec("UPDATE gmail_scout_configs SET enabled = 0");
		const box = fakeMailbox([JOB]);
		await expect(reprocessGmailScout(env, "scout", "u1", { messageIds: ["m-job"] }, { mailbox: box.factory })).rejects.toThrow(/disabled/);
		expect(box.calls.factory).toBe(0);
		expect((await listGmailScoutReceipts(env, "scout"))[0]).toMatchObject({ trigger: "reprocess", status: "failed" });
	});

	it("a missing pinned account or email permission refuses before any mailbox read, without touching scan state", async () => {
		const before = scanState();
		d1.exec("DELETE FROM user_api_keys");
		const box = fakeMailbox([JOB]);
		await expect(reprocessGmailScout(env, "scout", "u1", { messageIds: ["m-job"] }, { mailbox: box.factory })).rejects.toThrow(/not connected/);
		email = false;
		await expect(reprocessGmailScout(env, "scout", "u1", { messageIds: ["m-job"] }, { mailbox: box.factory })).rejects.toThrow(/Email access/);
		expect(box.calls.factory).toBe(0);
		expect(scanState()).toEqual(before);
	});

	it("bounds every request: either ids or a window, at most 25 ids, at most 30 days back", () => {
		const now = Date.now();
		const ids = (n: number) => Array.from({ length: n }, (_, i) => `id${i}`);
		expect(parseReprocessInput({ messageIds: ["a", "a", "b"] }, now)).toEqual({ ok: true, input: { messageIds: ["a", "b"] } });
		expect(parseReprocessInput({ messageIds: ids(REPROCESS_MAX_MESSAGES) }, now).ok).toBe(true);
		for (const bad of [
			{},
			{ messageIds: [] },
			{ messageIds: ids(REPROCESS_MAX_MESSAGES + 1) },
			{ messageIds: ["../../etc"] },
			{ messageIds: ["a"], after: new Date(now - DAY).toISOString() },
			{ after: "yesterday" },
			{ after: new Date(now - 31 * DAY).toISOString() },
			{ after: new Date(now - DAY).toISOString(), before: new Date(now - 2 * DAY).toISOString() },
		]) expect(parseReprocessInput(bad, now)).toMatchObject({ ok: false });
		expect(parseReprocessInput({ after: new Date(now - 7 * DAY).toISOString(), before: new Date(now + DAY).toISOString() }, now)).toEqual({ ok: true, input: { after: new Date(now - 7 * DAY).toISOString(), before: new Date(now).toISOString() } });
	});
});

describe("the reprocess route", () => {
	async function post(body: unknown) {
		const app = new Hono<{ Bindings: Env }>();
		const { instanceRoutes } = await import("../../../routes/instances.js");
		app.route("/v1/instances", instanceRoutes);
		app.onError((e, c) => c.json({ error: e instanceof Error ? e.message : String(e) }, e instanceof HttpError ? (e.status as 400) : 500));
		const headers = { Authorization: `Bearer ${await signSession("u1", SECRET, { roles: ["user"] })}`, "Content-Type": "application/json" };
		const res = await app.request("/v1/instances/scout/gmail-scout/reprocess", { method: "POST", headers, body: JSON.stringify(body) }, env);
		return { status: res.status, body: (await res.json()) as { scan?: GmailScoutScanResult; error?: string } };
	}

	it("reprocesses the owner's selection and answers the scan with its reprocess receipt", async () => {
		setGmailScoutMailboxForTest(fakeMailbox([JOB]).factory);
		const res = await post({ messageIds: ["m-job"] });
		expect(res.status).toBe(200);
		expect(res.body.scan).toMatchObject({ added: 1, receipt: { trigger: "reprocess", status: "completed" } });
	});

	it("rejects an out-of-bounds request with 400 before opening a receipt", async () => {
		const res = await post({ after: new Date(Date.now() - 60 * DAY).toISOString() });
		expect(res.status).toBe(400);
		expect(res.body.error).toMatch(/30 days/);
		expect(await listGmailScoutReceipts(env, "scout")).toEqual([]);
	});
});
