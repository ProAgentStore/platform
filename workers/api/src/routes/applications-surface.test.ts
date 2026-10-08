/**
 * The Applications control surface (#958) over the real schema: the routes the console tab AND the
 * typed MCP tools call (`workers/mcp/src/instance-tools/applications.ts` posts the same bodies to
 * them — its own test holds that), over one service. Faked:
 * the relay/runner seam, and the Scout's Durable Object — whose triage and record reads are the REAL
 * `agent-do-storage-routes` handlers over an in-memory record store.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRecord, queryRecords, triageJobLead } from "../agent-do-storage-routes.js";
import { HttpError } from "../lib/auth.js";
import { realSchemaD1, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import { JOB_LEAD_APPLY_EVENT } from "../lib/job-lead-triage.js";
import { RECONCILE_LIMIT } from "../lib/applications/application-board.js";
import type { Env } from "../types.js";

vi.mock("../lib/auth.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/auth.js")>("../lib/auth.js");
	return { ...actual, requireUser: async () => ({ uid: "u1", roles: [] }) };
});
const { getBoundRunnerConn } = vi.hoisted(() => ({ getBoundRunnerConn: vi.fn() }));
vi.mock("../lib/runner-client.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../lib/runner-client.js")>()), getBoundRunnerConn }));

const { instanceRoutes } = await import("./instances.js");

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

type Rec = { id: string; collection: string; data: Record<string, unknown>; createdAt: string; updatedAt: string };
let leads: Map<string, Rec>;
const engine = {
	recordGet: async (_c: string, id: string) => leads.get(id) ?? null,
	recordUpdate: async (_c: string, id: string, patch: Record<string, unknown>) => {
		const r = leads.get(id);
		if (!r) return null;
		const next = { ...r, data: { ...r.data, ...patch }, updatedAt: new Date().toISOString() };
		leads.set(id, next);
		return next;
	},
	recordQuery: async () => ({ records: [...leads.values()], total: leads.size }),
};
/** The Scout's DO: the real storage-route handlers. Other instances' DOs answer task posts only. */
const agentDO = {
	idFromName: (n: string) => n,
	get: (id: string) => ({
		fetch: async (req: Request) => {
			const url = new URL(req.url);
			const p = url.pathname;
			if (id === "scout" && p === "/collections/job_leads/records" && req.method === "GET") return queryRecords(engine as never, "job_leads", url);
			if (id === "scout" && /^\/collections\/job_leads\/records\/[^/]+$/.test(p)) return getRecord(engine as never, "job_leads", p.split("/")[4]);
			if (id === "scout" && /^\/job-leads\/[^/]+\/triage$/.test(p)) return triageJobLead(engine as never, p.split("/")[2], req);
			return Response.json({ ok: true }, { status: 201 });
		},
	}),
};
const env = () => ({ DB: d1.DB, RELAY: relay, AGENT: agentDO }) as unknown as Env;

const SHA_R = "a".repeat(64);
const SHA_C = "b".repeat(64);
const lead = (id: string, data: Record<string, unknown> = {}): Rec => ({
	id,
	collection: "job_leads",
	data: { title: "Staff Engineer", company: "Globex", location: "Sydney", url: `https://jobs.example.com/${id}`, email: "recruiter@globex.example", notes: "private note", status: "new", ...data },
	createdAt: "2026-10-07T00:00:00Z",
	updatedAt: "2026-10-07T00:00:00Z",
});

beforeEach(() => {
	d1 = realSchemaD1();
	d1.exec(`INSERT INTO users (id, github_login) VALUES ('u1', 'u1'), ('u2', 'u2')`);
	d1.exec(`INSERT INTO agents (id, owner_id, slug, name, config) VALUES
	  ('scout-a', 'u1', 't958-scout', 'Job Search Scout', '{"capabilities":{"surfaces":[],"runtime":"local_browser"}}'),
	  ('tailor-a', 'u1', 't958-tailor', 'Application Tailor', '{"capabilities":{"surfaces":[],"runtime":"local_artifact"}}'),
	  ('runner-a', 'u1', 't958-runner', 'Job Application Runner', '{"capabilities":{"surfaces":[],"runtime":"local_apply"}}'),
	  ('chat-a', 'u1', 't958-chat', 'Plain chat', '{"capabilities":{"surfaces":[]}}')`);
	d1.exec(`INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES
	  ('scout', 'scout-a', 'u1', 'active', '{}'), ('t1', 'tailor-a', 'u1', 'active', '{"runnerNode":"mac"}'), ('ap', 'runner-a', 'u1', 'active', '{"runnerNode":"mac"}'),
	  ('chat', 'chat-a', 'u1', 'active', '{}'), ('other', 'tailor-a', 'u2', 'active', '{}')`);
	d1.exec(`INSERT INTO instance_runtime_nodes (instance_id, user_id, runner_node, endpoint_url, runner_version, status, last_seen_at) VALUES
	  ('t1', 'u1', 'mac', 'relay://', '0.6.0', 'online', '2026-10-07 00:00:00'), ('ap', 'u1', 'mac', 'relay://', '0.6.0', 'online', '2026-10-07 00:00:00')`);
	d1.exec(`INSERT INTO agent_connections (id, user_id, source_instance_id, event_type, target_instance_id, action, config, enabled) VALUES
	  ('c-lead', 'u1', 'scout', '${JOB_LEAD_APPLY_EVENT}', 't1', 'generate_application_materials', '{}', 1),
	  ('c-ready', 'u1', 't1', 'job.application.materials_ready', 'ap', 'start_application_fill', '{}', 1)`);
	getBoundRunnerConn.mockReset();
	getBoundRunnerConn.mockImplementation(async (_env: unknown, instanceId: string) => ({ runnerNode: "mac", instanceId, userId: "u1", relayName: `${instanceId}:node:mac`, endpointUrl: "relay://", token: "", env: {} }));
	answers = {
		"/local-artifact/run": { status: 202, body: { status: "running" } },
		"/local-apply/run": { status: 202, body: { status: "running" } },
		"/local-apply/resume": { status: 200, body: {} },
		"/local-apply/cancel": { status: 200, body: {} },
		"/local-artifact/cancel": { status: 200, body: {} },
	};
	sent = [];
	leads = new Map([["lead-new", lead("lead-new")], ["lead-skip", lead("lead-skip", { status: "skipped", lifecycle_version: 1 })]]);
});
afterEach(() => d1.close());

async function call(method: string, path: string, body?: unknown) {
	const app = new Hono<{ Bindings: Env }>();
	app.route("/v1/instances", instanceRoutes);
	app.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500)));
	const res = await app.request(`/v1/instances${path}`, { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, env());
	// biome-ignore lint/suspicious/noExplicitAny: a JSON response read field by field in assertions.
	return { status: res.status, body: (await res.json()) as Record<string, any> };
}
/** One typed action, posted the way the console tab and the MCP tools post it — from any pipeline member. */
const act = (instanceId: string, body: Record<string, unknown>) => call("POST", `/${instanceId}/application-queue/actions`, body);
const dispatches = (p: string) => sent.filter((s) => s.path === p);
const audit = async (id: string) =>
	(await d1.DB.prepare("SELECT version, from_status, to_status, actor, reason FROM job_application_events WHERE application_id = ?1 ORDER BY version").bind(id).all<Record<string, unknown>>()).results;

/** An application the Tailor finished (#956), at materials_ready. */
function readyApp(id: string, over: { title?: string } = {}) {
	const l = { eventId: `scout:${id}:1`, sourceInstanceId: "scout", leadId: id, leadUrl: `https://jobs.example.com/${id}`, lifecycleVersion: 1, requestedAt: "2026-10-07T00:00:00Z", lead: { title: over.title ?? "Staff Engineer", company: "Globex", location: "Sydney" } };
	const ready = { eventType: "job.application.materials_ready", eventId: `t1:${id}:1:materials`, applicationId: id, tailorInstanceId: "t1", leadId: id };
	d1.DB.prepare(
		`INSERT INTO job_applications (id, instance_id, user_id, source_instance_id, lead_id, lifecycle_version, idempotency_key, status, lead, resume_artifact, cover_letter_artifact, profile_version, generated_at, ready_event, ready_emitted_at, created_at, updated_at)
		 VALUES (?1, 't1', 'u1', 'scout', ?1, 1, ?2, 'materials_ready', ?3, ?4, ?5, '0123456789abcdef', '2026-10-07T00:05:00Z', ?6, 1, 1, 1)`,
	)
		.bind(id, l.eventId, JSON.stringify(l), JSON.stringify({ kind: "resume", path: `~/jobs/applications/${id}/r/resume.md`, sha256: SHA_R, bytes: 9 }), JSON.stringify({ kind: "cover_letter", path: `~/jobs/applications/${id}/r/cover-letter.md`, sha256: SHA_C, bytes: 9 }), JSON.stringify(ready))
		.run();
}
// biome-ignore lint/suspicious/noExplicitAny: a JSON queue item read field by field in assertions.
const item = (items: Array<{ key: string }>, key: string) => items.find((i) => i.key === key) as Record<string, any> | undefined;

describe("the queue: every state, from any member of the pipeline", () => {
	it("joins the Scout's leads with the applications, the same from the Tailor's tab and a session on the Runner", async () => {
		readyApp("app-ready");
		d1.exec("INSERT INTO job_applications (id, instance_id, user_id, source_instance_id, lead_id, lifecycle_version, idempotency_key, status, lead, created_at, updated_at) VALUES ('app-sub', 't1', 'u1', 'scout', 'app-sub', 1, 'k-sub', 'submitted', '{\"leadUrl\":\"https://jobs.example.com/s\",\"lead\":{\"title\":\"Done\"}}', 2, 2)");
		const fromTailor = await call("GET", "/t1/application-queue");
		expect(fromTailor.status).toBe(200);
		expect(fromTailor.body.pipeline).toEqual({ scouts: ["scout"], tailors: ["t1"], runners: ["ap"] });
		expect(fromTailor.body.counts).toMatchObject({ new: 1, skipped: 1, materials_ready: 1, submitted: 1, filling: 0 });
		expect(Object.keys(fromTailor.body.counts)).toEqual(["new", "apply_requested", "tailoring", "materials_ready", "filling", "awaiting_review", "submitted", "blocked", "deferred", "skipped", "archived", "failed"]);
		expect(item(fromTailor.body.items, "lead:scout:lead-new")).toMatchObject({ kind: "lead", status: "new", leadVersion: 0, actions: ["apply", "skip", "defer", "archive", "mark_not_interested"] });
		expect(item(fromTailor.body.items, "app:app-sub")?.actions).toEqual([]);
		// The same queue read from the Runner — the instance an MCP caller may well hold.
		const fromRunner = await call("GET", "/ap/application-queue");
		expect(fromRunner.status).toBe(200);
		expect(fromRunner.body.items.map((i: { key: string }) => i.key).sort()).toEqual(fromTailor.body.items.map((i: { key: string }) => i.key).sort());
		expect(fromRunner.body.connections.map((c: { id: string }) => c.id).sort()).toEqual(["c-lead", "c-ready"]);
		// Privacy: no lead contact data or notes, anywhere.
		expect(JSON.stringify(fromTailor.body)).not.toMatch(/recruiter@globex|private note/);
		expect(JSON.stringify(fromRunner.body)).not.toMatch(/recruiter@globex|private note/);
	});

	it("refuses an instance outside any pipeline, and someone else's", async () => {
		expect((await call("GET", "/chat/application-queue")).status).toBe(409);
		expect((await call("GET", "/other/application-queue")).status).toBe(404);
	});
});

describe("one transition whichever member of the pipeline it is made from", () => {
	it("defer from the Tailor's tab and defer on the Runner write the same transition and audit row", async () => {
		readyApp("a1");
		readyApp("a2");
		const viaConsole = await call("POST", "/t1/application-queue/actions", { action: "defer", application_id: "a1", expected_status: "materials_ready", expected_version: 0 });
		const viaTool = await act("ap", { action: "defer", application_id: "a2", expected_status: "materials_ready", expected_version: 0 });
		expect(viaConsole.body.item).toMatchObject({ status: "deferred", stateVersion: 1, actions: ["apply", "archive", "mark_not_interested"] });
		expect(viaTool.body.item).toMatchObject({ status: "deferred", stateVersion: 1, actions: ["apply", "archive", "mark_not_interested"] });
		const strip = (rows: Record<string, unknown>[]) => rows.map(({ version, from_status, to_status, actor, reason }) => ({ version, from_status, to_status, actor, reason }));
		expect(strip(await audit("a1"))).toEqual([{ version: 1, from_status: "materials_ready", to_status: "deferred", actor: "owner", reason: "defer" }]);
		expect(strip(await audit("a2"))).toEqual(strip(await audit("a1")));
		// Nothing was sent to a runner: defer touches PAGS records only.
		expect(sent).toHaveLength(0);
	});

	it("lead triage from the surface IS the Scout's triage — the same handoff, the same Tailor run", async () => {
		const r = await call("POST", "/ap/application-queue/actions", { action: "apply", scout_instance_id: "scout", record_id: "lead-new", expected_status: "new", expected_version: 0 });
		expect(r.status).toBe(200);
		expect(leads.get("lead-new")?.data).toMatchObject({ status: "apply_requested", lifecycle_version: 1, apply_request_id: "scout:lead-new:1" });
		// The connection delivered it to the Tailor, which started tailoring; the item is now the application.
		expect(dispatches("/local-artifact/run")).toHaveLength(1);
		expect(r.body.item).toMatchObject({ kind: "application", status: "tailoring", leadId: "lead-new" });
		// The same decision repeated is refused — the lead is an application now — not a second one.
		const again = await act("t1", { action: "apply", scout_instance_id: "scout", record_id: "lead-new", expected_status: "tailoring" });
		expect(again.status).toBe(409);
		expect(dispatches("/local-artifact/run")).toHaveLength(1);
	});
});

describe("stale and invalid transitions are refused, with nothing written", () => {
	it("refuses a stale version and a stale status (console and tool), and an action the state does not allow", async () => {
		readyApp("s1");
		const staleVersion = await call("POST", "/t1/application-queue/actions", { action: "archive", application_id: "s1", expected_status: "materials_ready", expected_version: 7 });
		expect(staleVersion.status).toBe(409);
		expect(staleVersion.body.error).toMatch(/^stale/);
		const staleStatus = await act("t1", { action: "archive", application_id: "s1", expected_status: "awaiting_review" });
		expect(staleStatus.status).toBe(409);
		expect(staleStatus.body.error).toMatch(/^stale/);
		const invalid = await call("POST", "/t1/application-queue/actions", { action: "retry_fill", application_id: "s1", expected_status: "materials_ready" });
		expect(invalid.status).toBe(409);
		expect((await call("POST", "/t1/application-queue/actions", { action: "archive", application_id: "s1" })).status).toBe(400);
		expect(await audit("s1")).toEqual([]);
		// A stale lead decision is refused by the Scout's own compare-and-set.
		const staleLead = await call("POST", "/t1/application-queue/actions", { action: "apply", scout_instance_id: "scout", record_id: "lead-skip", expected_status: "skipped", expected_version: 0 });
		expect(staleLead.status).toBe(409);
		expect(leads.get("lead-skip")?.data.status).toBe("skipped");
	});
});

// ── #986: the queue response says how far the fill GOT, from the runner's facts ──────────────
//
// `awaiting_review` is the outcome the Runner reports BOTH for a finished form and for a run that
// stopped before touching one, so a surface that reads the status word alone calls both "Filled".
// Live, that put "Filled — waiting for your review before anything is sent" on an application
// whose checkpoint said `filled: 0, uploaded: 0`.
describe("how far the fill actually got, on the queue response (#986)", () => {
	/** An application with a fill run in a given state — the shapes the issue enumerates. */
	function withRun(id: string, appStatus: string, run: { status: string; pause?: unknown; result?: unknown; checkpoint?: { phase: string; filled: number; uploaded: number } }) {
		readyApp(id);
		const runId = `run-${id}`;
		d1.DB.prepare("INSERT INTO local_apply_runs (id, instance_id, user_id, application_id, request_id, status, policy, pause, result, created_at, updated_at) VALUES (?1, 'ap', 'u1', ?2, ?1, ?3, '{\"mode\":\"fill_and_review\"}', ?4, ?5, 1, 1)")
			.bind(runId, id, run.status, run.pause ? JSON.stringify(run.pause) : null, run.result ? JSON.stringify(run.result) : null)
			.run();
		if (run.checkpoint) {
			d1.DB.prepare("INSERT INTO local_apply_supervisor_checkpoints (run_id, instance_id, user_id, checkpoint_id, schema_version, facts, runner_seq, received_at) VALUES (?1, 'ap', 'u1', ?2, 1, ?3, 1, 1)")
				.bind(runId, `${id}:cp`, JSON.stringify({ ...run.checkpoint, actions: 1, blockers: [] }))
				.run();
		}
		d1.DB.prepare("UPDATE job_applications SET status = ?2, fill_run_id = ?3 WHERE id = ?1").bind(id, appStatus, runId).run();
		return runId;
	}
	const progress = async (id: string) => item((await call("GET", "/t1/application-queue")).body.items, `app:${id}`)?.fillProgress;

	it("the five states read differently, and only one of them says a form was filled", async () => {
		withRun("zero", "awaiting_review", { status: "paused", pause: { reason: "supervisor_checkpoint" }, checkpoint: { phase: "initial", filled: 0, uploaded: 0 } });
		withRun("partial", "filling", { status: "running", result: { outcome: "awaiting_review", filled: 3, uploaded: [] } });
		withRun("ready", "awaiting_review", { status: "awaiting_review", result: { outcome: "awaiting_review", filled: 9, uploaded: ["resume"] } });
		withRun("stuck", "blocked", { status: "blocked", result: { outcome: "blocked", blockReason: "login_required", filled: 1 } });
		withRun("final", "awaiting_review", { status: "paused", pause: { reason: "supervisor_checkpoint" }, checkpoint: { phase: "before_submit", filled: 8, uploaded: 1 } });

		expect(await progress("zero")).toMatchObject({ stage: "supervisor_pending", label: "Paused before form filling — supervisor decision pending. Nothing has been entered yet.", filled: 0, uploaded: 0, checkpointPhase: "initial", checkpointId: "zero:cp" });
		expect(await progress("partial")).toMatchObject({ stage: "filling", label: "Filling the application in the browser — 3 fields so far." });
		expect(await progress("ready")).toMatchObject({ stage: "ready_for_review", label: "Filled 9 fields and 1 attachment — waiting for your review before anything is sent.", filled: 9, uploaded: 1 });
		expect(await progress("stuck")).toMatchObject({ stage: "blocked", label: "Stopped — login required, after 1 field." });
		expect(await progress("final")).toMatchObject({ stage: "before_submit_review", label: "Form complete (8 fields and 1 attachment) — waiting for the supervisor's decision before anything is sent.", checkpointPhase: "before_submit" });

		// Two applications sit at the SAME lifecycle status with opposite claims — which is the
		// distinction the status word cannot carry and the reason this projection exists.
		const q = await call("GET", "/t1/application-queue");
		expect([item(q.body.items, "app:zero")?.status, item(q.body.items, "app:ready")?.status]).toEqual(["awaiting_review", "awaiting_review"]);
		expect(q.body.items.filter((i: { fillProgress?: { label: string } }) => /Filled \d/.test(i.fillProgress?.label ?? "")).map((i: { key: string }) => i.key)).toEqual(["app:ready"]);
	});

	it("the item read and the list read agree, and a lead with no run carries no progress at all", async () => {
		withRun("one", "awaiting_review", { status: "paused", pause: { reason: "supervisor_checkpoint" }, checkpoint: { phase: "initial", filled: 0, uploaded: 0 } });
		const one = (await call("GET", "/t1/application-queue/item?application_id=one")).body.item;
		expect(one.fillProgress).toEqual(await progress("one"));
		expect(item((await call("GET", "/t1/application-queue")).body.items, "lead:scout:lead-new")?.fillProgress).toBeNull();
	});

	it("an attempted submit outranks the checkpoint — nobody is told to review a form that may be gone", async () => {
		const runId = withRun("sent", "awaiting_review", { status: "paused", pause: { reason: "supervisor_checkpoint" }, checkpoint: { phase: "initial", filled: 0, uploaded: 0 } });
		d1.DB.prepare("UPDATE job_applications SET submit_attempted_at = 1 WHERE id = 'sent'").run();
		expect(runId).toBe("run-sent");
		expect(await progress("sent")).toMatchObject({ stage: "submitted", submitAttempted: true, label: "A final submit was attempted — check the employer's site before anything else is done." });
	});
});

// ── #987: the Board projects every durable application, not only the ones that moved ─────────
//
// Live: the Runner's board reported `jobCount: 1` against an authoritative queue of three —
// BusinessAI (awaiting_review), DAI (awaiting_review) and Gentrack (blocked). The two older
// applications predated #978's projection, their lifecycle was finished, and no future transition
// would ever write them a card.
describe("existing applications are reconciled onto the Board (#987)", () => {
	/** An application at a lifecycle state, with its runs, and NO card — the pre-#978 shape. */
	function legacy(id: string, status: string, over: { fill?: string; fills?: number; tailoring?: boolean; stateVersion?: number } = {}) {
		readyApp(id);
		if (over.tailoring !== false) {
			d1.DB.prepare("INSERT INTO local_artifact_runs (id, instance_id, user_id, application_id, request_id, status, policy, created_at, updated_at) VALUES (?1, 't1', 'u1', ?2, ?1, 'completed', '{}', 1, 1)").bind(`tail-${id}`, id).run();
			d1.DB.prepare("UPDATE job_applications SET tailoring_run_id = ?2 WHERE id = ?1").bind(id, `tail-${id}`).run();
		}
		for (let i = 0; i < (over.fills ?? 0); i++) {
			const runId = `fill-${id}-${i}`;
			d1.DB.prepare("INSERT INTO local_apply_runs (id, instance_id, user_id, application_id, request_id, status, policy, result, created_at, updated_at, ended_at) VALUES (?1, 'ap', 'u1', ?2, ?1, ?3, '{\"mode\":\"fill_and_review\"}', ?4, ?5, ?5, ?5)")
				.bind(runId, id, i === (over.fills ?? 0) - 1 ? (over.fill ?? "awaiting_review") : "blocked", JSON.stringify({ outcome: i === (over.fills ?? 0) - 1 ? (over.fill ?? "awaiting_review") : "blocked", filled: 4, uploaded: ["resume"] }), 100 + i)
				.run();
			d1.DB.prepare("UPDATE job_applications SET fill_run_id = ?2 WHERE id = ?1").bind(id, runId).run();
		}
		d1.DB.prepare("UPDATE job_applications SET status = ?2, state_version = ?3 WHERE id = ?1").bind(id, status, over.stateVersion ?? 1).run();
	}
	const board = async (instance: string) => (await call("GET", `/${instance}/board`)).body;
	const appCards = async (instance: string) => ((await board(instance)).items as Array<{ latestTaskId: string; application?: { applicationId: string } }>).filter((i) => i.application);
	const cardRows = async () => (await d1.DB.prepare("SELECT COUNT(*) AS n FROM instance_runtime_tasks WHERE type = 'application.run'").first<{ n: number }>())?.n;

	it("backfills every pre-existing application in one pass, in its own truthful state", async () => {
		legacy("biz", "awaiting_review", { fills: 1 });
		legacy("dai", "awaiting_review", { fills: 1 });
		legacy("gentrack", "blocked", { fills: 1, fill: "blocked" });
		legacy("ready", "materials_ready");
		legacy("filling", "filling", { fills: 1, fill: "running" });
		legacy("sent", "submitted", { fills: 1, fill: "submitted" });
		legacy("gone", "archived", { fills: 1, fill: "blocked" });
		expect(await cardRows(), "the pre-#978 state: durable applications, no cards").toBe(0);

		// ONE board read reconciles them.
		const cards = await appCards("ap");
		expect(cards.map((c) => c.application?.applicationId).sort()).toEqual(["biz", "dai", "filling", "gentrack", "gone", "ready", "sent"].sort());
		// …each carrying ITS lifecycle state, not the state of whatever ran last.
		const byId = new Map(cards.map((c) => [c.application?.applicationId, c as { application?: Record<string, unknown> }]));
		expect(byId.get("gentrack")?.application).toMatchObject({ applicationStatus: "blocked" });
		expect(byId.get("sent")?.application).toMatchObject({ applicationStatus: "submitted" });
		expect(byId.get("ready")?.application).toMatchObject({ applicationStatus: "materials_ready", kind: "tailor" });
		// And the correlated trace link for each, which is how an owner gets from a card to a run.
		for (const c of cards) expect(String((c as unknown as { application: { traceUrl: string } }).application.traceUrl)).toContain("/applications/");
	});

	it("is idempotent: reading the board again writes no second card and changes nothing", async () => {
		legacy("biz", "awaiting_review", { fills: 1 });
		legacy("dai", "awaiting_review", { fills: 1 });
		const first = await appCards("ap");
		const rows = await cardRows();
		const second = await appCards("ap");
		const third = await appCards("ap");
		expect(await cardRows(), "the card id is the application's, so a repeat cannot fork it").toBe(rows);
		expect(second.map((c) => c.application?.applicationId).sort()).toEqual(first.map((c) => c.application?.applicationId).sort());
		expect(third.length).toBe(first.length);
		expect(second.map((c) => c.latestTaskId).sort()).toEqual(["app-biz", "app-dai"]);
	});

	it("does not touch the lifecycle it projects — no transition, no audit row, no run change", async () => {
		legacy("biz", "awaiting_review", { fills: 1 });
		const before = (await call("GET", "/t1/application-queue/item?application_id=biz")).body.item;
		const auditBefore = await audit("biz");
		await appCards("ap");
		const after = (await call("GET", "/t1/application-queue/item?application_id=biz")).body.item;
		expect(after.status).toBe(before.status);
		expect(after.stateVersion).toBe(before.stateVersion);
		expect(after.fillRunId).toBe(before.fillRunId);
		expect(await audit("biz")).toEqual(auditBefore);
	});

	it("a lifecycle move AFTER the backfill lands on the same card", async () => {
		legacy("biz", "materials_ready");
		expect((await appCards("ap")).length).toBe(1);
		// The owner defers it: a real transition through the action service.
		const acted = await act("t1", { action: "defer", application_id: "biz", expected_status: "materials_ready" });
		expect(acted.status).toBe(200);
		const cards = await appCards("ap");
		expect(await cardRows(), "still one card for this application").toBe(1);
		expect(cards[0]?.application).toMatchObject({ applicationId: "biz", applicationStatus: "deferred" });
	});

	it("the Board, the Board's MCP response and the queue agree on the same applications", async () => {
		legacy("biz", "awaiting_review", { fills: 1 });
		legacy("dai", "awaiting_review", { fills: 1 });
		legacy("gentrack", "blocked", { fills: 1, fill: "blocked" });
		const b = await board("ap");
		// MCP `instance_board` IS this route (`workers/mcp/src/instance-tools/board.ts`), so the set
		// it reports is this set; the queue is the authoritative list the issue compares against.
		const cards = (b.items as Array<{ application?: { applicationId: string } }>).filter((i) => i.application).map((i) => i.application?.applicationId);
		const queue = ((await call("GET", "/t1/application-queue")).body.items as Array<{ applicationId: string | null }>).filter((i) => i.applicationId).map((i) => i.applicationId);
		expect(cards.sort()).toEqual(queue.sort());
		// `jobCount` is MCP's own field over this response (`instance-tools/shared.ts` = items.length),
		// so the count the two surfaces report is this one.
		expect((b.items as unknown[]).filter((i) => (i as { application?: unknown }).application)).toHaveLength(3);
		expect(queue).toHaveLength(3);
	});

	it("an application with FOUR historical fills is one card reporting four executions", async () => {
		legacy("biz", "awaiting_review", { fills: 4 });
		const cards = await appCards("ap");
		expect(cards).toHaveLength(1);
		const card = cards[0] as unknown as { attempts: Array<{ id: string }>; application?: { executions?: { total: number; fills: number; latest?: { runId: string; status: string } }; runId?: string } };
		expect(card.application?.executions).toMatchObject({ total: 5, fills: 4, tailorings: 1 });
		// The generic attempt counter said 1 for this shape. The attempts are the runs now.
		expect(card.attempts.map((a) => a.id)).toContain("fill-biz-3");
		expect(card.application?.executions?.latest).toMatchObject({ runId: "fill-biz-3", status: "awaiting_review" });
		// One card, keyed on the application — the product model #978 states.
		expect(await cardRows()).toBe(1);
	});

	it("reconciliation is bounded: a big backlog heals over passes instead of one huge read", async () => {
		for (let i = 0; i < RECONCILE_LIMIT + 4; i++) legacy(`app-${i}`, "awaiting_review", { fills: 1 });
		const first = await appCards("ap");
		expect(first.length, "one pass takes at most the bound").toBe(RECONCILE_LIMIT);
		const second = await appCards("ap");
		expect(second.length).toBe(RECONCILE_LIMIT + 4);
		// And a third pass has nothing left to do.
		expect((await appCards("ap")).length).toBe(RECONCILE_LIMIT + 4);
	});

	it("an instance in no apply pipeline is untouched — the generic board stays generic", async () => {
		legacy("biz", "awaiting_review", { fills: 1 });
		const chat = await call("GET", "/chat/board");
		expect(chat.status).toBe(200);
		expect((chat.body.items as Array<{ application?: unknown }>).filter((i) => i.application)).toEqual([]);
	});
});

describe("no submit path under the default fill-and-review policy", () => {
	it("offers request_review only, refuses start_fill, and request_review dispatches without a gate", async () => {
		readyApp("f1");
		const q = await call("GET", "/t1/application-queue?status=materials_ready");
		const it1 = item(q.body.items, "app:f1");
		expect(it1?.submitPolicy).toMatchObject({ allowed: false });
		expect(it1?.submitPolicy.failing).toContain("auto_submit_enabled");
		// #973 added the owner's per-application approval, which is offered here BECAUSE the standing
		// policy refuses: it is the one way this card can reach a submit. `start_fill` — the
		// standing-policy control — is still absent, which is what this test is about.
		expect(it1?.actions).toEqual(["approve_and_proceed", "request_review", "defer", "archive", "mark_not_interested"]);
		expect(it1?.actions).not.toContain("start_fill");
		const refused = await act("ap", { action: "start_fill", application_id: "f1", expected_status: "materials_ready" });
		expect(refused.status).toBe(409);
		expect(refused.body.error).toMatch(/does not allow an automatic submit/);
		expect(dispatches("/local-apply/run")).toHaveLength(0);
		const review = await act("ap", { action: "request_review", application_id: "f1", expected_status: "materials_ready" });
		expect(review.body.result).toMatchObject({ outcome: "started", mode: "fill_and_review" });
		expect((dispatches("/local-apply/run")[0].body.policy as Record<string, unknown>).submitGate).toBeUndefined();
	});

	it("offers the final-submit control only when the policy allows it — and request_review still never submits", async () => {
		await call("PUT", "/ap/application-runner/settings", { allowDomains: ["example.com"], autoSubmit: { enabled: true, roles: ["engineer"], dailyCap: 2 } });
		readyApp("f2");
		readyApp("f3");
		const q = await call("GET", "/t1/application-queue");
		expect(item(q.body.items, "app:f2")?.actions).toEqual(["approve_and_proceed", "start_fill", "request_review", "defer", "archive", "mark_not_interested"]);
		expect(q.body.limits).toEqual([{ runnerInstanceId: "ap", autoSubmitEnabled: true, dailyCap: 2, usedToday: 0, remaining: 2 }]);
		const submitted = await call("POST", "/t1/application-queue/actions", { action: "start_fill", application_id: "f3", expected_status: "materials_ready" });
		expect(submitted.body.result.mode).toBe("auto_submit");
		// One open run: the gate's concurrency check now withholds the submit control from the other.
		const after = (await call("GET", "/t1/application-queue/item?application_id=f2")).body.item;
		// An approval is still offerable while another run holds the slot — granting one is a decision,
		// and the gate's own concurrency check is what refuses the dispatch until the slot frees.
		expect(after.actions).toEqual(["approve_and_proceed", "request_review", "defer", "archive", "mark_not_interested"]);
		expect(after.submitPolicy.failing).toEqual(["concurrency"]);
		const reviewed = await call("POST", "/t1/application-queue/actions", { action: "request_review", application_id: "f2", expected_status: "materials_ready" });
		expect(reviewed.body.result.mode).toBe("fill_and_review");
		const policies = dispatches("/local-apply/run").map((d) => d.body.policy as Record<string, unknown>);
		expect(policies[0].submitGate).toBeDefined();
		expect(policies[1].submitGate).toBeUndefined();
	});
});

describe("retry, cancel and resume", () => {
	it("retries tailoring that stopped, under a fresh key, with an audit row", async () => {
		d1.exec(
			"INSERT INTO job_applications (id, instance_id, user_id, source_instance_id, lead_id, lifecycle_version, idempotency_key, status, lead, block_reason, created_at, updated_at) VALUES ('rt', 't1', 'u1', 'scout', 'rt', 1, 'scout:rt:1', 'blocked', '{\"eventId\":\"scout:rt:1\",\"sourceInstanceId\":\"scout\",\"leadId\":\"rt\",\"leadUrl\":\"https://jobs.example.com/rt\",\"lifecycleVersion\":1,\"requestedAt\":\"2026-10-07T00:00:00Z\",\"lead\":{\"title\":\"Engineer\"}}', 'runner_lost', 1, 1)",
		);
		const r = await act("t1", { action: "retry_tailoring", application_id: "rt", expected_status: "blocked" });
		expect(r.body.item).toMatchObject({ status: "tailoring", blockReason: null });
		expect(dispatches("/local-artifact/run")[0].body.requestId).toBe("scout:rt:1:retry:1");
		expect((await audit("rt")).map((a) => `${a.from_status}→${a.to_status}`)).toEqual(["blocked→tailoring"]);
	});

	it("retries a stopped fill — and never after a submit attempt", async () => {
		readyApp("rf");
		const started = await call("POST", "/t1/application-queue/actions", { action: "request_review", application_id: "rf", expected_status: "materials_ready" });
		const runId = started.body.result.runId;
		answers["/local-apply/status"] = { status: 200, body: { state: "ended", lastSeq: 0, events: [], result: { runId, outcome: "blocked", mode: "fill_and_review", traceId: runId, engineAuth: "machine-login", filled: 2, uploaded: [], submitAttempted: false, summary: "", blockReason: "incomplete", questions: ["Stopped."] } } };
		await call("GET", `/ap/application-runs/${runId}`);
		const blocked = await call("GET", "/t1/application-queue/item?application_id=rf");
		// #991: the fill RAN and stopped with nothing sent, so the owner's one-job approval belongs
		// here too — it is the same state the live one-click refusal closed in.
		expect(blocked.body.item.actions).toEqual(["approve_and_proceed", "retry_fill", "defer", "archive", "mark_not_interested"]);
		const retried = await call("POST", "/t1/application-queue/actions", { action: "retry_fill", application_id: "rf", expected_status: "blocked" });
		expect(retried.body.result.runId).not.toBe(runId);
		expect(dispatches("/local-apply/run")).toHaveLength(2);
		// After any submit attempt, retry is neither offered nor accepted.
		d1.exec("UPDATE job_applications SET status = 'blocked', submit_attempted_at = 5 WHERE id = 'rf'");
		const after = await call("GET", "/t1/application-queue/item?application_id=rf");
		expect(after.body.item.actions).not.toContain("retry_fill");
		expect((await call("POST", "/t1/application-queue/actions", { action: "retry_fill", application_id: "rf", expected_status: "blocked" })).status).toBe(409);
	});

	it("a paused fill offers resume with the owner's answer, and cancel", async () => {
		readyApp("pz");
		const started = await call("POST", "/t1/application-queue/actions", { action: "request_review", application_id: "pz", expected_status: "materials_ready" });
		const runId = started.body.result.runId;
		answers["/local-apply/status"] = { status: 200, body: { state: "paused", pause: { reason: "missing_answer", question: "Notice period?" }, lastSeq: 1, events: [{ seq: 1, type: "run.paused", at: "2026-10-07T00:06:00Z", pauseReason: "missing_answer" }] } };
		await call("GET", `/ap/application-runs/${runId}`);
		const paused = (await call("GET", "/t1/application-queue/item?application_id=pz")).body.item;
		expect(paused).toMatchObject({ status: "blocked", blockReason: "missing_answer", questions: ["Notice period?"], actions: ["resume", "cancel"], fillRun: { status: "paused", pause: { reason: "missing_answer" } } });
		answers["/local-apply/status"] = { status: 200, body: { state: "running", lastSeq: 2, events: [{ seq: 2, type: "run.resumed", at: "2026-10-07T00:07:00Z" }] } };
		const resumed = await act("t1", { action: "resume", application_id: "pz", expected_status: "blocked", answers: [{ question: "Notice period?", answer: "four weeks" }] });
		expect(resumed.body.item.status).toBe("filling");
		expect(dispatches("/local-apply/resume")[0].body.answers).toEqual([{ question: "Notice period?", answer: "four weeks" }]);
		const cancelled = await call("POST", "/t1/application-queue/actions", { action: "cancel", application_id: "pz", expected_status: "filling" });
		expect(cancelled.body.item).toMatchObject({ status: "blocked", blockReason: "cancelled_by_owner" });
		expect(dispatches("/local-apply/cancel")).toHaveLength(1);
	});
});

describe("the trace: Scout lead → triage → Tailor run → Runner run → final record", () => {
	it("correlates every stage on one timeline, without content", async () => {
		await call("POST", "/t1/application-queue/actions", { action: "apply", scout_instance_id: "scout", record_id: "lead-new", expected_status: "new", expected_version: 0 });
		const appId = (await call("GET", "/t1/application-queue?status=tailoring")).body.items[0].applicationId as string;
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
						{ kind: "resume", path: `~/jobs/applications/lead-new/${tailorRun}/resume.md`, sha256: SHA_R, bytes: 9 },
						{ kind: "cover_letter", path: `~/jobs/applications/lead-new/${tailorRun}/cover-letter.md`, sha256: SHA_C, bytes: 9 },
					],
					sourceHashes: [],
				},
			},
		};
		// Reading it settles the tailoring, emits materials_ready, and the connection starts the Runner.
		await call("GET", `/t1/applications/${appId}`);
		const fillRun = dispatches("/local-apply/run")[0].body.runId as string;
		answers["/local-apply/status"] = { status: 200, body: { state: "ended", lastSeq: 0, events: [], result: { runId: fillRun, outcome: "awaiting_review", mode: "fill_and_review", traceId: fillRun, engineAuth: "machine-login", filled: 5, uploaded: ["resume"], submitAttempted: false, summary: "Filled." } } };
		await call("GET", `/ap/application-runs/${fillRun}`);

		const viaTool = await call("GET", `/ap/application-queue/${appId}/trace`);
		const viaConsole = await call("GET", `/t1/application-queue/${appId}/trace`);
		expect(viaTool.body.correlation).toEqual(viaConsole.body.correlation);
		expect(viaConsole.body.correlation).toMatchObject({ scoutInstanceId: "scout", leadId: "lead-new", leadEventId: "scout:lead-new:1", tailorInstanceId: "t1", tailoringRunIds: [tailorRun], materialsReadyEventId: "t1:lead-new:1:materials", fillRunIds: [fillRun], status: "awaiting_review" });
		const sources = new Set(viaConsole.body.entries.map((e: { source: string }) => e.source));
		expect([...sources].sort()).toEqual(["delivery", "lead", "lifecycle", "runner", "tailor"]);
		expect(viaConsole.body.entries.filter((e: { source: string }) => e.source === "lifecycle").map((e: { type: string }) => e.type)).toEqual(["apply_requested→tailoring", "tailoring→materials_ready", "materials_ready→filling", "filling→awaiting_review"]);
		expect(viaConsole.body.entries.find((e: { source: string }) => e.source === "lead")).toMatchObject({ type: "triage.apply", detail: { from: "new", to: "apply_requested" } });
		expect(JSON.stringify(viaConsole.body)).not.toMatch(/recruiter@globex|private note/);
	});
});
