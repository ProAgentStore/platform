/**
 * Application Runner (#957) over the real schema. Only the relay/runner seam and the Agent DO are
 * faked; capability resolution, settings, the submit gate, the application lifecycle (compare-and-
 * set + audit), the run, the pull, the connection outbox and the Tailor upstream are real code
 * against the real migrations.
 */
import { Hono } from "hono";
import { completeRunnerBatch } from "../lib/local-apply/__fixtures__/status.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { readFillViews } from "../lib/applications/fill-views.js";
import { realSchemaD1, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import { JOB_LEAD_APPLY_EVENT, planJobLeadTriage } from "../lib/job-lead-triage.js";
import type { ApplicationExecutionProjection } from "../lib/applications/execution-projection.js";
import type { Env } from "../types.js";

vi.mock("../lib/auth.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/auth.js")>("../lib/auth.js");
	return { ...actual, requireUser: async () => ({ uid: "u1", roles: [] }) };
});
const { getBoundRunnerConn } = vi.hoisted(() => ({ getBoundRunnerConn: vi.fn() }));
vi.mock("../lib/runner-client.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../lib/runner-client.js")>()), getBoundRunnerConn }));

const { instanceRoutes } = await import("./instances.js");
const { deliverEvent } = await import("../lib/connections.js");
const { syncActiveApplyRuns, syncApplyRun, dispatchNextQueuedFill } = await import("../lib/local-apply/apply.js");
const { agentDeleteStatements } = await import("../lib/agent-cascade.js");

let d1: RealSchemaD1;
let sent: Array<{ path: string; body: Record<string, unknown> }>;
type Answer = { status: number; body: unknown };
/** A path's canned answer — or, for a runner whose answer depends on what it was asked before, a function. */
let answers: Record<string, Answer | ((body: Record<string, unknown>) => Answer)>;
const relay = {
	idFromName: (n: string) => n,
	get: () => ({
		fetch: async (req: Request) => {
			const cmd = (await req.json()) as { path: string; body: string | Record<string, unknown> };
			const body = typeof cmd.body === "string" ? JSON.parse(cmd.body) : (cmd.body ?? {});
			sent.push({ path: cmd.path, body });
			const canned = answers[cmd.path];
			const a = (typeof canned === "function" ? canned(body) : canned) ?? { status: 404, body: { error: "unknown path" } };
			return new Response(JSON.stringify(cmd.path === "/local-apply/status" && a.status === 200 ? completeRunnerBatch(a.body, body.afterSeq) : a.body), { status: a.status });
		},
	}),
};
let instanceMemory: Record<string, unknown[]>;
let memoryReadStatus = 200;
const agentDO = { idFromName: (n: string) => n, get: (id: string) => ({ fetch: async (req: Request) => new URL(req.url).pathname === "/memory" ? Response.json({ memory: instanceMemory[id] ?? [] }, { status: memoryReadStatus }) : Response.json({ ok: true }, { status: 201 }) }) };
/** In-memory R2 for replay frames (#1063/#1064). */
const stored = new Map<string, Uint8Array>();
const STORAGE = { put: async (k: string, v: Uint8Array) => void stored.set(k, v), get: async (k: string) => (stored.has(k) ? { body: stored.get(k) } : null), delete: async (k: string) => void stored.delete(k) };
const env = () => ({ DB: d1.DB, RELAY: relay, AGENT: agentDO, STORAGE }) as unknown as Env;

const SHA_R = "a".repeat(64);
const SHA_C = "b".repeat(64);

beforeEach(() => {
	instanceMemory = {}; memoryReadStatus = 200;
	d1 = realSchemaD1();
	d1.exec(`INSERT INTO users (id, github_login) VALUES ('u1', 'u1'), ('u2', 'u2')`);
	d1.exec(`INSERT INTO agents (id, owner_id, slug, name, config) VALUES
	  ('scout-a', 'u1', 't957-scout', 'Job Search Scout', '{"capabilities":{"surfaces":[],"runtime":"local_browser"}}'),
	  ('tailor-a', 'u1', 't957-tailor', 'Application Tailor', '{"capabilities":{"surfaces":[],"runtime":"local_artifact"}}'),
	  ('runner-a', 'u1', 't957-runner', 'Job Application Runner', '{"capabilities":{"surfaces":[],"runtime":"local_apply"}}')`);
	d1.exec(`INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES
	  ('scout', 'scout-a', 'u1', 'active', '{}'), ('t1', 'tailor-a', 'u1', 'active', '{"runnerNode":"mac"}'), ('ap', 'runner-a', 'u1', 'active', '{"runnerNode":"mac"}'),
	  ('other', 'runner-a', 'u2', 'active', '{}')`);
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
		"/local-apply/directive": { status: 200, body: { state: "running", events: [], lastSeq: 0 } },
	};
	sent = [];
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

const dispatches = () => sent.filter((s) => s.path === "/local-apply/run");
const appRow = (id: string) => d1.DB.prepare("SELECT * FROM job_applications WHERE id = ?1").bind(id).first<Record<string, unknown>>();
const audit = async (id: string) => (await d1.DB.prepare("SELECT from_status, to_status, actor, reason FROM job_application_events WHERE application_id = ?1 ORDER BY version").bind(id).all<Record<string, unknown>>()).results;
/** The runner reports this run's state; `result` ends it. */
function runner(state: "running" | "paused" | "ended", o: { pause?: unknown; events?: unknown[]; result?: unknown; lastSeq?: number } = {}) {
	answers["/local-apply/status"] = { status: 200, body: { state, lastSeq: o.lastSeq ?? 1, events: o.events ?? [], ...(o.pause ? { pause: o.pause } : {}), ...(o.result ? { result: o.result } : {}) } };
}
const RESULT = (runId: string, over: Record<string, unknown> = {}) => ({ runId, outcome: "awaiting_review", mode: "fill_and_review", traceId: runId, engineAuth: "machine-login", filled: 6, uploaded: ["resume"], submitAttempted: false, summary: "Filled.", ...over });

/** An application the Tailor finished (#956), as its row stands at materials_ready. */
function readyApp(id: string, over: { title?: string; url?: string } = {}) {
	const lead = { eventId: `scout:${id}:1`, sourceInstanceId: "scout", leadId: id, leadUrl: over.url ?? "https://jobs.example.com/1", lifecycleVersion: 1, requestedAt: "2026-10-07T00:00:00Z", lead: { title: over.title ?? "Staff Engineer", company: "Globex", location: "Sydney" } };
	d1.DB.prepare(
		`INSERT INTO job_applications (id, instance_id, user_id, source_instance_id, lead_id, lifecycle_version, idempotency_key, status, lead, resume_artifact, cover_letter_artifact, profile_version, generated_at, created_at, updated_at)
		 VALUES (?1, 't1', 'u1', 'scout', ?1, 1, ?2, 'materials_ready', ?3, ?4, ?5, '0123456789abcdef', '2026-10-07T00:05:00Z', 1, 1)`,
	)
		.bind(id, lead.eventId, JSON.stringify(lead), JSON.stringify({ kind: "resume", path: `~/jobs/applications/${id}/r/resume.md`, sha256: SHA_R, bytes: 9 }), JSON.stringify({ kind: "cover_letter", path: `~/jobs/applications/${id}/r/cover-letter.md`, sha256: SHA_C, bytes: 9 }))
		.run();
	return { eventType: "job.application.materials_ready", eventId: `t1:${id}:1:materials`, applicationId: id, tailorInstanceId: "t1", leadId: id };
}
const enableAutoSubmit = (over: Record<string, unknown> = {}) =>
	call("PUT", "/ap/application-runner/settings", { allowDomains: ["example.com"], autoSubmit: { enabled: true, roles: ["engineer"], dailyCap: 1, ...over }, acknowledgeRealSubmissions: true });

describe("explicit owner pause before application control", () => {
	it.each(["0.4.224", "0.4.225"])("requires a supporting runner and confirmed native settlement (%s)", async version => {
		d1.exec("UPDATE instance_runtime_nodes SET runner_version = '0.4.225' WHERE instance_id = 'ap'");
		const started = await call("POST", "/ap/application-runs", readyApp(`owner-${version}`));
		const runId = started.body.run.id;
		await d1.DB.prepare("UPDATE local_apply_runs SET runner_version = ?1 WHERE id = ?2").bind(version, runId).run();
		runner("running", { lastSeq: 0 });
		answers["/local-apply/owner-pause"] = () => {
			runner("paused", { pause: { reason: "owner_requested", handoffRequestId: "owner-pause-1" }, events: [{ seq: 1, type: "run.paused", at: new Date().toISOString(), pauseReason: "owner_requested" }] });
			return { status: 200, body: { state: "paused" } };
		};
		answers["/local-apply/handoff"] = { status: 200, body: { state: "ready" } };
		const takeover = await call("POST", `/ap/application-runs/${runId}/handoff`, { pause: true });
		if (version === "0.4.224") {
			expect(takeover.status).toBe(409); expect(takeover.body.error).toContain("0.4.225");
			expect(sent.some(s => s.path === "/local-apply/owner-pause")).toBe(false);
		} else {
			expect(takeover.status, JSON.stringify(takeover.body)).toBe(201);
			expect(takeover.body.handoff).toMatchObject({ runId, applicationId: `owner-${version}`, state: "active" });
			expect(sent.find(s => s.path === "/local-apply/owner-pause")?.body).toEqual({ runId, applicationId: `owner-${version}`, browserProfile: "isolated" });
			expect(sent.find(s => s.path === "/local-apply/handoff")?.body).toMatchObject({ runId, handoffRequestId: "owner-pause-1" });
		}
	});
	it("keeps pending native execution paused without exposing any handoff", async () => {
		d1.exec("UPDATE instance_runtime_nodes SET runner_version = '0.4.225' WHERE instance_id = 'ap'");
		const started = await call("POST", "/ap/application-runs", readyApp("owner-pending")); const runId = started.body.run.id;
		runner("running", { lastSeq: 0 });
		answers["/local-apply/owner-pause"] = () => {
			runner("paused", { pause: { reason: "owner_requested", handoffRequestId: "owner-pause-1" }, events: [{ seq: 1, type: "run.paused", at: new Date().toISOString(), pauseReason: "owner_requested" }] });
			return { status: 409, body: { error: "AI dispatch is paused; native execution is pending" } };
		};
		expect((await call("POST", `/ap/application-runs/${runId}/handoff`, { pause: true })).status).toBe(409);
		expect(sent.some(s => s.path === "/local-apply/handoff")).toBe(false);
		expect(await d1.DB.prepare("SELECT count(*) AS n FROM local_apply_handoffs WHERE run_id = ?1").bind(runId).first()).toEqual({ n: 0 });
	});
});

describe("full browser tool acceptance and dispatch", () => {
	const accept = { toolAccess: "full", acknowledgeFullBrowserTools: "full_playwright_v1" };
	it.each(["0.4.225", "0.4.224"])("accepts document-only failure evidence only from a supporting runner (%s)", async (version) => {
		await call("PUT", "/ap/application-runner/settings", accept);
		d1.exec("UPDATE instance_runtime_nodes SET runner_version = '0.4.225' WHERE instance_id = 'ap'");
		const id = `preflight-${version}`;
		const started = await call("POST", "/ap/application-runs", readyApp(id));
		expect(started.status).toBe(201);
		const runId = started.body.run.id;
		await d1.DB.prepare("UPDATE local_apply_runs SET runner_version = ?1 WHERE id = ?2").bind(version, runId).run();
		runner("ended", { events: [{ seq: 1, type: "source.read", at: new Date().toISOString(), detail: { role: "profile" } }], result: RESULT(runId, {
			outcome: "blocked", blockReason: "artifact_changed", engineAuth: "unknown", filled: 0, uploaded: [],
			preflightFailure: { schemaVersion: 1, runId, phase: "documents", reason: "artifact_changed" },
			executionEvidence: { schemaVersion: 1, fieldCounts: "unmeasured", nativeCalls: { attempted: 0, succeeded: 0, failed: 0, notDispatched: 0, dropped: 0, truncated: false, coverage: "unavailable" }, screenshotsDelivered: 0, screenshotRequests: 0, independentScreenshotAvailable: false, blockingQuestions: 0, optionalQuestions: 0, browser: { state: "unavailable", timeouts: 0 }, causes: [] },
		}) });
		const ended = await call("GET", `/ap/application-runs/${runId}`);
		expect(ended.body.run.status).toBe("blocked");
		const views = await readFillViews(env(), "u1", { id, fillRunId: runId, status: "blocked", submitAttemptedAt: null, blockReason: "artifact_changed" });
		if (version === "0.4.225") {
			expect(ended.body.run.result.preflightFailure, JSON.stringify(ended.body.run)).toMatchObject({ runId, phase: "documents" });
			expect(ended.body.run.result.submissionVerification).toBeUndefined();
			expect(views.submissionUncertain).toBe(false);
			expect(views.progress?.label).toContain("before any browser or model started; nothing was submitted");
			await d1.DB.prepare("UPDATE job_applications SET submit_attempted_at = 1 WHERE id = ?1").bind(id).run();
			// Fresh durable attempt evidence outranks the receipt even when a caller holds an older app.
			const contradictory = await readFillViews(env(), "u1", { id, fillRunId: runId, status: "blocked", submitAttemptedAt: null, blockReason: "artifact_changed" });
			expect(contradictory).toMatchObject({ submissionUncertain: true, submissionVerification: "unverified" });
			expect(contradictory.progress?.label).not.toContain("nothing was submitted");
			const attempted = await readFillViews(env(), "u1", { id, fillRunId: runId, status: "blocked", submitAttemptedAt: 1, blockReason: "artifact_changed" });
			expect(attempted.progress?.label).toContain("A final submit was attempted");
		} else {
			expect(ended.body.run.result.preflightFailure).toBeUndefined();
			expect(ended.body.run.result.submissionVerification).toBe("unverified");
			expect(views.submissionUncertain).toBe(true);
			expect(views.progress?.label).toContain("Submission status is unverified");
		}
		expect(dispatches()).toHaveLength(1);
	});
	it("requires acknowledgement, rejects forged receipts, stamps owner provenance and records the change", async () => {
		const initial = await call("GET", "/ap/application-runner/settings");
		expect(initial.body.settings.toolAccess).toBe("guarded");
		expect(initial.body.toolAccessDisclosure.revision).toBe("full_playwright_v1");
		expect(initial.body.toolAccessDisclosure.risks.join(" ")).toContain("not sandboxed");
		for (const patch of [{ toolAccess: "full" }, { ...accept, acknowledgeFullBrowserTools: true }, { ...accept, toolAccessAcceptance: { acceptedBy: "u1" } }]) expect((await call("PUT", "/ap/application-runner/settings", patch)).status).toBe(400);
		expect((await call("PUT", "/other/application-runner/settings", accept)).status).toBe(404);
		const enabled = await call("PUT", "/ap/application-runner/settings", accept);
		expect(enabled.status).toBe(200);
		expect((await call("PUT", "/ap/application-runner/settings", { toolAccess: "full" })).status).toBe(400);
		expect((await call("PUT", "/ap/application-runner/settings", { escalationLevel: "autonomous" })).body.settings.toolAccessAcceptance).toEqual(enabled.body.settings.toolAccessAcceptance);
		expect(enabled.body.settings).toMatchObject({ toolAccess: "full", toolAccessAcceptance: { revision: "full_playwright_v1", acceptedBy: "u1", instanceId: "ap", acceptedAt: expect.any(String) }, autoSubmit: { enabled: false } });
		const audit = await d1.DB.prepare("SELECT context FROM agent_events WHERE event = 'apply.tool_access.changed' AND instance_id = 'ap'").first<{ context: string }>();
		expect(JSON.parse(audit?.context ?? "{}")).toMatchObject({ toolAccess: "full", acceptance: { acceptedBy: "u1" } });
		const disabled = await call("PUT", "/ap/application-runner/settings", { toolAccess: "guarded" });
		expect(disabled.body.settings.toolAccessAcceptance).toBeNull();
		expect((await call("PUT", "/ap/application-runner/settings", { toolAccess: "full" })).status).toBe(400);
	});
	it("gates full mode at CLI221 and freezes accepted provenance in the dispatched run", async () => {
		const accepted = await call("PUT", "/ap/application-runner/settings", accept);
		const event = readyApp("full-old");
		d1.exec("UPDATE instance_runtime_nodes SET runner_version = '0.4.220' WHERE instance_id = 'ap'");
		const refused = await call("POST", "/ap/application-runs", event);
		expect(refused.status).toBe(409); expect(refused.body.error).toContain("0.4.221"); expect(dispatches()).toHaveLength(0);
		d1.exec("UPDATE instance_runtime_nodes SET runner_version = '0.4.225' WHERE instance_id = 'ap'");
		const started = await call("POST", "/ap/application-runs", event);
		expect(started.status).toBe(201);
		expect(dispatches()[0].body.policy).toMatchObject({ toolAccess: "full", toolAccessAcceptance: accepted.body.settings.toolAccessAcceptance, mode: "fill_and_review" });
		await call("PUT", "/ap/application-runner/settings", { toolAccess: "guarded" });
		expect(started.body.run.policy.toolAccess).toBe("full");
		const viewInput = { id: "full-old", fillRunId: started.body.run.id as string, status: "filling" as const, submitAttemptedAt: null, blockReason: null };
		expect(await readFillViews(env(), "u1", viewInput)).toMatchObject({ toolAccess: "full", submissionVerification: "unverified" });
		runner("ended", { result: RESULT(started.body.run.id, { filled: 0, uploaded: [] }) });
		const ended = await call("GET", `/ap/application-runs/${started.body.run.id}`);
		expect(ended.body.run.result).toMatchObject({ submissionVerification: "unverified", submitAttempted: false });
		const endedView = await readFillViews(env(), "u1", { ...viewInput, status: "awaiting_review" });
		expect(endedView).toMatchObject({ toolAccess: "full", submissionVerification: "unverified" });
		expect(endedView.progress?.label).toContain("Submission status is unverified");
	});
	it("never records an explicitly unverified full result as a confirmed submission", async () => {
		await enableAutoSubmit();
		await call("PUT", "/ap/application-runner/settings", accept);
		const started = await call("POST", "/ap/application-runs", readyApp("full-unverified"));
		const run = started.body.run;
		runner("ended", { result: RESULT(run.id, { outcome: "submitted", mode: "auto_submit", submissionVerification: "unverified", submitAttempted: true, submitted: { url: "https://jobs.example.com/confirmation", at: "2026-11-05T02:00:00.000Z", gateId: run.policy.gate.gateId } }) });
		const ended = await call("GET", `/ap/application-runs/${run.id}`);
		expect(ended.body.run.result).toMatchObject({ outcome: "blocked", blockReason: "submit_unconfirmed", submissionVerification: "unverified" });
		expect((await appRow("full-unverified"))?.status).toBe("blocked");
	});
	it.each(["blocked", "failed", "awaiting_review"])("reconciles ended Full %s without treating absent submit events or old approval as safe to retry", async (outcome) => {
		await call("PUT", "/ap/application-runner/settings", accept);
		const id = `full-uncertain-${outcome}`;
		const event = readyApp(id);
		await d1.DB.prepare("UPDATE job_applications SET ready_event = ?1 WHERE id = ?2").bind(JSON.stringify(event), id).run();
		const started = await call("POST", "/ap/application-queue/actions", { action: "approve_and_proceed", application_id: id, expected_status: "materials_ready" });
		expect(started.status, JSON.stringify(started.body)).toBe(200);
		const runId = started.body.result.runId;
		runner("ended", { result: RESULT(runId, { outcome, blockReason: "incomplete", questions: ["Current public profile URL?"] }) });
		await call("GET", `/ap/application-runs/${runId}`);
		const card = async () => (await call("GET", "/ap/application-queue")).body.items.find((i: { applicationId: string }) => i.applicationId === id);
		const before = await card();
		expect(before.submitAttempted).toBe(false);
		expect(before.submitAuthorization.usable).toBe(true);
		expect(before.actions).not.toEqual(expect.arrayContaining(["retry_fill"]));
		expect(before.actions).not.toContain("approve_and_proceed");
		for (const action of ["retry_fill", "approve_and_proceed"]) expect((await call("POST", "/ap/application-queue/actions", { action, application_id: id, expected_status: before.status })).status).toBe(409);
		// Direct fill bypasses the action projection, but cannot replay the uncertain run either.
		await d1.DB.prepare("UPDATE job_applications SET status = 'materials_ready' WHERE id = ?1").bind(id).run();
		expect((await call("POST", "/ap/application-runs", { ...event, eventId: `${event.eventId}:unsafe-retry` })).status).toBe(409);
		d1.exec("INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES ('ap2', 'runner-a', 'u1', 'active', '{\"runnerNode\":\"mac\"}')");
		expect((await call("POST", "/ap2/application-runs", { ...event, eventId: `${event.eventId}:other-runner` })).status).toBe(409);
		await d1.DB.prepare("UPDATE job_applications SET status = ?1 WHERE id = ?2").bind(before.status, id).run();
		d1.exec("UPDATE agent_connections SET target_instance_id = 'ap2' WHERE id = 'c-ready'");
		const switched = await call("POST", "/t1/application-queue/actions", { action: "retry_fill", application_id: id, expected_status: before.status });
		expect(switched.status).toBe(409);
		d1.exec("UPDATE agent_connections SET target_instance_id = 'ap' WHERE id = 'c-ready'");
		answers["/local-apply/reconciliation/run"] = (body) => ({ status: 200, body: { reconciliationId: body.reconciliationId, runId, applicationId: id, state: "ended", result: { state: "ambiguous", proofKind: "ambiguous_site_history" } } });
		const checked = await call("POST", `/ap/application-runs/${runId}/reconciliation`);
		expect(checked.status, JSON.stringify(checked.body)).toBe(201);
		expect(checked.body.reconciliation).toMatchObject({ state: "ambiguous", runId, applicationId: id });
		expect((await card()).actions).not.toContain("retry_fill");
		if (outcome === "blocked") {
			const current = await card();
			expect(current.actions).toContain("resume");
			const saved = await call("POST", "/ap/application-queue/actions", { action: "resume", application_id: id, expected_status: "blocked", expected_version: current.stateVersion, answers: [{ question: "Current public profile URL?", answer: "Leave this optional field blank" }] });
			expect(saved.body.result).toMatchObject({ outcome: "answers_saved", resumed: false });
		}
		expect(dispatches()).toHaveLength(1);
	});
	it("requires fresh exact-run proof for each explicitly retried Full attempt", async () => {
		await call("PUT", "/ap/application-runner/settings", accept);
		const id = "full-exact-proof";
		const event = readyApp(id);
		await d1.DB.prepare("UPDATE job_applications SET ready_event = ?1 WHERE id = ?2").bind(JSON.stringify(event), id).run();
		const first = (await call("POST", "/ap/application-runs", event)).body.run.id;
		runner("ended", { result: RESULT(first, { outcome: "blocked", blockReason: "incomplete" }) });
		await call("GET", `/ap/application-runs/${first}`);
		const card = async () => (await call("GET", "/ap/application-queue")).body.items.find((i: { applicationId: string }) => i.applicationId === id);
		expect((await card()).actions).not.toContain("retry_fill");
		answers["/local-apply/reconciliation/run"] = (body) => ({ status: 200, body: { reconciliationId: body.reconciliationId, runId: first, applicationId: id, state: "ended", result: { state: "no_submission_proven", proofKind: "authorized_site_history_no_submission" } } });
		expect((await call("POST", `/ap/application-runs/${first}/reconciliation`)).body.reconciliation.state).toBe("no_submission_proven");
		const proven = await card();
		expect(proven.actions).toContain("retry_fill");
		const retried = await call("POST", "/ap/application-queue/actions", { action: "retry_fill", application_id: id, expected_status: proven.status, expected_version: proven.stateVersion });
		expect(retried.status, JSON.stringify(retried.body)).toBe(200);
		const second = retried.body.result.runId;
		expect(second).not.toBe(first);
		expect(dispatches()).toHaveLength(2);
		runner("ended", { result: RESULT(second, { outcome: "blocked", blockReason: "incomplete" }) });
		await call("GET", `/ap/application-runs/${second}`);
		expect((await card()).actions).not.toContain("retry_fill");
	});
	it("holds queued full work on old CLI or revoked acknowledgement", async () => {
		await call("PUT", "/ap/application-runner/settings", accept);
		answers["/local-apply/run"] = { status: 409, body: { error: "This machine is already filling 1 application(s) for this agent (limit 1)." } };
		const started = await call("POST", "/ap/application-runs", readyApp("full-queued"));
		expect(started.body.run.status).toBe("queued");
		d1.exec("UPDATE instance_runtime_nodes SET runner_version = '0.4.220' WHERE instance_id = 'ap'");
		d1.exec("UPDATE local_apply_runs SET next_attempt_at = 0 WHERE status = 'queued'");
		expect(await dispatchNextQueuedFill(env(), "ap", "u1")).toBe("queued");
		expect(dispatches()).toHaveLength(1);
		d1.exec("UPDATE instance_runtime_nodes SET runner_version = '0.4.225' WHERE instance_id = 'ap'");
		await call("PUT", "/ap/application-runner/settings", { toolAccess: "guarded" });
		d1.exec("UPDATE local_apply_runs SET next_attempt_at = 0 WHERE status = 'queued'");
		expect(await dispatchNextQueuedFill(env(), "ap", "u1")).toBe("queued");
		expect(dispatches()).toHaveLength(1);
	});
});

describe("per-instance browser command timeout settings and dispatch", () => {
	it("defaults to 600 seconds, isolates settings, and refuses an old runner before claiming", async () => {
		expect((await call("GET", "/ap/application-runner/settings")).body.settings.browserCommandTimeoutSeconds).toBe(600);
		expect((await call("PUT", "/ap/application-runner/settings", { browserCommandTimeoutSeconds: 900 })).body.settings.browserCommandTimeoutSeconds).toBe(900);
		expect((await call("GET", "/t1/application-runner/settings")).body.settings.browserCommandTimeoutSeconds).toBe(600);
		expect((await call("PUT", "/ap/application-runner/settings", { browserCommandTimeoutSeconds: 0 })).status).toBe(400);
		d1.exec("UPDATE instance_runtime_nodes SET runner_version = '0.4.224' WHERE instance_id = 'ap'");
		const event = readyApp("timeout-old");
		const refused = await call("POST", "/ap/application-runs", event);
		expect(refused.status).toBe(409); expect(refused.body.error).toContain("0.4.225");
		expect((await appRow("timeout-old"))?.status).toBe("materials_ready");
		expect(dispatches()).toHaveLength(0);
		d1.exec("UPDATE instance_runtime_nodes SET runner_version = '0.4.225' WHERE instance_id = 'ap'");
		const started = await call("POST", "/ap/application-runs", event);
		expect(started.status).toBe(201);
		expect(started.body.run.policy.browserCommandTimeoutSeconds).toBe(900);
		expect(dispatches()[0].body.policy).toMatchObject({ browserCommandTimeoutSeconds: 900 });
	});
	it("retains the frozen timeout when settings change during a queue wait", async () => {
		await call("PUT", "/ap/application-runner/settings", { browserCommandTimeoutSeconds: 1200 });
		answers["/local-apply/run"] = { status: 409, body: { error: "This machine is already filling 1 application(s) for this agent (limit 1)." } };
		const started = await call("POST", "/ap/application-runs", readyApp("timeout-queued"));
		expect(started.body.run.status).toBe("queued");
		await call("PUT", "/ap/application-runner/settings", { browserCommandTimeoutSeconds: 1 });
		d1.exec("UPDATE local_apply_runs SET next_attempt_at = 0 WHERE status = 'queued'");
		answers["/local-apply/run"] = { status: 202, body: { status: "running" } };
		expect(await dispatchNextQueuedFill(env(), "ap", "u1")).toBe("dispatched");
		expect(dispatches().at(-1)?.body.policy).toMatchObject({ browserCommandTimeoutSeconds: 1200 });
	});
});

describe("application escalation setting survives dispatch and queue waits", () => {
	it("round-trips only this instance's level and refuses old runtimes before claiming the application", async () => {
		expect((await call("GET", "/ap/application-runner/settings")).body.settings.escalationLevel).toBe("conservative");
		expect((await call("PUT", "/ap/application-runner/settings", { escalationLevel: "balanced" })).body.settings.escalationLevel).toBe("balanced");
		expect((await call("GET", "/t1/application-runner/settings")).body.settings.escalationLevel).toBe("conservative");
		expect((await call("PUT", "/ap/application-runner/settings", { escalationLevel: "invalid" })).status).toBe(400);
		d1.exec("UPDATE instance_runtime_nodes SET runner_version = '0.4.219' WHERE instance_id = 'ap'");
		const event = readyApp("escalation-old");
		const refused = await call("POST", "/ap/application-runs", event);
		expect(refused.status).toBe(409);
		expect(refused.body.error).toContain("0.4.220");
		expect((await appRow("escalation-old"))?.status).toBe("materials_ready");
		expect(dispatches()).toHaveLength(0);
		d1.exec("UPDATE instance_runtime_nodes SET runner_version = '0.4.225' WHERE instance_id = 'ap'");
		const started = await call("POST", "/ap/application-runs", event);
		expect(started.status).toBe(201);
		expect(started.body.run.policy).toMatchObject({ escalationLevel: "balanced", mode: "fill_and_review" });
		expect(dispatches()[0].body.policy).toMatchObject({ escalationLevel: "balanced", mode: "fill_and_review" });
		expect(started.body.run.trace).toContainEqual(expect.objectContaining({ type: "run.requested", detail: expect.objectContaining({ escalationLevel: "balanced" }) }));
	});
	it("checks the frozen policy on queued retries instead of a later permissive or conservative setting", async () => {
		await call("PUT", "/ap/application-runner/settings", { escalationLevel: "balanced" });
		answers["/local-apply/run"] = { status: 409, body: { error: "This machine is already filling 1 application(s) for this agent (limit 1)." } };
		const started = await call("POST", "/ap/application-runs", readyApp("escalation-queued"));
		expect(started.body.run.status).toBe("queued");
		await call("PUT", "/ap/application-runner/settings", { escalationLevel: "conservative" });
		d1.exec("UPDATE instance_runtime_nodes SET runner_version = '0.4.219' WHERE instance_id = 'ap'");
		d1.exec("UPDATE local_apply_runs SET next_attempt_at = 0 WHERE status = 'queued'");
		expect(await dispatchNextQueuedFill(env(), "ap", "u1")).toBe("queued");
		expect(dispatches()).toHaveLength(1);
		await call("PUT", "/ap/application-runner/settings", { escalationLevel: "autonomous" });
		d1.exec("UPDATE instance_runtime_nodes SET runner_version = '0.4.225' WHERE instance_id = 'ap'");
		d1.exec("UPDATE local_apply_runs SET next_attempt_at = 0 WHERE status = 'queued'");
		answers["/local-apply/run"] = { status: 202, body: { status: "running" } };
		expect(await dispatchNextQueuedFill(env(), "ap", "u1")).toBe("dispatched");
		expect(dispatches().at(-1)?.body.policy).toMatchObject({ escalationLevel: "balanced", mode: "fill_and_review" });
	});
});

describe("owner instance memory reaches application dispatch (#1508)", () => {
	const preference = (answer: string) => ({ key: "job_application_preferences", source: "user", type: "preference", updatedAt: Date.now(), content: JSON.stringify({ version: 1, facts: [{ field: "salary_expectation", answer, confirmedAt: "2026-10-01" }], pendingFields: ["salary_super_basis", "disclosures"] }) });
	it("binds the Runner's own current facts without changing documents or submission authority", async () => {
		instanceMemory.ap = [preference("AUD 150,000")]; instanceMemory.t1 = [preference("AUD 180,000")];
		const result = await call("POST", "/ap/application-runs", readyApp("prefs-own"));
		expect(result.status).toBeLessThan(300);
		const task = dispatches()[0].body;
		expect(task.instancePreferences).toMatchObject({ instanceId: "ap", facts: [{ field: "salary_expectation", answer: "AUD 150,000" }] });
		expect(task.policy).toMatchObject({ mode: "fill_and_review" });
		expect((task.policy as Record<string, unknown>).submitGate).toBeUndefined();
		expect(task.artifacts).toMatchObject([{ sha256: SHA_R }, { sha256: SHA_C }]);
		const receipt = result.body.run.trace.find((event: { type: string; detail?: { role?: string } }) => event.type === "source.read" && event.detail?.role === "instance_preferences");
		expect(receipt.detail).toMatchObject({ count: 1, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
		expect(JSON.stringify(receipt)).not.toMatch(/150,000|180,000/);
	});
	it("reads edited memory afresh when a queued run reaches the machine", async () => {
		instanceMemory.ap = [preference("AUD 150,000")];
		answers["/local-apply/run"] = { status: 409, body: { error: "This machine is already filling 1 application(s) for this agent (limit 1)." } };
		const started = await call("POST", "/ap/application-runs", readyApp("prefs-queued"));
		expect(started.body.run.status).toBe("queued");
		memoryReadStatus = 503;
		d1.exec("UPDATE local_apply_runs SET next_attempt_at = 0 WHERE status = 'queued'");
		expect(await dispatchNextQueuedFill(env(), "ap", "u1")).toBe("queued");
		expect(dispatches()).toHaveLength(1);
		memoryReadStatus = 200;
		instanceMemory.ap = [preference("AUD 160,000")];
		d1.exec("UPDATE local_apply_runs SET next_attempt_at = 0 WHERE status = 'queued'");
		answers["/local-apply/run"] = { status: 202, body: { status: "running" } };
		expect(await dispatchNextQueuedFill(env(), "ap", "u1")).toBe("dispatched");
		expect(dispatches().at(-1)?.body.instancePreferences).toMatchObject({ facts: [{ answer: "AUD 160,000" }] });
		expect(dispatches().at(-1)?.body.policy).toMatchObject({ mode: "fill_and_review" });
	});
	it("does not claim an application when its preference memory cannot be read", async () => {
		memoryReadStatus = 503;
		const result = await call("POST", "/ap/application-runs", readyApp("prefs-unreadable"));
		expect(result.status).toBe(503);
		expect(dispatches()).toHaveLength(0);
		expect((await appRow("prefs-unreadable"))?.status).toBe("materials_ready");
	});
});

describe("end to end: approved lead → materials_ready → filled and awaiting review, exactly once", () => {
	it("chains the Tailor into the Runner, writes the lifecycle back with an audit row per move, and never dispatches twice", async () => {
		const plan = planJobLeadTriage({ id: "lead-1", data: { title: "Staff Engineer", company: "Globex", location: "Sydney", url: "https://jobs.example.com/1", email: "recruiter@globex.example", status: "new" } } as never, { action: "apply", sourceInstanceId: "scout" }, { now: "2026-10-07T00:00:00.000Z" });
		if (!plan.ok || !plan.event) throw new Error("fixture lead did not plan");
		await deliverEvent(env(), "scout", "u1", JOB_LEAD_APPLY_EVENT, [plan.event], { traceId: plan.event.eventId });
		const tailorRun = sent.find((s) => s.path === "/local-artifact/run")?.body.runId as string;
		// A pre-cloud run completing after upgrade still drives the existing fill lifecycle.
		d1.DB.prepare("UPDATE local_artifact_runs SET policy = json_remove(policy, '$.cloudDocuments') WHERE id = ?1").bind(tailorRun).run();
		answers["/local-artifact/status"] = {
			status: 200,
			body: {
				state: "ended",
				lastSeq: 1,
				events: [],
				result: {
					runId: tailorRun,
					outcome: "completed",
					traceId: tailorRun,
					engineAuth: "machine-login",
					profileVersion: "0123456789abcdef",
					generatedAt: "2026-10-07T00:05:00.000Z",
					artifacts: [
						{ kind: "resume", path: `~/jobs/applications/lead-1/${tailorRun}/resume.md`, sha256: SHA_R, bytes: 900 },
						{ kind: "cover_letter", path: `~/jobs/applications/lead-1/${tailorRun}/cover-letter.md`, sha256: SHA_C, bytes: 700 },
					],
					sourceHashes: [],
				},
			},
		};
		const apps = (await call("GET", "/t1/applications")).body.applications;
		// Reading the application pulls the Tailor's run, which emits materials_ready → the Runner.
		const read = await call("GET", `/t1/applications/${apps[0].id}`);
		expect(read.body.application.status).toBe("filling");

		expect(dispatches()).toHaveLength(1);
		const task = dispatches()[0].body;
		expect(task).toMatchObject({
			type: "local_browser.apply",
			instanceId: "ap",
			applicationId: apps[0].id,
			authMode: "machine",
			applicationUrl: "https://jobs.example.com/1",
			artifacts: [
				{ kind: "resume", sha256: SHA_R },
				{ kind: "cover_letter", sha256: SHA_C },
			],
			policy: { mode: "fill_and_review", allowDomains: ["jobs.example.com"] },
		});
		// Default policy: no gate is ever sent, so the runner cannot submit.
		expect((task.policy as Record<string, unknown>).submitGate).toBeUndefined();
		expect(JSON.stringify(task)).not.toMatch(/recruiter@globex|token|apiKey/i);

		// Replays: the owner route with the same event, and a fresh emission of it — the same run.
		const ready = JSON.parse((await appRow(apps[0].id))?.ready_event as string);
		expect((await call("POST", "/ap/application-runs", { event: ready })).body.outcome).toBe("existing");
		await deliverEvent(env(), "t1", "u1", "job.application.materials_ready", [ready], { traceId: "a-retry" });
		expect(dispatches()).toHaveLength(1);
		expect((await d1.DB.prepare("SELECT COUNT(*) AS n FROM local_apply_runs").first<{ n: number }>())?.n).toBe(1);

		const runId = task.runId as string;
		// A pause on the runner shows on the application as blocked, with the question.
		runner("paused", { pause: { reason: "missing_answer", question: "Expected salary?" }, events: [{ seq: 1, type: "run.paused", at: "2026-10-07T00:06:00Z", pauseReason: "missing_answer", detail: { value: "secret answer" } }] });
		const paused = await call("GET", `/ap/application-runs/${runId}`);
		expect(paused.body.run).toMatchObject({ status: "paused", pause: { reason: "missing_answer", question: "Expected salary?" } });
		expect(paused.body.application).toMatchObject({ status: "blocked", blockReason: "missing_answer", blockQuestions: ["Expected salary?"] });
		expect(JSON.stringify(paused.body.run.trace)).not.toContain("secret answer");

		// The owner answers; the answer goes to the runner and onto the application's decision (#1079), never into the application record.
		runner("running", { lastSeq: 2, events: [{ seq: 2, type: "run.resumed", at: "2026-10-07T00:07:00Z" }] });
		const resumed = await call("POST", `/ap/application-runs/${runId}/resume`, { answers: [{ question: "Expected salary?", answer: "150000 AUD" }] });
		expect(resumed.body.run.status).toBe("running");
		expect(sent.find((s) => s.path === "/local-apply/resume")?.body).toMatchObject({ runId, answers: [{ question: "Expected salary?", answer: "150000 AUD" }] });
		expect(JSON.stringify(await appRow(apps[0].id))).not.toContain("150000");

		runner("ended", { lastSeq: 3, events: [{ seq: 3, type: "review.ready", at: "2026-10-07T00:08:00Z", detail: { class: "review" } }], result: RESULT(runId) });
		await syncActiveApplyRuns(env());
		await syncActiveApplyRuns(env()); // a second pull changes nothing
		const done = await call("GET", `/ap/application-runs/${runId}`);
		expect(done.body.run).toMatchObject({ status: "awaiting_review", engineAuth: "machine-login" });
		expect(done.body.application).toMatchObject({ status: "awaiting_review", submittedAt: null, submittedUrl: null, submitAttemptedAt: null });
		// From the Tailor's creation of the application (#958) to the Runner's last move, one row per version.
		expect(done.body.audit.map((a: { from: string; to: string }) => `${a.from}→${a.to}`)).toEqual(["apply_requested→tailoring", "tailoring→materials_ready", "materials_ready→filling", "filling→blocked", "blocked→filling", "filling→awaiting_review"]);
		expect(done.body.audit.slice(2).every((a: { actorInstanceId: string; runId: string }) => a.actorInstanceId === "ap" && a.runId === runId)).toBe(true);
		expect(done.body.audit.map((a: { version: number }) => a.version)).toEqual([0, 1, 2, 3, 4, 5]);
	});

	it("two starts racing on one application: one run, one dispatch", async () => {
		const ev = readyApp("lead-2");
		const [a, b] = await Promise.all([call("POST", "/ap/application-runs", ev), call("POST", "/ap/application-runs", { ...ev, eventId: "another-delivery-id" })]);
		expect([a.body.outcome, b.body.outcome].sort()).toEqual(["existing", "started"]);
		expect(dispatches()).toHaveLength(1);
		expect(await audit("lead-2")).toHaveLength(1);
	});

	it("no runner connected: 503 and nothing recorded, so the outbox retries", async () => {
		getBoundRunnerConn.mockResolvedValue(null);
		const r = await call("POST", "/ap/application-runs", readyApp("lead-3"));
		expect(r.status).toBe(503);
		expect((await appRow("lead-3"))?.status).toBe("materials_ready");
		expect((await d1.DB.prepare("SELECT COUNT(*) AS n FROM local_apply_runs").first<{ n: number }>())?.n).toBe(0);
	});
});

describe("shared website access on application dispatch", () => {
	it.each(["allow_all", "allowlist", "ask_once"])("freezes %s without granting submission or implicitly listing the starting job host", async (mode) => {
		const websiteAccess = { mode, domains: [] };
		expect((await call("PUT", "/ap/browser-settings", { websiteAccess })).status).toBe(200);
		const started = await call("POST", "/ap/application-runs", readyApp("website-policy"));
		expect(started.status).toBeLessThan(300);
		const expected = { ...websiteAccess, ...(mode === "ask_once" ? { rememberedDomains: [], deniedDomains: [] } : {}) };
		expect(dispatches()[0].body.policy).toMatchObject({ mode: "fill_and_review", browserWebsiteAccess: expected });
		expect(started.body.run.policy).toMatchObject({ browserWebsiteAccess: expected, gate: { allowed: false } });
		await call("PUT", "/ap/browser-settings", { websiteAccess: null });
		expect(JSON.parse((await d1.DB.prepare("SELECT policy FROM local_apply_runs WHERE id = ?1").bind(started.body.run.id).first<{ policy: string }>())!.policy).browserWebsiteAccess).toEqual(expected);
	});
	it("refuses explicit website policy on CLI208 before claiming an application", async () => {
		await call("PUT", "/ap/browser-settings", { websiteAccess: { mode: "allow_all", domains: [] } });
		d1.exec("UPDATE instance_runtime_nodes SET runner_version = '0.4.208' WHERE instance_id = 'ap'");
		const refused = await call("POST", "/ap/application-runs", readyApp("website-old"));
		expect(refused.status).toBe(409);
		expect(refused.body.error).toMatch(/0\.4\.209/);
		expect(dispatches()).toEqual([]);
		expect((await d1.DB.prepare("SELECT COUNT(*) AS n FROM local_apply_runs").first<{n: number}>())?.n).toBe(0);
	});
});

describe("the owner's browser-screenshot switch (#1064)", () => {
	const frame = btoa(String.fromCharCode(0xff, 0xd8, 0xff, 0xe0, 1));
	const storedRun = (id: string) => d1.DB.prepare("SELECT policy, trace FROM local_apply_runs WHERE id = ?1").bind(id).first<{ policy: string; trace: string }>();

	it("freezes the owner's blur choice and refuses old runners before a fill starts", async () => {
		await call("PUT", "/ap/browser-screenshots", { blurFormFields: false });
		d1.exec("UPDATE instance_runtime_nodes SET runner_version = '0.4.198' WHERE instance_id = 'ap'");
		const refused = await call("POST", "/ap/application-runs", readyApp("blur-old"));
		expect(refused.status).toBe(409);
		expect(refused.body.error).toMatch(/0.4.199/);
		expect(dispatches()).toHaveLength(0);
		d1.exec("UPDATE instance_runtime_nodes SET runner_version = '0.4.225' WHERE instance_id = 'ap'");
		const started = await call("POST", "/ap/application-runs", readyApp("blur-new"));
		expect(started.status, JSON.stringify(started.body)).toBeLessThan(300);
		expect(dispatches()[0].body.policy).toMatchObject({ blurFormFields: false });
		await call("PUT", "/ap/browser-screenshots", { blurFormFields: true });
		expect(JSON.parse((await storedRun(started.body.run.id))!.policy)).toMatchObject({ blurFormFields: false });
	});

	it("OFF: the fill run records it, the runner is told, and its frames are never pulled", async () => {
		await call("PUT", "/ap/browser-screenshots", { enabled: false });
		stored.clear();
		const runId = (await call("POST", "/ap/application-runs", readyApp("lead-shots-off"))).body.run.id as string;
		expect(dispatches()[0].body.policy).toMatchObject({ screenshots: false });
		const row = await storedRun(runId);
		expect(JSON.parse(row!.policy)).toMatchObject({ screenshots: false });
		expect(JSON.parse(row!.trace)[0]).toMatchObject({ type: "run.requested", detail: { screenshots: "off", reason: "owner_setting" } });
		runner("running");
		answers["/local-apply/shots"] = { status: 200, body: { runId, shots: [{ seq: 1, point: "navigated", url: "https://jobs.example.com/1", mimeType: "image/jpeg", data: frame, at: "2026-10-14T00:00:00Z" }], lastSeq: 1 } };
		await call("GET", `/ap/application-runs/${runId}`);
		expect(sent.some((x) => x.path === "/local-apply/shots")).toBe(false);
		expect(stored.size).toBe(0);
	});

	it("ON (the default): the same run asks the runner for its frames, as #1063 shipped", async () => {
		const runId = (await call("POST", "/ap/application-runs", readyApp("lead-shots-on"))).body.run.id as string;
		expect(dispatches()[0].body.policy).not.toHaveProperty("screenshots");
		expect(JSON.parse((await storedRun(runId))!.trace)[0].detail).toMatchObject({ screenshots: "on" });
		runner("running");
		stored.clear();
		answers["/local-apply/shots"] = { status: 200, body: { runId, shots: [{ seq: 1, point: "navigated", url: "https://jobs.example.com/1", mimeType: "image/jpeg", data: frame, at: "2026-10-14T00:00:00Z" }], lastSeq: 1 } };
		await call("GET", `/ap/application-runs/${runId}`);
		expect(sent.some((x) => x.path === "/local-apply/shots")).toBe(true);
		expect([...stored.keys()]).toEqual([`browser-artifacts/u1/ap/local_apply_run/${runId}/00001.jpg`]);
	});
});

/** The live shape of run bfecb6f4: a one-click press, then a sign-in page and no receipt. */
async function pressedThenSignIn(id: string) {
	await enableAutoSubmit();
	const r = await call("POST", "/ap/application-runs", readyApp(id));
	const runId = r.body.run.id as string;
	const gateId = r.body.run.policy.gate.gateId as string;
	runner("ended", {
		events: [
			{ seq: 1, type: "submit.attempted", at: "2026-10-14T06:28:26Z", domain: "jobs.example.com", detail: { class: "submit", gateId } },
			{ seq: 2, type: "submit.unconfirmed", at: "2026-10-14T06:28:42Z", url: "https://jobs.example.com/login", detail: { gateId, looks: 6, urlChanged: true, titleChanged: true } },
		],
		lastSeq: 2,
		result: RESULT(runId, { outcome: "blocked", mode: "auto_submit", filled: 0, uploaded: [], submitAttempted: true, blockReason: "submit_unconfirmed", questions: ["The application was submitted but the site did not confirm it. Check the employer's site or your email before anything is retried."] }),
	});
	await call("GET", `/ap/application-runs/${runId}`);
	return runId;
}

describe("an owner assertion that nothing was sent allows ONE clean retry (#1073)", () => {
	const CONFIRM = "I checked the employer site and nothing was submitted";
	const card = async (id: string) => (await call("GET", "/ap/application-queue")).body.items.find((i: { applicationId: string }) => i.applicationId === id);
	const act = async (id: string, action: string, extra: Record<string, unknown> = {}) => {
		const c = await card(id);
		return call("POST", "/t1/application-queue/actions", { action, application_id: id, expected_status: c.status, expected_version: c.stateVersion, ...extra });
	};
	const assertion = (id: string) => d1.DB.prepare("SELECT * FROM application_owner_assertions WHERE application_id = ?1").bind(id).first<Record<string, unknown>>();
	/** The live application carries its materials_ready event (what a retry fills from); `readyApp` does not. */
	const uncertain = async (id: string) => {
		const runId = await pressedThenSignIn(id);
		await d1.DB.prepare("UPDATE job_applications SET ready_event = ?1 WHERE id = ?2").bind(JSON.stringify({ eventId: `t1:${id}:1:materials`, applicationId: id }), id).run();
		return runId;
	};

	it("DEFAULT: with no assertion an attempted submit stays blocked — no retry offered, a forced one refused", async () => {
		await uncertain("lead-oa1");
		const c = await card("lead-oa1");
		expect(c.actions).toEqual(expect.arrayContaining(["assert_not_submitted", "defer", "archive"]));
		expect(c.actions).not.toContain("retry_fill");
		expect((await act("lead-oa1", "retry_fill")).status).toBe(409);
		// The outbox path skips the action table entirely — the fill guard itself refuses it.
		await d1.DB.prepare("UPDATE job_applications SET status = 'materials_ready' WHERE id = 'lead-oa1'").run();
		const direct = await call("POST", "/ap/application-runs", { eventType: "job.application.materials_ready", eventId: "t1:lead-oa1:retry-direct", applicationId: "lead-oa1", tailorInstanceId: "t1", leadId: "lead-oa1" });
		expect(direct.status).toBe(409);
		expect(direct.body.error).toMatch(/already attempted/);
		expect(dispatches()).toHaveLength(1);
	});

	it("is refused without the exact confirmation, without a statement, or for a different fill run — and records nothing", async () => {
		const runId = await uncertain("lead-oa2");
		expect((await act("lead-oa2", "assert_not_submitted", { fill_run_id: runId, statement: "Checked SEEK Applied jobs" })).status).toBe(400);
		expect((await act("lead-oa2", "assert_not_submitted", { fill_run_id: runId, confirm: CONFIRM })).status).toBe(400);
		const wrong = await act("lead-oa2", "assert_not_submitted", { fill_run_id: "some-other-run", statement: "Checked", confirm: CONFIRM });
		expect(wrong.status).toBe(409);
		expect(wrong.body.error).toMatch(/current attempt/);
		expect(await assertion("lead-oa2")).toBeNull();
	});

	it("an assertion is audited as the OWNER's, unblocks exactly one retry, and the retry spends it", async () => {
		const runId = await uncertain("lead-oa3");
		const before = await d1.DB.prepare("SELECT submit_attempted_at FROM job_applications WHERE id = 'lead-oa3'").first<{ submit_attempted_at: number }>();
		const out = await act("lead-oa3", "assert_not_submitted", { fill_run_id: runId, statement: "SEEK Applied jobs does not list Gentrack.", confirm: CONFIRM, surface: "mcp" });
		expect(out.status, JSON.stringify(out.body)).toBe(200);
		// The durable assertion row: the owner's words, the surface, the attempt and the marker it covers.
		expect(await assertion("lead-oa3")).toMatchObject({ fill_run_id: runId, kind: "not_submitted", statement: "SEEK Applied jobs does not list Gentrack.", actor: "owner_mcp", prior_submit_attempted_at: before!.submit_attempted_at, consumed_at: null });
		// The lifecycle audit names it as the owner's assertion, not proof.
		expect((await audit("lead-oa3")).at(-1)).toMatchObject({ from_status: "blocked", to_status: "blocked", actor: "owner", reason: "owner_asserted_not_submitted" });
		expect((await appRow("lead-oa3"))!.block_questions).toMatch(/your assertion, not proof/);
		expect(d1.sqlite.prepare("SELECT count(*) AS n FROM agent_events WHERE event = 'application.owner_asserted_not_submitted'").get()).toEqual({ n: 1 });
		// It is not reconciliation proof: no reconciliation record is written or changed.
		expect(d1.sqlite.prepare("SELECT count(*) AS n FROM local_apply_reconciliations").get()).toEqual({ n: 0 });

		const c = await card("lead-oa3");
		expect(c.actions).toContain("retry_fill");
		expect(c.actions).not.toContain("assert_not_submitted");

		const retried = await act("lead-oa3", "retry_fill");
		expect(retried.status, JSON.stringify(retried.body)).toBe(200);
		expect(dispatches()).toHaveLength(2);
		const newRun = retried.body.result.runId as string;
		expect(await assertion("lead-oa3")).toMatchObject({ consumed_run_id: newRun, consumed_at: expect.any(Number) });
		expect((await appRow("lead-oa3"))).toMatchObject({ fill_run_id: newRun, submit_attempted_at: null });
		// The new run carries which assertion allowed it.
		const trace = JSON.parse((await d1.DB.prepare("SELECT trace FROM local_apply_runs WHERE id = ?1").bind(newRun).first<{ trace: string }>())!.trace) as Array<{ type: string; detail?: Record<string, unknown> }>;
		expect(trace).toEqual(expect.arrayContaining([expect.objectContaining({ type: "policy.decision", detail: expect.objectContaining({ basis: "owner_asserted_not_submitted" }) })]));
	});

	it("ONE assertion is ONE fill: a second uncertain end is blocked again until the owner asserts again", async () => {
		const first = await uncertain("lead-oa4");
		await act("lead-oa4", "assert_not_submitted", { fill_run_id: first, statement: "Checked.", confirm: CONFIRM });
		const second = (await act("lead-oa4", "retry_fill")).body.result.runId as string;
		const gateId = (await d1.DB.prepare("SELECT policy FROM local_apply_runs WHERE id = ?1").bind(second).first<{ policy: string }>())!.policy;
		runner("ended", { events: [{ seq: 1, type: "submit.attempted", at: "2026-10-15T00:00:00Z", domain: "jobs.example.com", detail: { class: "submit", gateId: JSON.parse(gateId).gate.gateId } }], lastSeq: 1, result: RESULT(second, { outcome: "blocked", filled: 0, uploaded: [], submitAttempted: true, blockReason: "submit_unconfirmed", questions: ["unconfirmed"] }) });
		await call("GET", `/ap/application-runs/${second}`);
		const c = await card("lead-oa4");
		expect(c.actions).not.toContain("retry_fill");
		expect(c.actions).toContain("assert_not_submitted");
		expect((await act("lead-oa4", "retry_fill")).status).toBe(409);
	});

	it("from DEFERRED (where the live application sits): the assertion brings it back to be filled", async () => {
		const runId = await uncertain("lead-oa5");
		await act("lead-oa5", "defer");
		const deferred = await card("lead-oa5");
		expect(deferred.actions).toEqual(expect.arrayContaining(["apply", "assert_not_submitted", "archive"]));
		await act("lead-oa5", "assert_not_submitted", { fill_run_id: runId, statement: "Checked SEEK.", confirm: CONFIRM });
		expect((await audit("lead-oa5")).at(-1)).toMatchObject({ from_status: "deferred", to_status: "materials_ready", reason: "owner_asserted_not_submitted" });
		expect((await card("lead-oa5")).actions).toContain("request_review");
		const reviewed = await act("lead-oa5", "request_review");
		expect(reviewed.status, JSON.stringify(reviewed.body)).toBe(200);
		expect(dispatches()).toHaveLength(2);
	});

	it("materials_ready after an attempt, with no assertion, no longer offers fills that can only fail", async () => {
		const runId = await uncertain("lead-oa6");
		await act("lead-oa6", "defer");
		await act("lead-oa6", "apply");
		const c = await card("lead-oa6");
		expect(c.status).toBe("materials_ready");
		expect(c.actions).not.toContain("start_fill");
		expect(c.actions).not.toContain("request_review");
		expect(c.actions).toContain("assert_not_submitted");
		expect(runId).toBeTruthy();
	});
});

describe("an unconfirmed submit tells the owner, and offers only the read-only check (#1068)", () => {
	const notes = async () => (await d1.DB.prepare("SELECT type, title, body, url, kind, instance_id, dedupe_key FROM notifications WHERE user_id = 'u1' ORDER BY created_at").all<Record<string, unknown>>()).results ?? [];
	it("raises ONE decision_required alert for the application — never a retry, and nothing claimed about the send", async () => {
		await pressedThenSignIn("lead-uc1");
		expect((await appRow("lead-uc1"))).toMatchObject({ status: "blocked", block_reason: "submit_unconfirmed" });
		const raised = await notes();
		expect(raised).toEqual([expect.objectContaining({ type: "apply", kind: "alert", instance_id: "ap", url: "/console/instances/ap/applications?application=lead-uc1" })]);
		expect(String(raised[0].title)).toBe("Check whether it was sent: Staff Engineer at Globex");
		expect(String(raised[0].body)).toMatch(/will not be retried/);
		expect(String(raised[0].body)).toMatch(/read-only/);
		expect(String(raised[0].body)).not.toMatch(/was not sent|nothing was sent|retry it/i);
		// No retry is offered for an attempted submit — the card still says so after the push.
		const read = await call("GET", "/ap/application-queue");
		const item = read.body.items.find((i: { applicationId: string }) => i.applicationId === "lead-uc1");
		expect(item.actions).not.toContain("retry_fill");
	});

	it("a replayed settle or a sweep never raises it twice", async () => {
		const runId = await pressedThenSignIn("lead-uc2");
		await call("GET", `/ap/application-runs/${runId}`);
		await syncActiveApplyRuns(env());
		expect(await notes()).toHaveLength(1);
	});

	it.each(["ask", "deny"])("website permission %s during reconciliation creates no submission proof or retry", async (decision) => {
		const runId = await pressedThenSignIn("lead-website-reconcile");
		await call("PUT", "/ap/browser-settings", { websiteAccess: { mode: decision === "ask" ? "ask_once" : "allowlist", domains: [] } });
		answers["/local-apply/reconciliation/run"] = (body) => ({ status: 200, body: { reconciliationId: body.reconciliationId, runId, applicationId: "lead-website-reconcile", state: "ended", result: { state: "no_submission_proven", proofKind: "explicit_site_no_submission" }, websiteAccess: { decision, mode: decision === "ask" ? "ask_once" : "allowlist", hostname: "jobs.example.com", url: "https://jobs.example.com/history", actionDispatched: false } } });
		const before = dispatches().length;
		const out = await call("POST", `/ap/application-runs/${runId}/reconciliation`);
		expect(out.status).toBe(409);
		expect(out.body).toMatchObject({ state: "blocked", reconciliation: { state: "requested" } });
		expect(out.body.error).toMatch(decision === "ask" ? /website-requests/ : /denied/);
		expect((await call("GET", `/ap/application-runs/${runId}/reconciliation`)).body.reconciliation.state).toBe("requested");
		expect(dispatches()).toHaveLength(before);
	});

	it("is the attempt #1013 can reconcile: the owner's read-only check is accepted for exactly this run", async () => {
		const runId = await pressedThenSignIn("lead-uc3");
		// The owner's machine is away: the durable request is still recorded for this exact attempt.
		getBoundRunnerConn.mockResolvedValue(null);
		const out = await call("POST", `/ap/application-runs/${runId}/reconciliation`);
		expect(out.status, JSON.stringify(out.body)).toBe(202);
		expect(out.body).toMatchObject({ reconciliation: { runId, applicationId: "lead-uc3", state: "requested" }, runner: { state: "waiting_for_runtime" } });
	});

	it("a run blocked for any OTHER reason raises no such alert", async () => {
		const r = await call("POST", "/ap/application-runs", readyApp("lead-uc4"));
		runner("ended", { result: RESULT(r.body.run.id, { outcome: "blocked", filled: 0, uploaded: [], blockReason: "incomplete", questions: ["Stopped."] }) });
		await call("GET", `/ap/application-runs/${r.body.run.id}`);
		expect((await notes()).filter((n) => String(n.dedupe_key).includes("decision_required"))).toEqual([]);
	});
});

describe("submission is gated", () => {
	it("is impossible under the default policy: the gate refuses and names why", async () => {
		const r = await call("POST", "/ap/application-runs", readyApp("lead-4"));
		expect(r.body.run.policy).toMatchObject({ mode: "fill_and_review", gate: { allowed: false, gateId: null } });
		const failing = r.body.run.policy.gate.checks.filter((c: { ok: boolean }) => !c.ok).map((c: { check: string }) => c.check);
		expect(failing).toEqual(expect.arrayContaining(["auto_submit_enabled", "domain_allowlisted", "role_matches", "daily_cap"]));
		expect(r.body.run.trace.find((e: { type: string }) => e.type === "policy.submit_gate").detail).toMatchObject({ mode: "fill_and_review", decision: "refused" });
		expect((dispatches()[0].body.policy as Record<string, unknown>).submitGate).toBeUndefined();
	});

	it("a runner claiming a submit the policy did not permit is not recorded as submitted", async () => {
		const r = await call("POST", "/ap/application-runs", readyApp("lead-5"));
		const runId = r.body.run.id;
		runner("ended", { result: RESULT(runId, { outcome: "submitted", mode: "auto_submit", submitAttempted: true, submitted: { url: "https://jobs.example.com/thanks", at: "2026-10-07T00:09:00Z", gateId: "forged" } }) });
		const read = await call("GET", `/ap/application-runs/${runId}`);
		expect(read.body.application).toMatchObject({ status: "blocked", blockReason: "submit_unconfirmed", submittedAt: null, submittedUrl: null });
		expect(read.body.application.submitAttemptedAt).not.toBeNull();
	});

	it("with every check passing: auto_submit with a gate, and a confirmed submit is recorded with its page and time", async () => {
		await enableAutoSubmit();
		const r = await call("POST", "/ap/application-runs", readyApp("lead-6"));
		const gateId = r.body.run.policy.gate.gateId;
		expect(r.body.run.policy).toMatchObject({ mode: "auto_submit", gate: { allowed: true } });
		expect(dispatches()[0].body.policy).toEqual({ mode: "auto_submit", browserCommandTimeoutSeconds: 600, escalationLevel: "conservative", allowDomains: ["jobs.example.com", "example.com"], submitGate: { gateId }, blurFormFields: true });

		const runId = r.body.run.id;
		runner("ended", {
			events: [
				{ seq: 1, type: "submit.attempted", at: "2026-10-07T00:09:00Z", domain: "jobs.example.com", detail: { class: "submit", gateId } },
				{ seq: 2, type: "submit.confirmed", at: "2026-10-07T00:09:02Z", url: "https://jobs.example.com/thanks", detail: { gateId } },
			],
			lastSeq: 2,
			result: RESULT(runId, { outcome: "submitted", mode: "auto_submit", submitAttempted: true, submitted: { url: "https://jobs.example.com/thanks", at: "2026-10-07T00:09:02Z", gateId } }),
		});
		const read = await call("GET", `/ap/application-runs/${runId}`);
		expect(read.body.application).toMatchObject({ status: "submitted", submittedAt: "2026-10-07T00:09:02Z", submittedUrl: "https://jobs.example.com/thanks" });
		expect(read.body.run.trace.map((e: { type: string }) => e.type)).toEqual(expect.arrayContaining(["policy.submit_gate", "submit.attempted", "submit.confirmed"]));
		expect(read.body.audit.at(-1)).toMatchObject({ from: "filling", to: "submitted" });
		const terminalNotes = async () => (await d1.DB.prepare("SELECT type, title, body, url, kind, instance_id, dedupe_key FROM notifications WHERE user_id = 'u1' ORDER BY created_at").all<Record<string, unknown>>()).results ?? [];
		expect(await terminalNotes()).toEqual([expect.objectContaining({ type: "apply", kind: "update", instance_id: "ap", url: "/console/instances/ap/applications?application=lead-6", title: expect.stringMatching(/^Application submitted: Staff Engineer at Globex$/), body: "The employer site confirmed this application was submitted.", dedupe_key: expect.any(String) })]);
		// The persisted terminal result is polled again after a restart/scheduled sweep; it must not
		// produce another terminal notification.
		await call("GET", `/ap/application-runs/${runId}`);
		await syncActiveApplyRuns(env());
		expect(await terminalNotes()).toHaveLength(1);

		// The daily cap (1) is now used: the next application fills and waits for review.
		const next = await call("POST", "/ap/application-runs", readyApp("lead-7"));
		expect(next.body.run.policy.mode).toBe("fill_and_review");
		expect(next.body.run.policy.gate.checks.find((c: { check: string }) => c.check === "daily_cap").ok).toBe(false);
	});

	it("records one truthful terminal failure notification and never replays it", async () => {
		const r = await call("POST", "/ap/application-runs", readyApp("lead-terminal-failed"));
		const runId = r.body.run.id as string;
		runner("ended", { result: RESULT(runId, { outcome: "failed", error: "The signed-in runner engine exited before it could fill the form." }) });
		const read = await call("GET", `/ap/application-runs/${runId}`);
		expect(read.body.application).toMatchObject({ status: "failed" });
		const notes = async () => (await d1.DB.prepare("SELECT type, title, body, url, kind, instance_id FROM notifications WHERE user_id = 'u1' ORDER BY created_at").all<Record<string, unknown>>()).results ?? [];
		expect(await notes()).toEqual([expect.objectContaining({ type: "apply", kind: "update", instance_id: "ap", url: "/console/instances/ap/applications?application=lead-terminal-failed", title: "Application failed: Staff Engineer at Globex", body: "The signed-in runner engine exited before it could fill the form." })]);
		await call("GET", `/ap/application-runs/${runId}`);
		await syncActiveApplyRuns(env());
		expect(await notes()).toHaveLength(1);
	});

	it.each([
		["a role outside the approved ones", { title: "Sales Director" }, "role_matches"],
		["a site outside the allow list", { url: "https://careers.globex.com/1" }, "domain_allowlisted"],
	])("refuses auto_submit for %s", async (_label, over, check) => {
		await enableAutoSubmit();
		const r = await call("POST", "/ap/application-runs", readyApp("lead-8", over));
		expect(r.body.run.policy.mode).toBe("fill_and_review");
		expect(r.body.run.policy.gate.checks.find((c: { check: string }) => c.check === check).ok).toBe(false);
	});

	it("an unconfirmed submit blocks the application and nothing starts another fill", async () => {
		await enableAutoSubmit();
		const ev = readyApp("lead-9");
		const r = await call("POST", "/ap/application-runs", ev);
		const runId = r.body.run.id;
		// The attempt is recorded the moment PAGS sees it, while the run is still going.
		runner("running", { events: [{ seq: 1, type: "submit.attempted", at: "2026-10-07T00:09:00Z", detail: { class: "submit" } }] });
		await call("GET", `/ap/application-runs/${runId}`);
		expect((await appRow("lead-9"))?.submit_attempted_at).not.toBeNull();
		runner("ended", { lastSeq: 2, result: RESULT(runId, { outcome: "blocked", mode: "auto_submit", submitAttempted: true, blockReason: "submit_unconfirmed", questions: ["Check the employer's site."] }) });
		const read = await call("GET", `/ap/application-runs/${runId}`);
		expect(read.body.application).toMatchObject({ status: "blocked", blockReason: "submit_unconfirmed", submittedAt: null });
		// Even if the owner puts it back in the queue, the earlier attempt stops another fill.
		await d1.DB.prepare("UPDATE job_applications SET status = 'materials_ready' WHERE id = 'lead-9'").run();
		const again = await call("POST", "/ap/application-runs", { ...ev, eventId: "a-new-delivery" });
		expect(again.status).toBe(409);
		expect(dispatches()).toHaveLength(1);
	});

	it("a runner lost during an auto_submit run leaves the submit state unknown, never retryable", async () => {
		await enableAutoSubmit();
		const r = await call("POST", "/ap/application-runs", readyApp("lead-10"));
		answers["/local-apply/status"] = { status: 404, body: { error: "No application run" } };
		const read = await call("GET", `/ap/application-runs/${r.body.run.id}`);
		expect(read.body.run).toMatchObject({ status: "failed", errorCode: "runner_lost" });
		expect(read.body.application).toMatchObject({ status: "blocked", blockReason: "submit_state_unknown" });
		expect(read.body.application.submitAttemptedAt).not.toBeNull();
	});

	it("a runner lost during fill-and-review is just lost", async () => {
		const r = await call("POST", "/ap/application-runs", readyApp("lead-11"));
		answers["/local-apply/status"] = { status: 404, body: { error: "No application run" } };
		const read = await call("GET", `/ap/application-runs/${r.body.run.id}`);
		expect(read.body.application).toMatchObject({ status: "blocked", blockReason: "runner_lost", submitAttemptedAt: null });
	});

	it("settles a runner-verified unavailable posting to a terminal archive, never a retry", async () => {
		const event = readyApp("lead-unavailable");
		const started = await call("POST", "/ap/application-runs", event);
		const runId = started.body.run.id as string;
		const unavailable = { reason: "expired", url: "https://jobs.example.com/1", observedAt: "2026-10-07T00:09:00.000Z", source: "page_notice" };
		runner("ended", {
			lastSeq: 2,
			events: [{ seq: 2, type: "job.unavailable", at: unavailable.observedAt, url: unavailable.url, detail: { reason: unavailable.reason, source: unavailable.source } }],
			result: RESULT(runId, { outcome: "blocked", blockReason: "job_unavailable", unavailable, summary: "This posting has expired." }),
		});
		await call("GET", `/ap/application-runs/${runId}`);
		const archived = await call("GET", `/t1/applications/lead-unavailable`);
		expect(archived.body.application).toMatchObject({ status: "archived", archiveReason: "job_unavailable", archiveEvidence: unavailable });
		expect((await appRow("lead-unavailable"))?.lead_disposition_synced_at).not.toBeNull();
		expect((await audit("lead-unavailable")).at(-1)).toMatchObject({ from_status: "filling", to_status: "archived", reason: "job_unavailable" });

		// The terminal run is not pulled again and a new readiness delivery returns the same run;
		// neither path can produce another browser dispatch or lifecycle audit.
		await call("GET", `/ap/application-runs/${runId}`);
		const replay = await call("POST", "/ap/application-runs", { ...event, eventId: "unavailable-replay" });
		expect(replay.body).toMatchObject({ outcome: "existing", run: { id: runId } });
		expect(dispatches()).toHaveLength(1);
		expect(await audit("lead-unavailable")).toEqual(expect.arrayContaining([expect.objectContaining({ from_status: "filling", to_status: "archived", reason: "job_unavailable" })]));
		expect(await audit("lead-unavailable")).toHaveLength(2);
	});
});

// ── #973: the owner approves ONE job on the board, and that is what lets it be submitted ──────
//
// The acceptance list from the issue, over the real schema and the real action route — the one the
// console button and `approve_application` both post to. The daily cap is deliberately NEVER set in
// this block: the whole point is that a per-application approval needs none.
describe("per-application Approve & proceed authorizes exactly one submission (#973)", () => {
	/**
	 * A materials_ready application that also HOLDS its readiness event, as the Tailor leaves it in
	 * production — `approve_and_proceed` dispatches from that stored event, the same one the
	 * connection would have delivered, so the owner's approval needs no payload of its own.
	 */
	const readyWithEvent = (id: string) => {
		const ev = readyApp(id);
		d1.DB.prepare("UPDATE job_applications SET ready_event = ?2 WHERE id = ?1").bind(id, JSON.stringify(ev)).run();
		return ev;
	};
	const approve = (id: string, over: Record<string, unknown> = {}) =>
		call("POST", "/t1/application-queue/actions", { action: "approve_and_proceed", application_id: id, expected_status: "materials_ready", ...over });
	const auth = (id: string) => d1.DB.prepare("SELECT * FROM job_application_submit_authorizations WHERE application_id = ?1").bind(id).first<Record<string, unknown>>();
	const card = async (id: string) => (await call("GET", `/t1/application-queue/item?application_id=${id}`)).body.item;

	it("approves, submits that one application, and needs no auto-submit toggle and no daily cap", async () => {
		readyWithEvent("lead-ap1");
		// The Runner's settings allow the site and nothing else: auto-submit OFF, dailyCap 0.
		await call("PUT", "/ap/application-runner/settings", { allowDomains: ["example.com"] });
		const before = await card("lead-ap1");
		expect(before.submitPolicy.allowed, "unapproved: the standing policy must refuse").toBe(false);
		expect(before.actions).toContain("approve_and_proceed");
		expect(before.submitAuthorization).toBeNull();

		const r = await approve("lead-ap1", { expected_version: before.stateVersion });
		expect(r.status).toBe(200);
		expect(r.body.result).toMatchObject({ approval: "granted", mode: "auto_submit", nextAction: expect.stringMatching(/submits it/) });
		// The run the Runner was actually told to do carries the submit mode and the gate that allowed it.
		// What the RUNNER was told — the envelope carries the mode and the gate id that allowed it.
		const dispatched = dispatches().at(-1)?.body as { policy: { mode: string; submitGate?: { gateId: string } } };
		expect(dispatched.policy.mode).toBe("auto_submit");
		expect(dispatched.policy.submitGate?.gateId).toEqual(expect.any(String));
		const run = (await call("GET", `/ap/application-runs/${r.body.result.runId}`)).body.run;
		expect(run.policy.gate.allowed).toBe(true);
		expect(run.policy.gate.checks.find((c: { check: string }) => c.check === "submission_approved")).toMatchObject({ ok: true });
		// Not via the cap: it is still zero, and its check passed on the approval's authority.
		expect(run.policy.gate.checks.find((c: { check: string }) => c.check === "daily_cap")).toMatchObject({ ok: true, why: "approved for this application by the owner" });
		const settings = (await call("GET", "/ap/application-runner/settings")).body.settings;
		expect(settings.autoSubmit.enabled, "the global toggle must still be off").toBe(false);
		expect(settings.autoSubmit.dailyCap).toBe(0);
	});

	it("an unapproved application cannot submit — it fills for review instead", async () => {
		const ev = readyApp("lead-ap2");
		await call("PUT", "/ap/application-runner/settings", { allowDomains: ["example.com"] });
		const item = await card("lead-ap2");
		expect(item.actions).not.toContain("start_fill");
		// Dispatching it anyway (the connection path) must not submit.
		const r = await call("POST", "/ap/application-runs", ev);
		expect(r.body.run.policy.mode).toBe("fill_and_review");
		expect(r.body.run.policy.gate.allowed).toBe(false);
		expect(await auth("lead-ap2")).toBeNull();
	});

	it("is single-use: the run spends it, and a second approval is refused", async () => {
		readyWithEvent("lead-ap3");
		await call("PUT", "/ap/application-runner/settings", { allowDomains: ["example.com"] });
		const first = await approve("lead-ap3");
		const runId = first.body.result.runId as string;
		expect(first.body.result.authorizationConsumedBy).toBe(runId);
		expect(await auth("lead-ap3")).toMatchObject({ consumed_run_id: runId });

		const again = await approve("lead-ap3", { expected_status: "filling" });
		expect(again.status).toBe(409);
		expect(again.body.error).toMatch(/already used by a run|cannot approve/i);
		// Still exactly one authorization row, bound to the one run.
		expect((await d1.DB.prepare("SELECT COUNT(*) AS n FROM job_application_submit_authorizations").first<{ n: number }>())?.n).toBe(1);
	});

	it("a retried approval is idempotent — one authorization, one run, no second submission", async () => {
		readyWithEvent("lead-ap4");
		await call("PUT", "/ap/application-runner/settings", { allowDomains: ["example.com"] });
		const key = { idempotency_key: "approve:lead-ap4:0" };
		const first = await approve("lead-ap4", key);
		const dispatchedAfterFirst = dispatches().length;
		// The same decision sent again (a double-click, a replayed MCP call): the application has
		// left materials_ready, so the CAS refuses it — and nothing new is dispatched either way.
		const replay = await approve("lead-ap4", { ...key, expected_status: "materials_ready" });
		expect(replay.status).toBe(409);
		expect(dispatches()).toHaveLength(dispatchedAfterFirst);
		expect((await d1.DB.prepare("SELECT COUNT(*) AS n FROM job_application_submit_authorizations WHERE application_id = 'lead-ap4'").first<{ n: number }>())?.n).toBe(1);
		expect(await auth("lead-ap4")).toMatchObject({ idempotency_key: "approve:lead-ap4:0", consumed_run_id: first.body.result.runId });
	});

	it("binds to the state version the owner saw: a stale approval is refused with nothing recorded", async () => {
		readyWithEvent("lead-ap5");
		await call("PUT", "/ap/application-runner/settings", { allowDomains: ["example.com"] });
		const stale = await approve("lead-ap5", { expected_version: 99 });
		expect(stale.status).toBe(409);
		expect(stale.body.error).toMatch(/stale/);
		expect(await auth("lead-ap5")).toBeNull();
		expect(dispatches()).toHaveLength(0);
	});

	it("the card shows the approval and the run that spent it, for the board and MCP alike", async () => {
		readyWithEvent("lead-ap6");
		await call("PUT", "/ap/application-runner/settings", { allowDomains: ["example.com"] });
		const r = await approve("lead-ap6");
		const item = await card("lead-ap6");
		expect(item.submitAuthorization).toMatchObject({
			usable: false,
			approvedBy: "owner",
			consumedRunId: r.body.result.runId,
			label: expect.stringMatching(/single-use/),
		});
		expect(item.submitAuthorization.approvedStateVersion).toBe(0);
	});

	it("only a materials_ready application may be approved", async () => {
		const ev = readyApp("lead-ap7");
		await call("PUT", "/ap/application-runner/settings", { allowDomains: ["example.com"] });
		await call("POST", "/ap/application-runs", ev); // → filling, unapproved
		const r = await approve("lead-ap7", { expected_status: "filling" });
		expect(r.status).toBe(409);
		expect(await auth("lead-ap7")).toBeNull();
	});
});

// ── #991: the one-click refusal leaves a blocked application the owner CAN approve ───────────
//
// The live sequence, end to end. Application `435d31c8…` / run `c27d1178…`: a real SEEK listing
// whose final control is a genuine `one_click_apply`. Everything safe worked — the supervisor
// continued the initial checkpoint, the runner refused that control under `fill_and_review`, no
// field was fabricated, no submit was attempted — and the run ENDED, closing the application
// `blocked / incomplete` with "Approve this application to let it be sent, or apply on the site
// yourself". The exposed actions were `retry_fill`, `defer`, `archive`, `mark_not_interested`: the
// safe state had no supported path to the authorized application.
describe("a one-click block is approvable, and the approval is spent once (#991)", () => {
	const readyWithEvent = (id: string) => {
		const ev = readyApp(id);
		d1.DB.prepare("UPDATE job_applications SET ready_event = ?2 WHERE id = ?1").bind(id, JSON.stringify(ev)).run();
		return ev;
	};
	const card = async (id: string) => (await call("GET", `/t1/application-queue/item?application_id=${id}`)).body.item;
	const auth = (id: string) => d1.DB.prepare("SELECT id, consumed_at, consumed_run_id FROM job_application_submit_authorizations WHERE application_id = ?1").bind(id).first<Record<string, unknown>>();
	const settings = async () => (await call("GET", "/ap/application-runner/settings")).body.settings;

	/** Fill once and have the runner refuse a genuine one-click control, as the live run did. */
	async function oneClickBlocked(id: string) {
		// One insert, one event: `readyApp` WRITES the row, so calling it a second time for the
		// dispatch body violates the per-instance idempotency key.
		const ev = readyWithEvent(id);
		await call("PUT", "/ap/application-runner/settings", { allowDomains: ["example.com"] });
		const started = await call("POST", "/ap/application-runs", ev);
		const runId = started.body.run.id as string;
		runner("ended", {
			lastSeq: 3,
			events: [
				{ seq: 2, type: "supervisor.directive", at: "2026-10-08T12:00:00Z", detail: { checkpointId: "initial:1", directive: "continue" } },
				{ seq: 3, type: "policy.decision", at: "2026-10-08T12:00:05Z", detail: { tool: "browser_click", class: "submit", decision: "refused", reason: "fill_and_review", rule: "one_click_apply" } },
			],
			result: RESULT(runId, {
				outcome: "blocked",
				blockReason: "incomplete",
				filled: 0,
				uploaded: [],
				submitAttempted: false,
				summary: "Stopped at a one-click apply control: it can send the application outright, and this run fills and waits for review.",
				questions: ["This listing's apply control can send the application in one click, so a fill-and-review run may not press it, and nothing was entered. Approve this application to let it be sent, or apply on the site yourself."],
			}),
		});
		await syncApplyRun(env(), "u1", (await call("GET", `/ap/application-runs/${runId}`)).body.run);
		return runId;
	}

	it("THE LIVE GAP: the blocked application now offers the one-job approval", async () => {
		await oneClickBlocked("lead-oc1");
		const item = await card("lead-oc1");
		expect(item.status).toBe("blocked");
		expect(item.blockReason).toBe("incomplete");
		// The sentence the record shows, and now an action that matches it.
		expect(item.questions[0]).toMatch(/Approve this application to let it be sent/);
		expect(item.actions, "approval remains available; recorded questions also permit save-only owner answers").toEqual(["resume", "approve_and_proceed", "retry_fill", "defer", "archive", "mark_not_interested"]);
		// Nothing was sent, and no authorization exists until the owner makes one.
		expect(item.submitAuthorization).toBeNull();
		expect(item.submitAttempted).toBe(false);
		expect(await auth("lead-oc1")).toBeNull();
	});

	it("approving records ONE held authorization and says the retry is what spends it", async () => {
		await oneClickBlocked("lead-oc2");
		const before = await card("lead-oc2");
		const r = await call("POST", "/t1/application-queue/actions", { action: "approve_and_proceed", application_id: "lead-oc2", expected_status: "blocked", expected_version: before.stateVersion });
		expect(r.status).toBe(200);
		// The exact run cannot be continued — its browser session ended — so the approval is HELD.
		expect(r.body.result).toMatchObject({ approval: "granted", stage: "post_fill", outcome: "not_resumable", reason: "run_ended", resumable: false });
		expect(String(r.body.result.nextAction)).toMatch(/approval is recorded and held for this application/);
		expect(String(r.body.result.nextAction)).toMatch(/retry_fill/);
		const row = await auth("lead-oc2");
		expect(row, "exactly one authorization, scoped to this application").toBeTruthy();
		expect(row?.consumed_at, "not spent yet — nothing has run").toBeNull();
		// Still nothing sent, and the GLOBAL toggle is untouched: this is one job, not a policy.
		expect((await card("lead-oc2")).submitAttempted).toBe(false);
		expect((await settings()).autoSubmit).toMatchObject({ enabled: false, dailyCap: 0 });
	});

	it("the authorized retry may press THAT application's final control, once, and records it truthfully", async () => {
		await oneClickBlocked("lead-oc3");
		const before = await card("lead-oc3");
		await call("POST", "/t1/application-queue/actions", { action: "approve_and_proceed", application_id: "lead-oc3", expected_status: "blocked", expected_version: before.stateVersion });
		const approved = await card("lead-oc3");
		expect(approved.submitAuthorization).toMatchObject({ usable: true });

		const retry = await call("POST", "/t1/application-queue/actions", { action: "retry_fill", application_id: "lead-oc3", expected_status: "blocked" });
		expect(retry.status).toBe(200);
		// The fake machine still held the FIRST run's result; a status read would settle this new run
		// against it ("the runner's result names another run"). The fresh run is simply running.
		runner("running", { lastSeq: 0 });
		// The run the machine was actually told to do: auto_submit, on the approval's authority.
		const dispatched = dispatches().at(-1)?.body as { policy: { mode: string; submitGate?: { gateId: string } } };
		expect(dispatched.policy.mode).toBe("auto_submit");
		expect(dispatched.policy.submitGate?.gateId).toEqual(expect.any(String));
		const runId = retry.body.result.runId as string;
		const run = (await call("GET", `/ap/application-runs/${runId}`)).body.run;
		expect(run.policy.gate.checks.find((c: { check: string }) => c.check === "submission_approved")).toMatchObject({ ok: true });
		expect(run.policy.gate.checks.find((c: { check: string }) => c.check === "daily_cap")).toMatchObject({ ok: true, why: "approved for this application by the owner" });
		// SPENT, and bound to the run that spent it — that row is the record of what was authorised.
		expect(await auth("lead-oc3")).toMatchObject({ consumed_run_id: runId, consumed_at: expect.any(Number) });

		// The employer's answer, recorded as what it was.
		runner("ended", { lastSeq: 1, result: RESULT(runId, { outcome: "submitted", mode: "auto_submit", submitAttempted: true, submitted: { url: "https://jobs.example.com/thanks", at: "2026-10-08T12:10:00Z", gateId: run.policy.gate.gateId }, filled: 7 }) });
		await syncApplyRun(env(), "u1", (await call("GET", `/ap/application-runs/${runId}`)).body.run);
		const after = await card("lead-oc3");
		expect(after.status).toBe("submitted");
		expect(after.submittedUrl).toBe("https://jobs.example.com/thanks");
		expect(after.submitAttempted).toBe(true);
		// And the approval is finished: no second one, and nothing left to approve.
		expect(after.actions).not.toContain("approve_and_proceed");
		expect((await settings()).autoSubmit).toMatchObject({ enabled: false, dailyCap: 0 });
	});

	it("NO APPROVAL means no submit: the same retry fills and stops again", async () => {
		await oneClickBlocked("lead-oc4");
		const retry = await call("POST", "/t1/application-queue/actions", { action: "retry_fill", application_id: "lead-oc4", expected_status: "blocked" });
		expect(retry.status).toBe(200);
		const dispatched = dispatches().at(-1)?.body as { policy: { mode: string; submitGate?: unknown } };
		expect(dispatched.policy.mode, "unapproved, so fill-and-review — whatever the owner was told").toBe("fill_and_review");
		expect(dispatched.policy.submitGate).toBeUndefined();
	});

	/** A legacy undispatched queue row advanced the canonical fill after claiming recovery. */
	async function lostClaimedRecovery(id: string) {
		const originalRunId = await oneClickBlocked(id);
		const before = await card(id);
		await call("POST", "/t1/application-queue/actions", { action: "approve_and_proceed", application_id: id, expected_status: "blocked", expected_version: before.stateVersion });
		const blocker = await call("POST", "/ap/application-runs", readyWithEvent(`${id}-busy`));
		answers["/local-apply/run"] = { status: 409, body: { error: "This machine is already filling an application for this agent; one at a time." } };
		const first = await call("POST", "/t1/application-queue/actions", { action: "retry_fill", application_id: id, expected_status: "blocked" });
		expect(first.status, JSON.stringify(first.body)).toBe(200);
		const lostRunId = first.body.result.runId as string;
		const lost = (await call("GET", `/ap/application-runs/${lostRunId}`)).body.run;
		expect(lost).toMatchObject({ status: "queued", policy: { mode: "fill_and_review", approvalRecoveryId: expect.any(String) } });
		// Simulate a row from before durable capacity waits: no dispatch acknowledgement, attempts
		// or reason. The real sync path settles it as runner_lost without submitting or spending.
		await d1.DB.prepare("UPDATE local_apply_runs SET queued_reason = NULL, attempts = 0, created_at = ?1 WHERE id = ?2").bind(Date.now() - 11 * 60_000, lostRunId).run();
		await call("GET", `/ap/application-runs/${lostRunId}`);
		expect(await card(id)).toMatchObject({ status: "blocked", blockReason: "runner_lost", fillRunId: lostRunId, submitAttempted: false, submitAuthorization: { usable: true, recoveryPending: true } });
		runner("ended", { result: RESULT(blocker.body.run.id) });
		await call("GET", `/ap/application-runs/${blocker.body.run.id}`);
		answers["/local-apply/run"] = { status: 202, body: { status: "running" } };
		return { originalRunId, lostRunId, recoveryId: lost.policy.approvalRecoveryId as string };
	}

	it.each(["blocked", "failed", "awaiting_review", "materials_ready"])("keeps an exact claimed recovery usable after a guarded undispatched run is lost (%s)", async (status) => {
		const id = `one-click-lost-recovery-${status}`;
		const { lostRunId, recoveryId } = await lostClaimedRecovery(id);
		await d1.DB.prepare("UPDATE job_applications SET status = ?1, block_reason = CASE WHEN ?1 = 'materials_ready' THEN NULL ELSE block_reason END WHERE id = ?2").bind(status, id).run();
		const count = dispatches().length;
		const retried = await call("POST", "/t1/application-queue/actions", { action: "retry_fill", application_id: id, expected_status: status });
		expect(retried.status, JSON.stringify(retried.body)).toBe(200);
		expect(retried.body.result.runId).not.toBe(lostRunId);
		expect(dispatches()).toHaveLength(count + 1);
		expect(dispatches().at(-1)?.body.policy, JSON.stringify(dispatches().at(-1)?.body.policy)).toMatchObject({ mode: "auto_submit" });
		const next = (await d1.DB.prepare("SELECT policy FROM local_apply_runs WHERE id = ?1").bind(retried.body.result.runId).first<{ policy: string }>())!;
		expect(JSON.parse(next.policy).approvalRecoveryId).toBe(recoveryId);
		expect(await auth(id)).toMatchObject({ consumed_run_id: retried.body.result.runId, consumed_at: expect.any(Number) });
		expect((await d1.DB.prepare("SELECT COUNT(*) AS n FROM job_application_submit_authorizations WHERE application_id = ?1").bind(id).first<{ n: number }>())?.n).toBe(1);
	});

	it.each(["blocked", "failed", "awaiting_review", "materials_ready"].flatMap((status) => ["revoked", "materials", "job", "runner", "claim", "attempt", "full uncertainty"].map((changed) => ({ status, changed }))))("does not revive a claimed recovery after $changed changes ($status)", async ({ status, changed }) => {
		const id = `one-click-lost-${status}-${changed}`;
		const { lostRunId } = await lostClaimedRecovery(id);
		await d1.DB.prepare("UPDATE job_applications SET status = ?1, block_reason = CASE WHEN ?1 = 'materials_ready' THEN NULL ELSE block_reason END WHERE id = ?2").bind(status, id).run();
		if (changed === "revoked") await d1.DB.prepare("UPDATE job_application_submit_authorizations SET revoked_at = 1 WHERE application_id = ?1").bind(id).run();
		if (changed === "materials") await d1.DB.prepare("UPDATE job_applications SET profile_version = 'changed-profile' WHERE id = ?1").bind(id).run();
		if (changed === "job") await d1.DB.prepare("UPDATE job_applications SET work_key = 'another-job' WHERE id = ?1").bind(id).run();
		if (changed === "runner") await d1.DB.prepare("UPDATE job_application_submit_authorizations SET recovery_runner_instance_id = 'another-runner' WHERE application_id = ?1").bind(id).run();
		if (changed === "claim") await d1.DB.prepare("UPDATE job_application_submit_authorizations SET recovery_id = 'superseded-claim' WHERE application_id = ?1").bind(id).run();
		if (changed === "attempt") await d1.DB.prepare("UPDATE job_applications SET submit_attempted_at = 1 WHERE id = ?1").bind(id).run();
		if (changed === "full uncertainty") await d1.DB.prepare("UPDATE local_apply_runs SET policy = json_set(policy, '$.toolAccess', 'full') WHERE id = ?1").bind(lostRunId).run();
		const count = dispatches().length;
		const refused = await call("POST", "/t1/application-queue/actions", { action: "retry_fill", application_id: id, expected_status: status });
		expect(refused.status).toBe(409);
		expect(dispatches()).toHaveLength(count);
		expect((await appRow(id))?.fill_run_id).toBe(lostRunId);
		expect(await auth(id)).toMatchObject({ consumed_at: null, consumed_run_id: null });
	});

	it("a second approval is refused — the spent one is the record of what was authorised", async () => {
		await oneClickBlocked("lead-oc5");
		const before = await card("lead-oc5");
		await call("POST", "/t1/application-queue/actions", { action: "approve_and_proceed", application_id: "lead-oc5", expected_status: "blocked", expected_version: before.stateVersion });
		await call("POST", "/t1/application-queue/actions", { action: "retry_fill", application_id: "lead-oc5", expected_status: "blocked" });
		// The approval is spent by that run. Nothing here may grant another.
		const spent = await card("lead-oc5");
		expect(spent.submitAuthorization).toMatchObject({ usable: false, consumedRunId: expect.any(String) });
		expect(spent.actions).not.toContain("approve_and_proceed");
		expect((await d1.DB.prepare("SELECT COUNT(*) AS n FROM job_application_submit_authorizations WHERE application_id = 'lead-oc5'").first<{ n: number }>())?.n).toBe(1);
	});

	it("TELLS THE OWNER, through the generic attention policy, exactly when the approval is offered (#991)", async () => {
		// The other half of the live gap: the record said "approve this application to let it be
		// sent" and nothing reached the owner. This asserts the pairing rather than the prose — a
		// notification is raised for the same state in which `approve_and_proceed` is offered, and
		// it deep links to the Board, which is where that control renders.
		const notes = async () =>
			((await d1.DB.prepare("SELECT type, title, body, url, kind, instance_id, dedupe_key, pushed_at FROM notifications WHERE user_id = 'u1' ORDER BY created_at").all()).results ?? []) as unknown as Array<Record<string, unknown>>;
		expect(await notes()).toHaveLength(0);

		await oneClickBlocked("lead-oc8");
		expect((await card("lead-oc8")).actions).toContain("approve_and_proceed");
		const raised = await notes();
		expect(raised).toHaveLength(1);
		expect(raised[0]).toMatchObject({ type: "apply", kind: "alert", instance_id: "ap", url: "/console/instances/ap/applications?application=lead-oc8" });
		expect(String(raised[0].title)).toMatch(/Approve to send/);
		// The owner's own sentence from the run, not a paraphrase invented here.
		expect(String(raised[0].body)).toMatch(/Approve this application to let it be sent/);
		// An alert interrupts: `pushed_at` is set, which is what the truthful outcome reads back.
		expect(raised[0].pushed_at).toBeTruthy();

		// Approved: the owner has decided, so the next settle must not ask again. Run it for real —
		// the retry ends blocked a second time, and the gate is "is there still a usable approval".
		const before = await card("lead-oc8");
		await call("POST", "/t1/application-queue/actions", { action: "approve_and_proceed", application_id: "lead-oc8", expected_status: "blocked", expected_version: before.stateVersion });
		expect(await notes(), "approving is not itself news to the person who just did it").toHaveLength(1);
	});

	it("blocked at TAILORING offers no approval — there is no form and no final control", async () => {
		readyWithEvent("lead-oc6");
		d1.DB.prepare("UPDATE job_applications SET status = 'blocked', block_reason = 'engine_not_signed_in', fill_run_id = NULL WHERE id = 'lead-oc6'").run();
		const item = await card("lead-oc6");
		expect(item.actions).not.toContain("approve_and_proceed");
		expect(item.actions).toContain("retry_tailoring");
	});

	it("after a submit was ATTEMPTED, nothing is offered to approve — whatever the status says", async () => {
		await oneClickBlocked("lead-oc7");
		d1.DB.prepare("UPDATE job_applications SET submit_attempted_at = 1 WHERE id = 'lead-oc7'").run();
		const item = await card("lead-oc7");
		expect(item.actions).not.toContain("approve_and_proceed");
		expect(item.actions).not.toContain("retry_fill");
	});
});

// ── #982: a safe initial checkpoint fills the form instead of asking for a review of nothing ──
//
// The live failure, end to end: two runs reached `awaiting_review` at the runner's INITIAL
// checkpoint with `filled: 0, uploaded: 0` and no blocker. The brain proposed `request_review` and
// the proposal passed through, so a `fill_and_review` run stopped before filling anything.
describe("a routine checkpoint continues deterministically (#982)", () => {
	const initialCheckpoint = { schemaVersion: 1, checkpointId: "initial:1", facts: { phase: "initial", actions: 1, filled: 0, uploaded: 0, blockers: [], url: "https://jobs.example.com/apply", domain: "jobs.example.com" } };
	const traceOf = async (runId: string) =>
		JSON.parse(String((await d1.DB.prepare("SELECT trace FROM local_apply_runs WHERE id = ?1").bind(runId).first<{ trace: string }>())?.trace ?? "[]")) as Array<{ type: string; detail?: Record<string, unknown> }>;
	const directiveOf = async (runId: string) =>
		await d1.DB.prepare("SELECT directive FROM local_apply_supervisor_directives WHERE run_id = ?1").bind(runId).first<{ directive: string }>();

	/** Park the run at a checkpoint and let the platform decide it, as the cron does. */
	async function parkAt(id: string, checkpoint: Record<string, unknown>) {
		const started = await call("POST", "/ap/application-runs", readyApp(id));
		const runId = started.body.run.id as string;
		runner("paused", { lastSeq: 4, pause: { reason: "supervisor_checkpoint", checkpoint }, events: [{ seq: 4, type: "supervisor.checkpoint", at: "2026-10-08T00:06:00Z", detail: { checkpointId: String(checkpoint.checkpointId) } }] });
		await syncApplyRun(env(), "u1", (await call("GET", `/ap/application-runs/${runId}`)).body.run);
		return runId;
	}

	it("THE regression: initial + filled:0 + no blocker is CONTINUED, and the trace says the platform decided it", async () => {
		// No brain is reachable in this harness, which is the "brain unavailable" half of the issue —
		// before #982 that fell to `request_review` and ended the run as a review of an empty form.
		const runId = await parkAt("lead-c1", initialCheckpoint);
		expect(await directiveOf(runId)).toMatchObject({ directive: "continue" });
		// The directive reached the machine, so the run goes on filling rather than ending.
		expect(sent.filter((x) => x.path === "/local-apply/directive").map((x) => x.body)).toEqual([
			{ runId, checkpointId: "initial:1", schemaVersion: 1, directive: "continue" },
		]);
		// And the rationale is on the trace, with the progress that made it safe.
		const decision = (await traceOf(runId)).find((e) => e.detail?.class === "checkpoint");
		expect(decision?.detail).toMatchObject({ phase: "initial", decision: "continue", source: "policy", reason: "routine_checkpoint_cannot_submit", filled: 0, uploaded: 0 });
	});

	it("a real blocker at the same phase still stops, with the blocker named", async () => {
		const runId = await parkAt("lead-c2", { ...initialCheckpoint, checkpointId: "initial:2", facts: { ...initialCheckpoint.facts, blockers: ["captcha"] } });
		expect(await directiveOf(runId)).toMatchObject({ directive: "stop" });
		const decision = (await traceOf(runId)).find((e) => e.detail?.class === "checkpoint");
		expect(decision?.detail).toMatchObject({ decision: "stop", reason: "blocker", blockers: "captcha" });
	});

	it("a fill_and_review run at before_submit still asks the owner — it never submits", async () => {
		const runId = await parkAt("lead-c3", { schemaVersion: 1, checkpointId: "before-submit:1", facts: { phase: "before_submit", actions: 9, filled: 6, uploaded: 1, blockers: [] } });
		expect(await directiveOf(runId)).toMatchObject({ directive: "request_review" });
		const decision = (await traceOf(runId)).find((e) => e.detail?.class === "checkpoint");
		expect(decision?.detail).toMatchObject({ decision: "request_review", reason: "fill_and_review_never_submits" });
	});

	it("the recorded rationale carries no page value — only ids, counts and the phase", async () => {
		const runId = await parkAt("lead-c4", initialCheckpoint);
		const decision = (await traceOf(runId)).find((e) => e.detail?.class === "checkpoint");
		const text = JSON.stringify(decision);
		for (const leak of ["https://", "jobs.example.com"]) expect(text, leak).not.toContain(leak);
	});

	it("the decision is written once — a replayed pull does not re-decide or re-log it", async () => {
		const runId = await parkAt("lead-c5", initialCheckpoint);
		const before = (await traceOf(runId)).filter((e) => e.detail?.class === "checkpoint").length;
		await syncApplyRun(env(), "u1", (await call("GET", `/ap/application-runs/${runId}`)).body.run);
		expect((await traceOf(runId)).filter((e) => e.detail?.class === "checkpoint")).toHaveLength(before);
		expect((await d1.DB.prepare("SELECT COUNT(*) AS n FROM local_apply_supervisor_directives WHERE run_id = ?1").bind(runId).first<{ n: number }>())?.n).toBe(1);
	});
});

// ── #978: the run is on the owner's NORMAL board, linked to the application ──────────────────
//
// Before this the Board rendered only generic runtime tasks, so a Runner actively filling an
// employer's form had an EMPTY board and the work existed only on a separate Applications surface.
describe("an application execution appears on the normal Kanban (#978)", () => {
	const board = async (instance = "ap") => (await call("GET", `/${instance}/board`)).body;
	const appCard = async (instance = "ap") => {
		type Card = { application?: { applicationId: string; kind: string; stage: string; actions: string[]; traceUrl: string; checkpoint?: { checkpointId: string; directive: string | null }; progress?: { stage: string; label: string; filled: number; uploaded: number; checkpointPhase: string | null; checkpointId: string | null; submitAttempted: boolean; evidence: string }; blockReason?: string; execution?: ApplicationExecutionProjection }; title: string; status: string; attempts: unknown[] };
		const b = (await board(instance)) as { board?: Record<string, Card[]>; items?: Card[] };
		const cards = b.items ?? Object.values(b.board ?? {}).flat();
		return cards.find((c) => c.application);
	};

	it("shows a running card the moment the fill starts, titled with the job it is for", async () => {
		const ev = readyApp("lead-b1");
		await call("POST", "/ap/application-runs", ev);
		const card = await appCard();
		expect(card, "the board must not be empty while the Runner works").toBeTruthy();
		expect(card?.status).toBe("running");
		// Linked to the application, in the words of the lead.
		expect(card?.title).toBe("Staff Engineer — Globex");
		// #986: the stage is the runner's own facts — a run that has opened the page and filled
		// nothing says so, rather than being described as "filling" because its status says running.
		expect(card?.application).toMatchObject({ applicationId: "lead-b1", kind: "fill", stage: "Opening the application in the browser — no field filled yet." });
		// And it points at the correlated trace.
		expect(card?.application?.traceUrl).toContain("/applications/lead-b1/trace");
	});

	it("moves to awaiting-review with the checkpoint when the supervisor pauses it — the acceptance line", async () => {
		const ev = readyApp("lead-b2");
		const started = await call("POST", "/ap/application-runs", ev);
		const runId = started.body.run.id as string;
		const checkpoint = { schemaVersion: 1, checkpointId: "before-submit-1", facts: { phase: "before_submit", actions: 9, filled: 6, uploaded: 1, blockers: [], domain: "jobs.example.com" } };
		runner("paused", { lastSeq: 4, pause: { reason: "supervisor_checkpoint", checkpoint }, events: [{ seq: 4, type: "supervisor.checkpoint", at: "2026-10-08T00:06:00Z", detail: { checkpointId: "before-submit-1" } }] });
		await syncApplyRun(env(), "u1", (await call("GET", `/ap/application-runs/${runId}`)).body.run);

		const card = await appCard();
		expect(card?.status, "a run waiting on a person belongs in the needs-you column").toBe("needs_human");
		expect(card?.application?.checkpoint).toMatchObject({ checkpointId: "before-submit-1" });
		// #986: and it says WHICH checkpoint in the owner's terms — the form is complete, the counts
		// prove it, and nothing has been sent. ("Waiting for the cloud supervisor's decision at a
		// checkpoint" was the same sentence for a run that had filled nothing.)
		expect(card?.application?.stage).toBe("Model reported ready (6 fill actions and 1 upload) — waiting for the supervisor's decision before anything is sent.");
		expect(card?.application?.progress).toMatchObject({ stage: "before_submit_review", filled: 6, uploaded: 1, checkpointPhase: "before_submit", checkpointId: "before-submit-1", submitAttempted: false });
	});

	it("offers only the controls the application action service permits, with its compare-and-set", async () => {
		const ev = readyApp("lead-b3");
		await call("POST", "/ap/application-runs", ev);
		const card = await appCard();
		// The SAME list the Applications surface computes for this state — parity by construction.
		const item = (await call("GET", "/ap/application-queue/item?application_id=lead-b3")).body.item;
		expect(card?.application?.actions).toEqual(item.actions);
		// …and a control taken from the card goes through that service's own route.
		const acted = await call("POST", "/ap/application-queue/actions", { action: "cancel", application_id: "lead-b3", expected_status: item.status, expected_version: item.stateVersion });
		expect(acted.status).toBe(200);
	});

	it("one application is ONE card however many runs it has — a retry is an attempt, not a second card", async () => {
		const ev = readyApp("lead-b4");
		const started = await call("POST", "/ap/application-runs", ev);
		const runId = started.body.run.id as string;
		runner("ended", { lastSeq: 1, result: RESULT(runId, { outcome: "blocked", blockReason: "incomplete", filled: 1 }) });
		await syncApplyRun(env(), "u1", (await call("GET", `/ap/application-runs/${runId}`)).body.run);
		await call("POST", "/ap/application-queue/actions", { action: "retry_fill", application_id: "lead-b4", expected_status: "blocked" });

		const cards = (await d1.DB.prepare("SELECT COUNT(*) AS n FROM instance_runtime_tasks WHERE type = 'application.run'").first<{ n: number }>())?.n;
		expect(cards, "the retry must land on the application's existing card").toBe(1);
	});

	it("a terminal run explains itself on the card", async () => {
		const ev = readyApp("lead-b5");
		const started = await call("POST", "/ap/application-runs", ev);
		const runId = started.body.run.id as string;
		runner("ended", {
			lastSeq: 1,
			result: RESULT(runId, { outcome: "blocked", blockReason: "bridge_unused", filled: 0, diagnostic: { cause: "bridge_unused", bridgeCalls: 0, engineExit: 0, activeMs: 51_000, pages: 0, filled: 0, signals: [] } }),
		});
		await syncApplyRun(env(), "u1", (await call("GET", `/ap/application-runs/${runId}`)).body.run);
		const card = await appCard();
		expect(card?.status).toBe("blocked");
		expect(card?.application?.blockReason).toBe("bridge_unused");
	});

	// ── #986: what the card SAYS about the fill is the runner's own measurement ─────────────────
	//
	// The live contradiction, over the real routes: application `435d31c8…` was parked at
	// `phase: initial, filled: 0, uploaded: 0`, no blocker, no submit attempt — and its card read
	// "Filled — waiting for your review before anything is sent", which invites the one action
	// (#981's approve-and-continue) that would send an empty application to an employer.
	const parkZeroField = async (id: string) => {
		const started = await call("POST", "/ap/application-runs", readyApp(id));
		const runId = started.body.run.id as string;
		const checkpoint = { schemaVersion: 1, checkpointId: `${id}:initial`, facts: { phase: "initial", actions: 1, filled: 0, uploaded: 0, blockers: [], domain: "jobs.example.com" } };
		runner("paused", { lastSeq: 2, pause: { reason: "supervisor_checkpoint", checkpoint }, events: [{ seq: 2, type: "supervisor.checkpoint", at: "2026-10-08T00:06:00Z", detail: { checkpointId: checkpoint.checkpointId } }] });
		await syncApplyRun(env(), "u1", (await call("GET", `/ap/application-runs/${runId}`)).body.run);
		return runId;
	};

	it("THE LIVE CASE: a zero-field initial checkpoint is never described as a filled form", async () => {
		await parkZeroField("lead-p1");
		const card = await appCard();
		expect(card?.application?.stage).toBe("Paused before form filling — supervisor decision pending. Nothing has been entered yet.");
		expect(card?.application?.progress).toMatchObject({ stage: "supervisor_pending", filled: 0, uploaded: 0, checkpointPhase: "initial", submitAttempted: false, evidence: "runner_checkpoint" });
		expect(JSON.stringify(card)).not.toMatch(/Filled/);
	});

	it("the Board card and the Applications/Data item carry the SAME progress, not two derivations", async () => {
		await parkZeroField("lead-p2");
		const card = await appCard();
		const item = (await call("GET", "/ap/application-queue/item?application_id=lead-p2")).body.item;
		expect(item.fillProgress).toEqual(card?.application?.progress);
		// #988: this is the complete durable execution claim, not merely one duplicated label. Board,
		// application API and MCP (which calls this route) therefore cannot independently reinterpret
		// a checkpoint, its directive delivery or the set of permitted actions.
		expect(item.execution).toEqual(card?.application?.execution);
		expect(item.execution).toMatchObject({
			schemaVersion: 1,
			lifecycle: { submitAttempted: false },
			checkpoint: { phase: "initial", facts: { filled: 0, uploaded: 0, blockers: [] } },
			progress: { stage: "supervisor_pending", filled: 0, uploaded: 0 },
		});
		// Privacy boundary: the allow-list domain is a closed, safe fact; browser URL/title, DOM and
		// form values are not projected.
		expect(Object.keys(item.execution.checkpoint.facts)).toEqual(["actions", "filled", "uploaded", "blockers", "domain"]);
		expect(JSON.stringify(item.execution)).not.toMatch(/https?:\/\/|<input|password|resume\.pdf/i);
		// …and the queue item's own sentence is the one the card shows, so an owner reading either
		// surface — or an MCP client reading the queue — is told the same thing about one run.
		expect(item.fillProgress.label).toBe(card?.application?.stage);
	});

	it("a run that ENDED at awaiting_review with nothing filled says there is nothing to review", async () => {
		const started = await call("POST", "/ap/application-runs", readyApp("lead-p3"));
		const runId = started.body.run.id as string;
		runner("ended", { lastSeq: 1, result: RESULT(runId, { outcome: "awaiting_review", filled: 0, uploaded: [], summary: "Opened the ad." }) });
		await syncApplyRun(env(), "u1", (await call("GET", `/ap/application-runs/${runId}`)).body.run);
		const card = await appCard();
		const item = (await call("GET", "/ap/application-queue/item?application_id=lead-p3")).body.item;
		expect(item.status, "the lifecycle status is unchanged — only the CLAIM about it is").toBe("awaiting_review");
		expect(card?.application?.stage).toBe("Stopped before any field was filled — there is nothing to review, and nothing was sent.");
		expect(item.fillProgress).toMatchObject({ stage: "stopped_before_filling", filled: 0, uploaded: 0, evidence: "runner_result" });
	});

	it("a genuinely filled form still reads as review-ready, with the counts it rests on", async () => {
		const started = await call("POST", "/ap/application-runs", readyApp("lead-p4"));
		const runId = started.body.run.id as string;
		runner("ended", { lastSeq: 1, result: RESULT(runId, { outcome: "awaiting_review", filled: 12, uploaded: ["resume", "cover_letter"] }) });
		await syncApplyRun(env(), "u1", (await call("GET", `/ap/application-runs/${runId}`)).body.run);
		const item = (await call("GET", "/ap/application-queue/item?application_id=lead-p4")).body.item;
		expect(item.fillProgress).toMatchObject({ stage: "ready_for_review", filled: 12, uploaded: 2, evidence: "runner_result" });
		expect(item.fillProgress.label).toBe("Recorded 12 fill actions and 2 uploads — waiting for your review before anything is sent.");
		expect((await appCard())?.application?.stage).toBe(item.fillProgress.label);
	});

	it("an instance with no application runtime keeps a plain board — generic behaviour is preserved", async () => {
		// `t1` is the Tailor; a card only ever appears for an application it actually ran.
		const b = (await board("t1")) as { board?: Record<string, unknown[]>; items?: unknown[] };
		const cards = b.items ?? Object.values(b.board ?? {}).flat();
		expect(cards.filter((c) => (c as { application?: unknown }).application)).toEqual([]);
	});
});

// ── #977: a machine below the contract is refused up front, and the version is on the record ──
//
// The live regression: #975 shipped and deployed, and a real retry STILL came back
// `blocked: incomplete` with `diagnostic: null` — because the connected machine ran an older
// published CLI, which reports the zero-bridge outcome in the previous vocabulary. The cloud took
// the old shape silently, so "nothing to diagnose" and "cannot diagnose" were one record.
describe("an outdated runner never silently produces the old result shape (#977)", () => {
	const setRunnerVersion = (version: string) => d1.exec(`UPDATE instance_runtime_nodes SET runner_version = '${version}' WHERE instance_id = 'ap'`);
	const runRow = (id: string) => d1.DB.prepare("SELECT status, runner_version FROM local_apply_runs WHERE id = ?1").bind(id).first<Record<string, unknown>>();

	it.each([false, true])("refuses CLI207 before a new fill even when auto-submit is %s", async (autoSubmit) => {
		if (autoSubmit) await enableAutoSubmit();
		setRunnerVersion("0.4.207");
		const refused = await call("POST", "/ap/application-runs", readyApp("old-domain-guard"));
		expect(refused.status).toBe(409);
		expect(refused.body.error).toMatch(/0\.4\.208.*mutation-domain/);
		expect(dispatches()).toEqual([]);
		expect((await d1.DB.prepare("SELECT COUNT(*) AS n FROM local_apply_runs").first<{ n: number }>())?.n).toBe(0);
	});

	it("refuses the fill before anything is claimed, naming the update", async () => {
		// 0.4.84 is BELOW the floor from #994 on: it cannot observe a post-submit SEEK receipt.
		setRunnerVersion("0.4.84");
		const ev = readyApp("lead-v1");
		const r = await call("POST", "/ap/application-runs", ev);
		expect(r.status).toBe(409);
		expect(r.body.error).toMatch(/has not verified this application contract/);
		expect(r.body.error).toMatch(/0\.4\.208 or newer/);
		expect(r.body.error).toMatch(/post-submit confirmation/);
		expect(r.body.error).toMatch(/npm i -g @proagentstore\/cli|runner_update/);
		// Nothing was spent and nothing moved: no run row, no dispatch, and the application is still
		// materials_ready, so it retries cleanly once the machine is updated.
		expect((await d1.DB.prepare("SELECT COUNT(*) AS n FROM local_apply_runs").first<{ n: number }>())?.n).toBe(0);
		expect(dispatches()).toHaveLength(0);
		expect(await appRow("lead-v1")).toMatchObject({ status: "materials_ready", block_reason: null });
	});

	it("the same application runs once the machine is updated", async () => {
		setRunnerVersion("0.4.84");
		const ev = readyApp("lead-v2");
		expect((await call("POST", "/ap/application-runs", ev)).status).toBe(409);
		setRunnerVersion("0.4.225");
		const ok = await call("POST", "/ap/application-runs", ev);
		expect(ok.body.run.status).toBe("running");
		// And the record says WHICH runner executed it — the fact that was missing.
		expect(await runRow(ok.body.run.id as string)).toMatchObject({ runner_version: "0.4.225" });
	});

	it("stamps the executing runner's version on every run, and returns it over the API", async () => {
		setRunnerVersion("0.5.0");
		const started = await call("POST", "/ap/application-runs", readyApp("lead-v3"));
		const runId = started.body.run.id as string;
		expect(await runRow(runId)).toMatchObject({ runner_version: "0.5.0" });
		// The same row #971's `application_run` returns over MCP.
		expect((await call("GET", `/ap/application-runs/${runId}`)).body.run.runnerVersion).toBe("0.5.0");
	});

	it("an unreported version cannot prove application safety and is refused before dispatch", async () => {
		setRunnerVersion("");
		const r = await call("POST", "/ap/application-runs", readyApp("lead-v4"));
		expect(r.status).toBe(409);
		expect(r.body.error).toContain("0.4.208");
		expect(dispatches()).toHaveLength(0);
	});

	it("an up-to-date runner still reports the #975 zero-bridge diagnosis end to end", async () => {
		setRunnerVersion("0.4.225");
		const ev = readyApp("lead-v5");
		const started = await call("POST", "/ap/application-runs", ev);
		const runId = started.body.run.id as string;
		runner("ended", {
			lastSeq: 1,
			result: RESULT(runId, {
				outcome: "blocked",
				blockReason: "bridge_unused",
				filled: 0,
				uploaded: [],
				questions: ["The claude CLI ran for 51s and exited (code 0) without opening the application page."],
				diagnostic: { cause: "bridge_unused", bridgeCalls: 0, engineExit: 0, activeMs: 51_000, pages: 0, filled: 0, signals: ["approval_policy_blocked"] },
			}),
		});
		await syncApplyRun(env(), "u1", (await call("GET", `/ap/application-runs/${runId}`)).body.run);
		const run = (await call("GET", `/ap/application-runs/${runId}`)).body.run;
		// The pairing #977 asks for: the diagnosis AND the contract that produced it, on one record.
		expect(run.result).toMatchObject({ blockReason: "bridge_unused", diagnostic: { cause: "bridge_unused", bridgeCalls: 0 } });
		expect(run.runnerVersion).toBe("0.4.225");
		expect(await appRow("lead-v5")).toMatchObject({ status: "blocked", block_reason: "bridge_unused" });
		// Still no free text from the CLI, whichever release ran it.
		expect(JSON.stringify(run.result.diagnostic)).not.toMatch(/[A-Za-z]{200}/);
		expect(Object.keys(run.result.diagnostic).sort()).toEqual(["activeMs", "bridgeCalls", "cause", "engineExit", "filled", "pages", "signals"]);
	});
});

// ── #975: a CLI that did nothing on the page is diagnosed through the API, board and MCP ─────
describe("the did-nothing diagnosis reaches the owner's surfaces (#975)", () => {
	const card = async (id: string) => (await call("GET", `/t1/application-queue/item?application_id=${id}`)).body.item;

	it("persists the structured cause and shows it on the card and the run", async () => {
		const ev = readyApp("lead-d1");
		const started = await call("POST", "/ap/application-runs", ev);
		const runId = started.body.run.id as string;
		runner("ended", {
			lastSeq: 1,
			result: RESULT(runId, {
				outcome: "blocked",
				blockReason: "bridge_unused",
				questions: ["The claude CLI ran for 51s and exited (code 0) without opening the application page."],
				summary: "I reviewed the materials.",
				filled: 0,
				uploaded: [],
				diagnostic: { cause: "bridge_unused", bridgeCalls: 0, engineExit: 0, activeMs: 51_000, pages: 0, filled: 0, signals: ["approval_policy_blocked"] },
			}),
		});
		await syncApplyRun(env(), "u1", (await call("GET", `/ap/application-runs/${runId}`)).body.run);

		// The API (the same row #971's application_run returns over MCP).
		const run = (await call("GET", `/ap/application-runs/${runId}`)).body.run;
		expect(run.result).toMatchObject({ blockReason: "bridge_unused", diagnostic: { cause: "bridge_unused", bridgeCalls: 0, activeMs: 51_000, signals: ["approval_policy_blocked"] } });
		// The board card, which had only a generic blocked state before.
		expect(await card("lead-d1")).toMatchObject({ status: "blocked", diagnostic: { cause: "bridge_unused", bridgeCalls: 0, engineExit: 0, signals: ["approval_policy_blocked"] } });
	});

	it("refuses prose and unknown vocabulary in the diagnostic — nothing free-form is stored", async () => {
		const ev = readyApp("lead-d2");
		const started = await call("POST", "/ap/application-runs", ev);
		const runId = started.body.run.id as string;
		runner("ended", {
			lastSeq: 1,
			result: RESULT(runId, {
				outcome: "blocked",
				blockReason: "bridge_unused",
				filled: 0,
				diagnostic: {
					cause: "bridge_unused",
					bridgeCalls: 0,
					engineExit: 0,
					activeMs: 1,
					pages: 0,
					filled: 0,
					// A runner that tries to smuggle text or its own vocabulary gets neither.
					signals: ["approval_policy_blocked", "made_up_signal"],
					outputTail: "Jane Citizen, 10 Secret St — session=abc123",
					note: "sk-ant-0000000000000000000000000000000000000000",
				},
			}),
		});
		await syncApplyRun(env(), "u1", (await call("GET", `/ap/application-runs/${runId}`)).body.run);
		const stored = JSON.stringify((await call("GET", `/ap/application-runs/${runId}`)).body.run.result.diagnostic);
		expect(JSON.parse(stored).signals).toEqual(["approval_policy_blocked"]);
		for (const leak of ["Jane Citizen", "Secret St", "session=abc123", "sk-ant-", "outputTail", "note"]) expect(stored, leak).not.toContain(leak);
		expect(Object.keys(JSON.parse(stored)).sort()).toEqual(["activeMs", "bridgeCalls", "cause", "engineExit", "filled", "pages", "signals"]);
	});

	it("a run with no diagnostic shows none — the card does not invent one", async () => {
		const ev = readyApp("lead-d3");
		const started = await call("POST", "/ap/application-runs", ev);
		const runId = started.body.run.id as string;
		runner("ended", { lastSeq: 1, result: RESULT(runId) });
		await syncApplyRun(env(), "u1", (await call("GET", `/ap/application-runs/${runId}`)).body.run);
		expect((await card("lead-d3")).diagnostic).toBeNull();
	});
});

// ── #993: the queue must not cost the owner the mode their approval earned ───────────────────
//
// Two live failures in one real test session, and they are opposite halves of the same mistake —
// deciding the submit mode at a moment that is not the moment the run reaches the machine.
//
//  1. Halcyon Knights application `b6244557…`, run `42990ac8…`: approved, then asked to retry while
//     another application was filling. `concurrency` is the one check an approval deliberately does
//     NOT satisfy, so the run was created `fill_and_review` and the mode was frozen into the queued
//     row. On dequeue it dispatched `mode: fill_and_review, from: queue` with `submitAuthorization.
//     usable: true`, hit a one-click control it was not allowed to press, and stopped `incomplete`.
//  2. Online Education Services application `cc90cd13…`, run `26d8f1c1…`: launched `auto_submit`,
//     consumed the approval, then emitted `review.ready` and ended `awaiting_review` with
//     `submitAttempted=false, filled=0` — spending a one-time approval on nothing and leaving a
//     retry that could only fill-and-review again.
describe("an approval survives the queue, and is never spent on a run that sent nothing (#993)", () => {
	const BUSY_RUNNER = { status: 409, body: { error: "This machine is already filling an application for this agent; one at a time." } };
	const readyWithEvent = (id: string) => {
		const ev = readyApp(id);
		d1.DB.prepare("UPDATE job_applications SET ready_event = ?2 WHERE id = ?1").bind(id, JSON.stringify(ev)).run();
		return ev;
	};
	const card = async (id: string) => (await call("GET", `/t1/application-queue/item?application_id=${id}`)).body.item;
	const auth = (id: string) => d1.DB.prepare("SELECT id, consumed_at, consumed_run_id FROM job_application_submit_authorizations WHERE application_id = ?1").bind(id).first<Record<string, unknown>>();
	const runRow = (id: string) => d1.DB.prepare("SELECT status, policy, trace FROM local_apply_runs WHERE id = ?1").bind(id).first<{ status: string; policy: string; trace: string }>();
	const modeOf = async (runId: string) => (JSON.parse((await runRow(runId))?.policy ?? "{}") as { mode?: string }).mode;
	const traceOf = async (runId: string) => JSON.parse((await runRow(runId))?.trace ?? "[]") as Array<{ type: string; detail?: Record<string, unknown> }>;

	/** Fill once and stop at a genuine one-click control, exactly as the live SEEK run did. */
	async function oneClickBlocked(id: string) {
		const ev = readyWithEvent(id);
		await call("PUT", "/ap/application-runner/settings", { allowDomains: ["example.com"] });
		const started = await call("POST", "/ap/application-runs", ev);
		const runId = started.body.run.id as string;
		runner("ended", {
			lastSeq: 2,
			events: [{ seq: 2, type: "policy.decision", at: "2026-10-09T01:00:00Z", detail: { tool: "browser_click", class: "submit", decision: "refused", reason: "fill_and_review", rule: "one_click_apply" } }],
			result: RESULT(runId, { outcome: "blocked", blockReason: "incomplete", filled: 0, uploaded: [], submitAttempted: false, summary: "Stopped at a one-click apply control.", questions: ["Approve this application to let it be sent, or apply on the site yourself."] }),
		});
		await syncApplyRun(env(), "u1", (await call("GET", `/ap/application-runs/${runId}`)).body.run);
		return runId;
	}

	/** Another application, actually filling — the machine is busy and `concurrency` fails for real. */
	async function occupyTheMachine(id: string) {
		const started = await call("POST", "/ap/application-runs", readyWithEvent(id));
		const runId = started.body.run.id as string;
		expect(await runRow(runId), "the blocker has to be OPEN for concurrency to fail").toMatchObject({ status: "running" });
		return runId;
	}

	it("THE LIVE GAP: a queued approved retry reaches the machine in auto_submit, not the mode it earned while busy", async () => {
		await oneClickBlocked("lead-993a");
		const busyRunId = await occupyTheMachine("lead-993busy");

		// Approve the blocked one-click application. Its own run has ended, so the approval is HELD.
		const before = await card("lead-993a");
		const approved = await call("POST", "/t1/application-queue/actions", { action: "approve_and_proceed", application_id: "lead-993a", expected_status: "blocked", expected_version: before.stateVersion });
		expect(approved.body.result).toMatchObject({ approval: "granted", resumable: false });
		expect(await auth("lead-993a"), "held, not spent — nothing has run").toMatchObject({ consumed_at: null });

		// Retry while the other application is still filling: the machine refuses, and the gate
		// refuses too — `concurrency` is open. This is the state the bug was frozen in.
		answers["/local-apply/run"] = BUSY_RUNNER;
		const retry = await call("POST", "/t1/application-queue/actions", { action: "retry_fill", application_id: "lead-993a", expected_status: "blocked" });
		const queuedRunId = retry.body.result.runId as string;
		expect(await runRow(queuedRunId)).toMatchObject({ status: "queued" });
		expect(await modeOf(queuedRunId), "while the machine was busy it could only fill-and-review").toBe("fill_and_review");
		const queuedGate = (await traceOf(queuedRunId)).find((e) => e.type === "policy.submit_gate");
		expect(String(queuedGate?.detail?.reason)).toMatch(/concurrency/);
		expect(await auth("lead-993a"), "a refused gate must not spend the approval").toMatchObject({ consumed_at: null });

		// The other application finishes; the sweep settles it and dequeues this one in the same tick.
		answers["/local-apply/run"] = { status: 202, body: { status: "running" } };
		runner("ended", { lastSeq: 1, result: RESULT(busyRunId, { outcome: "awaiting_review", filled: 4 }) });
		await syncActiveApplyRuns(env());
		expect(await runRow(busyRunId), "the machine is free again").toMatchObject({ status: "awaiting_review" });

		// THE FIX: the mode is decided when it reaches the machine, so the approval is honoured.
		expect(await runRow(queuedRunId)).toMatchObject({ status: "running" });
		expect(await modeOf(queuedRunId)).toBe("auto_submit");
		const envelope = dispatches().at(-1)?.body as { runId: string; policy: { mode: string; submitGate?: { gateId: string } } };
		expect(envelope.runId, "the LAST dispatch is the dequeued one").toBe(queuedRunId);
		expect(envelope.policy.mode).toBe("auto_submit");
		expect(envelope.policy.submitGate?.gateId, "the machine is given the gate it must quote back").toEqual(expect.any(String));
		// The envelope and the stored policy are the same gate — what `settleFromResult` checks a
		// reported submission against.
		expect((JSON.parse((await runRow(queuedRunId))?.policy ?? "{}") as { gate: { gateId: string } }).gate.gateId).toBe(envelope.policy.submitGate?.gateId);
		// Spent at the upgrade, bound to this run, and recorded as the owner's own approval.
		expect(await auth("lead-993a")).toMatchObject({ consumed_run_id: queuedRunId, consumed_at: expect.any(Number) });
		const upgrade = (await traceOf(queuedRunId)).filter((e) => e.type === "policy.submit_gate").at(-1);
		expect(upgrade?.detail).toMatchObject({ mode: "auto_submit", decision: "allowed", from: "queue" });
		expect((await traceOf(queuedRunId)).some((e) => e.type === "policy.decision" && e.detail?.basis === "application_approval")).toBe(true);
		// And exactly one run for the application — no duplicate was started on the way (#993 Safety).
		expect((await d1.DB.prepare("SELECT COUNT(*) AS n FROM local_apply_runs WHERE application_id = 'lead-993a'").first<{ n: number }>())?.n).toBe(2);
	});

	it("a deferred approval upgrade loses its submit authority before the owner revokes it", async () => {
		await oneClickBlocked("lead-revoke-deferred");
		const busyRunId = await occupyTheMachine("lead-revoke-busy");
		const before = await card("lead-revoke-deferred");
		await call("POST", "/t1/application-queue/actions", { action: "approve_and_proceed", application_id: "lead-revoke-deferred", expected_status: "blocked", expected_version: before.stateVersion });
		answers["/local-apply/run"] = BUSY_RUNNER;
		const queuedRunId = (await call("POST", "/t1/application-queue/actions", { action: "retry_fill", application_id: "lead-revoke-deferred", expected_status: "blocked" })).body.result.runId as string;
		runner("ended", { result: RESULT(busyRunId) });
		await syncActiveApplyRuns(env());
		// The fresh gate upgraded this attempt, then the runner definitively refused it.
		expect(dispatches().at(-1)?.body.policy).toMatchObject({ mode: "auto_submit" });
		expect(await modeOf(queuedRunId)).toBe("fill_and_review");
		expect(await auth("lead-revoke-deferred")).toMatchObject({ consumed_at: null });
		const { revokeSubmitAuthorization } = await import("../lib/local-apply/approval-store.js");
		expect(await revokeSubmitAuthorization(env(), "lead-revoke-deferred", "u1", "owner changed mind", Date.now())).toBe(true);
		answers["/local-apply/run"] = { status: 202, body: { status: "running" } };
		d1.exec("UPDATE local_apply_runs SET next_attempt_at = 0 WHERE status = 'queued'");
		await syncActiveApplyRuns(env());
		expect(await runRow(queuedRunId)).toMatchObject({ status: "running" });
		expect(dispatches().at(-1)?.body.policy).toMatchObject({ mode: "fill_and_review" });
		expect((dispatches().at(-1)?.body.policy as { submitGate?: unknown }).submitGate).toBeUndefined();
	});

	it("an approval revoked after the gate read cannot be atomically consumed", async () => {
		await occupyTheMachine("lead-revoke-race-busy");
		readyWithEvent("lead-revoke-race");
		await call("PUT", "/ap/application-runner/settings", { allowDomains: ["example.com"] });
		answers["/local-apply/run"] = BUSY_RUNNER;
		await call("POST", "/t1/application-queue/actions", { action: "approve_and_proceed", application_id: "lead-revoke-race", expected_status: "materials_ready" });
		const observed = await auth("lead-revoke-race");
		expect(observed).toMatchObject({ consumed_at: null });
		const { revokeSubmitAuthorization, consumeSubmitAuthorization } = await import("../lib/local-apply/approval-store.js");
		expect(await revokeSubmitAuthorization(env(), "lead-revoke-race", "u1", "owner changed mind", Date.now())).toBe(true);
		expect(await consumeSubmitAuthorization(env(), observed!.id as string, "u1", "another-run", Date.now())).toBeNull();
		expect(await auth("lead-revoke-race")).toMatchObject({ consumed_at: null, consumed_run_id: null });
	});

	it("a REVIEW the owner asked for is not an intent the queue may override", async () => {
		// The mirror of the test above, and the reason the upgrade is not simply "re-run the gate".
		// Auto-submit is ON and this lead matches it, so the fresh verdict at dequeue DOES allow a
		// submit — but the owner asked to look at the filled form first, and that is a decision,
		// not the transient `concurrency` refusal the queue exists to wait out.
		const ev = readyWithEvent("lead-993r");
		await enableAutoSubmit();
		const busyRunId = await occupyTheMachine("lead-993rbusy");
		answers["/local-apply/run"] = BUSY_RUNNER;
		const asked = await call("POST", "/t1/application-queue/actions", { action: "request_review", application_id: "lead-993r", expected_status: "materials_ready" });
		expect(asked.status, JSON.stringify(asked.body)).toBe(200);
		const queuedRunId = asked.body.result.runId as string;
		expect(await runRow(queuedRunId)).toMatchObject({ status: "queued" });
		expect(await modeOf(queuedRunId)).toBe("fill_and_review");
		expect((await traceOf(queuedRunId)).find((e) => e.type === "policy.submit_gate")?.detail?.reason).toMatch(/review_requested/);
		expect(ev.applicationId).toBe("lead-993r");

		answers["/local-apply/run"] = { status: 202, body: { status: "running" } };
		runner("ended", { lastSeq: 1, result: RESULT(busyRunId, { outcome: "awaiting_review", filled: 4 }) });
		await syncActiveApplyRuns(env());
		expect(await runRow(queuedRunId)).toMatchObject({ status: "running" });
		expect(await modeOf(queuedRunId), "the owner asked to look at it first").toBe("fill_and_review");
		expect((dispatches().at(-1)?.body as { policy: { mode: string; submitGate?: unknown } }).policy.mode).toBe("fill_and_review");
		expect((dispatches().at(-1)?.body as { policy: { submitGate?: unknown } }).policy.submitGate, "no gate means it cannot submit even if it wanted to").toBeUndefined();
	});

	it("the owner's STANDING auto-submit policy survives the queue too — not only a per-application approval", async () => {
		// The same loss without an approval anywhere: auto-submit is on, the lead matches, and the
		// only reason the run was created `fill_and_review` is that the machine was busy. An
		// ordinary (non-one-click) application that waits in line must still reach the browser in
		// the mode the owner's own policy earned it.
		const ev = readyWithEvent("lead-993s");
		// A cap with room in it: the application occupying the machine below also auto-submits, and
		// at `dailyCap: 1` the recomputed gate refuses on `daily_cap` — correctly, which the test
		// after this one pins. The cap is a live fact the dequeue re-reads, not a formality.
		await enableAutoSubmit({ dailyCap: 5 });
		const busyRunId = await occupyTheMachine("lead-993sbusy");
		answers["/local-apply/run"] = BUSY_RUNNER;
		const started = await call("POST", "/ap/application-runs", ev);
		const queuedRunId = started.body.run.id as string;
		expect(await runRow(queuedRunId)).toMatchObject({ status: "queued" });
		expect(await modeOf(queuedRunId)).toBe("fill_and_review");
		expect((await traceOf(queuedRunId)).find((e) => e.type === "policy.submit_gate")?.detail?.reason).toMatch(/concurrency/);

		answers["/local-apply/run"] = { status: 202, body: { status: "running" } };
		runner("ended", { lastSeq: 1, result: RESULT(busyRunId, { outcome: "awaiting_review", filled: 4 }) });
		await syncActiveApplyRuns(env());
		expect(await modeOf(queuedRunId)).toBe("auto_submit");
		const envelope = dispatches().at(-1)?.body as { runId: string; policy: { mode: string; submitGate?: { gateId: string } } };
		expect(envelope.runId).toBe(queuedRunId);
		expect(envelope.policy.submitGate?.gateId).toEqual(expect.any(String));
		// No authorization was invented to do it: this is the standing policy, not an approval.
		expect(await auth("lead-993s")).toBeNull();
		expect((await traceOf(queuedRunId)).some((e) => e.type === "policy.decision" && e.detail?.basis === "application_approval")).toBe(false);
	});

	it("the dequeue re-reads the LIVE gate: a daily cap used up while it waited still refuses", async () => {
		// The other direction, and the reason this is a re-evaluation rather than a remembered
		// intent: whatever changed while the run sat in line is what decides it now. Here the
		// application that went first spent the owner's one allowed submission for the day.
		const ev = readyWithEvent("lead-993cap");
		await enableAutoSubmit({ dailyCap: 1 });
		const busyRunId = await occupyTheMachine("lead-993capbusy");
		expect(await modeOf(busyRunId), "the first one took the day's only slot").toBe("auto_submit");
		answers["/local-apply/run"] = BUSY_RUNNER;
		const queuedRunId = (await call("POST", "/ap/application-runs", ev)).body.run.id as string;
		expect(await modeOf(queuedRunId)).toBe("fill_and_review");

		answers["/local-apply/run"] = { status: 202, body: { status: "running" } };
		runner("ended", { lastSeq: 1, result: RESULT(busyRunId, { outcome: "awaiting_review", filled: 4 }) });
		await syncActiveApplyRuns(env());
		expect(await runRow(queuedRunId)).toMatchObject({ status: "running" });
		expect(await modeOf(queuedRunId), "the cap is used: fill and review, as the gate says").toBe("fill_and_review");
	});

	it("THE SECOND LIVE GAP: an auto_submit run that reviews instead of sending gives the approval back", async () => {
		// The review-ready path, with nothing sent: `submitAttempted=false`, and in the live run
		// `filled=0` too. The approval must be usable again, and the retry it offers must be able
		// to spend it — otherwise the owner's one-time decision bought nothing.
		await oneClickBlocked("lead-993b");
		const before = await card("lead-993b");
		await call("POST", "/t1/application-queue/actions", { action: "approve_and_proceed", application_id: "lead-993b", expected_status: "blocked", expected_version: before.stateVersion });
		const retry = await call("POST", "/t1/application-queue/actions", { action: "retry_fill", application_id: "lead-993b", expected_status: "blocked" });
		const runId = retry.body.result.runId as string;
		expect(await modeOf(runId)).toBe("auto_submit");
		expect(await auth("lead-993b")).toMatchObject({ consumed_run_id: runId });

		// It fills the form and asks for a review instead of submitting.
		runner("ended", { lastSeq: 1, result: RESULT(runId, { outcome: "awaiting_review", mode: "auto_submit", submitAttempted: false, filled: 0, uploaded: [] }) });
		await syncApplyRun(env(), "u1", (await call("GET", `/ap/application-runs/${runId}`)).body.run);

		const after = await card("lead-993b");
		expect(after.status).toBe("awaiting_review");
		expect(after.submitAttempted).toBe(false);
		// The recoverable state: the approval is the owner's again, and the card says so.
		expect(await auth("lead-993b")).toMatchObject({ consumed_at: null, consumed_run_id: null });
		expect(after.submitAuthorization).toMatchObject({ usable: true });
		expect(after.actions).toContain("retry_fill");

		// ...and the continuation actually continues: the next run submits on that same approval.
		runner("running", { lastSeq: 0 });
		const second = await call("POST", "/t1/application-queue/actions", { action: "retry_fill", application_id: "lead-993b", expected_status: "awaiting_review" });
		const secondRunId = second.body.result.runId as string;
		expect(await modeOf(secondRunId), "the approval was still there to spend").toBe("auto_submit");
		expect(await auth("lead-993b")).toMatchObject({ consumed_run_id: secondRunId });
	});

	it("a run that ATTEMPTED a submit keeps the approval spent, and is never retried (#993 Safety)", async () => {
		await oneClickBlocked("lead-993c");
		const before = await card("lead-993c");
		await call("POST", "/t1/application-queue/actions", { action: "approve_and_proceed", application_id: "lead-993c", expected_status: "blocked", expected_version: before.stateVersion });
		const retry = await call("POST", "/t1/application-queue/actions", { action: "retry_fill", application_id: "lead-993c", expected_status: "blocked" });
		const runId = retry.body.result.runId as string;
		// The machine pressed Submit and then lost the page — the outcome PAGS must stay conservative
		// about. `submitAttempted` is the fact that makes it terminal.
		runner("ended", { lastSeq: 1, result: RESULT(runId, { outcome: "blocked", blockReason: "submit_unconfirmed", mode: "auto_submit", submitAttempted: true, filled: 7, questions: ["Check the employer's site."] }) });
		await syncApplyRun(env(), "u1", (await call("GET", `/ap/application-runs/${runId}`)).body.run);

		expect(await auth("lead-993c"), "something may have reached the employer: the approval stays spent").toMatchObject({ consumed_run_id: runId, consumed_at: expect.any(Number) });
		const after = await card("lead-993c");
		expect(after.submitAttempted).toBe(true);
		expect(after.actions).not.toContain("retry_fill");
		expect(after.actions).not.toContain("approve_and_proceed");
	});

	it("a submitted run keeps its approval spent — the one-time decision was used for what it was for", async () => {
		await oneClickBlocked("lead-993d");
		const before = await card("lead-993d");
		await call("POST", "/t1/application-queue/actions", { action: "approve_and_proceed", application_id: "lead-993d", expected_status: "blocked", expected_version: before.stateVersion });
		const retry = await call("POST", "/t1/application-queue/actions", { action: "retry_fill", application_id: "lead-993d", expected_status: "blocked" });
		const runId = retry.body.result.runId as string;
		const gateId = (JSON.parse((await runRow(runId))?.policy ?? "{}") as { gate: { gateId: string } }).gate.gateId;
		runner("ended", { lastSeq: 1, result: RESULT(runId, { outcome: "submitted", mode: "auto_submit", submitAttempted: true, submitted: { url: "https://jobs.example.com/thanks", at: "2026-10-09T02:00:00Z", gateId }, filled: 9 }) });
		await syncApplyRun(env(), "u1", (await call("GET", `/ap/application-runs/${runId}`)).body.run);
		const after = await card("lead-993d");
		expect(after.status).toBe("submitted");
		expect(await auth("lead-993d")).toMatchObject({ consumed_run_id: runId, consumed_at: expect.any(Number) });
	});
});

// ── #974: the Runner's busy machine behaves exactly like the Tailor's ───────────────────────
describe("a busy Runner queues the fill instead of blocking the application (#974)", () => {
	const BUSY = { status: 409, body: { error: "This machine is already filling an application for this agent; one at a time." } };
	const runRow = (id: string) => d1.DB.prepare("SELECT status, attempts, queued_reason FROM local_apply_runs WHERE id = ?1").bind(id).first<Record<string, unknown>>();

	it("waits in line, keeps the application out of blocked, and dispatches when the machine frees", async () => {
		answers["/local-apply/run"] = BUSY;
		const r = await call("POST", "/ap/application-runs", readyApp("lead-q1"));
		const runId = r.body.run.id as string;
		expect(await runRow(runId)).toMatchObject({ status: "queued" });
		expect(String((await runRow(runId))?.queued_reason)).toMatch(/already filling/);
		// Not blocked: the application is filling, waiting its turn — the old path made it terminal.
		expect(await appRow("lead-q1")).toMatchObject({ status: "filling", block_reason: null });
		expect((await audit("lead-q1")).some((a) => a.to_status === "blocked")).toBe(false);

		// The machine frees; the sweep dispatches it with no owner action.
		answers["/local-apply/run"] = { status: 202, body: { status: "running" } };
		runner("running", { lastSeq: 0 });
		await syncActiveApplyRuns(env());
		expect(await runRow(runId)).toMatchObject({ status: "running" });
	});

	it.each([false, true])("claims dispatch durably before a lost reply (queued=%s) and reconciles without replay", async (queued) => {
		await enableAutoSubmit();
		answers["/local-apply/run"] = queued ? BUSY : () => { throw new Error("response lost"); };
		const r = await call("POST", "/ap/application-runs", readyApp("lead-dispatch-gap"));
		const runId = r.body.run.id as string;
		if (queued) {
			expect(await runRow(runId)).toMatchObject({ status: "queued" });
			answers["/local-apply/run"] = () => {
				expect(d1.sqlite.prepare("SELECT status FROM local_apply_runs WHERE id = ?").get(runId)).toMatchObject({ status: "running" });
				throw new Error("response lost");
			};
			await syncActiveApplyRuns(env());
		}
		expect(await runRow(runId)).toMatchObject({ status: "running" });
		const count = dispatches().length;
		runner("running", { lastSeq: 1 });
		await syncActiveApplyRuns(env());
		expect(dispatches()).toHaveLength(count);
		answers["/local-apply/status"] = { status: 404, body: {} };
		await syncActiveApplyRuns(env());
		expect(await appRow("lead-dispatch-gap")).toMatchObject({ status: "blocked", block_reason: "submit_state_unknown" });
		expect((await appRow("lead-dispatch-gap"))?.submit_attempted_at).not.toBeNull();
		expect(dispatches()).toHaveLength(count);
	});

	it("a durable runner claim with no result is uncertainty, never a safe refusal to retry", async () => {
		await enableAutoSubmit();
		answers["/local-apply/run"] = { status: 409, body: { code: "application_start_uncertain", error: "Prior dispatch has no result" } };
		await call("POST", "/ap/application-runs", readyApp("lead-prior-claim"));
		expect(await appRow("lead-prior-claim")).toMatchObject({ status: "blocked", block_reason: "submit_state_unknown" });
		expect((await appRow("lead-prior-claim"))?.submit_attempted_at).not.toBeNull();
	});

	it("a durable capacity wait is not orphaned when its creation age exceeds the lost-runner grace", async () => {
		await enableAutoSubmit();
		answers["/local-apply/run"] = BUSY;
		const started = await call("POST", "/ap/application-runs", readyApp("lead-capacity-wait"));
		const queued = started.body.run;
		const later = await syncApplyRun(env(), "u1", queued, queued.createdAt + 2 * 60 * 60_000);
		expect(later.status).toBe("queued");
		expect(await appRow("lead-capacity-wait")).toMatchObject({ status: "filling", submit_attempted_at: null });
		expect(dispatches()).toHaveLength(1);
	});

	it("a genuine 409 conflict still blocks, so a bound run is never retried forever", async () => {
		answers["/local-apply/run"] = { status: 409, body: { error: "Run abc already exists with another requestId" } };
		const r = await call("POST", "/ap/application-runs", readyApp("lead-q2"));
		expect(await runRow(r.body.run.id as string)).toMatchObject({ status: "failed" });
		expect(await appRow("lead-q2")).toMatchObject({ status: "blocked", block_reason: "runner_rejected" });
	});

	it("a replayed materials_ready event finds the queued run instead of starting a second", async () => {
		answers["/local-apply/run"] = BUSY;
		const ev = readyApp("lead-q3");
		const first = await call("POST", "/ap/application-runs", ev);
		const replay = await call("POST", "/ap/application-runs", ev);
		expect(replay.body.outcome).toBe("existing");
		expect(replay.body.run.id).toBe(first.body.run.id);
		expect((await d1.DB.prepare("SELECT COUNT(*) AS n FROM local_apply_runs WHERE application_id = 'lead-q3'").first<{ n: number }>())?.n).toBe(1);
	});

	it("an approved submission survives the wait and reclaims its authority at dispatch", async () => {
		// #973 + #974: the approval is consumed at the first dispatch attempt, so the run that
		// eventually goes to the machine is still the one the owner authorized.
		readyApp("lead-q4");
		d1.DB.prepare("UPDATE job_applications SET ready_event = ?2 WHERE id = ?1")
			.bind("lead-q4", JSON.stringify({ eventType: "job.application.materials_ready", eventId: "t1:lead-q4:1:materials", applicationId: "lead-q4", tailorInstanceId: "t1", leadId: "lead-q4" }))
			.run();
		await call("PUT", "/ap/application-runner/settings", { allowDomains: ["example.com"] });
		answers["/local-apply/run"] = BUSY;
		const approved = await call("POST", "/t1/application-queue/actions", { action: "approve_and_proceed", application_id: "lead-q4", expected_status: "materials_ready" });
		const runId = approved.body.result.runId as string;
		expect(await runRow(runId)).toMatchObject({ status: "queued" });
		expect(approved.body.result.mode).toBe("fill_and_review");
		expect(approved.body.result.authorizationConsumedBy).toBeNull();
		// When it finally dispatches, it still carries the submit gate the approval granted.
		answers["/local-apply/run"] = { status: 202, body: { status: "running" } };
		runner("running", { lastSeq: 0 });
		await syncActiveApplyRuns(env());
		const sentEnvelope = dispatches().at(-1)?.body as { policy: { mode: string; submitGate?: { gateId: string } } };
		expect(sentEnvelope.policy.mode).toBe("auto_submit");
		expect(sentEnvelope.policy.submitGate?.gateId).toEqual(expect.any(String));
	});
});

describe("cloud supervision", () => {
	it("persists bounded checkpoint facts and has the Runner's cloud brain direct that exact checkpoint", async () => {
		const started = await call("POST", "/ap/application-runs", readyApp("lead-supervised"));
		const runId = started.body.run.id as string;
		const checkpoint = {
			schemaVersion: 1,
			checkpointId: "before-submit-1",
			facts: {
				phase: "before_submit",
				actions: 14,
				filled: 6,
				uploaded: 2,
				blockers: [],
				url: "https://jobs.example.com/apply/step-3",
				domain: "jobs.example.com",
				title: "Staff Engineer application",
			},
		};
		runner("paused", { lastSeq: 4, pause: { reason: "supervisor_checkpoint", checkpoint }, events: [{ seq: 4, type: "supervisor.checkpoint", at: "2026-10-07T00:06:00Z", detail: { checkpointId: "before-submit-1" } }] });

		const received = await call("GET", `/ap/application-runs/${runId}/supervision`);
		expect(received.body).toMatchObject({ schemaVersion: 1, checkpoints: [{ checkpointId: "before-submit-1", schemaVersion: 1, runnerSeq: 4, facts: checkpoint.facts, directive: { directive: "request_review", idempotencyKey: "brain:before-submit-1", deliveredAt: expect.any(Number) } }] });
		expect(JSON.stringify(received.body)).not.toContain("150000 AUD");
		expect(sent.filter((s) => s.path === "/local-apply/directive").map((s) => s.body)).toEqual([{ runId, checkpointId: "before-submit-1", schemaVersion: 1, directive: "request_review" }]);

		// A human/API caller cannot revise the brain's durable decision for the same checkpoint.
		const revision = await call("POST", `/ap/application-runs/${runId}/supervision/checkpoints/before-submit-1/directives`, { schemaVersion: 1, idempotencyKey: "directive-revision", directive: "continue" });
		expect(revision.status).toBe(409);
		expect(sent.filter((s) => s.path === "/local-apply/directive")).toHaveLength(1);
		expect((await d1.DB.prepare("SELECT COUNT(*) AS n FROM local_apply_supervisor_directives").first<{ n: number }>())?.n).toBe(1);
	});

	it("does not make an untyped runner pause actionable as a supervisor checkpoint", async () => {
		const started = await call("POST", "/ap/application-runs", readyApp("lead-supervised-invalid"));
		const runId = started.body.run.id as string;
		runner("paused", { lastSeq: 1, pause: { reason: "supervisor_checkpoint", checkpoint: { schemaVersion: 1, checkpointId: "unsafe", facts: { phase: "before_submit", actions: 1, filled: 0, uploaded: 0, blockers: ["not-a-real-blocker"] } } } });
		const received = await call("GET", `/ap/application-runs/${runId}/supervision`);
		expect(received.body.checkpoints).toEqual([]);
		const directive = await call("POST", `/ap/application-runs/${runId}/supervision/checkpoints/unsafe/directives`, { schemaVersion: 1, idempotencyKey: "unsafe-directive", directive: "stop" });
		expect(directive.status).toBe(404);
	});

	it("stops a CLI that remains responsive past the policy deadline, rather than renewing it from polls", async () => {
		const started = await call("POST", "/ap/application-runs", readyApp("lead-time-limit"));
		const runId = started.body.run.id as string;
		const startedAt = started.body.run.startedAt as number;
		// The local process is still answering status, but has not sent a terminal result.
		runner("running", { lastSeq: 0 });
		const ended = await syncApplyRun(env(), "u1", started.body.run, startedAt + 20 * 60_000);

		expect(sent.find((s) => s.path === "/local-apply/cancel")?.body).toEqual({ runId });
		expect(ended).toMatchObject({ status: "failed", errorCode: "run_timed_out" });
		expect(await appRow("lead-time-limit")).toMatchObject({ status: "blocked", block_reason: "run_timed_out", submit_attempted_at: null });
	});

	it("excludes a long owner pause from the execution budget after resume and trace truncation", async () => {
		await enableAutoSubmit();
		const started = await call("POST", "/ap/application-runs", readyApp("lead-paused-clock"));
		const runId = started.body.run.id as string;
		const start = started.body.run.startedAt as number;
		runner("paused", { pause: { reason: "missing_answer", question: "Owner answer" } });
		const paused = await syncApplyRun(env(), "u1", started.body.run, start + 60_000);
		expect(paused).toMatchObject({ status: "paused", activeElapsedMs: 60_000, activeStartedAt: null });
		// Clock state is durable independently of the bounded display trace.
		d1.DB.prepare("UPDATE local_apply_runs SET trace = '[]' WHERE id = ?1").bind(runId).run();
		const { getApplyRun } = await import("../lib/local-apply/store.js");
		const fresh = await getApplyRun(env(), "ap", "u1", runId);
		runner("running", { lastSeq: 2 });
		const resumed = await syncApplyRun(env(), "u1", fresh!, start + 2 * 60 * 60_000);
		expect(resumed.status).toBe("running");
		const continuing = await syncApplyRun(env(), "u1", resumed, start + 2 * 60 * 60_000 + 18 * 60_000);
		expect(continuing.status).toBe("running");
		expect(sent.filter((s) => s.path === "/local-apply/cancel")).toHaveLength(0);
		expect((await appRow("lead-paused-clock"))?.submit_attempted_at).toBeNull();
		const ended = await syncApplyRun(env(), "u1", continuing, start + 2 * 60 * 60_000 + 19 * 60_000);
		expect(ended).toMatchObject({ status: "failed", errorCode: "run_timed_out" });
	});

	it("accepts a structured terminal result that arrives at the deadline before stopping the CLI", async () => {
		const started = await call("POST", "/ap/application-runs", readyApp("lead-time-limit-result"));
		const runId = started.body.run.id as string;
		const startedAt = started.body.run.startedAt as number;
		runner("ended", { lastSeq: 0, result: RESULT(runId) });

		const ended = await syncApplyRun(env(), "u1", started.body.run, startedAt + 20 * 60_000);
		expect(ended.status).toBe("awaiting_review");
		expect(sent.filter((s) => s.path === "/local-apply/cancel")).toHaveLength(0);
		expect(await appRow("lead-time-limit-result")).toMatchObject({ status: "awaiting_review" });
	});

	it("replays a durably received terminal result after a Worker restart without contacting the runner again", async () => {
		const started = await call("POST", "/ap/application-runs", readyApp("lead-receipt-replay"));
		const runId = started.body.run.id as string;
		const result = RESULT(runId);
		// This is the exact crash window: result receipt committed, but projection to the
		// application has not happened. Reconstructing the scheduled sweep must need no runner.
		await d1.DB.prepare("UPDATE local_apply_runs SET status = 'awaiting_review', result = ?2 WHERE id = ?1").bind(runId, JSON.stringify(result)).run();
		sent = [];
		await syncApplyRun(env(), "u1", { ...started.body.run, status: "awaiting_review", result } as never);
		expect(sent).toEqual([]);
		expect(await appRow("lead-receipt-replay")).toMatchObject({ status: "awaiting_review" });
		expect(await audit("lead-receipt-replay")).toEqual(expect.arrayContaining([expect.objectContaining({ to_status: "awaiting_review", actor: "runner" })]));
	});

	it("treats a timed-out auto-submit run as an unknown submit, so the cloud never retries it", async () => {
		await enableAutoSubmit();
		const started = await call("POST", "/ap/application-runs", readyApp("lead-time-limit-auto"));
		expect(started.body.run.policy.mode).toBe("auto_submit");
		runner("running", { lastSeq: 0 });
		await syncApplyRun(env(), "u1", started.body.run, (started.body.run.startedAt as number) + 20 * 60_000);

		expect(await appRow("lead-time-limit-auto")).toMatchObject({ status: "blocked", block_reason: "submit_state_unknown" });
		expect((await appRow("lead-time-limit-auto"))?.submit_attempted_at).not.toBeNull();
	});
});

describe("settings, access and cancel", () => {
	it.each(["login_required", "captcha"] as const)("keeps an isolated %s handoff exact, opaque and closed on a lost page without changing submit uncertainty", async (pauseReason) => {
		const started = await call("POST", "/ap/application-runs", readyApp("lead-handoff"));
		const runId = started.body.run.id as string;
		runner("paused", { pause: { reason: pauseReason, question: "Complete the site step" } });
		answers["/local-apply/handoff"] = { status: 200, body: { handoffId: "ignored-by-relay", runId, applicationId: "lead-handoff", browserProfile: "isolated", state: "ready", expiresAt: "2026-10-11T01:00:00.000Z" } };
		answers["/local-apply/handoff-status"] = { status: 200, body: { handoffId: "ignored-by-relay", runId, applicationId: "lead-handoff", browserProfile: "isolated", state: "ready", expiresAt: "2026-10-11T01:00:00.000Z" } };

		const first = await call("POST", `/ap/application-runs/${runId}/handoff`);
		expect(first.status).toBe(201);
		const handoff = first.body.handoff as { id: string; state: string };
		expect(handoff).toMatchObject({ state: "active" });
		expect(first.body.consoleLink).toBe(`/console/instances/ap/applications?handoff=${encodeURIComponent(handoff.id)}`);
		// The pause producer opens the exact same handoff before it emits the existing, preference-
		// controlled owner alert.  This is the mobile push's canonical target, not a Board fallback.
		const alert = await d1.DB.prepare("SELECT type, kind, url, body FROM notifications WHERE user_id = 'u1' ORDER BY created_at DESC LIMIT 1").first<{ type: string; kind: string; url: string; body: string }>();
		expect(alert).toMatchObject({ type: "apply", kind: "alert", url: `/console/instances/ap/applications?handoff=${encodeURIComponent(handoff.id)}` });
		expect(JSON.stringify(alert)).not.toMatch(/cookie|token|password|https?:\/\//i);
		const relayBody = sent.find((s) => s.path === "/local-apply/handoff")?.body;
		expect(relayBody).toMatchObject({ handoffId: handoff.id, runId, applicationId: "lead-handoff", browserProfile: "isolated" });
		expect(JSON.stringify({ first: first.body, relayBody })).not.toMatch(/cookie|token|password|https?:\/\//i);

		// A duplicate tap only checks the same opaque handoff; another run/id cannot read it.
		const repeated = await call("POST", `/ap/application-runs/${runId}/handoff`);
		expect(repeated.status).toBe(201);
		expect(repeated.body.handoff.id).toBe(handoff.id);
		expect((await call("GET", `/ap/application-runs/${runId}/handoff?handoff_id=wrong`)).status).toBe(404);

		answers["/local-apply/handoff/frame"] = { status: 409, body: { error: "page lost" } };
		const lost = await call("GET", `/ap/application-runs/${runId}/handoff/frame?handoff_id=${encodeURIComponent(handoff.id)}`);
		expect(lost.status).toBe(409);
		const closed = await call("GET", `/ap/application-runs/${runId}/handoff?handoff_id=${encodeURIComponent(handoff.id)}`);
		expect(closed.body.handoff).toMatchObject({ state: "closed", reason: "page_lost" });
		// A lost login view is never evidence that no submit occurred, nor permission to mint another approval.
		expect(await appRow("lead-handoff")).toMatchObject({ status: "blocked", block_reason: pauseReason, submit_attempted_at: null });
	});

	it("defaults to fill-and-review with auto-submit off, and refuses an API-key mode", async () => {
		const s = (await call("GET", "/ap/application-runner/settings")).body.settings;
		expect(s).toMatchObject({ engine: "claude", authMode: "machine", browserProfile: "isolated", workspace: "~/jobs", sources: { profile: "profile.md" }, autoSubmit: { enabled: false, dailyCap: 0 } });
		const bad = await call("PUT", "/ap/application-runner/settings", { authMode: "api-key" });
		expect(bad.status).toBe(400);
		expect(bad.body.error).toMatch(/never a provider API key/);
		expect((await call("PUT", "/ap/application-runner/settings", { allowDomains: ["https://x.com/path"] })).status).toBe(400);
	});

	it("is a 409 on an agent that is not a Runner, and a 404 on someone else's application or instance", async () => {
		const ev = readyApp("lead-12");
		const tailor = await call("POST", "/t1/application-runs", ev);
		expect(tailor.status).toBe(409);
		expect(tailor.body.error).toMatch(/runtime is "local_artifact"/);
		expect((await call("POST", "/ap/application-runs", { ...ev, tailorInstanceId: "scout" })).status).toBe(404);
		expect((await call("GET", "/other/application-runs")).status).toBe(404);
	});

	it("cancel stops the run on the runner and blocks the application — nothing external", async () => {
		const r = await call("POST", "/ap/application-runs", readyApp("lead-13"));
		const c = await call("POST", `/ap/application-runs/${r.body.run.id}/cancel`);
		expect(c.body.run.status).toBe("cancelled");
		expect(sent.some((s) => s.path === "/local-apply/cancel")).toBe(true);
		expect((await appRow("lead-13"))?.status).toBe("blocked");
		expect((await appRow("lead-13"))?.block_reason).toBe("cancelled_by_owner");
	});
});

describe("the runtime-task live view of an application card reaches its fill's browser (#1100)", () => {
	const FRAME = { frame: "data:image/jpeg;base64,AAAA", width: 1280, height: 720 };
	/** A fill paused on a SEEK sign-in, as the reported run was: the card is `app-<applicationId>`. */
	async function pausedOnSignIn(id: string) {
		const started = await call("POST", "/ap/application-runs", readyApp(id));
		const runId = started.body.run.id as string;
		runner("paused", { pause: { reason: "login_required", question: "Sign in to SEEK" } });
		const ready = { handoffId: "ignored-by-relay", runId, applicationId: id, browserProfile: "isolated", state: "ready", expiresAt: "2026-10-11T01:00:00.000Z" };
		answers["/local-apply/handoff"] = { status: 200, body: ready };
		answers["/local-apply/handoff-status"] = { status: 200, body: ready };
		answers["/local-apply/handoff/frame"] = { status: 200, body: FRAME };
		answers["/local-apply/handoff/input"] = { status: 200, body: { ok: true } };
		answers["/local-apply/handoff/resume"] = { status: 200, body: { ok: true } };
		return { runId, card: `app-${id}` };
	}
	const takeoverOf = (card: string) => d1.DB.prepare("SELECT id, state FROM browser_takeovers WHERE subject_kind = 'runtime_task' AND subject_id = ?1 ORDER BY created_at DESC LIMIT 1").bind(card).first<{ id: string; state: string }>();

	it("an active runtime_task takeover on the card streams the fill's page — the reported failure", async () => {
		const { runId, card } = await pausedOnSignIn("lead-1100");
		const requested = await call("POST", "/ap/browser-takeovers", { subjectKind: "runtime_task", subjectId: card });
		expect(requested.status).toBeLessThan(300);

		const frame = await call("GET", `/ap/takeover/${card}/frame?device=mobile`);
		expect(frame.status).toBe(200);
		expect(frame.body).toEqual(FRAME);
		// Served through the fill's handoff, bound to this run — never the runner's task-takeover map, which
		// is where "No active human-takeover session for this task" came from.
		const handoffId = (await d1.DB.prepare("SELECT continuity_id FROM local_apply_handoffs WHERE run_id = ?1").bind(runId).first<{ continuity_id: string }>())?.continuity_id;
		expect(sent.find((x) => x.path === "/local-apply/handoff/frame")?.body).toMatchObject({ handoffId, runId, applicationId: "lead-1100" });
		expect(sent.some((x) => x.path.startsWith("/takeover/"))).toBe(false);
		expect((await takeoverOf(card))?.state).toBe("active");

		// Polling again reuses the open handoff rather than opening another.
		await call("GET", `/ap/takeover/${card}/frame?device=mobile`);
		expect(sent.filter((x) => x.path === "/local-apply/handoff")).toHaveLength(1);
	});

	it("the owner's input reaches that page, and resume hands the fill back and closes the takeover", async () => {
		const { runId, card } = await pausedOnSignIn("lead-1100b");
		await call("GET", `/ap/takeover/${card}/frame`);
		const input = { type: "click", x: 10, y: 20 };
		expect((await call("POST", `/ap/takeover/${card}/input`, input)).status).toBe(200);
		expect(sent.find((x) => x.path === "/local-apply/handoff/input")?.body).toMatchObject({ runId, input });

		runner("running");
		const resumed = await call("POST", `/ap/takeover/${card}/resume`);
		expect(resumed.status).toBe(200);
		expect(sent.some((x) => x.path === "/local-apply/handoff/resume")).toBe(true);
		expect(sent.some((x) => x.path === "/local-apply/resume")).toBe(true);
		expect((await takeoverOf(card))?.state).toBe("resumed");
	});

	it("a card whose fill is not waiting on a person has no takeover to open — and records none", async () => {
		const started = await call("POST", "/ap/application-runs", readyApp("lead-1100c"));
		expect(started.status).toBeLessThan(300);
		runner("running");
		const r = await call("GET", "/ap/takeover/app-lead-1100c/frame");
		expect(r.status).toBe(404);
		expect(await takeoverOf("app-lead-1100c")).toBeNull();
		expect(sent.some((x) => x.path.startsWith("/local-apply/handoff"))).toBe(false);
	});

	it("the owner's no-phone preference still holds on the card's live view", async () => {
		const { card } = await pausedOnSignIn("lead-1100d");
		await call("POST", "/ap/browser-takeovers", { subjectKind: "runtime_task", subjectId: card });
		d1.sqlite.prepare("UPDATE browser_takeovers SET mobile_allowed = 0 WHERE subject_id = ?").run(card);
		const r = await call("GET", `/ap/takeover/${card}/frame?device=mobile`);
		expect(r.status).toBe(409);
		expect(sent.some((x) => x.path === "/local-apply/handoff/frame")).toBe(false);
	});
});

/**
 * #1100 round 2 — the REAL sequence, which round 1's tests never modelled: they all began from a fill that
 * was still paused. Run 9a7d9e85 (application b8586cf8…) paused `login_required` at 11:32:44, hit its
 * 20-minute limit and ended `blocked` at 11:53:26; takeover 30532b43 was requested at 11:57:11 and forced
 * `active` through the API — by then there was no paused fill and no handoff page, so every frame poll was
 * a 409, and the console had no control to activate it with. Here the runner is a stateful fake that
 * behaves as `sign-in-runtime.ts` does: a frame for a sign-in it does not hold is 404 until it is opened.
 */
describe("a takeover requested AFTER the fill ended blocked on a sign-in streams a real page (#1100 round 2)", () => {
	const RUNNER = "2e85124f-4946-49d2-b922-8636ba92ca6a";
	const APP = "b8586cf8-0987-4397-85ef-e4db9563cdd5";
	const CARD = `app-${APP}`;
	const TAKEOVER = "30532b43-66b0-41c4-8906-021f8ebc31d7";
	const JOB = "https://www.seek.com.au/job/88001234";
	const FRAME = { frame: "data:image/jpeg;base64,U0lHTklO", width: 1280, height: 720 };

	beforeEach(() => {
		d1.exec(`INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES ('${RUNNER}', 'runner-a', 'u1', 'active', '{"runnerNode":"dell-laptop"}')`);
		d1.exec(`INSERT INTO instance_runtime_nodes (instance_id, user_id, runner_node, endpoint_url, runner_version, status, last_seen_at) VALUES ('${RUNNER}', 'u1', 'dell-laptop', 'relay://', '0.6.0', 'online', '2026-10-15 11:57:00')`);
		getBoundRunnerConn.mockImplementation(async (_env: unknown, instanceId: string) => ({ runnerNode: "dell-laptop", instanceId, userId: "u1", relayName: `${instanceId}:node:dell-laptop`, endpointUrl: "relay://", token: "", env: {} }));
	});

	/** The runner's sign-in surface, holding what it holds in memory: one open page per sign-in id. */
	function signInRunner() {
		const st = { open: null as Record<string, unknown> | null, opens: 0 };
		const held = (b: Record<string, unknown>) => st.open?.signInId === b.signInId;
		const view = (b: Record<string, unknown>, over: Record<string, unknown>) => ({ signInId: b.signInId, browserProfile: st.open?.browserProfile ?? "isolated", site: "seek.com.au", expiresAt: "2026-10-15T12:57:11.000Z", ...over });
		answers["/local-apply/sign-in"] = (b) => {
			st.opens++;
			st.open = b;
			return { status: 200, body: view(b, { state: "ready" }) };
		};
		answers["/local-apply/sign-in/frame"] = (b) => (held(b) ? { status: 200, body: FRAME } : { status: 404, body: { error: "Sign-in not found" } });
		answers["/local-apply/sign-in/input"] = (b) => (held(b) ? { status: 200, body: { ok: true } } : { status: 404, body: { error: "Sign-in not found" } });
		answers["/local-apply/sign-in/end"] = (b) => {
			if (!held(b)) return { status: 404, body: { error: "Sign-in not found" } };
			const out = view(b, { state: "closed", ...(b.complete === true ? { signedIn: { fingerprint: 1, verifiable: true } } : { terminalReason: "unavailable" }) });
			st.open = null;
			return { status: 200, body: out };
		};
		return st;
	}

	/** Paused on the SEEK sign-in, then ended blocked when nobody reached it in time — the reported run. */
	async function endedBlockedOnSignIn() {
		const started = await call("POST", `/${RUNNER}/application-runs`, readyApp(APP, { url: JOB }));
		expect(started.status).toBeLessThan(300);
		const runId = started.body.run.id as string;
		// What the Tailor's materials_ready delivery records on a real application (see the #1073 tests).
		await d1.DB.prepare("UPDATE job_applications SET ready_event = ?1 WHERE id = ?2").bind(JSON.stringify({ eventId: `t1:${APP}:1:materials`, applicationId: APP }), APP).run();
		runner("paused", { pause: { reason: "login_required", question: "Sign in to seek.com.au in this browser." } });
		expect((await call("GET", `/${RUNNER}/application-runs/${runId}`)).body.run.status).toBe("paused");
		const question = "Sign in to seek.com.au on this machine's application browser, then retry. Nothing was submitted.";
		runner("ended", { lastSeq: 2, result: RESULT(runId, { outcome: "blocked", filled: 0, uploaded: [], blockReason: "login_required", questions: [question] }) });
		const ended = await call("GET", `/${RUNNER}/application-runs/${runId}`);
		expect(ended.body.run.status).toBe("blocked");
		return { runId, profile: started.body.run.policy.browserProfile as string };
	}
	const takeoverRow = () => d1.DB.prepare("SELECT id, state, reason, end_reason FROM browser_takeovers WHERE subject_kind = 'runtime_task' AND subject_id = ?1 ORDER BY created_at DESC LIMIT 1").bind(CARD).first<{ id: string; state: string; reason: string; end_reason: string | null }>();
	const requestedAfterTheRunEnded = async () => {
		const { requestTakeover } = await import("../lib/browser-takeovers.js");
		const out = await requestTakeover(env(), { id: TAKEOVER, userId: "u1", instanceId: RUNNER, subjectKind: "runtime_task", subjectId: CARD, reason: "login_required", mobileAllowed: true });
		expect(out?.takeover.state).toBe("requested");
	};

	it.each(["ask", "deny"])("website permission %s on a sign-in frame never auto-opens or retries the application", async (decision) => {
		await endedBlockedOnSignIn();
		await requestedAfterTheRunEnded();
		await call("PATCH", `/${RUNNER}/browser-takeovers/${TAKEOVER}`, { state: "active", device: "mobile" });
		await call("PUT", `/${RUNNER}/browser-settings`, { websiteAccess: { mode: decision === "ask" ? "ask_once" : "allowlist", domains: [] } });
		answers["/local-apply/sign-in/frame"] = { status: 200, body: { state: "closed", websiteAccess: { decision, mode: decision === "ask" ? "ask_once" : "allowlist", hostname: "login.seek.com", url: "https://login.seek.com/login", actionDispatched: false } } };
		const before = sent.length;
		const frame = await call("GET", `/${RUNNER}/takeover/${CARD}/frame?device=mobile`);
		expect(frame.status).toBe(409);
		expect(frame.body.error).toMatch(decision === "ask" ? /website-requests/ : /denied/);
		expect(sent.slice(before).map((x) => x.path)).toEqual(["/local-apply/sign-in/frame"]);
		expect((await d1.DB.prepare("SELECT COUNT(*) AS n FROM website_access_requests WHERE instance_id=?1").bind(RUNNER).first<{n:number}>())?.n).toBe(decision === "ask" ? 1 : 0);
	});

	it("requested → activated from the phone → every frame poll is a live page, opened on the run's own profile at the job", async () => {
		const st = signInRunner();
		const { runId, profile } = await endedBlockedOnSignIn();
		await requestedAfterTheRunEnded();
		const before = sent.length;

		// The console's take-over control: the move to active, from a phone.
		const activated = await call("PATCH", `/${RUNNER}/browser-takeovers/${TAKEOVER}`, { state: "active", device: "mobile" });
		expect(activated.status).toBe(200);
		expect(activated.body.takeover.state).toBe("active");

		// The frame poll the live view makes at ~2 fps. Round 1 answered every one of these 409.
		for (let i = 0; i < 4; i++) {
			const frame = await call("GET", `/${RUNNER}/takeover/${CARD}/frame?device=mobile`);
			expect(frame.status).toBe(200);
			expect(frame.body).toEqual(FRAME);
		}
		// Opened ONCE, then kept: the same page serves every poll for the takeover's lifetime.
		expect(st.opens).toBe(1);
		expect(sent.find((x) => x.path === "/local-apply/sign-in")?.body).toEqual({ signInId: `sign-in-${TAKEOVER}`, browserProfile: profile, url: JOB });
		// Never the ended run's fill handoff (gone with the run), never the runner's task-takeover map.
		expect(sent.slice(before).some((x) => x.path.startsWith("/local-apply/handoff") || x.path.startsWith("/takeover/"))).toBe(false);
		expect((await takeoverRow())?.state).toBe("active");

		// The runner restarts mid-takeover (nothing in memory): the next poll re-establishes the page.
		st.open = null;
		expect((await call("GET", `/${RUNNER}/takeover/${CARD}/frame?device=mobile`)).status).toBe(200);
		expect(st.opens).toBe(2);

		// The owner types into SEEK's sign-in page.
		const input = { type: "text", text: "x" };
		expect((await call("POST", `/${RUNNER}/takeover/${CARD}/input?device=mobile`, input)).status).toBe(200);
		expect(sent.find((x) => x.path === "/local-apply/sign-in/input")?.body).toEqual({ signInId: `sign-in-${TAKEOVER}`, input });

		// "Resume — done": the sign-in is recorded on the runner, and the fill runs again.
		const resumed = await call("POST", `/${RUNNER}/takeover/${CARD}/resume`);
		expect(resumed.status).toBe(200);
		expect(sent.find((x) => x.path === "/local-apply/sign-in/end")?.body).toEqual({ signInId: `sign-in-${TAKEOVER}`, complete: true });
		expect(resumed.body.signIn.signedIn).toEqual({ fingerprint: 1, verifiable: true });
		expect(resumed.body.retry.outcome).toBe("started");
		expect(resumed.body.retry.runId).not.toBe(runId);
		expect(dispatches()).toHaveLength(2);
		expect((await appRow(APP))?.fill_run_id).toBe(resumed.body.retry.runId);
		expect((await takeoverRow())?.state).toBe("resumed");
	});

	it("the banner's own moves work on the card: resumed records the sign-in and retries; ended records nothing", async () => {
		signInRunner();
		await endedBlockedOnSignIn();
		await requestedAfterTheRunEnded();
		await call("PATCH", `/${RUNNER}/browser-takeovers/${TAKEOVER}`, { state: "active", device: "desktop" });
		await call("GET", `/${RUNNER}/takeover/${CARD}/frame`);
		const handed = await call("PATCH", `/${RUNNER}/browser-takeovers/${TAKEOVER}`, { state: "resumed" });
		expect(handed.status).toBe(200);
		expect(handed.body.takeover.state).toBe("resumed");
		expect(sent.find((x) => x.path === "/local-apply/sign-in/end")?.body).toMatchObject({ complete: true });
		expect(dispatches()).toHaveLength(2);
	});

	it("declining closes the page without recording a sign-in or retrying", async () => {
		signInRunner();
		await endedBlockedOnSignIn();
		await requestedAfterTheRunEnded();
		await call("GET", `/${RUNNER}/takeover/${CARD}/frame`);
		const declined = await call("PATCH", `/${RUNNER}/browser-takeovers/${TAKEOVER}`, { state: "ended" });
		expect(declined.body.takeover.state).toBe("ended");
		expect(sent.find((x) => x.path === "/local-apply/sign-in/end")?.body).toEqual({ signInId: `sign-in-${TAKEOVER}`, complete: false });
		expect(dispatches()).toHaveLength(1);
		expect((await call("GET", `/${RUNNER}/takeover/${CARD}/frame`)).status).toBe(409);
	});

	it("with no takeover recorded yet, the card's live view asks for one — for the sign-in — and serves the page", async () => {
		signInRunner();
		await endedBlockedOnSignIn();
		const frame = await call("GET", `/${RUNNER}/takeover/${CARD}/frame?device=mobile`);
		expect(frame.status).toBe(200);
		expect(await takeoverRow()).toMatchObject({ state: "active", reason: "login_required" });
	});

	it("a runner too old to open a sign-in says so, rather than a dead live view", async () => {
		await endedBlockedOnSignIn();
		await requestedAfterTheRunEnded();
		const frame = await call("GET", `/${RUNNER}/takeover/${CARD}/frame?device=mobile`);
		expect(frame.status).toBe(409);
		expect(frame.body.error).toMatch(/cannot open a sign-in after a run has ended\. Update it/);
		expect((await takeoverRow())?.state).toBe("active");
	});

	it("resume is refused, and nothing retried, when the runner no longer holds the page to record the sign-in from", async () => {
		const st = signInRunner();
		await endedBlockedOnSignIn();
		await requestedAfterTheRunEnded();
		await call("GET", `/${RUNNER}/takeover/${CARD}/frame`);
		st.open = null;
		const resumed = await call("POST", `/${RUNNER}/takeover/${CARD}/resume`);
		expect(resumed.status).toBe(409);
		expect(resumed.body.error).toMatch(/not recorded/);
		expect(dispatches()).toHaveLength(1);
		expect((await takeoverRow())?.state).toBe("active");
	});
});

/**
 * #1098: the Runner attempts an application on a site it has never seen — a company career page the owner pasted —
 * and a hard block is handed to the owner, never reported as a submit. Auto-submit stays on the instance's own
 * allow list: an unknown site is filled and waits for review, whatever the owner enabled for known ones.
 */
describe("an application on any site: attempted, never auto-submitted, a hard block handed to the owner (#1098)", () => {
	const CAREERS = "https://careers.racv.com.au/job/Melbourne-Head-of-Engineering/1234567";

	it("is dispatched with the job's own site allowed, in fill-and-review — the auto-submit gate refuses an unlisted site", async () => {
		await enableAutoSubmit(); // auto-submit ON, for example.com only
		const r = await call("POST", "/ap/application-runs", readyApp("lead-1098", { url: CAREERS, title: "Head of Engineering" }));
		expect(r.status).toBeLessThan(300);
		const run = r.body.run;
		expect(run.policy.mode).toBe("fill_and_review");
		expect(run.policy.allowDomains).toContain("careers.racv.com.au");
		expect(run.policy.gate.checks.find((c: { check: string }) => c.check === "domain_allowlisted")).toMatchObject({ ok: false });
		const dispatched = dispatches()[0].body as { policy: { mode: string; allowDomains: string[]; submitGate?: unknown } };
		expect(dispatched.policy).toMatchObject({ mode: "fill_and_review" });
		expect(dispatched.policy.allowDomains).toContain("careers.racv.com.au");
		expect(dispatched.policy.submitGate).toBeUndefined();
	});

	it("a sign-in wall the Runner cannot pass ends blocked with the owner's next step — never a submit", async () => {
		const r = await call("POST", "/ap/application-runs", readyApp("lead-1098b", { url: CAREERS, title: "Head of Engineering" }));
		const runId = r.body.run.id as string;
		const question = "Sign in to racv.com.au on this machine's application browser, then retry. Nothing was submitted.";
		runner("ended", { lastSeq: 2, result: RESULT(runId, { outcome: "blocked", filled: 0, uploaded: [], blockReason: "login_required", questions: [question] }) });
		const ended = await call("GET", `/ap/application-runs/${runId}`);
		expect(ended.body.run.status).toBe("blocked");
		expect(await appRow("lead-1098b")).toMatchObject({ status: "blocked", block_reason: "login_required", submit_attempted_at: null });
		expect(JSON.parse(String((await appRow("lead-1098b"))?.block_questions))).toEqual([question]);
	});
});

describe("deleting an agent", () => {
	it.each([
		["the Tailor (its applications and their audit go; the Runner's run rows stay)", "tailor-a", { apps: 0, audit: 0, runs: 1 }],
		["the Runner (its runs go; the Tailor's application and audit stay)", "runner-a", { apps: 1, audit: 1, runs: 0 }],
	])("cascades cleanly for %s", async (_label, agentId, left) => {
		d1.exec("PRAGMA foreign_keys = ON");
		await call("POST", "/ap/application-runs", readyApp("lead-14"));
		// Sign-in receipts belong to the Runner: delete them before its runs, but retain them when only the Tailor goes.
		d1.exec(`INSERT INTO local_apply_agent_sign_ins (run_id, instance_id, user_id, host, state, created_at, updated_at)
		 SELECT id, instance_id, user_id, 'example.com', 'signed_in', created_at, updated_at FROM local_apply_runs`);
		await d1.DB.batch(agentDeleteStatements(d1.DB as never, agentId, { cascadeSubscribers: true }) as never);
		const n = async (t: string) => (await d1.DB.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first<{ n: number }>())?.n;
		expect({ apps: await n("job_applications"), audit: await n("job_application_events"), runs: await n("local_apply_runs") }).toEqual(left);
		expect(await n("local_apply_agent_sign_ins")).toBe(left.runs);
	});
});

describe("explicit acknowledgement for standing auto-submit (#1039)", () => {
	const policy = { allowDomains: ["example.com"], autoSubmit: { enabled: true, roles: ["engineer"], dailyCap: 1 } };

	it("enabling without acknowledgeRealSubmissions is refused, and nothing is saved", async () => {
		const res = await call("PUT", "/ap/application-runner/settings", policy);
		expect(res).toMatchObject({ status: 400, body: { acknowledgementRequired: true, error: expect.stringMatching(/acknowledgeRealSubmissions: true/) } });
		expect((await call("GET", "/ap/application-runner/settings")).body.settings.autoSubmit).toMatchObject({ enabled: false, acknowledgedAt: null });
	});

	it("enabling with it stamps acknowledgedAt server-side — a client-sent stamp is ignored", async () => {
		const forged = await call("PUT", "/ap/application-runner/settings", { ...policy, autoSubmit: { ...policy.autoSubmit, acknowledgedAt: "2020-01-01T00:00:00.000Z" } });
		expect(forged.status).toBe(400);
		const before = Date.now();
		const res = await call("PUT", "/ap/application-runner/settings", { ...policy, acknowledgeRealSubmissions: true });
		expect(res.status).toBe(200);
		const at = Date.parse(res.body.settings.autoSubmit.acknowledgedAt);
		expect(at).toBeGreaterThanOrEqual(before - 1000);
		expect((await call("GET", "/ap/application-runner/settings")).body.settings.autoSubmit.acknowledgedAt).toBe(res.body.settings.autoSubmit.acknowledgedAt);
	});

	it("the prerequisites still apply even with the acknowledgement", async () => {
		const res = await call("PUT", "/ap/application-runner/settings", { autoSubmit: { enabled: true }, acknowledgeRealSubmissions: true });
		expect(res).toMatchObject({ status: 400, body: { error: expect.stringMatching(/cannot be enabled yet/) } });
	});

	it("disabling never needs it, and clears the acknowledgement", async () => {
		await call("PUT", "/ap/application-runner/settings", { ...policy, acknowledgeRealSubmissions: true });
		const off = await call("PUT", "/ap/application-runner/settings", { autoSubmit: { enabled: false } });
		expect(off).toMatchObject({ status: 200, body: { settings: { autoSubmit: { enabled: false, acknowledgedAt: null } } } });
	});
});


describe("a Runner answer is a durable decision on the application (#1079)", () => {
	const decisions = () => d1.sqlite.prepare("SELECT question, answer, answered_via, task_id, scope, applied_ref FROM owner_decisions ORDER BY asked_at, rowid").all() as Array<Record<string, unknown>>;
	const pause = () => runner("paused", { pause: { reason: "missing_answer", question: "Expected salary?" }, events: [{ seq: 1, type: "run.paused", at: "2026-10-07T00:06:00Z", pauseReason: "missing_answer" }] });
	const finalPause = (key: string, questions: string[], seq: number, expiresAt = Date.now() + 60_000) => runner("paused", {
		pause: { reason: "missing_answer", question: questions[0], handoffRequestId: key, answerWait: { kind: "final_review", expiresAt, budgetMs: 60_000, questions } },
		lastSeq: seq, events: [{ seq, type: "run.paused", at: new Date().toISOString(), pauseReason: "missing_answer" }],
	});
	it("retains verified final-answer identity when a malformed replacement pause arrives (#1560)", async () => {
		const runId = (await call("POST", "/ap/application-runs", readyApp("final-malformed"))).body.run.id;
		finalPause("final-1", ["Expected salary?"], 1);
		await call("GET", `/ap/application-runs/${runId}`);
		const before = await d1.DB.prepare("SELECT pause, runner_seq FROM local_apply_runs WHERE id = ?1").bind(runId).first();
		const version = (await appRow("final-malformed"))!.state_version;
		runner("paused", { pause: { reason: "missing_answer", handoffRequestId: "final-2", answerWait: { kind: "final_review", expiresAt: "invalid", questions: ["Other question"] } }, lastSeq: 2, events: [{ seq: 2, type: "run.paused", at: new Date().toISOString(), pauseReason: "missing_answer" }] });
		const invalid = await call("GET", `/ap/application-runs/${runId}`);
		expect(invalid.status).toBe(409); expect(invalid.body.error).toContain("invalid final-answer pause");
		expect(await d1.DB.prepare("SELECT pause, runner_seq FROM local_apply_runs WHERE id = ?1").bind(runId).first()).toEqual(before);
		expect((await appRow("final-malformed"))!.state_version).toBe(version);
		expect(decisions()).toEqual([expect.objectContaining({ question: "Expected salary?", answer: null })]);
		expect(sent.some(s => s.path === "/local-apply/resume")).toBe(false);
	});
	it.each(["questions", "expiresAt", "budgetMs", "removed"])("rejects changed %s under the same final-answer pause key (#1560)", async change => {
		const id = `final-immutable-${change}`;
		const runId = (await call("POST", "/ap/application-runs", readyApp(id))).body.run.id;
		const expiresAt = Date.now() + 60_000;
		finalPause("final-1", ["Expected salary?"], 1, expiresAt); await call("GET", `/ap/application-runs/${runId}`);
		const original = await d1.DB.prepare("SELECT pause, runner_seq FROM local_apply_runs WHERE id = ?1").bind(runId).first();
		const version = (await appRow(id))!.state_version;
		const marker = { kind: "final_review", expiresAt, budgetMs: 60_000, questions: ["Expected salary?"], ...(change === "questions" ? { questions: ["Another question"] } : change === "expiresAt" ? { expiresAt: expiresAt + 1 } : change === "budgetMs" ? { budgetMs: 90_000 } : {}) };
		runner("paused", { pause: { reason: "missing_answer", handoffRequestId: "final-1", ...(change === "removed" ? {} : { answerWait: marker }) }, lastSeq: 2, events: [{ seq: 2, type: "run.paused", at: new Date().toISOString(), pauseReason: "missing_answer" }] });
		const changed = await call("GET", `/ap/application-runs/${runId}`);
		expect(changed.status).toBe(409); expect(changed.body.error).toContain("without a new key");
		expect(await d1.DB.prepare("SELECT pause, runner_seq FROM local_apply_runs WHERE id = ?1").bind(runId).first()).toEqual(original);
		expect((await appRow(id))!.state_version).toBe(version); expect(decisions().every(d => d.answer === null)).toBe(true);
	});
	it("refuses an unseen pause epoch during the run/app mirror gap and heals that gap after a crash (#1560)", async () => {
		const runId = (await call("POST", "/ap/application-runs", readyApp("final-mirror-gap"))).body.run.id;
		const expiresAt = Date.now() + 60_000;
		finalPause("final-1", ["Expected salary?"], 1, expiresAt); await call("GET", `/ap/application-runs/${runId}`);
		const oldVersion = (await appRow("final-mirror-gap"))!.state_version;
		// The run receipt is durable; the Worker has not yet mirrored its new epoch onto the app.
		await d1.DB.prepare("UPDATE local_apply_runs SET runner_seq = 2, pause = ?1 WHERE id = ?2").bind(JSON.stringify({ reason: "missing_answer", handoffRequestId: "final-2", answerWait: { kind: "final_review", expiresAt, budgetMs: 60_000, questions: ["Expected salary?"] } }), runId).run();
		const ownerAnswers = [{ question: "Expected salary?", answer: "150000 AUD base" }];
		const unseen = await call("POST", `/ap/application-runs/${runId}/resume`, { expected_version: oldVersion, expectedAnswerPauseKey: "final-2", answers: ownerAnswers });
		expect(unseen.status).toBe(409); expect(decisions().every(d => d.answer === null)).toBe(true);
		expect(sent.some(s => s.path === "/local-apply/resume")).toBe(false);
		finalPause("final-2", ["Expected salary?"], 2, expiresAt);
		expect((await Promise.all([call("GET", `/ap/application-runs/${runId}`), call("GET", `/ap/application-runs/${runId}`)])).map(r => r.status)).toEqual([200, 200]);
		const mirroredVersion = (await appRow("final-mirror-gap"))!.state_version;
		expect(mirroredVersion).toBe((oldVersion as number) + 1);
		expect(await d1.DB.prepare("SELECT reason FROM job_application_events WHERE application_id = 'final-mirror-gap' AND version = ?1").bind(mirroredVersion).first()).toEqual({ reason: "final_answer_pause:final-2" });
		await call("GET", `/ap/application-runs/${runId}`);
		expect((await appRow("final-mirror-gap"))!.state_version).toBe(mirroredVersion);
		answers["/local-apply/resume"] = () => { runner("running", { lastSeq: 3, events: [{ seq: 3, type: "run.resumed", at: new Date().toISOString() }] }); return { status: 200, body: {} }; };
		const resumed = await call("POST", `/ap/application-runs/${runId}/resume`, { expected_version: mirroredVersion, expectedAnswerPauseKey: "final-2", answers: ownerAnswers });
		expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
		expect(decisions()).toEqual([expect.objectContaining({ question: "Expected salary?", answer: "150000 AUD base", applied_ref: runId })]);
		expect(dispatches()).toHaveLength(1);
	});
	it("resumes final answers on the same approved run, preserves submission authority, and versions each partial pause (#1560)", async () => {
		const event = readyApp("live-final");
		await d1.DB.prepare("UPDATE job_applications SET ready_event = ?1 WHERE id = 'live-final'").bind(JSON.stringify(event)).run();
		await call("PUT", "/ap/application-runner/settings", { allowDomains: ["example.com"] });
		const approved = await call("POST", "/ap/application-queue/actions", { action: "approve_and_proceed", application_id: "live-final", expected_status: "materials_ready", expected_version: 0 });
		expect(approved.status, JSON.stringify(approved.body)).toBe(200);
		const runId = approved.body.result.runId;
		const originalPolicy = JSON.parse((await d1.DB.prepare("SELECT policy FROM local_apply_runs WHERE id = ?1").bind(runId).first<{ policy: string }>())!.policy);
		expect(originalPolicy).toMatchObject({ mode: "auto_submit" });
		const authorization = () => d1.DB.prepare("SELECT * FROM job_application_submit_authorizations WHERE application_id = 'live-final'").first();
		const spent = await authorization(); expect(spent).toMatchObject({ consumed_run_id: runId });
		const expiresAt = Date.now() + 60_000;
		finalPause("final-1", ["Expected salary?", "Infrastructure experience?"], 1, expiresAt);
		const held = await call("GET", `/ap/application-runs/${runId}`);
		expect(held.body.run.pause.answerWait.questions).toEqual(["Expected salary?", "Infrastructure experience?"]);
		const firstVersion = (await appRow("live-final"))!.state_version;
		expect((await appRow("live-final"))!.block_questions).toBe(JSON.stringify(["Expected salary?", "Infrastructure experience?"]));
		answers["/local-apply/resume"] = () => { finalPause("final-2", ["Infrastructure experience?"], 2, expiresAt); return { status: 200, body: {} }; };
		const partial = await call("POST", "/ap/application-queue/actions", { action: "resume", application_id: "live-final", expected_status: "blocked", expected_version: firstVersion, answers: [{ question: "Expected salary?", answer: "150000 AUD base" }] });
		expect(partial.status, JSON.stringify(partial.body)).toBe(200);
		expect(sent.find(s => s.path === "/local-apply/resume")?.body).toMatchObject({ runId, expectedAnswerPauseKey: "final-1", answers: [{ question: "Expected salary?", answer: "150000 AUD base" }] });
		const next = await appRow("live-final"); expect(next!.state_version).toBeGreaterThan(firstVersion as number);
		expect(next!.block_questions).toBe(JSON.stringify(["Infrastructure experience?"]));
		const stale = await call("POST", "/ap/application-queue/actions", { action: "resume", application_id: "live-final", expected_status: "blocked", expected_version: firstVersion, answers: [{ question: "Infrastructure experience?", answer: "Owner supplied experience" }] });
		expect(stale.status).toBe(409);
		expect((await call("POST", `/ap/application-runs/${runId}/resume`, { expected_version: next!.state_version, expectedAnswerPauseKey: "final-1", answers: [{ question: "Infrastructure experience?", answer: "Owner supplied experience" }] })).status).toBe(409);
		answers["/local-apply/resume"] = () => { runner("running", { lastSeq: 3, events: [{ seq: 3, type: "run.resumed", at: new Date().toISOString() }] }); return { status: 200, body: {} }; };
		const resumed = await call("POST", "/ap/application-queue/actions", { action: "resume", application_id: "live-final", expected_status: "blocked", expected_version: next!.state_version, answers: [{ question: "Infrastructure experience?", answer: "Owner supplied experience" }] });
		expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
		expect(resumed.body.result).toMatchObject({ runId, runStatus: "running" });
		expect(dispatches()).toHaveLength(1); expect(await authorization()).toEqual(spent);
		expect(JSON.parse((await d1.DB.prepare("SELECT policy FROM local_apply_runs WHERE id = ?1").bind(runId).first<{ policy: string }>())!.policy)).toEqual(originalPolicy);
	});
	it.each(["missing_version", "missing_key", "empty", "unrelated", "duplicate", "expired", "rebound"])("refuses %s final answers before storage or browser dispatch (#1560)", async kind => {
		const id = `final-${kind}`;
		const runId = (await call("POST", "/ap/application-runs", readyApp(id))).body.run.id;
		finalPause("final-1", ["Expected salary?"], 1, kind === "expired" ? Date.now() - 1 : undefined);
		await call("GET", `/ap/application-runs/${runId}`);
		const version = (await appRow(id))!.state_version;
		if (kind === "rebound") await d1.DB.prepare("UPDATE job_applications SET fill_run_id = 'another-run' WHERE id = ?1").bind(id).run();
		const ownerAnswers = kind === "empty" ? [] : kind === "unrelated" ? [{ question: "Other question", answer: "Do not use" }] : kind === "duplicate" ? [{ question: "Expected salary?", answer: "150000" }, { question: "Expected salary?", answer: "160000" }] : [{ question: "Expected salary?", answer: "150000" }];
		const rejected = await call("POST", `/ap/application-runs/${runId}/resume`, { ...(kind === "missing_version" ? {} : { expected_version: version }), ...(kind === "missing_key" ? {} : { expectedAnswerPauseKey: "final-1" }), answers: ownerAnswers });
		expect([400, 409]).toContain(rejected.status);
		expect(sent.some(s => s.path === "/local-apply/resume")).toBe(false);
		expect(decisions().every(d => d.answer === null)).toBe(true);
		expect(dispatches()).toHaveLength(1);
	});

	it("a question pause is recorded; the answer is stored FIRST, delivered, and marked as used by that run", async () => {
		const runId = (await call("POST", "/ap/application-runs", readyApp("lead-d1"))).body.run.id as string;
		pause();
		await call("GET", `/ap/application-runs/${runId}`);
		expect(decisions()).toEqual([expect.objectContaining({ question: "Expected salary?", answer: null, task_id: runId, scope: "lead-d1" })]);
		runner("running", { lastSeq: 2, events: [{ seq: 2, type: "run.resumed", at: "2026-10-07T00:07:00Z" }] });
		await call("POST", `/ap/application-runs/${runId}/resume`, { answers: [{ question: "Expected salary?", answer: "150000 AUD" }] });
		expect(decisions()).toEqual([expect.objectContaining({ answer: "150000 AUD", answered_via: "console", applied_ref: runId })]);
	});

	it("an answer to a run that already ended is kept — not refused — and the next fill of that application is given it", async () => {
		const first = (await call("POST", "/ap/application-runs", readyApp("lead-d2"))).body.run.id as string;
		pause();
		await call("GET", `/ap/application-runs/${first}`);
		// The machine restarts: the run is lost before anyone answered.
		answers["/local-apply/status"] = { status: 404, body: { error: "No application run" } };
		await call("GET", `/ap/application-runs/${first}`);
		const late = await call("POST", `/ap/application-runs/${first}/resume`, { answers: [{ question: "Expected salary?", answer: "150000 AUD" }] });
		expect(late.status).toBe(200);
		expect(sent.some((x) => x.path === "/local-apply/resume")).toBe(false);
		expect(decisions()).toEqual([expect.objectContaining({ answer: "150000 AUD", applied_ref: null })]);

		await d1.DB.prepare("UPDATE job_applications SET status = 'materials_ready' WHERE id = 'lead-d2'").run();
		const next = await call("POST", "/ap/application-runs", { eventType: "job.application.materials_ready", eventId: "t1:lead-d2:again", applicationId: "lead-d2", tailorInstanceId: "t1", leadId: "lead-d2" });
		const nextRun = next.body.run.id as string;
		expect(dispatches().find((x) => x.body.runId === nextRun)?.body.ownerAnswers).toEqual([{ question: "Expected salary?", answer: "150000 AUD" }]);
		expect(decisions()).toEqual([expect.objectContaining({ applied_ref: nextRun })]);
	});

	describe("#1121: a run PARKED on a question gave its machine back; the owner's answer re-fills the application", () => {
		/** The runner reports the run parked; the live application carries its materials_ready event (what a re-fill fills from), which `readyApp` does not. */
		const parked = (runId: string, over: Record<string, unknown> = {}) => {
			runner("ended", { result: RESULT(runId, { outcome: "blocked", blockReason: "missing_answer", questions: ["Expected salary?"], filled: 2, summary: "Parked for the owner's answer.", ...over }) });
			const id = d1.sqlite.prepare("SELECT application_id FROM local_apply_runs WHERE id = ?").get(runId) as { application_id: string };
			d1.sqlite.prepare("UPDATE job_applications SET ready_event = ? WHERE id = ?").run(JSON.stringify({ eventId: `t1:${id.application_id}:1:materials`, applicationId: id.application_id }), id.application_id);
		};
		const SALARY = [{ question: "Expected salary?", answer: "150000 AUD" }];

		it("the answer starts ONE fresh fill carrying the stored answer — nothing is sent to the ended run", async () => {
			const first = (await call("POST", "/ap/application-runs", readyApp("lead-p1"))).body.run.id as string;
			parked(first);
			await call("GET", `/ap/application-runs/${first}`);
			expect(await appRow("lead-p1")).toMatchObject({ status: "blocked", block_reason: "missing_answer" });

			const res = await call("POST", `/ap/application-runs/${first}/resume`, { answers: SALARY });
			expect(res.status).toBe(200);
			const refill = dispatches().filter((x) => x.body.applicationId === "lead-p1");
			expect(refill).toHaveLength(2);
			expect(refill[1].body.runId).not.toBe(first);
			expect(refill[1].body.ownerAnswers).toEqual(SALARY);
			expect(sent.some((x) => x.path === "/local-apply/resume")).toBe(false);
			expect(await appRow("lead-p1")).toMatchObject({ status: "filling", fill_run_id: refill[1].body.runId });
			expect(decisions()).toEqual([expect.objectContaining({ answer: "150000 AUD", applied_ref: refill[1].body.runId })]);
			// A repeated answer to the same parked run never starts a second fill.
			await call("POST", `/ap/application-runs/${first}/resume`, { answers: SALARY });
			expect(dispatches().filter((x) => x.body.applicationId === "lead-p1")).toHaveLength(2);
		});

		it("never re-fills when the parked run's own result says a submit was attempted (#1013/#1073) — the answer is kept", async () => {
			const first = (await call("POST", "/ap/application-runs", readyApp("lead-p2"))).body.run.id as string;
			parked(first, { submitAttempted: true });
			await call("GET", `/ap/application-runs/${first}`);
			expect((await call("POST", `/ap/application-runs/${first}/resume`, { answers: SALARY })).status).toBe(200);
			expect(dispatches().filter((x) => x.body.applicationId === "lead-p2")).toHaveLength(1);
			expect(decisions()).toEqual([expect.objectContaining({ answer: "150000 AUD", applied_ref: null })]);
		});

		it("a run blocked on a LIVE-PAGE reason (sign-in) is not re-filled by an answer", async () => {
			const first = (await call("POST", "/ap/application-runs", readyApp("lead-p3"))).body.run.id as string;
			parked(first, { blockReason: "login_required", questions: ["Sign in to example.com"] });
			await call("GET", `/ap/application-runs/${first}`);
			await call("POST", `/ap/application-runs/${first}/resume`, { answers: SALARY });
			expect(dispatches().filter((x) => x.body.applicationId === "lead-p3")).toHaveLength(1);
		});

		it("an answer to an OLDER run of the application — not its current fill — starts nothing", async () => {
			const first = (await call("POST", "/ap/application-runs", readyApp("lead-p4"))).body.run.id as string;
			parked(first);
			await call("GET", `/ap/application-runs/${first}`);
			await d1.DB.prepare("UPDATE job_applications SET fill_run_id = 'a-newer-run' WHERE id = 'lead-p4'").run();
			await call("POST", `/ap/application-runs/${first}/resume`, { answers: SALARY });
			expect(dispatches().filter((x) => x.body.applicationId === "lead-p4")).toHaveLength(1);
		});
	});

	it("a resume with no answers on an ended run is still refused — there is nothing to keep", async () => {
		const runId = (await call("POST", "/ap/application-runs", readyApp("lead-d3"))).body.run.id as string;
		answers["/local-apply/status"] = { status: 404, body: { error: "No application run" } };
		await call("GET", `/ap/application-runs/${runId}`);
		expect((await call("POST", `/ap/application-runs/${runId}/resume`, {})).status).toBe(409);
	});
});
