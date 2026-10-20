/**
 * #1247 — every Gmail Scout scan logs each matched email: which one (ids + a link that opens it), what
 * was read, what it was taken for and on what evidence, the decision and its reason, the lead it became
 * or duplicated — and a digest's jobs one row each. Real migrated schema, the ONE scan path; only the
 * mailbox and the Scout's Durable Object are faked.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "../../d1-sqlite.js";
import { GMAIL_SCOUT_PINNED_EMAIL } from "../config.js";
import { pruneGmailScoutReceipts, RECEIPTS_KEPT } from "../receipts.js";
import { digestJobs, ingestGmailCandidates, type GmailScoutMailboxFactory, gmailScoutStatus, runDueGmailScoutScans, scanGmailScout } from "../scan.js";
import { pruneScanLog, readScanLog, SCAN_LOG_SNIPPET_MAX } from "../scan-log.js";
import type { GmailMessage } from "../../gmail.js";
import { workKeyForLead } from "../../job-lead-triage.js";
import type { Env } from "../../../types.js";

let d1: RealSchemaD1;
let env: Env;
let leads: Array<{ id: string; data: Record<string, unknown> }>;

const BODY_SECRET = "This sentence is body prose and must never be stored";
const msg = (id: string, subject: string, text: string, opts: { from?: string; date?: string; snippet?: string } = {}): GmailMessage =>
	({ id, threadId: `t-${id}`, from: opts.from ?? "Acme Careers <careers@acme.example>", to: GMAIL_SCOUT_PINNED_EMAIL, cc: "", subject, date: opts.date ?? new Date().toUTCString(), messageId: "", references: "", snippet: opts.snippet ?? "", text, attachments: [] }) as unknown as GmailMessage;

/** One email per decision path. */
const INBOX = () => [
	msg("m-job", "Platform Engineer at Acme", `Company: Acme Pty Ltd\n${BODY_SECRET}\nhttps://jobs.example.com/job/42`, { snippet: "Acme is hiring a Platform Engineer in Sydney" }),
	msg("m-dup", "Backend Engineer at Globex", "https://jobs.example.com/job/7"),
	msg("m-digest", "20 new jobs for Platform Engineer", `<a href="https://jobs.example.com/job/1">Site Reliability Engineer</a>\n<a href="https://jobs.example.com/job/7">Backend Engineer</a>`, { from: "SEEK Recommendations <noreply@s.seek.com.au>" }),
	msg("m-nonjob", "Your weekly newsletter", "https://news.example.com/"),
	msg("m-security", "Security alert: new sign-in", "https://accounts.example.com/x/y"),
	msg("m-stale", "Old role at Initech", "https://jobs.example.com/job/9", { date: "Mon, 01 Jan 2024 00:00:00 +0000" }),
];

function mailbox(messages: GmailMessage[]): GmailScoutMailboxFactory {
	return async () => ({ list: async () => messages.map((m) => ({ id: m.id })), read: async (id) => messages.find((m) => m.id === id) as GmailMessage });
}

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["scout", "other"] });
	d1.exec(`UPDATE agent_instances SET config = '{"source_mode":"gmail"}' WHERE id IN ('scout','other')`);
	d1.exec(`INSERT INTO user_api_keys (user_id, provider, account_id, key_ciphertext, dek_wrapped, iv, account_label) VALUES ('u1', 'gmail', '${GMAIL_SCOUT_PINNED_EMAIL}', X'00', X'00', X'00', '${GMAIL_SCOUT_PINNED_EMAIL}')`);
	for (const id of ["scout", "other"]) d1.exec(`INSERT INTO gmail_scout_configs (id, instance_id, pinned_email, enabled) VALUES ('cfg-${id}', '${id}', '${GMAIL_SCOUT_PINNED_EMAIL}', 1)`);
	leads = [{ id: "existing", data: { url: "https://jobs.example.com/job/7", status: "unverified", gmail_message_id: "older" } }];
	const agent = {
		idFromName: (n: string) => n,
		get: () => ({
			fetch: async (req: Request) => {
				const url = new URL(req.url);
				if (url.pathname === "/state") return Response.json({ permissions: { email: true } });
				if (url.pathname === "/collections/job_leads") return Response.json({ name: "job_leads" });
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
	env = { DB: d1.DB, AGENT: agent } as unknown as Env;
});
afterEach(() => d1.close());

const scan = () => scanGmailScout(env, "scout", "u1", { trigger: "on_demand", triggeredBy: "u1", mailbox: mailbox(INBOX()) });
const byId = async (scanId?: string) => Object.fromEntries((await readScanLog(env, "scout", { scanId, limit: 100 })).items.map((i) => [i.messageId, i]));

describe("the scan log's schema (#1247)", () => {
	it("records the exact query and window on the receipt, and one row per matched email with a link that opens it", async () => {
		const { receipt } = await scan();
		expect(receipt.query).toMatch(/newer_than:2d$/);
		expect(receipt.window).toMatchObject({ newerThanDays: 2, after: null, maxResults: 25 });
		const page = await readScanLog(env, "scout", { scanId: receipt.id, limit: 100 });
		expect(page.total).toBe(6);
		expect(page.items.map((i) => i.messageId)).toEqual(["m-job", "m-dup", "m-digest", "m-nonjob", "m-security", "m-stale"]);
		for (const item of page.items) {
			expect(item).toMatchObject({ threadId: `t-${item.messageId}`, gmailLink: `https://mail.google.com/mail/u/${GMAIL_SCOUT_PINNED_EMAIL}/#all/${item.messageId}` });
			expect(item.sender && item.subject && item.receivedAt && item.reason).toBeTruthy();
			expect(item.read?.parts).toEqual(["headers", "snippet", "body"]);
		}
		expect(page.items[0].read).toMatchObject({ linksFound: 1, jobPostingsDetected: 1 });
	});

	it("stores metadata and a short snippet only — never the body", async () => {
		const long = "x".repeat(SCAN_LOG_SNIPPET_MAX * 2);
		const { receipt } = await scanGmailScout(env, "scout", "u1", { trigger: "on_demand", mailbox: mailbox([msg("m-long", "Platform Engineer at Acme", `${BODY_SECRET} https://jobs.example.com/job/77`, { snippet: long })]) });
		const rows = JSON.stringify(d1.sqlite.prepare("SELECT * FROM gmail_scout_scan_log_items").all());
		expect(rows).not.toContain(BODY_SECRET);
		const [item] = (await readScanLog(env, "scout", { scanId: receipt.id })).items;
		expect(item.snippet?.length).toBeLessThanOrEqual(SCAN_LOG_SNIPPET_MAX);
	});
});

describe("every decision path is logged with its reason (#1247)", () => {
	it("added: a single posting becomes a lead, named with its console link", async () => {
		await scan();
		const job = (await byId())["m-job"];
		expect(job).toMatchObject({ classification: "single_posting", decision: "added", leadId: "lead-1", job: { url: "https://jobs.example.com/job/42", title: "Platform Engineer at Acme" } });
		expect(job.reason).toMatch(/^Added as an unverified lead/);
		expect(job.leadUrl).toBe("https://proagentstore.online/console/instances/scout/data");
	});

	it("deduped: names the lead it duplicated, and on which key", async () => {
		await scan();
		const dup = (await byId())["m-dup"];
		expect(dup).toMatchObject({ classification: "duplicate", decision: "deduped", leadId: "existing", evidence: "the same job (https://jobs.example.com/job/7) is already a lead" });
		expect(dup.reason).toMatch(/^Already a lead \(existing\)/);
	});

	it("digest (#1248): the evidence quotes what marked it, and each listed job is its own row with its own decision", async () => {
		await scan();
		const digest = (await byId())["m-digest"];
		expect(digest).toMatchObject({ classification: "digest", decision: "added", rejection: null, evidence: 'subject contains "20 new jobs"; 2 jobs named in it' });
		expect(digest.reason).toMatch(/1 added, 1 already leads, 0 not taken/);
		expect(digest.subItems).toEqual([
			expect.objectContaining({ classification: "digest_item", decision: "added", leadId: "lead-2", job: { title: "Site Reliability Engineer", company: null, url: "https://jobs.example.com/job/1" } }),
			expect.objectContaining({ classification: "digest_item", decision: "deduped", leadId: "existing", job: { title: "Backend Engineer", company: null, url: "https://jobs.example.com/job/7" } }),
		]);
	});

	it("a digest job's title is its link text or its own listing block — never a nearby plain-text line (live, Scout 2: \"[\", a suburb, a salary)", () => {
		const plain = "Scrum Master\nAcme Pty Ltd\n[\nhttps://au.seek.com/job/95335702?tracking=PLAIN1]\n\nProduct Owner\n[\nhttps://au.seek.com/job/95335703?tracking=PLAIN2]";
		const html = '<a href="https://au.seek.com/job/95335702?tracking=HTML1"><span>Scrum Master</span></a>';
		const { jobs } = digestJobs(msg("m-seek-digest", "2 new jobs for Scrum Master", `${plain}\n${html}`));
		expect(jobs).toEqual([
			// The anchor names it; the first block has no start that can be placed (no `logo`), so it adds nothing.
			{ title: "Scrum Master", company: null, url: "https://au.seek.com/job/95335702" },
			// #1251: read from where its listing STARTS (just after the previous job's link), not beside its own link.
			{ title: "Product Owner", company: null, url: "https://au.seek.com/job/95335703" },
		]);
		expect(JSON.stringify(jobs)).not.toMatch(/tracking|PLAIN|HTML1/);
	});

	it("rejected non-job, security mail and a stale alert each say why", async () => {
		await scan();
		const items = await byId();
		expect(items["m-nonjob"]).toMatchObject({ classification: "non_job", decision: "rejected", rejection: "no_specific_job_url", evidence: "1 link(s) checked; none names one posting" });
		expect(items["m-security"]).toMatchObject({ classification: "non_job", rejection: "security_alert", evidence: 'subject or sender contains "Security"' });
		expect(items["m-stale"]).toMatchObject({ classification: "too_old", rejection: "stale" });
		expect(items["m-stale"].evidence).toMatch(/^received Mon, 01 Jan 2024 .* last 2 day\(s\)$/);
	});

	it("awaiting browser verification: a posting the server could not check names its canonical URL, never a tracking link", async () => {
		const seek = msg("m-seek", "Platform Engineer at Acme", "https://www.seek.com.au/job/81234567?tracking=SECRETTRACK&ref=x");
		const out = await ingestGmailCandidates({ hits: [{ id: "m-seek" }], readMessage: async () => seek, existing: [], mailbox: GMAIL_SCOUT_PINNED_EMAIL, insertLead: async () => ({ created: true, id: "lead-s" }), fetchImpl: (async () => new Response("<html></html>", { status: 200 })) as typeof fetch });
		expect(out.log).toEqual([expect.objectContaining({ decision: "awaiting_browser_verification", leadId: "lead-s", classification: "single_posting" })]);
		expect(JSON.stringify(out.log)).not.toContain("SECRETTRACK");
		expect(out.log[0].reason).toMatch(/waiting for browser verification/);
	});

	it("a prior application is logged as rejected with the job it matched", async () => {
		const job = msg("m-applied", "Platform Engineer at Acme", "https://jobs.example.com/job/55");
		const workKey = workKeyForLead({ url: "https://jobs.example.com/job/55" }) as string;
		const out = await ingestGmailCandidates({ hits: [{ id: "m-applied" }], readMessage: async () => job, existing: [], appliedWorkKeys: new Set([workKey]), insertLead: async () => ({ created: true, id: "x" }) });
		expect(out.log[0]).toMatchObject({ decision: "rejected", rejection: "prior_application", classification: "single_posting", evidence: `job ${workKey}` });
	});
});

describe("reading the log (#1247)", () => {
	it("pages by cursor, defaults to the newest scan, and never reads another Scout's scan", async () => {
		const { receipt } = await scan();
		const first = await readScanLog(env, "scout", { limit: 4 });
		expect(first.scan?.id).toBe(receipt.id);
		expect(first.items).toHaveLength(4);
		const second = await readScanLog(env, "scout", { limit: 4, cursor: first.nextCursor });
		expect(second.items.map((i) => i.messageId)).toEqual(["m-security", "m-stale"]);
		expect(second.nextCursor).toBeNull();
		expect((await readScanLog(env, "other", { scanId: receipt.id })).scan).toBeNull();
	});

	it("gmail_scout_status points each receipt at its log", async () => {
		const { receipt } = await scan();
		const status = await gmailScoutStatus(env, "scout");
		expect(status.receipts[0].scanLog).toEqual({ path: `/v1/instances/scout/gmail-scout/scan-log?scan_id=${receipt.id}`, tool: "gmail_scout_scan_log", scan_id: receipt.id });
	});
});

describe("30-day retention (#1247)", () => {
	it("prunes log rows past 30 days, and keeps every receipt younger than that even past the count cap", async () => {
		const { receipt } = await scan();
		d1.exec(`UPDATE gmail_scout_scan_log_items SET created_at = datetime('now', '-31 days') WHERE message_id = 'm-stale'`);
		await runDueGmailScoutScans(env, Date.now(), 0); // the scheduler prunes every Scout's log first
		expect((await readScanLog(env, "scout", { scanId: receipt.id, limit: 100 })).items.map((i) => i.messageId)).not.toContain("m-stale");
		for (let i = 0; i < RECEIPTS_KEPT + 5; i++) d1.exec(`INSERT INTO gmail_scout_scan_receipts (id, instance_id, scan_trigger, status, created_at) VALUES ('r${i}', 'scout', 'schedule', 'completed', datetime('now', '-${i} hours'))`);
		d1.exec(`INSERT INTO gmail_scout_scan_receipts (id, instance_id, scan_trigger, status, created_at) VALUES ('ancient', 'scout', 'schedule', 'completed', datetime('now', '-40 days'))`);
		await pruneGmailScoutReceipts(env, "scout");
		await pruneScanLog(env, "scout");
		const ids = (d1.sqlite.prepare("SELECT id FROM gmail_scout_scan_receipts WHERE instance_id = 'scout'").all() as Array<{ id: string }>).map((r) => r.id);
		expect(ids).toHaveLength(RECEIPTS_KEPT + 6);
		expect(ids).not.toContain("ancient");
	});
});
