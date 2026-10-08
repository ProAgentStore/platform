/**
 * #981 end to end, through the routes both surfaces call: a review-mode fill stops at its
 * supervisor checkpoint, the owner approves THAT application, and the approval carries to the
 * employer — with no global auto-submit and no second submission anywhere in it.
 *
 * The live state it reconstructs: a fill reached a SEEK checkpoint, #982's deterministic decision
 * asked for a review, the run ended `awaiting_review`, and the queue then offered `defer`,
 * `archive` and `mark_not_interested`. The owner had reviewed the populated form and had no way to
 * say "send this one".
 *
 * Real: the migrated schema, the Tailor, the Runner, the submit gate, the authorization store, the
 * supervisor checkpoint/directive store, the action service and the trace. Faked: the machine at the
 * end of the relay (its answers are scripted, so what it was ASKED is assertable) and the Scout's
 * Durable Object storage behind the real storage-route handlers.
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
const { syncActiveApplyRuns } = await import("../lib/local-apply/apply.js");

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

let leads: Map<string, CollectionRecord>;
let nextId = 0;
const engine = {
	recordInsert: async (_c: string, data: Record<string, unknown>) => {
		const rec = { id: `lead-${++nextId}`, collection: "job_leads", data, createdAt: "2026-10-08T00:00:00Z", updatedAt: "2026-10-08T00:00:00Z" } as CollectionRecord;
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
		return { records: all.slice(o.offset ?? 0, (o.offset ?? 0) + (o.limit ?? 50)), total: all.length };
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

beforeEach(() => {
	d1 = realSchemaD1();
	leads = new Map();
	nextId = 0;
	d1.exec(`INSERT INTO users (id, github_login) VALUES ('u1', 'u1')`);
	d1.exec(`INSERT INTO agents (id, owner_id, slug, name, config) VALUES
	  ('scout-a', 'u1', 't981-scout', 'Job Search Scout', '{"capabilities":{"surfaces":[],"runtime":"local_browser"}}'),
	  ('tailor-a', 'u1', 't981-tailor', 'Application Tailor', '{"capabilities":{"surfaces":[],"runtime":"local_artifact"}}'),
	  ('runner-a', 'u1', 't981-runner', 'Application Runner', '{"capabilities":{"surfaces":[],"runtime":"local_apply"}}')`);
	d1.exec(`INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES
	  ('scout', 'scout-a', 'u1', 'active', '{}'), ('t1', 'tailor-a', 'u1', 'active', '{"runnerNode":"mac"}'), ('ap', 'runner-a', 'u1', 'active', '{"runnerNode":"mac"}')`);
	d1.exec(`INSERT INTO instance_runtime_nodes (instance_id, user_id, runner_node, endpoint_url, runner_version, status, last_seen_at) VALUES
	  ('t1', 'u1', 'mac', 'relay://', '0.6.0', 'online', '2026-10-08 00:00:00'), ('ap', 'u1', 'mac', 'relay://', '0.6.0', 'online', '2026-10-08 00:00:00')`);
	d1.exec(`INSERT INTO agent_connections (id, user_id, source_instance_id, event_type, target_instance_id, action, config, enabled) VALUES
	  ('c-lead', 'u1', 'scout', '${JOB_LEAD_APPLY_EVENT}', 't1', 'generate_application_materials', '{}', 1),
	  ('c-ready', 'u1', 't1', 'job.application.materials_ready', 'ap', 'start_application_fill', '{}', 1)`);
	d1.DB.prepare(
		`INSERT INTO local_browser_runs (id, instance_id, user_id, request_id, objective, status, policy, result, created_at, updated_at)
		 VALUES ('run-1', 'scout', 'u1', 'req-1', 'Product roles in Sydney', 'completed', ?1, ?2, 1, 1)`,
	)
		.bind(
			JSON.stringify({ collection: { name: "job_leads", keyField: "url" }, limits: { maxMinutes: 15, maxPages: 30, maxActions: 200, maxConcurrent: 1 } }),
			JSON.stringify({
				runId: "run-1",
				outcome: "completed",
				findings: [{ title: "Product Manager", url: "https://jobs.example.com/pm", evidence: "Product Manager — BusinessAI, Sydney", fields: { company: "BusinessAI", location: "Sydney", source: "seek" } }],
				sourceFailures: [],
				summary: "1 found",
				traceId: "run-1",
				engineAuth: "machine-login",
			}),
		)
		.run();
	getBoundRunnerConn.mockReset();
	getBoundRunnerConn.mockImplementation(async (_env: unknown, instanceId: string) => ({ runnerNode: "mac", instanceId, userId: "u1", relayName: `${instanceId}:node:mac`, endpointUrl: "relay://", token: "", env: {} }));
	answers = { "/local-artifact/run": { status: 202, body: { status: "running" } }, "/local-apply/run": { status: 202, body: { status: "running" } }, "/local-apply/directive": { status: 200, body: { ok: true } } };
	sent = [];
});
afterEach(() => d1.close());

/** Lead → Tailor → materials_ready → the Runner's review-mode fill. Returns the ids. */
async function fillForReview(): Promise<{ applicationId: string; fillRunId: string }> {
	// The employer's site is allow-listed — a SAFETY check, which an approval deliberately does not
	// stand in for (#973) — while auto-submit itself stays OFF, which is the whole point of #981: the
	// only thing that can authorise this submission is the owner's decision about this one job.
	const settings = await call("PUT", "/ap/application-runner/settings", { allowDomains: ["jobs.example.com"] });
	expect(settings.status).toBe(200);
	expect(settings.body.settings.autoSubmit.enabled).toBe(false);
	expect((await call("POST", "/scout/local-browser/runs/run-1/findings/0/save")).status).toBe(200);
	expect((await call("POST", "/scout/application-queue/actions", { action: "apply", scout_instance_id: "scout", record_id: "lead-1", expected_status: "new", expected_version: 0 })).status).toBe(200);
	await runDueDeliveries(env());
	const applicationId = (await call("GET", "/t1/applications")).body.applications[0].id as string;
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
				generatedAt: "2026-10-08T00:05:00.000Z",
				artifacts: [
					{ kind: "resume", path: `~/jobs/applications/lead-1/${tailorRun}/resume.md`, sha256: "a".repeat(64), bytes: 9 },
					{ kind: "cover_letter", path: `~/jobs/applications/lead-1/${tailorRun}/cover-letter.md`, sha256: "b".repeat(64), bytes: 9 },
				],
				sourceHashes: [],
			},
		},
	};
	await call("GET", `/t1/applications/${applicationId}`);
	const fillRunId = dispatches("/local-apply/run")[0].body.runId as string;
	// The default configuration: fill and STOP. No submit gate exists for this run.
	expect(dispatches("/local-apply/run")[0].body.policy).toEqual({ mode: "fill_and_review", allowDomains: ["jobs.example.com"] });
	return { applicationId, fillRunId };
}


/** The initial checkpoint the live run paused at: nothing filled, no blocker, domain allow-listed. */
const INITIAL = { schemaVersion: 1, checkpointId: "seek-94991284-initial", facts: { phase: "initial", actions: 2, filled: 0, uploaded: 0, blockers: [], url: "https://jobs.example.com/pm", domain: "jobs.example.com" } };

/** The runner, paused at `cp` and reporting it exactly as the CLI does. */
const pausedAt = (runId: string, cp: Record<string, unknown> = INITIAL, seq = 7) => ({
	status: 200,
	body: {
		runId,
		state: "paused",
		pause: { reason: "supervisor_checkpoint", checkpoint: cp },
		lastSeq: seq,
		events: [{ seq, type: "supervisor.checkpoint", at: "2026-10-08T09:41:38Z", url: "https://jobs.example.com/pm", domain: "jobs.example.com", detail: { checkpointId: String((cp as { checkpointId: string }).checkpointId), phase: String((cp.facts as { phase: string }).phase), filled: 0 } }],
	},
});

const rows = async (sql: string) => ((await d1.DB.prepare(sql).all<Record<string, unknown>>()).results ?? []);
const directives = () => rows("SELECT checkpoint_id, directive, idempotency_key, delivery_attempted_at, delivered_at FROM local_apply_supervisor_directives");
const checkpoints = () => rows("SELECT checkpoint_id, runner_seq FROM local_apply_supervisor_checkpoints");
const dispatched = () => sent.filter((s) => s.path === "/local-apply/directive");
const traceOf = async (runId: string) => {
	const row = await d1.DB.prepare("SELECT trace FROM local_apply_runs WHERE id = ?1").bind(runId).first<{ trace: string }>();
	return JSON.parse(row?.trace ?? "[]") as Array<{ type: string; detail?: Record<string, unknown> }>;
};
const checkpointEvents = async (runId: string) => (await traceOf(runId)).filter((e) => e.type === "policy.decision" && e.detail?.class === "checkpoint");
const applicationStatus = async (applicationId: string) => (await call("GET", `/t1/applications/${applicationId}`)).body.application.status as string;

describe("#985: the sweep wakes the supervisor, decides and dispatches — with no human in it", () => {
	it("initial checkpoint → continue → delivered → the CLI resumes and fills", async () => {
		const { applicationId, fillRunId } = await fillForReview();
		answers["/local-apply/status"] = pausedAt(fillRunId);

		// ONE cron tick. No GET of the run, no chat turn, no resume_application.
		expect(await syncActiveApplyRuns(env())).toBeGreaterThan(0);

		// The decision is the deterministic policy's, recorded with its source and reason (#982).
		const decided = await checkpointEvents(fillRunId);
		expect(decided[0]?.detail).toMatchObject({ checkpointId: INITIAL.checkpointId, phase: "initial", decision: "continue", source: "policy", reason: "routine_checkpoint_cannot_submit" });
		// It was dispatched to the machine, and the DISPATCH is on the trace too (#985).
		expect(dispatched().map((d) => d.body)).toMatchObject([{ runId: fillRunId, checkpointId: INITIAL.checkpointId, directive: "continue", schemaVersion: 1 }]);
		expect(decided.find((e) => e.detail?.dispatch)?.detail).toMatchObject({ dispatch: "delivered", reason: "acknowledged", decision: "continue" });
		expect(await directives()).toMatchObject([{ checkpoint_id: INITIAL.checkpointId, directive: "continue", idempotency_key: `brain:${INITIAL.checkpointId}` }]);
		expect((await directives())[0].delivered_at).toBeTruthy();
		// Nobody was asked to resume it.
		expect(sent.filter((s) => s.path === "/local-apply/resume")).toEqual([]);

		// The CLI then does the field work the live runs never reached.
		answers["/local-apply/status"] = {
			status: 200,
			body: {
				runId: fillRunId,
				state: "ended",
				lastSeq: 12,
				events: [
					{ seq: 8, type: "supervisor.directive", at: "2026-10-08T09:42:16Z", detail: { checkpointId: INITIAL.checkpointId, directive: "continue" } },
					{ seq: 9, type: "run.resumed", at: "2026-10-08T09:42:16Z" },
					{ seq: 10, type: "policy.decision", at: "2026-10-08T09:42:18Z", detail: { tool: "browser_click", class: "entry", decision: "allowed", reason: "entry_label_nothing_filled" } },
					{ seq: 11, type: "field.filled", at: "2026-10-08T09:42:25Z", detail: { tool: "browser_type", class: "fill", role: "textbox" } },
					{ seq: 12, type: "artifact.uploaded", at: "2026-10-08T09:42:31Z", detail: { kind: "resume", class: "fill" } },
				],
				result: { runId: fillRunId, outcome: "awaiting_review", mode: "fill_and_review", traceId: fillRunId, engineAuth: "machine-login", filled: 6, uploaded: ["resume"], submitAttempted: false, summary: "Filled; waiting for your review." },
			},
		};
		await syncActiveApplyRuns(env());
		const { run } = (await call("GET", `/ap/application-runs/${fillRunId}`)).body;
		expect(run.result).toMatchObject({ filled: 6, uploaded: ["resume"], submitAttempted: false });
		expect(await applicationStatus(applicationId)).toBe("awaiting_review");
	});

	it("a LOST directive is retried by the next tick, decided once, delivered once", async () => {
		const { fillRunId } = await fillForReview();
		answers["/local-apply/status"] = pausedAt(fillRunId);
		// The relay refuses the dispatch: the decision is durable, the delivery is not.
		answers["/local-apply/directive"] = { status: 500, body: { error: "no socket" } };
		await syncActiveApplyRuns(env());
		expect(await directives()).toHaveLength(1);
		expect((await directives())[0]).toMatchObject({ directive: "continue", delivered_at: null });
		expect((await directives())[0].delivery_attempted_at).toBeTruthy();
		// The failure is VISIBLE, which it was not before (#985).
		expect((await checkpointEvents(fillRunId)).find((e) => e.detail?.dispatch)?.detail).toMatchObject({ dispatch: "undelivered", reason: "runner_refused_500" });

		// The machine comes back. The same directive is re-sent — never re-decided.
		answers["/local-apply/directive"] = { status: 200, body: { ok: true } };
		await syncActiveApplyRuns(env());
		expect(await directives()).toHaveLength(1);
		expect((await directives())[0].delivered_at).toBeTruthy();
		expect(dispatched()).toHaveLength(2);
		const decisions = (await checkpointEvents(fillRunId)).filter((e) => e.detail?.decision && !e.detail?.dispatch);
		expect(decisions, "one checkpoint, one decision, however many ticks").toHaveLength(1);
		expect((await checkpointEvents(fillRunId)).filter((e) => e.detail?.dispatch === "delivered")).toHaveLength(1);
	});

	it("a delivery the CLI never ACTS on is not re-decided, not re-sent, and stays visible as paused", async () => {
		const { applicationId, fillRunId } = await fillForReview();
		answers["/local-apply/status"] = pausedAt(fillRunId);
		await syncActiveApplyRuns(env());
		expect(dispatched()).toHaveLength(1);

		// The runner keeps reporting the same pause: it took the directive and did nothing with it.
		for (let i = 0; i < 3; i++) await syncActiveApplyRuns(env());
		expect(await directives()).toHaveLength(1);
		// `deliveredAt` is set, so the dispatch is not repeated — and the trace is not flooded.
		expect(dispatched(), "a delivered directive is sent once").toHaveLength(1);
		expect((await checkpointEvents(fillRunId)).filter((e) => e.detail?.dispatch)).toHaveLength(1);
		// And the state an owner sees is the honest one: still waiting on the machine.
		expect((await call("GET", `/ap/application-runs/${fillRunId}`)).body.run.status).toBe("paused");
		expect(await applicationStatus(applicationId)).toBe("blocked");
	});

	it("a STALE checkpoint replay takes no second decision", async () => {
		const { fillRunId } = await fillForReview();
		answers["/local-apply/status"] = pausedAt(fillRunId);
		await syncActiveApplyRuns(env());
		// The runner re-reports the SAME checkpoint id — a restart, a re-pull, a duplicated page.
		answers["/local-apply/status"] = pausedAt(fillRunId, { ...INITIAL, facts: { ...INITIAL.facts, actions: 9 } }, 11);
		await syncActiveApplyRuns(env());
		expect(await checkpoints(), "one checkpoint row per (run, checkpointId)").toHaveLength(1);
		// The stored facts are the FIRST ones — the decision was taken on those, and a row that
		// changed under a recorded decision would make the audit a fiction.
		expect((await checkpoints())[0]).toMatchObject({ runner_seq: 7 });
		expect(await directives()).toHaveLength(1);
		expect((await checkpointEvents(fillRunId)).filter((e) => e.detail?.decision && !e.detail?.dispatch)).toHaveLength(1);
	});

	it("DUPLICATE continuation: two ticks in the same minute produce one directive and one dispatch", async () => {
		const { fillRunId } = await fillForReview();
		answers["/local-apply/status"] = pausedAt(fillRunId);
		await Promise.all([syncActiveApplyRuns(env()), syncActiveApplyRuns(env())]);
		expect(await directives()).toHaveLength(1);
		expect(dispatched().length, "the immutable directive is what makes this safe").toBeLessThanOrEqual(2);
		expect((await directives())[0]).toMatchObject({ directive: "continue" });
		expect((await checkpointEvents(fillRunId)).filter((e) => e.detail?.decision && !e.detail?.dispatch)).toHaveLength(1);
	});
});

describe("#985: the hard stops are preserved", () => {
	it.each([
		["a blocker on the page", { phase: "initial", blockers: ["captcha"] }, "stop"],
		["an uncertain phase", { phase: "uncertain", blockers: [] }, "request_review"],
		["a before_submit checkpoint with no approval", { phase: "before_submit", blockers: [] }, "request_review"],
	])("fails closed on %s", async (_why, facts, expected) => {
		const { applicationId, fillRunId } = await fillForReview();
		answers["/local-apply/status"] = pausedAt(fillRunId, { schemaVersion: 1, checkpointId: `cp-${expected}`, facts: { actions: 3, filled: 0, uploaded: 0, ...facts } });
		await syncActiveApplyRuns(env());
		expect((await directives())[0]).toMatchObject({ directive: expected });
		expect(dispatched()[0]?.body).toMatchObject({ directive: expected });
		// The decision says WHY it stopped, which is what makes a fail-closed stop actionable.
		expect((await checkpointEvents(fillRunId))[0]?.detail).toMatchObject({ decision: expected, source: "policy" });
		// Nothing was sent to the employer, and the application is visibly waiting.
		expect((await call("GET", `/t1/applications/${applicationId}`)).body.application.submitAttemptedAt).toBeNull();
	});
});
