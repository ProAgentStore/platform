/**
 * #1096 — a Job Search Scout's research run writes what it found into `job_leads` when it completes.
 *
 * Run 1a01120e found 26 jobs and produced no lead: every finding sat at `pending` (added 0,
 * recordIds []), waiting on a per-finding save nobody was asked for. Over the real routes and the real
 * schema — only the runner relay and the Scout's Durable Object are faked, the DO modelling its
 * job-lead create-or-get by work key — these drive the run's end exactly as the pull does (GET the
 * run → the runner reports `ended` with its result) and read back the leads, the verification queue
 * and the scan's telemetry.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { BROWSER_VERIFICATION_DEFAULTS, writeBrowserVerification } from "../lib/browser-verification.js";
import { realSchemaD1, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import { listLeadVerifications } from "../lib/job-lead-browser-verification.js";
import type { Env } from "../types.js";

vi.mock("../lib/auth.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/auth.js")>("../lib/auth.js");
	return { ...actual, requireUser: async () => ({ uid: "u1", roles: [] }) };
});
const { getBoundRunnerConn } = vi.hoisted(() => ({ getBoundRunnerConn: vi.fn() }));
vi.mock("../lib/runner-client.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../lib/runner-client.js")>()), getBoundRunnerConn }));

const { instanceRoutes } = await import("./instances.js");

let d1: RealSchemaD1;
let runnerPaths: Record<string, { status: number; body: unknown }>;
type Rec = { id: string; data: Record<string, unknown> };
let collections: Record<string, Rec[]>;
let storeFails: (data: Record<string, unknown>) => boolean;

const relay = {
	idFromName: (n: string) => n,
	get: () => ({
		fetch: async (req: Request) => {
			const cmd = (await req.json()) as { path: string };
			if (cmd.path === "/capabilities") return Response.json({ taskTypes: ["local_browser.research"] });
			const byPath = runnerPaths[cmd.path];
			return byPath ? new Response(JSON.stringify(byPath.body), { status: byPath.status }) : new Response(JSON.stringify({ taskId: "t1" }), { status: 202 });
		},
	}),
};
/** The Scout's DO: collection reads by `where`, and `job_leads` create-or-get by work key (agent-storage/collections.ts). */
const agentDO = {
	idFromName: (n: string) => n,
	get: () => ({
		fetch: async (req: Request) => {
			const url = new URL(req.url);
			const name = decodeURIComponent(url.pathname.split("/")[2] ?? "");
			if (!collections[name]) collections[name] = [];
			const rows = collections[name];
			if (req.method === "GET") {
				const where = JSON.parse(url.searchParams.get("where") || "{}") as Record<string, unknown>;
				const records = rows.filter((r) => Object.entries(where).every(([k, v]) => r.data[k] === v));
				return Response.json({ records, total: records.length });
			}
			const { data } = (await req.json()) as { data: Record<string, unknown> };
			if (storeFails(data)) return Response.json({ error: "storage unavailable" }, { status: 500 });
			if (name === "job_leads") {
				const held = rows.find((r) => r.data.work_key === data.work_key);
				if (held) return Response.json({ ...held, created: false });
			}
			const record = { id: `rec_${Object.values(collections).flat().length + 1}`, data };
			rows.push(record);
			return Response.json(name === "job_leads" ? { ...record, created: true } : record, { status: 201 });
		},
	}),
};

beforeEach(() => {
	d1 = realSchemaD1();
	d1.exec(`INSERT INTO users (id, github_login) VALUES ('u1', 'u1')`);
	d1.exec(`INSERT INTO agents (id, owner_id, slug, name, config) VALUES
	  ('scout', 'u1', 't1096-scout', 'Job Search Scout', '{"capabilities":{"surfaces":[],"runtime":"local_browser","localBrowser":{"allowDomains":["seek.com.au","indeed.com"]}}}')`);
	d1.exec(`INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES ('i1', 'scout', 'u1', 'active', '{"runnerNode":"mac"}')`);
	d1.exec(`INSERT INTO instance_runtime_nodes (instance_id, user_id, runner_node, endpoint_url, runner_version, status, last_seen_at) VALUES ('i1', 'u1', 'mac', 'relay://', '0.5.0', 'online', '2026-10-15 00:00:00')`);
	getBoundRunnerConn.mockReset();
	getBoundRunnerConn.mockResolvedValue({ runnerNode: "mac", instanceId: "i1", userId: "u1", relayName: "i1:node:mac", endpointUrl: "relay://", token: "", env: {} });
	runnerPaths = {};
	collections = {};
	storeFails = () => false;
});
afterEach(() => d1.close());

const env = () => ({ DB: d1.DB, RELAY: relay, AGENT: agentDO }) as unknown as Env;
async function call(method: string, path: string, body?: unknown) {
	const app = new Hono<{ Bindings: Env }>();
	app.route("/v1/instances", instanceRoutes);
	app.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500)));
	const res = await app.request(`/v1/instances${path}`, { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, env());
	// biome-ignore lint/suspicious/noExplicitAny: test reads arbitrary JSON reply fields
	return { status: res.status, body: (await res.json()) as Record<string, any> };
}

/** A finding as run 1a01120e's carried them — including the runner's own `status: "new"` and a forged lifecycle field. */
const finding = (n: number, over: Record<string, unknown> = {}) => ({
	title: `Engineering Manager ${n}`,
	url: `https://www.seek.com.au/job/9470${String(n).padStart(4, "0")}`,
	evidence: `Engineering Manager ${n} — Melbourne`,
	fields: { company: `Co ${n}`, status: "new", source: "seek", apply_request_id: "forged", ...over },
});

/** Start a scan and let it end with these findings — the pull a run read performs. */
async function scanEndingWith(findings: unknown[], collection: Record<string, unknown> | null = { name: "job_leads", keyField: "url" }) {
	if (collection) await call("PUT", "/i1/local-browser/settings", { collection });
	const run = (await call("POST", "/i1/local-browser/runs", { objective: "Find engineering leadership roles" })).body;
	runnerPaths["/local-browser/status"] = {
		status: 200,
		body: { runId: run.id, state: "ended", lastSeq: 0, events: [], result: { runId: run.id, outcome: "completed", traceId: run.id, engineAuth: "subscription", summary: "found", findings, sourceFailures: [] } },
	};
	const ended = (await call("GET", `/i1/local-browser/runs/${run.id}`)).body;
	expect(ended.status).toBe("completed");
	return run.id as string;
}
const telemetry = async (runId: string) => (await call("GET", `/i1/local-browser/runs/${runId}`)).body.telemetry;
const leads = () => collections.job_leads ?? [];

describe("browser verification OFF: every found job is written as a `new` lead (#1096)", () => {
	it("writes each finding, populates recordIds, and leaves nothing pending", async () => {
		const runId = await scanEndingWith([1, 2, 3, 4, 5].map((n) => finding(n)));
		expect(leads()).toHaveLength(5);
		const t = await telemetry(runId);
		expect(t.leads).toMatchObject({ added: 5, duplicates: 0, skipped: 0, pending: 0 });
		expect(t.leads.recordIds).toEqual(leads().map((r) => r.id));
		expect(t.rejections ?? []).not.toContainEqual(expect.objectContaining({ reason: "pending" }));
		expect(t.terminal.reason).toBe("5 lead(s) added from 5 result(s) across 0 page(s).");
	});

	it("each lead is a triageable `new` job lead with its provenance, never a page's lifecycle claim", async () => {
		const runId = await scanEndingWith([finding(1)]);
		const lead = leads()[0].data;
		expect(lead).toMatchObject({
			url: "https://www.seek.com.au/job/94700001",
			title: "Engineering Manager 1",
			company: "Co 1",
			source: "seek",
			status: "new",
			work_key: "seek:94700001",
			lifecycle_version: 0,
			sourceRunId: runId,
			intake: { kind: "local_browser_research", run_id: runId, finding_index: 0 },
			verification: { state: "research_observed", source: "local_browser_research" },
		});
		expect(lead.lifecycle).toEqual([expect.objectContaining({ from: null, to: "new", action: "intake", note: "local_browser_research" })]);
		expect(lead).not.toHaveProperty("apply_request_id");
	});

	it("dedupes by the key field against Data, and by work key within one run", async () => {
		collections.job_leads = [{ id: "rec_old", data: { url: finding(1).url, work_key: "seek:94700001", status: "new" } }];
		const runId = await scanEndingWith([finding(1), finding(2), { ...finding(2), title: "Same job, other listing" }]);
		const t = await telemetry(runId);
		expect(t.leads).toMatchObject({ added: 1, duplicates: 2, pending: 0 });
		expect(leads()).toHaveLength(2);
	});

	it("never re-creates a lead for a job that already has an application", async () => {
		d1.exec(`INSERT INTO job_applications (id, instance_id, user_id, source_instance_id, lead_id, lifecycle_version, idempotency_key, lead, created_at, updated_at, work_key)
		  VALUES ('app1', 'i1', 'u1', 'i1', 'gone', 1, 'k1', '{}', 0, 0, 'seek:94700003')`);
		const runId = await scanEndingWith([finding(3)]);
		expect(leads()).toHaveLength(0);
		expect((await call("GET", `/i1/local-browser/runs/${runId}`)).body.findingReviews["0"]).toMatchObject({ decision: "skipped", reason: "prior_application", basis: "auto" });
	});
});

describe("browser verification ON: written AND queued, never dropped (#1096)", () => {
	it("stores each as awaiting_browser_verification and puts it on the verification queue", async () => {
		await writeBrowserVerification(env(), "i1", "u1", { ...BROWSER_VERIFICATION_DEFAULTS, enabled: true });
		const runId = await scanEndingWith([finding(1), finding(2)]);
		expect(leads().map((r) => r.data.status)).toEqual(["awaiting_browser_verification", "awaiting_browser_verification"]);
		expect(leads()[0].data.verification).toMatchObject({ state: "awaiting_browser_verification", source: "local_browser_research" });
		const queue = await listLeadVerifications(env(), "i1", "u1");
		expect(queue.leads.map((l) => l.leadId).sort()).toEqual(leads().map((r) => r.id).sort());
		expect((await telemetry(runId)).leads).toMatchObject({ added: 2, pending: 0 });
	});
});

describe("what is not stored is still on the run, and the outcome says so (#1096)", () => {
	it("a store failure leaves that finding unreviewed — saveable by hand — and the reason does not claim a queue", async () => {
		storeFails = (data) => data.work_key === "seek:94700002";
		const runId = await scanEndingWith([finding(1), finding(2)]);
		const t = await telemetry(runId);
		expect(t.leads).toMatchObject({ added: 1, pending: 1 });
		expect(t.terminal.reason).toMatch(/1 lead\(s\) added from 2 result\(s\); 1 not in your Data yet — kept on this run until you save or skip each \(review_local_browser_finding\)/);
		expect(t.terminal.reason).not.toMatch(/waiting for your review/);
		storeFails = () => false;
		const saved = await call("POST", `/i1/local-browser/runs/${runId}/findings/1/save`);
		expect(saved.body.findingReviews["1"]).toMatchObject({ decision: "saved" });
		expect((await telemetry(runId)).leads).toMatchObject({ added: 2, pending: 0 });
	});

	it("a general research collection keeps the owner's review (#946): nothing is written by the run", async () => {
		const runId = await scanEndingWith([finding(1)], { name: "research_notes" });
		expect(collections.research_notes ?? []).toHaveLength(0);
		expect((await telemetry(runId)).leads).toMatchObject({ added: 0, pending: 1 });
	});
});
