/**
 * On-demand Gmail Scout scans (#1023), on the real migrated schema, through the ONE scan path.
 *
 * Only the mailbox is faked (inert synthetic messages, injected through the scan's own seam) and the
 * Scout's Durable Object is a small in-memory stand-in for its permission state and `job_leads` store.
 * No real mailbox is read, no credential is touched, nothing is handed downstream.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "../../d1-sqlite.js";
import { HttpError } from "../../auth.js";
import { signSession } from "../../session.js";
import { pipelineHealth } from "../../applications/pipeline-health.js";
import { GMAIL_SCOUT_PINNED_EMAIL } from "../config.js";
import { type GmailScoutScanReceipt, listGmailScoutReceipts } from "../receipts.js";
import { type GmailScoutMailbox, type GmailScoutMailboxFactory, gmailScoutStatus, runDueGmailScoutScans, scanGmailScout, setGmailScoutMailboxForTest } from "../scan.js";
import type { GmailMessage } from "../../gmail.js";
import type { Env } from "../../../types.js";
import type { GmailScoutScanResult } from "../../../agent-types.js";

const SECRET = "gmail-scout-on-demand-secret";
let d1: RealSchemaD1;
let env: Env;
/** Per-Scout DO state: the email permission and the private job_leads records. */
let dos: Map<string, { email: boolean; leads: Array<{ id: string; data: Record<string, unknown> }> }>;

const now = () => new Date().toUTCString();
const msg = (id: string, subject: string, text: string, from = "Acme Careers <careers@acme.example>", date = now()): GmailMessage =>
	({ id, threadId: `t-${id}`, from, to: GMAIL_SCOUT_PINNED_EMAIL, cc: "", subject, date, messageId: "", references: "", snippet: "", text, attachments: [] }) as unknown as GmailMessage;

/** The synthetic inbox every parity check reads: one job, one digest, one duplicate, one stale alert. */
const INBOX = () => [
	msg("m-job", "Platform Engineer at Acme", "Company: Acme Pty Ltd\nhttps://jobs.example.com/job/42"),
	msg("m-digest", "20 new jobs for Platform Engineer", "https://jobs.example.com/job/1"),
	msg("m-dup", "Backend Engineer at Globex", "https://jobs.example.com/job/7"),
	msg("m-stale", "Old role at Initech", "https://jobs.example.com/job/9", undefined, "Mon, 01 Jan 2024 00:00:00 +0000"),
];

/** A fake mailbox: what it lists, what it reads, and a log of the calls it received. */
function fakeMailbox(messages: GmailMessage[], opts: { listError?: Error; gate?: Promise<void> } = {}) {
	const calls = { factory: 0, list: 0, read: [] as string[] };
	const factory: GmailScoutMailboxFactory = async () => {
		calls.factory++;
		const box: GmailScoutMailbox = {
			list: async () => {
				calls.list++;
				if (opts.gate) await opts.gate;
				if (opts.listError) throw opts.listError;
				return messages.map((m) => ({ id: m.id }));
			},
			read: async (id) => {
				calls.read.push(id);
				return messages.find((m) => m.id === id) as GmailMessage;
			},
		};
		return box;
	};
	return { factory, calls };
}

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["scout", "scout-b", "tailor"] });
	d1.exec(`UPDATE agent_instances SET config = '{"source_mode":"gmail"}' WHERE id IN ('scout','scout-b')`);
	d1.exec(`INSERT INTO user_api_keys (user_id, provider, account_id, key_ciphertext, dek_wrapped, iv, account_label) VALUES ('u1', 'gmail', '${GMAIL_SCOUT_PINNED_EMAIL}', X'00', X'00', X'00', '${GMAIL_SCOUT_PINNED_EMAIL}')`);
	for (const id of ["scout", "scout-b"]) d1.exec(`INSERT INTO gmail_scout_configs (id, instance_id, pinned_email, enabled) VALUES ('cfg-${id}', '${id}', '${GMAIL_SCOUT_PINNED_EMAIL}', 1)`);
	// A downstream edge exists, so "nothing was handed off" is a real claim, not an empty graph.
	d1.exec(`INSERT INTO agent_connections (id, user_id, source_instance_id, event_type, target_instance_id, action, config, enabled) VALUES ('c-lead', 'u1', 'scout', 'job.lead.apply_requested', 'tailor', 'generate_application_materials', '{}', 1)`);
	dos = new Map(["scout", "scout-b"].map((id) => [id, { email: true, leads: [{ id: "existing", data: { url: "https://jobs.example.com/job/7", status: "unverified", gmail_message_id: "older" } }] }]));
	const agent = {
		idFromName: (n: string) => n,
		get: (id: string) => ({
			fetch: async (req: Request) => {
				const s = dos.get(id) ?? { email: false, leads: [] };
				const url = new URL(req.url);
				if (url.pathname === "/state") return Response.json({ permissions: { email: s.email } });
				if (url.pathname === "/collections/job_leads") return s.leads.length ? Response.json({ name: "job_leads" }) : new Response("{}", { status: 404 });
				if (url.pathname === "/collections/job_leads/records" && req.method === "GET") return Response.json({ records: s.leads });
				if (url.pathname === "/collections/job_leads/records" && req.method === "POST") {
					const { data } = (await req.json()) as { data: Record<string, unknown> };
					const id = `lead-${s.leads.length}`;
					s.leads.push({ id, data });
					return Response.json({ id, created: true });
				}
				return Response.json({});
			},
		}),
	};
	env = { DB: d1.DB, AGENT: agent, SESSION_SIGNING_KEY: SECRET } as unknown as Env;
});
afterEach(() => {
	vi.unstubAllGlobals();
	setGmailScoutMailboxForTest(null);
	d1.close();
});

const scanState = (id: string) => d1.sqlite.prepare("SELECT last_scan_at AS lastScanAt, failure_count AS failures, last_failure_message AS message FROM gmail_scout_scan_state WHERE instance_id = ?").get(id) as { lastScanAt: string | null; failures: number; message: string | null } | undefined;
const deliveries = () => (d1.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_connection_deliveries").get() as { n: number }).n;
const health = async (id = "scout") => (await pipelineHealth(env, "u1", { scouts: [id], tailors: ["tailor"], runners: [] }, [])).sources[0];

describe("Scan now: success, through the scheduler's own path", () => {
	it("classifies, dedups and stores unverified leads, closes a durable receipt, and hands nothing downstream", async () => {
		const box = fakeMailbox(INBOX());
		const result = await scanGmailScout(env, "scout", "u1", { trigger: "on_demand", triggeredBy: "u1", mailbox: box.factory });
		expect(result).toMatchObject({ candidates: 2, added: 1, deduped: 1, rejected: { posting_unverifiable: 1, stale: 1 }, reused: false, handoff: "none" });
		expect(result.receipt).toMatchObject({ trigger: "on_demand", triggeredBy: "u1", status: "completed", hits: 4, candidates: 2, added: 1, deduped: 1, rejected: { posting_unverifiable: 1, stale: 1 }, errorMessage: null, handoff: "none" });
		const [stored] = await listGmailScoutReceipts(env, "scout");
		expect(stored.id).toBe(result.receipt.id); // durable: it reads back after the call
		// No default hand-off: the new lead is unverified, no apply was requested, nothing was delivered.
		const added = dos.get("scout")?.leads.filter((l) => l.data.gmail_message_id === "m-job") ?? [];
		expect(added).toHaveLength(1);
		expect(added[0].data).toMatchObject({ status: "unverified", verification: { state: "unverified" } });
		expect(added[0].data).not.toHaveProperty("apply_handoff");
		expect(deliveries()).toBe(0);
		// Health reflects it: scanned, ready, and the latest receipt is this on-demand scan.
		expect(scanState("scout")?.lastScanAt).toBeTruthy();
		expect(await health()).toMatchObject({ ready: true, lastReceipt: { id: result.receipt.id, trigger: "on_demand", status: "completed", added: 1 } });
	});

	it("a receipt never carries mail content, subjects or addresses", async () => {
		const { receipt } = await scanGmailScout(env, "scout", "u1", { trigger: "on_demand", mailbox: fakeMailbox(INBOX()).factory });
		const text = JSON.stringify(receipt);
		for (const leaked of ["Platform Engineer", "Acme Pty", "careers@acme.example", GMAIL_SCOUT_PINNED_EMAIL, "jobs.example.com"]) expect(text).not.toContain(leaked);
	});
});

describe("Scan now: no results", () => {
	it("an empty mailbox is a completed scan with zero counts, and the source is healthy", async () => {
		const result = await scanGmailScout(env, "scout", "u1", { trigger: "on_demand", mailbox: fakeMailbox([]).factory });
		expect(result.receipt).toMatchObject({ status: "completed", hits: 0, candidates: 0, added: 0, deduped: 0, rejected: {} });
		expect(await health()).toMatchObject({ ready: true, lastReceipt: { status: "completed", added: 0 } });
	});
});

describe("Scan now: unavailable and auth failures", () => {
	it("Gmail unavailable: the receipt is failed with the reason, and health names a failing source", async () => {
		const box = fakeMailbox(INBOX(), { listError: new Error("Gmail API 503: backendError") });
		await expect(scanGmailScout(env, "scout", "u1", { trigger: "on_demand", mailbox: box.factory })).rejects.toThrow(/503/);
		const [receipt] = await listGmailScoutReceipts(env, "scout");
		expect(receipt).toMatchObject({ status: "failed", errorMessage: expect.stringMatching(/503/), added: null });
		expect(scanState("scout")).toMatchObject({ failures: 1 });
		expect(await health()).toMatchObject({ ready: false, lastReceipt: { status: "failed" } });
		expect(deliveries()).toBe(0);
	});

	it("an auth failure getting the read token is a failed receipt, and nothing is read", async () => {
		const failing: GmailScoutMailboxFactory = async () => {
			throw new Error("Gmail token refresh failed (401): invalid_grant");
		};
		await expect(scanGmailScout(env, "scout", "u1", { trigger: "on_demand", mailbox: failing })).rejects.toThrow(/401/);
		expect((await listGmailScoutReceipts(env, "scout"))[0]).toMatchObject({ status: "failed", errorMessage: expect.stringMatching(/401/) });
	});

	it("email access switched off: refused before the mailbox is even opened", async () => {
		(dos.get("scout") as { email: boolean }).email = false;
		const box = fakeMailbox(INBOX());
		await expect(scanGmailScout(env, "scout", "u1", { trigger: "on_demand", mailbox: box.factory })).rejects.toThrow(/Email access is not enabled/);
		expect(box.calls.factory).toBe(0);
		expect((await listGmailScoutReceipts(env, "scout"))[0]).toMatchObject({ status: "failed" });
	});

	it("a disabled source: the refusal is on the receipt, but it is not counted as a failing source", async () => {
		d1.exec("UPDATE gmail_scout_configs SET enabled = 0 WHERE instance_id = 'scout'");
		const box = fakeMailbox(INBOX());
		await expect(scanGmailScout(env, "scout", "u1", { trigger: "on_demand", mailbox: box.factory })).rejects.toThrow(/disabled/);
		expect(box.calls.factory).toBe(0);
		expect((await listGmailScoutReceipts(env, "scout"))[0]).toMatchObject({ status: "failed", errorMessage: expect.stringMatching(/disabled/) });
		expect(scanState("scout")).toBeUndefined();
	});
});

describe("Scan now: idempotency", () => {
	it("a second Scan now while one is running returns the running receipt and reads the mailbox once", async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const box = fakeMailbox(INBOX(), { gate });
		const first = scanGmailScout(env, "scout", "u1", { trigger: "on_demand", mailbox: box.factory });
		await new Promise((r) => setTimeout(r, 20)); // the first scan has opened its receipt and is reading
		const second = await scanGmailScout(env, "scout", "u1", { trigger: "on_demand", mailbox: box.factory });
		expect(second).toMatchObject({ reused: true, handoff: "none", receipt: { status: "running" } });
		release();
		const done = await first;
		expect(second.receipt.id).toBe(done.receipt.id);
		expect(box.calls.list).toBe(1);
		expect(await listGmailScoutReceipts(env, "scout")).toHaveLength(1);
	});

	it("scanning the same mail again adds nothing: every lead is a duplicate", async () => {
		await scanGmailScout(env, "scout", "u1", { trigger: "on_demand", mailbox: fakeMailbox(INBOX()).factory });
		const again = await scanGmailScout(env, "scout", "u1", { trigger: "on_demand", mailbox: fakeMailbox(INBOX()).factory });
		expect(again).toMatchObject({ added: 0, deduped: 2 });
		expect(dos.get("scout")?.leads.filter((l) => l.data.gmail_message_id === "m-job")).toHaveLength(1);
	});
});

describe("scheduler / on-demand parity", () => {
	it("the same inbox gives the same counts and reasons whichever starts it; only the trigger differs", async () => {
		const scheduled = await runDueGmailScoutScans(env, Date.now(), 1, fakeMailbox(INBOX()).factory);
		expect(scheduled).toEqual({ scanned: 1, failed: 0 });
		const scheduledReceipt = (await listGmailScoutReceipts(env, "scout"))[0] ?? (await listGmailScoutReceipts(env, "scout-b"))[0];
		const other = scheduledReceipt.instanceId === "scout" ? "scout-b" : "scout";
		const onDemand = (await scanGmailScout(env, other, "u1", { trigger: "on_demand", triggeredBy: "u1", mailbox: fakeMailbox(INBOX()).factory })).receipt;
		const counts = (r: typeof onDemand) => ({ hits: r.hits, candidates: r.candidates, added: r.added, deduped: r.deduped, rejected: r.rejected, status: r.status, handoff: r.handoff });
		expect(counts(scheduledReceipt)).toEqual(counts(onDemand));
		expect(scheduledReceipt).toMatchObject({ trigger: "schedule", triggeredBy: null });
		expect(onDemand).toMatchObject({ trigger: "on_demand", triggeredBy: "u1" });
	});
});

describe("the Scan now route (Console) and its receipt", () => {
	async function post(path: string) {
		const app = new Hono<{ Bindings: Env }>();
		const { instanceRoutes } = await import("../../../routes/instances.js");
		app.route("/v1/instances", instanceRoutes);
		app.onError((e, c) => c.json({ error: e instanceof Error ? e.message : String(e) }, e instanceof HttpError ? (e.status as 400) : 500));
		const headers = { Authorization: `Bearer ${await signSession("u1", SECRET, { roles: ["user"] })}`, "Content-Type": "application/json" };
		const res = await app.request(path, { method: path.endsWith("/scan") ? "POST" : "GET", headers }, env);
		return { status: res.status, body: (await res.json()) as { scan: GmailScoutScanResult; receipts: GmailScoutScanReceipt[]; error?: string; receipt?: GmailScoutScanReceipt | null } };
	}

	it("runs an on-demand scan for the signed-in owner and answers the scan with its receipt; status lists it", async () => {
		setGmailScoutMailboxForTest(fakeMailbox(INBOX()).factory);
		const res = await post("/v1/instances/scout/gmail-scout/scan");
		expect(res.status).toBe(200);
		expect(res.body.scan).toMatchObject({ added: 1, handoff: "none", receipt: { trigger: "on_demand", triggeredBy: "u1", status: "completed" } });
		const status = await post("/v1/instances/scout/gmail-scout/status");
		expect(status.body.receipts[0]).toMatchObject({ id: res.body.scan.receipt.id, status: "completed" });
	});

	it("a failed read answers 502 with the failed receipt, never a bare error", async () => {
		setGmailScoutMailboxForTest(fakeMailbox(INBOX(), { listError: new Error("Gmail API 503") }).factory);
		const res = await post("/v1/instances/scout/gmail-scout/scan");
		expect(res.status).toBe(502);
		expect(res.body).toMatchObject({ error: expect.stringMatching(/503/), receipt: { status: "failed", trigger: "on_demand" } });
	});
});

describe("#1024: a one-item provider alert, through the same scan", () => {
	const JK = "0123456789abcdef";
	const CANONICAL = `https://au.indeed.com/viewjob?jk=${JK}`;
	const INDEED = () => [msg("m-indeed", "Platform Engineer at Acme", `<a href="https://au.indeed.com/rc/clk/dl?jk=${JK}&amp;tk=SECRETTK&amp;alid=SECRETALID">Platform Engineer</a> Acme Pty Ltd - Sydney NSW`, "Indeed <alert@indeed.com>")];
	const page = (status: number) => new Response(status === 200 ? `<script type="application/ld+json">${JSON.stringify({ "@type": "JobPosting", title: "Platform Engineer", hiringOrganization: { name: "Acme Pty Ltd" } })}</script>` : "", { status });

	it("scheduled and on-demand scans both resolve it to one unverified canonical lead; no receipt carries a token or the mail", async () => {
		const requested: string[] = [];
		vi.stubGlobal("fetch", async (url: string) => {
			requested.push(String(url));
			return page(200);
		});
		const onDemand = await scanGmailScout(env, "scout", "u1", { trigger: "on_demand", mailbox: fakeMailbox(INDEED()).factory });
		await runDueGmailScoutScans(env, Date.now(), 5, fakeMailbox(INDEED()).factory);
		const [scheduled] = (await listGmailScoutReceipts(env, "scout-b")).filter((r) => r.trigger === "schedule");
		for (const r of [onDemand.receipt, scheduled]) expect(r).toMatchObject({ status: "completed", hits: 1, candidates: 1, added: 1, rejected: {}, handoff: "none" });
		for (const id of ["scout", "scout-b"]) {
			const lead = dos.get(id)?.leads.find((l) => l.data.gmail_message_id === "m-indeed");
			expect(lead?.data).toMatchObject({ url: CANONICAL, status: "unverified", verification: { state: "unverified" } });
			expect(JSON.stringify(lead)).not.toMatch(/SECRET/);
		}
		expect(requested.every((u) => u === CANONICAL)).toBe(true);
		// The receipt's `query` (#1247) is the scan's own static Gmail filter, which names indeed.com as a sender to search — not mail content.
		const withoutQuery = <T extends { query?: unknown }>(rs: T[]) => rs.map(({ query: _q, ...r }) => r);
		const receipts = JSON.stringify(withoutQuery(await listGmailScoutReceipts(env, "scout")));
		for (const leaked of ["SECRET", "indeed.com", "Platform Engineer", "Acme"]) expect(receipts).not.toContain(leaked);
		// Status (Console + MCP gmail_scout_status) carries counts and receipts, never the alert or its tokens.
		const st = await gmailScoutStatus(env, "scout");
		const status = JSON.stringify({ ...st, receipts: withoutQuery(st.receipts) });
		for (const leaked of ["SECRET", "indeed.com", "Platform Engineer", "Acme"]) expect(status).not.toContain(leaked);
		expect(deliveries()).toBe(0);
	});

	// #1030: before, this lead was thrown away as `posting_unverifiable`; now a browser checks it.
	it("a posting the server cannot check is stored awaiting browser verification, queued, and counted on the receipt", async () => {
		vi.stubGlobal("fetch", async () => page(403));
		const { receipt } = await scanGmailScout(env, "scout", "u1", { trigger: "on_demand", mailbox: fakeMailbox(INDEED()).factory });
		expect(receipt).toMatchObject({ status: "completed", added: 1, rejected: {}, awaitingBrowserVerification: 1 });
		const lead = dos.get("scout")?.leads.find((l) => l.data.gmail_message_id === "m-indeed");
		expect(lead?.data).toMatchObject({ status: "awaiting_browser_verification", verification: { state: "awaiting_browser_verification", reason: "server_fetch_refused" } });
		const queued = await d1.DB.prepare("SELECT lead_id, state, canonical_url, attempts FROM job_lead_browser_verifications WHERE instance_id = 'scout'").all<Record<string, unknown>>();
		expect(queued.results).toEqual([{ lead_id: lead?.id, state: "awaiting", canonical_url: lead?.data.url, attempts: 0 }]);
		// Only the canonical posting is kept — no alert token anywhere it was written.
		expect(JSON.stringify({ lead, queued: queued.results })).not.toMatch(/SECRET/);
	});
});

describe("#1050: a LinkedIn alert, through the same scan", () => {
	const CANONICAL = "https://www.linkedin.com/jobs/view/4012345678";
	const link = "https://www.linkedin.com/comm/jobs/view/4012345678/?trackingId=SECRETTRACK&amp;refId=SECRETREF&amp;midToken=SECRETMID&amp;otpToken=SECRETOTP";
	const LINKEDIN = () => [msg("m-li", "Platform Engineer at Acme", `<a href="${link}">Platform Engineer</a> Acme Pty Ltd · Sydney`, "LinkedIn Job Alerts <jobalerts-noreply@linkedin.com>")];

	it("behind LinkedIn's sign-in wall, the canonical posting is stored awaiting browser verification and queued — no token anywhere", async () => {
		const requested: string[] = [];
		vi.stubGlobal("fetch", async (url: string) => {
			requested.push(String(url));
			return new Response(null, { status: 302, headers: { location: "https://www.linkedin.com/authwall?trk=x" } });
		});
		const { receipt } = await scanGmailScout(env, "scout", "u1", { trigger: "on_demand", mailbox: fakeMailbox(LINKEDIN()).factory });
		expect(receipt).toMatchObject({ status: "completed", added: 1, rejected: {}, awaitingBrowserVerification: 1, handoff: "none" });
		const lead = dos.get("scout")?.leads.find((l) => l.data.gmail_message_id === "m-li");
		expect(lead?.data).toMatchObject({ url: CANONICAL, status: "awaiting_browser_verification", verification: { reason: "server_fetch_refused", canonical_job_url: CANONICAL } });
		const queued = await d1.DB.prepare("SELECT state, canonical_url FROM job_lead_browser_verifications WHERE instance_id = 'scout'").all<Record<string, unknown>>();
		expect(queued.results).toEqual([{ state: "awaiting", canonical_url: CANONICAL }]);
		// Only the canonical posting was requested, the wall was not followed, and nothing downstream moved.
		expect(requested).toEqual([CANONICAL]);
		expect(JSON.stringify({ lead, queued: queued.results, receipts: await listGmailScoutReceipts(env, "scout") })).not.toMatch(/SECRET|trackingId|otpToken/);
		expect(deliveries()).toBe(0);
	});
});

describe("#1022: pre-fix junk leads are reported, never archived", () => {
	it("pipeline health counts stored untouched leads today's rules reject, and leaves every lead as it was", async () => {
		const leads = dos.get("scout")?.leads ?? [];
		leads.push(
			{ id: "j1", data: { status: "new", source: "Gmail", title: "20 new jobs for Project manager in All Melbourne VIC", url: "https://au.seek.com/job/1?savedSearchID=x" } },
			{ id: "j2", data: { status: "new", source: "Gmail", title: "Security alert", url: "https://accounts.google.com/AccountChooser" } },
			{ id: "j3", data: { status: "archived", source: "Gmail", title: "18 new jobs for Scrum Master", url: "https://au.seek.com/job/2" } },
		);
		const before = JSON.stringify(leads);
		const h = await pipelineHealth(env, "u1", { scouts: ["scout"], tailors: ["tailor"], runners: [] }, []);
		expect(h.problems.find((p) => p.code === "source_junk_leads")?.message).toMatch(/holds 2 stored leads .*\(1 digest, 1 security alert\)/);
		expect(JSON.stringify(dos.get("scout")?.leads)).toBe(before);
	});
});
