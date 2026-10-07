/**
 * Application Tailor (#956) over the real schema. Only the relay/runner seam and the Agent DO are
 * faked; capability resolution, settings, the application claim, the run lifecycle, the pull, the
 * connection outbox and the materials_ready emit are the real code against the real migrations.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { realSchemaD1, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import { JOB_LEAD_APPLY_EVENT, planJobLeadTriage } from "../lib/job-lead-triage.js";
import type { Env } from "../types.js";

vi.mock("../lib/auth.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/auth.js")>("../lib/auth.js");
	return { ...actual, requireUser: async () => ({ uid: "u1", roles: [] }) };
});
const { getBoundRunnerConn } = vi.hoisted(() => ({ getBoundRunnerConn: vi.fn() }));
vi.mock("../lib/runner-client.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../lib/runner-client.js")>()), getBoundRunnerConn }));

const { instanceRoutes } = await import("./instances.js");
const { deliverEvent } = await import("../lib/connections.js");
const { syncActiveTailorRuns, emitReady } = await import("../lib/local-artifact/tailor.js");

let d1: RealSchemaD1;
let sent: Array<{ path: string; body: Record<string, unknown> }>;
/** What the fake runner answers per path. */
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
/** Tasks created on any instance's DO — the downstream consumer of materials_ready. */
let tasks: Array<{ instance: string; body: Record<string, unknown> }>;
const agentDO = {
	idFromName: (n: string) => n,
	get: (id: string) => ({
		fetch: async (req: Request) => {
			if (new URL(req.url).pathname === "/tasks") {
				tasks.push({ instance: id, body: (await req.json()) as Record<string, unknown> });
				return Response.json({ ok: true }, { status: 201 });
			}
			return Response.json({ error: "not faked" }, { status: 404 });
		},
	}),
};
const env = () => ({ DB: d1.DB, RELAY: relay, AGENT: agentDO }) as unknown as Env;

const LEAD_RECORD = {
	id: "lead-1",
	data: { title: "Staff Engineer", company: "Globex", location: "Sydney", url: "https://jobs.example.com/1", email: "recruiter@globex.example", notes: "private", status: "new" },
};
/** The real #955 handoff event, exactly as the Scout's triage produces it. */
function leadEvent() {
	const plan = planJobLeadTriage(LEAD_RECORD as never, { action: "apply", sourceInstanceId: "scout" }, { now: "2026-10-07T00:00:00.000Z" });
	if (!plan.ok || !plan.event) throw new Error("fixture lead did not plan");
	return plan.event;
}

const RESULT = (runId: string, over: Record<string, unknown> = {}) => ({
	runId,
	outcome: "completed",
	traceId: runId,
	engineAuth: "machine-login",
	profileVersion: "0123456789abcdef",
	generatedAt: "2026-10-07T00:05:00.000Z",
	artifacts: [
		{ kind: "resume", path: `~/jobs/applications/lead-1/${runId}/resume.md`, sha256: "a".repeat(64), bytes: 900 },
		{ kind: "cover_letter", path: `~/jobs/applications/lead-1/${runId}/cover-letter.md`, sha256: "b".repeat(64), bytes: 700 },
	],
	sourceHashes: [{ role: "resume", path: "~/jobs/resume.md", sha256: "c".repeat(64), bytes: 1200 }],
	...over,
});
/** The runner reports the run ended with `result` — and a trace event carrying content it must not. */
function runnerEnds(result: unknown) {
	answers["/local-artifact/status"] = {
		status: 200,
		body: {
			state: "ended",
			lastSeq: 2,
			events: [
				{ seq: 1, type: "source.read", at: "2026-10-07T00:01:00.000Z", detail: { role: "resume", sha256: "c".repeat(64), text: "Jane Citizen, 10 Secret St" } },
				{ seq: 2, type: "artifact.written", at: "2026-10-07T00:05:00.000Z", detail: { kind: "resume", path: "~/jobs/applications/lead-1/r/resume.md" } },
			],
			result,
		},
	};
}

beforeEach(() => {
	d1 = realSchemaD1();
	d1.exec(`INSERT INTO users (id, github_login) VALUES ('u1', 'u1'), ('u2', 'u2')`);
	d1.exec(`INSERT INTO agents (id, owner_id, slug, name, config) VALUES
	  ('scout-a', 'u1', 't956-scout', 'Job Search Scout', '{"capabilities":{"surfaces":[],"runtime":"local_browser"}}'),
	  ('tailor-a', 'u1', 't956-tailor', 'Application Tailor', '{"capabilities":{"surfaces":[],"runtime":"local_artifact"}}'),
	  ('runner-a', 'u1', 't956-runner', 'Application Runner', '{"capabilities":{"surfaces":[]}}')`);
	d1.exec(`INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES
	  ('scout', 'scout-a', 'u1', 'active', '{}'), ('t1', 'tailor-a', 'u1', 'active', '{"runnerNode":"mac"}'),
	  ('next', 'runner-a', 'u1', 'active', '{}'), ('other', 'tailor-a', 'u2', 'active', '{}')`);
	d1.exec(`INSERT INTO instance_runtime_nodes (instance_id, user_id, runner_node, endpoint_url, runner_version, status, last_seen_at) VALUES ('t1', 'u1', 'mac', 'relay://', '0.6.0', 'online', '2026-10-07 00:00:00')`);
	d1.exec(`INSERT INTO agent_connections (id, user_id, source_instance_id, event_type, target_instance_id, action, config, enabled) VALUES
	  ('c-lead', 'u1', 'scout', '${JOB_LEAD_APPLY_EVENT}', 't1', 'generate_application_materials', '{}', 1),
	  ('c-ready', 'u1', 't1', 'job.application.materials_ready', 'next', 'create_task', '{}', 1)`);
	getBoundRunnerConn.mockReset();
	getBoundRunnerConn.mockResolvedValue({ runnerNode: "mac", instanceId: "t1", userId: "u1", relayName: "t1:node:mac", endpointUrl: "relay://", token: "", env: {} });
	answers = { "/local-artifact/run": { status: 202, body: { runId: "x", taskId: "x", status: "running" } }, "/local-artifact/cancel": { status: 200, body: {} } };
	sent = [];
	tasks = [];
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
const appCount = async () => (await d1.DB.prepare("SELECT COUNT(*) AS n FROM job_applications").first<{ n: number }>())?.n;
const runCount = async () => (await d1.DB.prepare("SELECT COUNT(*) AS n FROM local_artifact_runs").first<{ n: number }>())?.n;

describe("end to end: apply_requested → materials_ready, exactly once", () => {
	it("tailors once however often the lead is delivered, and emits materials_ready once however often it is synced", async () => {
		const event = leadEvent();
		const first = await deliverEvent(env(), "scout", "u1", JOB_LEAD_APPLY_EVENT, [event], { traceId: event.eventId });
		expect(first).toMatchObject({ delivered: 1 });
		// Replays: the same emission (outbox duplicate), a fresh emission of the same event, and the owner route.
		expect(await deliverEvent(env(), "scout", "u1", JOB_LEAD_APPLY_EVENT, [event], { traceId: event.eventId })).toMatchObject({ duplicate: 1 });
		expect(await deliverEvent(env(), "scout", "u1", JOB_LEAD_APPLY_EVENT, [event], { traceId: "a-retry" })).toMatchObject({ delivered: 1 });
		const viaRoute = await call("POST", "/t1/applications", { event });
		expect(viaRoute).toMatchObject({ status: 200, body: { outcome: "existing" } });
		expect(await appCount()).toBe(1);
		expect(await runCount()).toBe(1);
		expect(sent.filter((s) => s.path === "/local-artifact/run")).toHaveLength(1);

		// What the runner was sent: the lead envelope (no contact data), the sources, no credential.
		const task = sent.find((s) => s.path === "/local-artifact/run")?.body as Record<string, unknown>;
		expect(task).toMatchObject({ type: "local_artifact.generate", requestId: event.eventId, authMode: "machine", workspace: "~/jobs", sources: [{ role: "resume", path: "resume.md" }, { role: "profile", path: "profile.md" }] });
		expect(JSON.stringify(task)).not.toMatch(/recruiter@globex|private|token|apiKey/i);

		const app = viaRoute.body.application;
		expect(app).toMatchObject({ status: "tailoring", leadId: "lead-1", lifecycleVersion: 1, sourceInstanceId: "scout", idempotencyKey: event.eventId });
		runnerEnds(RESULT(app.tailoringRunId));
		const read = await call("GET", `/t1/applications/${app.id}`);
		expect(read.body.application).toMatchObject({
			status: "materials_ready",
			tailoringRunId: app.tailoringRunId,
			resumeArtifact: { kind: "resume", path: `~/jobs/applications/lead-1/${app.tailoringRunId}/resume.md` },
			coverLetterArtifact: { kind: "cover_letter" },
			profileVersion: "0123456789abcdef",
			generatedAt: "2026-10-07T00:05:00.000Z",
			blockReason: null,
		});
		expect(read.body.run).toMatchObject({ status: "completed", engineAuth: "machine-login" });
		// The trace keeps handles and drops anything else the runner sent.
		expect(JSON.stringify(read.body.run.trace)).not.toContain("Secret St");

		// Re-read, cron, a direct re-emit: still exactly one downstream delivery.
		await call("GET", `/t1/applications/${app.id}`);
		await syncActiveTailorRuns(env());
		await emitReady(env(), "t1", "u1", app.id);
		await d1.DB.prepare("UPDATE job_applications SET ready_emitted_at = NULL").run(); // a crash between the outbox write and the mark
		await syncActiveTailorRuns(env());
		expect(tasks.filter((t) => t.instance === "next")).toHaveLength(1);
		const ready = JSON.parse(String(tasks[0].body.description));
		expect(ready).toMatchObject({ eventType: "job.application.materials_ready", applicationId: app.id, leadId: "lead-1", leadEventId: event.eventId, tailoringRunId: app.tailoringRunId });
		expect(JSON.stringify(ready)).not.toMatch(/recruiter@globex|private/);
	});

	it("a lead delivered while no runner is connected is retried by the outbox, not parked", async () => {
		getBoundRunnerConn.mockResolvedValue(null);
		const event = leadEvent();
		const out = await deliverEvent(env(), "scout", "u1", JOB_LEAD_APPLY_EVENT, [event], { traceId: event.eventId });
		expect(out).toMatchObject({ delivered: 0, failed: 1 });
		expect(await appCount()).toBe(0);
		const row = await d1.DB.prepare("SELECT status FROM agent_connection_deliveries").first<{ status: string }>();
		expect(row?.status).toBe("pending");
	});
});

describe("it pauses explicitly", () => {
	it("on a malformed lead — recorded as blocked, never dispatched", async () => {
		const r = await call("POST", "/t1/applications", { event: { ...leadEvent(), lead: {} } });
		expect(r.body.application).toMatchObject({ status: "blocked", blockReason: "malformed_lead" });
		expect(sent).toHaveLength(0);
	});

	it("on settings that no longer validate", async () => {
		d1.exec(`UPDATE agent_instances SET config = '{"runnerNode":"mac","applicationTailor":{"authMode":"api-key"}}' WHERE id = 't1'`);
		const r = await call("POST", "/t1/applications", leadEvent());
		expect(r.body.application).toMatchObject({ status: "blocked", blockReason: "settings_invalid" });
		expect(sent).toHaveLength(0);
	});

	it.each([
		["missing_source", ["Your profile at ~/jobs/profile.md could not be read (not found)."]],
		["uncertain_claim", ["Confirm or correct: “PhD” — no matching text was found in your resume."]],
		["workspace_unavailable", ["The workspace ~/jobs cannot be used."]],
	])("when the runner reports %s — with the questions, and no materials_ready", async (reason, questions) => {
		const r = await call("POST", "/t1/applications", leadEvent());
		const runId = r.body.application.tailoringRunId;
		runnerEnds({ runId, outcome: "needs_human", traceId: runId, engineAuth: "machine-login", artifacts: [], sourceHashes: [], profileVersion: null, blockReason: reason, questions });
		const read = await call("GET", `/t1/applications/${r.body.application.id}`);
		expect(read.body.application).toMatchObject({ status: "blocked", blockReason: reason, blockQuestions: questions, resumeArtifact: null });
		expect(read.body.run.status).toBe("needs_human");
		expect(tasks).toHaveLength(0);
	});

	it("when the runner lost the run (restart) — blocked runner_lost", async () => {
		const r = await call("POST", "/t1/applications", leadEvent());
		answers["/local-artifact/status"] = { status: 404, body: { error: "No local artifact run" } };
		const read = await call("GET", `/t1/applications/${r.body.application.id}`);
		expect(read.body.application).toMatchObject({ status: "blocked", blockReason: "runner_lost" });
	});

	it("when the runner predates the task — blocked runner_unsupported", async () => {
		answers["/local-artifact/run"] = { status: 404, body: { error: "Not found" } };
		const r = await call("POST", "/t1/applications", leadEvent());
		expect(r.body.application).toMatchObject({ status: "blocked", blockReason: "runner_unsupported" });
		expect(r.body.run.status).toBe("failed");
	});

	it("refuses a completed result without both artifacts", async () => {
		const r = await call("POST", "/t1/applications", leadEvent());
		const runId = r.body.application.tailoringRunId;
		runnerEnds(RESULT(runId, { artifacts: [RESULT(runId).artifacts[0]] }));
		const read = await call("GET", `/t1/applications/${r.body.application.id}`);
		expect(read.body.application).toMatchObject({ status: "failed", blockReason: "runner_result_invalid" });
		expect(tasks).toHaveLength(0);
	});
});

describe("settings and access", () => {
	it("defaults to ~/jobs with machine sign-in, and patches", async () => {
		expect((await call("GET", "/t1/application-tailor/settings")).body.settings).toEqual({ engine: "claude", authMode: "machine", workspace: "~/jobs", sources: { resume: "resume.md", profile: "profile.md" }, retainDays: 0, maxMinutes: 10 });
		const put = await call("PUT", "/t1/application-tailor/settings", { engine: "codex", sources: { answers: "answers/screening.md" }, retainDays: 30 });
		expect(put.body.settings).toMatchObject({ engine: "codex", sources: { resume: "resume.md", profile: "profile.md", answers: "answers/screening.md" }, retainDays: 30 });
		const row = await d1.DB.prepare("SELECT config FROM agent_instances WHERE id = 't1'").first<{ config: string }>();
		expect(JSON.parse(row!.config)).toMatchObject({ runnerNode: "mac", applicationTailor: { engine: "codex" } });
	});

	it.each([
		[{ authMode: "api-key" }, /never on a provider API key/],
		[{ workspace: "/etc" }, /under the home folder/],
		[{ workspace: "~/../etc" }, /under the home folder/],
		[{ sources: { resume: "../.ssh/id_rsa" } }, /inside the workspace/],
		[{ sources: { resume: "applications/x/resume.md" } }, /generated material/],
		[{ retainDays: -1 }, /retainDays/],
	])("refuses %j", async (patch, msg) => {
		const r = await call("PUT", "/t1/application-tailor/settings", patch);
		expect(r.status).toBe(400);
		expect(r.body.error).toMatch(msg);
	});

	it("is a 409 on an agent that is not a tailor, and a 404 on someone else's instance", async () => {
		const scout = await call("POST", "/scout/applications", leadEvent());
		expect(scout.status).toBe(409);
		expect(scout.body.error).toMatch(/runtime is "local_browser"/);
		expect((await call("GET", "/other/applications")).status).toBe(404);
	});

	it("cancels a running tailoring run, on the runner and in PAGS", async () => {
		const r = await call("POST", "/t1/applications", leadEvent());
		const c = await call("POST", `/t1/applications/${r.body.application.id}/cancel`);
		expect(c.body.application.status).toBe("cancelled");
		expect(c.body.run.status).toBe("cancelled");
		expect(sent.some((s) => s.path === "/local-artifact/cancel")).toBe(true);
		expect((await call("GET", "/t1/applications?status=cancelled")).body.applications).toHaveLength(1);
	});
});
