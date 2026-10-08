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

/** The checkpoint → review path (#982): a before_submit checkpoint on a fill-and-review run. */
async function reachAwaitingReview(applicationId: string, fillRunId: string): Promise<void> {
	answers["/local-apply/status"] = {
		status: 200,
		body: {
			state: "paused",
			pause: { reason: "supervisor_checkpoint", checkpoint: { schemaVersion: 1, checkpointId: "cp-seek-1", facts: { phase: "before_submit", actions: 9, filled: 7, uploaded: 1, blockers: [] } } },
			lastSeq: 9,
			// The two events the runner really emits here (`local-apply/runtime.ts`): it recorded the
			// checkpoint before it began waiting, and the form is ready for a person to look at.
			events: [
				{ seq: 8, type: "supervisor.checkpoint", at: "2026-10-08T00:07:59Z", url: "https://jobs.example.com/pm/apply", detail: { checkpointId: "cp-seek-1", phase: "before_submit", filled: 7 } },
				{ seq: 9, type: "review.ready", at: "2026-10-08T00:08:00Z" },
			],
		},
	};
	await call("GET", `/ap/application-runs/${fillRunId}`);
	// #982 decided it deterministically, and the machine was told — `request_review`, because this
	// run was never allowed to submit.
	expect(dispatches("/local-apply/directive").map((d) => d.body)).toMatchObject([{ runId: fillRunId, checkpointId: "cp-seek-1", directive: "request_review" }]);
	answers["/local-apply/status"] = {
		status: 200,
		body: { state: "ended", lastSeq: 10, events: [], result: { runId: fillRunId, outcome: "awaiting_review", mode: "fill_and_review", traceId: fillRunId, engineAuth: "machine-login", filled: 7, uploaded: ["resume"], submitAttempted: false, summary: "Filled; waiting for the owner." } },
	};
	await call("GET", `/ap/application-runs/${fillRunId}`);
	expect((await call("GET", `/t1/applications/${applicationId}`)).body.application).toMatchObject({ status: "awaiting_review", submittedAt: null, submitAttemptedAt: null });
}

const item = async (applicationId: string) => (await call("GET", `/t1/application-queue/item?application_id=${applicationId}`)).body.item;
const approve = (applicationId: string, extra: Record<string, unknown> = {}) =>
	call("POST", "/ap/application-queue/actions", { action: "approve_and_proceed", application_id: applicationId, expected_status: "awaiting_review", ...extra });

describe("#981: approve & continue a filled application", () => {
	it("checkpoint → review → one approval → a resumed fill that submits, and the trace shows all of it", async () => {
		const { applicationId, fillRunId } = await fillForReview();
		await reachAwaitingReview(applicationId, fillRunId);

		// 1. The gap this closes: the queue now offers the decision, beside the run that spends it.
		const waiting = await item(applicationId);
		expect(waiting.actions).toEqual(["approve_and_proceed", "retry_fill", "defer", "archive", "mark_not_interested"]);
		expect(waiting.submitAuthorization).toBeNull();

		// 2. ONE approval. The session has already closed with the run, so nothing is resumed and
		// nothing is recreated — it says so, and names what to do.
		const approved = await approve(applicationId);
		expect(approved.body).toMatchObject({});
		expect(approved.status, JSON.stringify(approved.body)).toBe(200);
		expect(approved.body.result).toMatchObject({ outcome: "not_resumable", approval: "granted", stage: "post_fill", resumable: false, reason: "run_ended", recovery: "retry_fill", runId: fillRunId });
		expect(String(approved.body.result.nextAction)).toMatch(/browser session for run .* has ended/);
		expect(approved.body.item.submitAuthorization).toMatchObject({ usable: true, approvedBy: "owner", consumedRunId: null });
		// Nothing was dispatched by the approval itself.
		expect(dispatches("/local-apply/run")).toHaveLength(1);

		// 3. A double-click, and a retried request: one authorization, no second run, no error.
		const again = await approve(applicationId, { idempotency_key: "owner-key-1" });
		expect(again.status).toBe(200);
		expect(again.body.result).toMatchObject({ approval: "existing", resumable: false });
		expect(again.body.item.submitAuthorization.id).toBe(approved.body.item.submitAuthorization.id);
		expect(dispatches("/local-apply/run")).toHaveLength(1);

		// 4. The recovery the approval named: a fresh run that SPENDS it. The envelope the machine
		// receives is the proof — auto_submit with a real gate id, which the earlier one never had.
		const retried = await call("POST", "/ap/application-queue/actions", { action: "retry_fill", application_id: applicationId, expected_status: "awaiting_review" });
		expect(retried.status).toBe(200);
		expect(dispatches("/local-apply/run")).toHaveLength(2);
		const envelope = dispatches("/local-apply/run")[1].body as { runId: string; policy: { mode: string; submitGate?: { gateId: string } } };
		expect(envelope.policy.mode).toBe("auto_submit");
		expect(envelope.policy.submitGate?.gateId).toBeTruthy();
		// Spent by exactly that run, atomically, and reported as spent to the owner.
		const spent = (await item(applicationId)).submitAuthorization;
		expect(spent).toMatchObject({ usable: false, consumedRunId: envelope.runId });
		expect(String(spent.label)).toMatch(/single-use/);

		// 5. The employer accepts it — and PAGS records a submission only because it gated this one.
		answers["/local-apply/status"] = {
			status: 200,
			body: {
				state: "ended",
				lastSeq: 4,
				events: [{ seq: 3, type: "submit.attempted", at: "2026-10-08T00:12:00Z" }, { seq: 4, type: "submit.confirmed", at: "2026-10-08T00:12:05Z", url: "https://jobs.example.com/pm/thanks" }],
				result: {
					runId: envelope.runId,
					outcome: "submitted",
					mode: "auto_submit",
					traceId: envelope.runId,
					engineAuth: "machine-login",
					filled: 7,
					uploaded: ["resume"],
					submitAttempted: true,
					submitted: { url: "https://jobs.example.com/pm/thanks", at: "2026-10-08T00:12:05Z", gateId: envelope.policy.submitGate?.gateId as string },
					summary: "Submitted.",
				},
			},
		};
		await call("GET", `/ap/application-runs/${envelope.runId}`);
		expect((await call("GET", `/t1/applications/${applicationId}`)).body.application).toMatchObject({ status: "submitted", submittedUrl: "https://jobs.example.com/pm/thanks" });

		// 6. One timeline, from the checkpoint to the employer's answer.
		const trace = (await call("GET", `/t1/application-queue/${applicationId}/trace`)).body;
		expect(trace.correlation).toMatchObject({ fillRunIds: [fillRunId, envelope.runId], status: "submitted" });
		const types = trace.entries.map((e: { type: string }) => e.type);
		expect(types).toContain("supervisor.checkpoint");
		expect(types).toContain("submit.confirmed");
		const approval = trace.entries.find((e: { detail: Record<string, unknown> }) => e.detail?.basis === "owner_application_approval");
		expect(approval).toMatchObject({ runId: fillRunId, detail: { decision: "approved", stage: "post_fill", continued: false, reason: "run_ended", recovery: "retry_fill" } });
		expect(trace.entries.some((e: { detail: Record<string, unknown> }) => e.detail?.basis === "application_approval")).toBe(true);

		// 7. And the standing policy was never touched: no auto-submit, no roles, no cap.
		expect((await call("GET", "/ap/application-runner/settings")).body.settings.autoSubmit).toMatchObject({ enabled: false });
		// Nothing can approve it a second time now that a run has spent the decision.
		const third = await call("POST", "/ap/application-queue/actions", { action: "approve_and_proceed", application_id: applicationId, expected_status: "submitted" });
		expect(third.status).toBe(409);
	});

	it("no approval means no submit: the same retry, unapproved, fills and stops again", async () => {
		const { applicationId, fillRunId } = await fillForReview();
		await reachAwaitingReview(applicationId, fillRunId);

		const retried = await call("POST", "/ap/application-queue/actions", { action: "retry_fill", application_id: applicationId, expected_status: "awaiting_review" });
		expect(retried.status, JSON.stringify(retried.body)).toBe(200);
		const envelope = dispatches("/local-apply/run")[1].body as { policy: { mode: string; submitGate?: unknown } };
		expect(envelope.policy.mode).toBe("fill_and_review");
		expect(envelope.policy.submitGate).toBeUndefined();
		// A submit the run was not gated for is NOT recorded as a submission, whatever the runner says.
		expect((await item(applicationId)).submitAuthorization).toBeNull();
	});

	it("an approval is refused once a submit has been attempted — that needs checking, not re-authorizing", async () => {
		const { applicationId, fillRunId } = await fillForReview();
		answers["/local-apply/status"] = {
			status: 200,
			body: {
				state: "ended",
				lastSeq: 2,
				events: [{ seq: 2, type: "submit.attempted", at: "2026-10-08T00:09:00Z" }],
				result: { runId: fillRunId, outcome: "blocked", mode: "fill_and_review", traceId: fillRunId, engineAuth: "machine-login", filled: 7, uploaded: [], submitAttempted: true, blockReason: "submit_unconfirmed", questions: ["Check the employer's site."], summary: "Unconfirmed." },
			},
		};
		await call("GET", `/ap/application-runs/${fillRunId}`);
		const blocked = await item(applicationId);
		expect(blocked.submitAttempted).toBe(true);
		expect(blocked.actions).not.toContain("approve_and_proceed");
		expect(blocked.actions).not.toContain("retry_fill");
		const refused = await call("POST", "/ap/application-queue/actions", { action: "approve_and_proceed", application_id: applicationId, expected_status: blocked.status });
		expect(refused.status).toBe(409);
		expect(dispatches("/local-apply/run")).toHaveLength(1);
	});
});
