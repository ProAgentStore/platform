/**
 * Owner-selected job URL intake (#1056), over the real schema and the real job-lead storage handlers.
 *
 * The Scout's Durable Object is the real `insertRecord` / `triageJobLead` / `applyJobLeadBrowserVerification`
 * handlers over an in-memory engine whose create-or-get dedupes on `workKeyForLead`, as production's does. Only
 * the session is faked. Nothing reaches a browser, a Tailor or a Runner.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyJobLeadBrowserVerification, getRecord, insertRecord, queryRecords, triageJobLead } from "../agent-do-storage-routes.js";
import type { CollectionRecord } from "../agent-storage-types.js";
import { HttpError } from "../lib/auth.js";
import { realSchemaD1, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import { workKeyForLead } from "../lib/job-lead-triage.js";
import type { Env } from "../types.js";

vi.mock("../lib/auth.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/auth.js")>("../lib/auth.js");
	return { ...actual, requireUser: async () => ({ uid: "u1", roles: [] }) };
});
const { instanceRoutes } = await import("./instances.js");

let d1: RealSchemaD1;
/** Each Scout's job_leads, by instance. */
let stores: Map<string, Map<string, CollectionRecord>>;
let seq = 0;

function engineFor(instanceId: string) {
	const leads = stores.get(instanceId) ?? stores.set(instanceId, new Map()).get(instanceId)!;
	const recordInsert = async (_c: string, data: Record<string, unknown>) => {
		const rec = { id: `lead-${++seq}`, collection: "job_leads", data, createdAt: "2026-10-13T00:00:00Z", updatedAt: "2026-10-13T00:00:00Z" } as CollectionRecord;
		leads.set(rec.id, rec);
		return rec;
	};
	return {
		recordInsert,
		recordCreateOrGetJobLead: async (data: Record<string, unknown>) => {
			const key = workKeyForLead(data);
			const existing = [...leads.values()].find((r) => r.data.work_key === key);
			return existing ? { record: existing, created: false } : { record: await recordInsert("job_leads", { ...data, work_key: key }), created: true };
		},
		recordGet: async (_c: string, id: string) => leads.get(id) ?? null,
		recordUpdate: async (_c: string, id: string, patch: Record<string, unknown>) => {
			const r = leads.get(id);
			if (!r) return null;
			const next = { ...r, data: { ...r.data, ...patch } };
			leads.set(id, next);
			return next;
		},
		recordQuery: async () => ({ records: [...leads.values()], total: leads.size }),
	};
}
const agentDO = {
	idFromName: (n: string) => n,
	get: (id: string) => ({
		fetch: async (req: Request) => {
			const url = new URL(req.url);
			const p = url.pathname;
			const e = engineFor(id) as never;
			if (p === "/collections/job_leads/records" && req.method === "POST") return insertRecord(e, "job_leads", req);
			if (p === "/collections/job_leads/records") return queryRecords(e, "job_leads", url);
			if (/^\/collections\/job_leads\/records\/[^/]+$/.test(p)) return getRecord(e, "job_leads", p.split("/")[4]);
			if (/^\/job-leads\/[^/]+\/triage$/.test(p)) return triageJobLead(e, p.split("/")[2], req);
			if (/^\/job-leads\/[^/]+\/browser-verification$/.test(p)) return applyJobLeadBrowserVerification(e, p.split("/")[2], req);
			return Response.json({ ok: true });
		},
	}),
};
const env = () => ({ DB: d1.DB, AGENT: agentDO }) as unknown as Env;

beforeEach(() => {
	d1 = realSchemaD1();
	stores = new Map();
	d1.exec(`INSERT INTO users (id, github_login) VALUES ('u1', 'u1'), ('u2', 'u2')`);
	d1.exec(`INSERT INTO agents (id, owner_id, slug, name, config) VALUES
	  ('scout-agent', 'u1', 't1056-scout', 'Job Search Scout', '{"capabilities":{"surfaces":[],"runtime":"local_browser","localBrowser":{}}}'),
	  ('chat-agent', 'u1', 'chat', 'Chat', '{}')`);
	d1.exec(`INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES
	  ('scout', 'scout-agent', 'u1', 'active', '{}'), ('scout-b', 'scout-agent', 'u1', 'active', '{}'),
	  ('chat', 'chat-agent', 'u1', 'active', '{}'), ('tailor', 'chat-agent', 'u1', 'active', '{}'),
	  ('other-scout', 'scout-agent', 'u2', 'active', '{}')`);
	d1.exec(`INSERT INTO agent_connections (id, user_id, source_instance_id, event_type, target_instance_id, action, config, enabled) VALUES ('c-lead', 'u1', 'scout', 'job.lead.apply_requested', 'tailor', 'generate_application_materials', '{}', 1)`);
});
afterEach(() => d1.close());

async function call(path: string, body: unknown) {
	const app = new Hono<{ Bindings: Env }>();
	app.route("/v1/instances", instanceRoutes);
	app.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500)));
	const res = await app.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, env());
	return { status: res.status, // biome-ignore lint/suspicious/noExplicitAny: response bodies are asserted field by field below
		body: (await res.json()) as Record<string, any> };
}
const intake = (url: string, instance = "scout", extra: Record<string, unknown> = {}) => call(`/v1/instances/${instance}/job-leads/manual-url`, { url, ...extra });
const receipts = () => d1.sqlite.prepare("SELECT outcome, canonical_url, provider, lead_id, rejection_reason, rejection_host, instance_id FROM job_lead_intake_receipts ORDER BY rowid").all() as Array<Record<string, unknown>>;
const verifications = () => d1.sqlite.prepare("SELECT instance_id, lead_id, work_key, canonical_url, state FROM job_lead_browser_verifications ORDER BY rowid").all() as Array<Record<string, unknown>>;
const deliveries = () => (d1.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_connection_deliveries").get() as { n: number }).n;
const lead = (id: string, instance = "scout") => stores.get(instance)?.get(id);

const SEEK = "https://www.seek.com.au/job/81234567?type=standard&ref=recom-homepage&sol=PERSONALSOL&tracking=PERSONALTRACK";
const SEEK_CANONICAL = "https://www.seek.com.au/job/81234567";
const LI = "https://www.linkedin.com/jobs/view/4012345678/?trackingId=PERSONAL%3D%3D&refId=PERSONAL&midToken=PERSONAL";
const LI_CANONICAL = "https://www.linkedin.com/jobs/view/4012345678";

describe("a valid owner-selected posting", () => {
	it.each([
		[SEEK, SEEK_CANONICAL, "seek"],
		[LI, LI_CANONICAL, "linkedin"],
	])("becomes ONE lead awaiting browser verification, queued behind the Scout's site policy: %s", async (url, canonical, provider) => {
		const res = await intake(url);
		expect(res.status).toBe(201);
		expect(res.body).toMatchObject({ ok: true, duplicate: false, canonicalUrl: canonical, provider, instanceId: "scout", verificationState: "awaiting", handoff: "none", receipt: { outcome: "created", canonicalUrl: canonical, provider } });
		const stored = lead(res.body.leadId as string);
		expect(stored?.data).toMatchObject({
			url: canonical,
			source: "manual_url",
			status: "awaiting_browser_verification",
			intake: { kind: "owner_selected", receipt_id: res.body.receipt.id },
			lifecycle: [{ from: null, to: "awaiting_browser_verification", action: "intake", version: 0 }],
			verification: { state: "awaiting_browser_verification", source: "manual_url", canonical_job_url: canonical },
		});
		expect(verifications()).toEqual([{ instance_id: "scout", lead_id: res.body.leadId, work_key: workKeyForLead({ url: canonical }), canonical_url: canonical, state: "awaiting" }]);
		expect(deliveries()).toBe(0); // never a handoff
	});

	it("never stores, returns or records the pasted link's personal tokens", async () => {
		const res = await intake(SEEK);
		const everything = JSON.stringify([res.body, [...(stores.get("scout")?.values() ?? [])], receipts(), verifications()]);
		expect(everything).not.toMatch(/PERSONAL|tracking=|sol=|ref=recom/);
	});

	it("a dry run validates and writes nothing", async () => {
		const res = await intake(SEEK, "scout", { dry_run: true });
		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ ok: true, dryRun: true, duplicate: false, canonicalUrl: SEEK_CANONICAL, receipt: null, leadId: null });
		expect(receipts()).toEqual([]);
		expect(stores.get("scout")?.size ?? 0).toBe(0);
	});
});

describe("idempotency per owner and canonical posting", () => {
	it("the same job pasted again with different tracking returns the first lead — into this Scout or another", async () => {
		const first = await intake(SEEK);
		const again = await intake("https://www.seek.com.au/job/81234567?tracking=OTHER&sol=OTHER");
		const elsewhere = await intake(SEEK, "scout-b");
		for (const r of [again, elsewhere]) {
			expect(r.status).toBe(200);
			expect(r.body).toMatchObject({ ok: true, duplicate: true, leadId: first.body.leadId, instanceId: "scout", receipt: { outcome: "duplicate", leadId: first.body.leadId } });
		}
		expect(stores.get("scout")?.size).toBe(1);
		expect(stores.get("scout-b")?.size ?? 0).toBe(0);
		expect(verifications()).toHaveLength(1);
		expect(receipts().map((r) => r.outcome)).toEqual(["created", "duplicate", "duplicate"]);
	});

	it("a job the Scout already holds (found in mail) keeps its own lifecycle; the receipt says duplicate", async () => {
		const leads = stores.set("scout", new Map()).get("scout")!;
		leads.set("gmail-1", { id: "gmail-1", collection: "job_leads", data: { url: SEEK_CANONICAL, work_key: workKeyForLead({ url: SEEK_CANONICAL }), status: "new", source: "Gmail" }, createdAt: "2026-10-12T00:00:00Z", updatedAt: "2026-10-12T00:00:00Z" } as CollectionRecord);
		const res = await intake(SEEK);
		expect(res.body).toMatchObject({ duplicate: true, leadId: "gmail-1", receipt: { outcome: "duplicate" } });
		expect(lead("gmail-1")?.data).toMatchObject({ status: "new", source: "Gmail" });
		expect(verifications()).toEqual([]);
	});

	it("another owner's intake of the same job is theirs, not a duplicate of this one", async () => {
		await intake(SEEK);
		d1.exec(`INSERT INTO job_lead_intake_receipts (id, user_id, instance_id, canonical_url, provider, lead_id, outcome) VALUES ('r-u2', 'u2', 'other-scout', '${SEEK_CANONICAL}', 'seek', 'x', 'created')`);
		expect(receipts().filter((r) => r.outcome === "created")).toHaveLength(2);
	});
});

describe("unsafe, personalised or non-posting URLs", () => {
	it.each([
		["http://www.seek.com.au/job/81234567", "not_https"],
		["https://169.254.169.254/latest/meta-data", "private_target"],
		["https://careers.acme.example/jobs/81234567", "provider_not_allowed"],
		["https://www.seek.com.au/jobs?keywords=engineer&sol=PERSONAL", "no_posting_id"],
	])("refuses %s with 422 %s — the receipt keeps the category and host, never the URL", async (url, reason) => {
		const res = await intake(url);
		expect(res.status).toBe(422);
		expect(res.body).toMatchObject({ reason, receipt: { outcome: "rejected", rejectionReason: reason, canonicalUrl: null } });
		expect(JSON.stringify([res.body, receipts()])).not.toContain(url);
		expect(JSON.stringify([res.body, receipts()])).not.toContain("PERSONAL");
		expect(stores.get("scout")?.size ?? 0).toBe(0);
		expect(verifications()).toEqual([]);
	});

	it("only a job Scout takes leads — never an arbitrary instance's collections", async () => {
		const res = await intake(SEEK, "chat");
		expect(res.status).toBe(409);
		expect(stores.get("chat")?.size ?? 0).toBe(0);
		expect(receipts()).toEqual([]);
	});

	it("a url is required", async () => {
		expect((await call("/v1/instances/scout/job-leads/manual-url", {})).status).toBe(400);
	});
});

describe("the lifecycle after browser verification — only verified active can be applied for", () => {
	const verdict = (leadId: string, outcome: string, exhausted = false) =>
		agentDO.get("scout").fetch(new Request(`https://agent/job-leads/${leadId}/browser-verification`, { method: "POST", body: JSON.stringify({ outcome, attempt: 1, receipt_id: "bva-1", exhausted }) }));
	const apply = (leadId: string) => call(`/v1/instances/scout/job-leads/${leadId}/triage`, { action: "apply" });

	it("before any verdict, Apply is refused", async () => {
		const { body } = await intake(SEEK);
		expect((await apply(body.leadId as string)).body.error).toMatch(/waiting for browser verification/);
		expect(deliveries()).toBe(0);
	});

	it("expired: the lead is closed and Apply is refused", async () => {
		const { body } = await intake(SEEK);
		await verdict(body.leadId as string, "expired");
		expect(lead(body.leadId as string)?.data).toMatchObject({ status: "archived", verification: { state: "unavailable" } });
		expect((await apply(body.leadId as string)).body.error).toBeTruthy();
		expect(deliveries()).toBe(0);
	});

	it("verification failed for good: unverifiable, and Apply is refused", async () => {
		const { body } = await intake(LI);
		await verdict(body.leadId as string, "temporarily_unverifiable", true);
		expect(lead(body.leadId as string)?.data).toMatchObject({ status: "unverifiable" });
		expect((await apply(body.leadId as string)).body.error).toMatch(/could not be verified/);
		expect(deliveries()).toBe(0);
	});

	it("verified active: only now may the owner Apply — the explicit triage, never the intake, hands it on", async () => {
		const { body } = await intake(SEEK);
		expect(deliveries()).toBe(0);
		await verdict(body.leadId as string, "active");
		expect(lead(body.leadId as string)?.data).toMatchObject({ status: "new", verification: { state: "live", reason: "browser_verified_active" } });
		const applied = await apply(body.leadId as string);
		expect(applied.status).toBe(200);
		expect(applied.body).toMatchObject({ transitioned: true, event: { eventType: "job.lead.apply_requested", leadUrl: SEEK_CANONICAL } });
	});
});
