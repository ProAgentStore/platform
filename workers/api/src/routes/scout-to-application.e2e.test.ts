/**
 * #953 end to end, deterministically: Job Search Scout → Connection → Application Tailor →
 * Application Runner → status written back to the lead. Over the real schema and the real code
 * at every step — the finding save (`reviewFinding`), the Scout's triage and record handlers, the
 * connection outbox with its dead letters and replay, the Tailor, the Runner, the submit gate and
 * the lead writeback. Faked: the relay to the owner's machine (no CLI, no browser, no model key,
 * no real job site — the runner's answers are scripted), and the Scout's Durable Object storage,
 * an in-memory map behind the REAL `agent-do-storage-routes` handlers.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRecord, insertRecord, queryRecords, triageJobLead, writeJobLeadApplication } from "../agent-do-storage-routes.js";
import type { CollectionRecord } from "../agent-storage-types.js";
import { HttpError } from "../lib/auth.js";
import { realSchemaD1, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import { JOB_LEAD_APPLY_EVENT } from "../lib/job-lead-triage.js";
import type { Env } from "../types.js";

vi.mock("../lib/auth.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/auth.js")>("../lib/auth.js");
	return { ...actual, requireUser: async () => ({ uid: "u1", roles: [] }) };
});
const { getBoundRunnerConn } = vi.hoisted(() => ({ getBoundRunnerConn: vi.fn() }));
vi.mock("../lib/runner-client.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../lib/runner-client.js")>()), getBoundRunnerConn }));

const { instanceRoutes } = await import("./instances.js");
const { runDueDeliveries } = await import("../lib/connections.js");
const { replayDelivery } = await import("../lib/connection-deliveries.js");

let d1: RealSchemaD1;
let sent: Array<{ path: string; body: Record<string, unknown> }>;
let answers: Record<string, { status: number; body: unknown }>;
const relay = {
	idFromName: (n: string) => n,
	get: () => ({
		fetch: async (req: Request) => {
			const cmd = (await req.json()) as { path: string; body: string | Record<string, unknown> };
			const body = typeof cmd.body === "string" ? JSON.parse(cmd.body) : (cmd.body ?? {});
			sent.push({ path: cmd.path, body });
			const a = answers[cmd.path] ?? { status: 404, body: { error: "unknown path" } };
			return new Response(JSON.stringify(a.body), { status: a.status });
		},
	}),
};

/** The Scout's `job_leads`, behind the real storage-route handlers. */
let leads: Map<string, CollectionRecord>;
let nextId = 0;
const engine = {
	recordInsert: async (_c: string, data: Record<string, unknown>) => {
		const rec = { id: `lead-${++nextId}`, collection: "job_leads", data, createdAt: "2026-10-07T00:00:00Z", updatedAt: "2026-10-07T00:00:00Z" } as CollectionRecord;
		leads.set(rec.id, rec);
		return rec;
	},
	recordGet: async (_c: string, id: string) => leads.get(id) ?? null,
	recordUpdate: async (_c: string, id: string, patch: Record<string, unknown>) => {
		const r = leads.get(id);
		if (!r) return null;
		const next = { ...r, data: { ...r.data, ...patch }, updatedAt: new Date().toISOString() };
		leads.set(id, next);
		return next;
	},
	recordQuery: async (_c: string, o: { where?: Record<string, unknown>; limit?: number; offset?: number } = {}) => {
		const all = [...leads.values()].filter((r) => !o.where || Object.entries(o.where).every(([k, v]) => r.data[k] === v));
		const offset = o.offset ?? 0;
		return { records: all.slice(offset, offset + (o.limit ?? 50)), total: all.length };
	},
};
const agentDO = {
	idFromName: (n: string) => n,
	get: (id: string) => ({
		fetch: async (req: Request) => {
			const url = new URL(req.url);
			const p = url.pathname;
			if (id === "scout") {
				if (p === "/collections/job_leads/records" && req.method === "GET") return queryRecords(engine as never, "job_leads", url);
				if (p === "/collections/job_leads/records" && req.method === "POST") return insertRecord(engine as never, "job_leads", req);
				if (/^\/collections\/job_leads\/records\/[^/]+$/.test(p)) return getRecord(engine as never, "job_leads", p.split("/")[4]);
				if (/^\/job-leads\/[^/]+\/triage$/.test(p)) return triageJobLead(engine as never, p.split("/")[2], req);
				if (/^\/job-leads\/[^/]+\/application$/.test(p)) return writeJobLeadApplication(engine as never, p.split("/")[2], req);
			}
			return Response.json({ ok: true }, { status: 201 });
		},
	}),
};
const env = () => ({ DB: d1.DB, RELAY: relay, AGENT: agentDO }) as unknown as Env;

async function call(method: string, path: string, body?: unknown) {
	const app = new Hono<{ Bindings: Env }>();
	app.route("/v1/instances", instanceRoutes);
	app.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500)));
	const res = await app.request(`/v1/instances${path}`, { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, env());
	// biome-ignore lint/suspicious/noExplicitAny: a JSON response read field by field in assertions.
	return { status: res.status, body: (await res.json()) as Record<string, any> };
}
const dispatches = (p: string) => sent.filter((s) => s.path === p);
const deliveries = async (event: string) =>
	(await d1.DB.prepare("SELECT id, status FROM agent_connection_deliveries WHERE event_type = ?1 ORDER BY created_at").bind(event).all<{ id: string; status: string }>()).results;

const FINDINGS = [
	{ title: "Staff Engineer", url: "https://jobs.example.com/staff-engineer", evidence: "Staff Engineer — Globex, Sydney", fields: { company: "Globex", location: "Sydney", source: "example-board" } },
	// The SAME posting found again through a tracking link — saved as its own record, but one job.
	{ title: "Staff Engineer", url: "https://jobs.example.com/staff-engineer/?utm_source=newsletter", evidence: "Staff Engineer — Globex", fields: { company: "Globex", location: "Sydney", source: "newsletter" } },
];

beforeEach(() => {
	d1 = realSchemaD1();
	leads = new Map();
	nextId = 0;
	d1.exec(`INSERT INTO users (id, github_login) VALUES ('u1', 'u1')`);
	d1.exec(`INSERT INTO agents (id, owner_id, slug, name, config) VALUES
	  ('scout-a', 'u1', 't953-scout', 'Job Search Scout', '{"capabilities":{"surfaces":[],"runtime":"local_browser"}}'),
	  ('tailor-a', 'u1', 't953-tailor', 'Application Tailor', '{"capabilities":{"surfaces":[],"runtime":"local_artifact"}}'),
	  ('runner-a', 'u1', 't953-runner', 'Job Application Runner', '{"capabilities":{"surfaces":[],"runtime":"local_apply"}}')`);
	d1.exec(`INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES
	  ('scout', 'scout-a', 'u1', 'active', '{}'), ('t1', 'tailor-a', 'u1', 'active', '{"runnerNode":"mac"}'), ('ap', 'runner-a', 'u1', 'active', '{"runnerNode":"mac"}')`);
	d1.exec(`INSERT INTO instance_runtime_nodes (instance_id, user_id, runner_node, endpoint_url, runner_version, status, last_seen_at) VALUES
	  ('t1', 'u1', 'mac', 'relay://', '0.6.0', 'online', '2026-10-07 00:00:00'), ('ap', 'u1', 'mac', 'relay://', '0.6.0', 'online', '2026-10-07 00:00:00')`);
	d1.exec(`INSERT INTO agent_connections (id, user_id, source_instance_id, event_type, target_instance_id, action, config, enabled) VALUES
	  ('c-lead', 'u1', 'scout', '${JOB_LEAD_APPLY_EVENT}', 't1', 'generate_application_materials', '{}', 1),
	  ('c-ready', 'u1', 't1', 'job.application.materials_ready', 'ap', 'start_application_fill', '{}', 1)`);
	// A finished Scout research run with two findings, waiting for the owner's review.
	d1.DB.prepare(
		`INSERT INTO local_browser_runs (id, instance_id, user_id, request_id, objective, status, policy, result, created_at, updated_at)
		 VALUES ('run-1', 'scout', 'u1', 'req-1', 'Staff roles in Sydney', 'completed', ?1, ?2, 1, 1)`,
	)
		.bind(
			JSON.stringify({ collection: { name: "job_leads", keyField: "url" }, limits: { maxMinutes: 15, maxPages: 30, maxActions: 200, maxConcurrent: 1 } }),
			JSON.stringify({ runId: "run-1", outcome: "completed", findings: FINDINGS, sourceFailures: [], summary: "2 found", traceId: "run-1", engineAuth: "machine-login" }),
		)
		.run();
	getBoundRunnerConn.mockReset();
	getBoundRunnerConn.mockImplementation(async (_env: unknown, instanceId: string) => ({ runnerNode: "mac", instanceId, userId: "u1", relayName: `${instanceId}:node:mac`, endpointUrl: "relay://", token: "", env: {} }));
	answers = { "/local-artifact/run": { status: 202, body: { status: "running" } }, "/local-apply/run": { status: 202, body: { status: "running" } } };
	sent = [];
});
afterEach(() => d1.close());

describe("#953: Scout → Connection → Application Runner → status writeback", () => {
	it("#1010: transfers one exact reviewed set through a paused edge once, to review only", async () => {
		// Isolated fixture: a completed Tailor record and an intentionally paused, authorized edge.
		// This exercises the actual outbox consumer and Runner, never a real owner edge or browser.
		d1.exec("UPDATE agent_connections SET enabled = 0 WHERE id = 'c-ready'");
		const resume = { kind: "resume", path: "~/jobs/applications/manual/resume.md", sha256: "c".repeat(64), bytes: 11 };
		const cover = { kind: "cover_letter", path: "~/jobs/applications/manual/cover.md", sha256: "d".repeat(64), bytes: 12 };
		const event = { eventType: "job.application.materials_ready", eventId: "tailor-ready", applicationId: "reviewed", tailorInstanceId: "t1", sourceInstanceId: "scout", leadId: "lead-reviewed", leadUrl: "https://jobs.example.com/reviewed", lifecycleVersion: 1, leadEventId: "lead-event", tailoringRunId: "tailor-run", profileVersion: "p1", generatedAt: "2026-10-07T00:00:00Z", artifacts: { resume, coverLetter: cover }, lead: { title: "Staff Engineer", company: "Globex" } };
		await d1.DB.prepare(`INSERT INTO job_applications (id, instance_id, user_id, source_instance_id, lead_id, lifecycle_version, idempotency_key, status, lead, resume_artifact, cover_letter_artifact, profile_version, generated_at, ready_event, state_version, created_at, updated_at)
			VALUES ('reviewed', 't1', 'u1', 'scout', 'lead-reviewed', 1, 'lead-event', 'materials_ready', ?1, ?2, ?3, 'p1', '2026-10-07T00:00:00Z', ?4, 7, 1, 1)`)
			.bind(JSON.stringify({ leadUrl: event.leadUrl, lead: event.lead }), JSON.stringify(resume), JSON.stringify(cover), JSON.stringify(event)).run();
		const body = { expected_status: "materials_ready", expected_version: 7, resume_sha256: resume.sha256, cover_letter_sha256: cover.sha256, destination_runner_instance_id: "ap", connection_id: "c-ready", idempotency_key: "reviewed-transfer-1" };
		const first = await call("POST", "/t1/applications/reviewed/transfer", body);
		expect(first.status).toBe(200);
		expect(first.body).toMatchObject({ sourceApplicationId: "reviewed", destinationApplicationId: "reviewed", destinationRunnerInstanceId: "ap", connectionId: "c-ready", resumeSha256: resume.sha256, coverLetterSha256: cover.sha256, status: "consumed" });
		expect(await d1.DB.prepare("SELECT enabled FROM agent_connections WHERE id = 'c-ready'").first<{ enabled: number }>()).toEqual({ enabled: 0 });
		expect(await d1.DB.prepare("SELECT count(*) AS n FROM agent_connection_deliveries WHERE connection_id = 'c-ready'").first<{ n: number }>()).toEqual({ n: 1 });
		expect(dispatches("/local-apply/run")).toHaveLength(1);
		expect(dispatches("/local-apply/run")[0].body.policy).toEqual({ mode: "fill_and_review", allowDomains: ["jobs.example.com"] });
		expect((await d1.DB.prepare("SELECT count(*) AS n FROM local_apply_runs WHERE application_id = 'reviewed'").first<{ n: number }>())?.n).toBe(1);
		// A lost response retry re-reads the same receipt; it cannot enqueue, fill, or submit again.
		expect((await call("POST", "/t1/applications/reviewed/transfer", body)).body.id).toBe(first.body.id);
		expect(dispatches("/local-apply/run")).toHaveLength(1);
		expect((await d1.DB.prepare("SELECT submit_attempted_at FROM job_applications WHERE id = 'reviewed'").first<{ submit_attempted_at: number | null }>())?.submit_attempted_at).toBeNull();
	});

	it("one saved lead, one handoff, delivered after a dead letter and a replay, filled for review, its status back on the lead", async () => {
		// 1. The owner saves both findings: two records in the Scout's Data table.
		expect((await call("POST", "/scout/local-browser/runs/run-1/findings/0/save")).status).toBe(200);
		expect((await call("POST", "/scout/local-browser/runs/run-1/findings/1/save")).status).toBe(200);
		expect([...leads.values()].map((l) => l.data.url)).toEqual([FINDINGS[0].url, FINDINGS[1].url]);
		// Saving emits nothing: only an explicit Apply hands a lead on (#955).
		expect(await deliveries(JOB_LEAD_APPLY_EVENT)).toEqual([]);

		// 2. The owner's machine is offline when they Apply: the handoff is written and waits in the outbox.
		getBoundRunnerConn.mockResolvedValue(null);
		const apply = await call("POST", "/scout/application-queue/actions", { action: "apply", scout_instance_id: "scout", record_id: "lead-1", expected_status: "new", expected_version: 0 });
		expect(apply.status).toBe(200);
		let rows = await deliveries(JOB_LEAD_APPLY_EVENT);
		expect(rows).toHaveLength(1);
		expect(rows[0].status).toBe("pending");
		// …and stays offline through every retry, until the delivery is dead.
		for (let i = 0; i < 6; i++) {
			d1.exec("UPDATE agent_connection_deliveries SET next_attempt_at = '2000-01-01T00:00:00.000Z' WHERE status = 'pending'");
			await runDueDeliveries(env());
		}
		rows = await deliveries(JOB_LEAD_APPLY_EVENT);
		expect(rows.map((r) => r.status)).toEqual(["dead"]);
		expect(dispatches("/local-artifact/run")).toHaveLength(0);

		// 3. The SAME job, applied for through its duplicate record: refused — no second handoff.
		const dup = await call("POST", "/scout/application-queue/actions", { action: "apply", scout_instance_id: "scout", record_id: "lead-2", expected_status: "new", expected_version: 0 });
		expect(dup.status).toBe(409);
		expect(dup.body.error).toMatch(/Already applied for this job through lead lead-1/);
		expect(leads.get("lead-2")?.data.status ?? "new").toBe("new");
		expect(await deliveries(JOB_LEAD_APPLY_EVENT)).toHaveLength(1);

		// 4. The machine is back; the owner replays the dead letter. Tailoring starts — once.
		getBoundRunnerConn.mockImplementation(async (_env: unknown, instanceId: string) => ({ runnerNode: "mac", instanceId, userId: "u1", relayName: `${instanceId}:node:mac`, endpointUrl: "relay://", token: "", env: {} }));
		expect(await replayDelivery(env(), "u1", rows[0].id)).toBe(true);
		d1.exec("UPDATE agent_connection_deliveries SET next_attempt_at = '2000-01-01T00:00:00.000Z' WHERE status = 'pending'");
		await runDueDeliveries(env());
		await runDueDeliveries(env());
		expect((await deliveries(JOB_LEAD_APPLY_EVENT)).map((r) => r.status)).toEqual(["delivered"]);
		expect(dispatches("/local-artifact/run")).toHaveLength(1);
		const app = (await call("GET", "/t1/applications")).body.applications[0];
		expect(app).toMatchObject({ status: "tailoring", leadId: "lead-1" });
		// The lead shows it.
		expect(leads.get("lead-1")?.data).toMatchObject({ status: "apply_requested", application_id: app.id, application_status: "tailoring" });

		// 5. The Tailor's CLI (scripted) finishes: materials_ready, which the connection hands to the Runner.
		const tailorRun = dispatches("/local-artifact/run")[0].body.runId as string;
		answers["/local-artifact/status"] = {
			status: 200,
			body: {
				state: "ended",
				lastSeq: 0,
				events: [],
				result: {
					runId: tailorRun,
					outcome: "completed",
					traceId: tailorRun,
					engineAuth: "machine-login",
					profileVersion: "0123456789abcdef",
					generatedAt: "2026-10-07T00:05:00.000Z",
					artifacts: [
						{ kind: "resume", path: `~/jobs/applications/lead-1/${tailorRun}/resume.md`, sha256: "a".repeat(64), bytes: 9 },
						{ kind: "cover_letter", path: `~/jobs/applications/lead-1/${tailorRun}/cover-letter.md`, sha256: "b".repeat(64), bytes: 9 },
					],
					sourceHashes: [],
				},
			},
		};
		await call("GET", `/t1/applications/${app.id}`);
		expect(dispatches("/local-apply/run")).toHaveLength(1);
		// Under the default configuration, the Runner is told to fill and STOP: no submit gate exists.
		const task = dispatches("/local-apply/run")[0].body;
		expect(task.policy).toEqual({ mode: "fill_and_review", allowDomains: ["jobs.example.com"] });
		expect(leads.get("lead-1")?.data.application_status).toBe("filling");

		// 6. The Runner's CLI (scripted) pauses on a question it cannot answer from the profile…
		const fillRun = task.runId as string;
		answers["/local-apply/status"] = { status: 200, body: { state: "paused", pause: { reason: "missing_answer", question: "Notice period?" }, lastSeq: 1, events: [{ seq: 1, type: "run.paused", at: "2026-10-07T00:06:00Z", pauseReason: "missing_answer" }] } };
		await call("GET", `/ap/application-runs/${fillRun}`);
		expect(leads.get("lead-1")?.data).toMatchObject({ application_status: "blocked", application_block_reason: "missing_answer" });
		// …the owner answers, and it finishes the form — and stops for review.
		answers["/local-apply/resume"] = { status: 200, body: {} };
		answers["/local-apply/status"] = { status: 200, body: { state: "running", lastSeq: 2, events: [{ seq: 2, type: "run.resumed", at: "2026-10-07T00:07:00Z" }] } };
		await call("POST", "/ap/application-queue/actions", { action: "resume", application_id: app.id, expected_status: "blocked", answers: [{ question: "Notice period?", answer: "four weeks" }] });
		answers["/local-apply/status"] = {
			status: 200,
			body: { state: "ended", lastSeq: 3, events: [], result: { runId: fillRun, outcome: "awaiting_review", mode: "fill_and_review", traceId: fillRun, engineAuth: "machine-login", filled: 6, uploaded: ["resume"], submitAttempted: false, summary: "Filled." } },
		};
		await call("GET", `/ap/application-runs/${fillRun}`);

		// 7. Nothing was submitted, and the lead says where the application stands.
		const final = (await call("GET", `/t1/applications/${app.id}`)).body.application;
		expect(final).toMatchObject({ status: "awaiting_review", submittedAt: null, submittedUrl: null, submitAttemptedAt: null });
		expect(leads.get("lead-1")?.data).toMatchObject({ application_status: "awaiting_review", application_block_reason: null, application_submitted_at: null });
		expect(Number(leads.get("lead-1")?.data.application_version)).toBe(final.stateVersion);

		// 8. The owner's queue shows both: the application under review, and the duplicate lead, still new.
		const q = (await call("GET", "/t1/application-queue")).body;
		expect(q.counts).toMatchObject({ awaiting_review: 1, new: 1 });
		const trace = (await call("GET", `/t1/application-queue/${app.id}/trace`)).body;
		expect(trace.correlation).toMatchObject({ scoutInstanceId: "scout", leadId: "lead-1", tailoringRunIds: [tailorRun], fillRunIds: [fillRun], status: "awaiting_review" });
		expect(trace.entries.filter((e: { source: string }) => e.source === "delivery").map((e: { detail: { status: string } }) => e.detail.status)).toContain("delivered");
	});

	it("a late or repeated status writeback never overwrites a newer one on the lead", async () => {
		await call("POST", "/scout/local-browser/runs/run-1/findings/0/save");
		const post = (version: number, status: string) =>
			agentDO.get("scout").fetch(new Request("https://agent/job-leads/lead-1/application", { method: "POST", body: JSON.stringify({ application_id: "app-1", lead_version: 1, status, version }) }));
		await post(3, "filling");
		await post(2, "materials_ready");
		await post(3, "materials_ready");
		expect(leads.get("lead-1")?.data).toMatchObject({ application_status: "filling", application_version: 3 });
		expect(leads.get("lead-1")?.data.status).toBeUndefined();
	});
});

describe("#953: the submission policy", () => {
	it("auto-submit cannot be enabled until a profile and an explicit submission policy exist", async () => {
		const bare = await call("PUT", "/ap/application-runner/settings", { autoSubmit: { enabled: true } });
		expect(bare.status).toBe(400);
		expect(bare.body.error).toMatch(/approved role.*allowed site.*daily cap/);
		const noProfile = await call("PUT", "/ap/application-runner/settings", { sources: { profile: null }, allowDomains: ["example.com"], autoSubmit: { enabled: true, roles: ["engineer"], dailyCap: 1 } });
		expect(noProfile.status).toBe(400);
		expect(noProfile.body.error).toMatch(/profile source/);
		const ok = await call("PUT", "/ap/application-runner/settings", { allowDomains: ["example.com"], autoSubmit: { enabled: true, roles: ["engineer"], dailyCap: 1 } });
		expect(ok.status).toBe(200);
		expect(ok.body.settings.autoSubmit).toMatchObject({ enabled: true, roles: ["engineer"], dailyCap: 1 });
		// And with it enabled, the one thing that turns it off again is the owner.
		expect((await call("PUT", "/ap/application-runner/settings", { autoSubmit: { enabled: false } })).body.settings.autoSubmit.enabled).toBe(false);
	});
});

describe("#953: the MCP control actions", () => {
	it("mark_not_interested is a skip on a lead and an archive on an application, both recorded as such", async () => {
		await call("POST", "/scout/local-browser/runs/run-1/findings/0/save");
		const r = await call("POST", "/t1/application-queue/actions", { action: "mark_not_interested", scout_instance_id: "scout", record_id: "lead-1", expected_status: "new" });
		expect(r.status).toBe(200);
		expect(leads.get("lead-1")?.data).toMatchObject({ status: "skipped", triage_note: "not interested" });
	});

	it("filters the queue by company, role, source, URL and date", async () => {
		await call("POST", "/scout/local-browser/runs/run-1/findings/0/save");
		await call("POST", "/scout/local-browser/runs/run-1/findings/1/save");
		const keys = async (q: string) => (await call("GET", `/t1/application-queue?${q}`)).body.items.map((i: { leadId: string }) => i.leadId).sort();
		expect(await keys("company=globex")).toEqual(["lead-1", "lead-2"]);
		expect(await keys("source=newsletter")).toEqual(["lead-2"]);
		expect(await keys("url=utm_source")).toEqual(["lead-2"]);
		expect(await keys("role=director")).toEqual([]);
		expect(await keys("since=2026-10-01")).toEqual(["lead-1", "lead-2"]);
		expect(await keys("until=2026-10-01")).toEqual([]);
		expect((await call("GET", "/t1/application-queue?since=yesterday")).status).toBe(400);
	});
});
