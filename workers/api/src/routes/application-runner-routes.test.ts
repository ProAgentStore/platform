/**
 * Application Runner (#957) over the real schema. Only the relay/runner seam and the Agent DO are
 * faked; capability resolution, settings, the submit gate, the application lifecycle (compare-and-
 * set + audit), the run, the pull, the connection outbox and the Tailor upstream are real code
 * against the real migrations.
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
const { syncActiveApplyRuns } = await import("../lib/local-apply/apply.js");
const { agentDeleteStatements } = await import("../lib/agent-cascade.js");

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
const agentDO = { idFromName: (n: string) => n, get: () => ({ fetch: async () => Response.json({ ok: true }, { status: 201 }) }) };
const env = () => ({ DB: d1.DB, RELAY: relay, AGENT: agentDO }) as unknown as Env;

const SHA_R = "a".repeat(64);
const SHA_C = "b".repeat(64);

beforeEach(() => {
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
	call("PUT", "/ap/application-runner/settings", { allowDomains: ["example.com"], autoSubmit: { enabled: true, roles: ["engineer"], dailyCap: 1, ...over } });

describe("end to end: approved lead → materials_ready → filled and awaiting review, exactly once", () => {
	it("chains the Tailor into the Runner, writes the lifecycle back with an audit row per move, and never dispatches twice", async () => {
		const plan = planJobLeadTriage({ id: "lead-1", data: { title: "Staff Engineer", company: "Globex", location: "Sydney", url: "https://jobs.example.com/1", email: "recruiter@globex.example", status: "new" } } as never, { action: "apply", sourceInstanceId: "scout" }, { now: "2026-10-07T00:00:00.000Z" });
		if (!plan.ok || !plan.event) throw new Error("fixture lead did not plan");
		await deliverEvent(env(), "scout", "u1", JOB_LEAD_APPLY_EVENT, [plan.event], { traceId: plan.event.eventId });
		const tailorRun = sent.find((s) => s.path === "/local-artifact/run")?.body.runId as string;
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

		// The owner answers; the answer goes to the runner, not into PAGS's records.
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
		expect(dispatches()[0].body.policy).toEqual({ mode: "auto_submit", allowDomains: ["jobs.example.com", "example.com"], submitGate: { gateId } });

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

		// The daily cap (1) is now used: the next application fills and waits for review.
		const next = await call("POST", "/ap/application-runs", readyApp("lead-7"));
		expect(next.body.run.policy.mode).toBe("fill_and_review");
		expect(next.body.run.policy.gate.checks.find((c: { check: string }) => c.check === "daily_cap").ok).toBe(false);
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
});

describe("settings, access and cancel", () => {
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

describe("deleting an agent", () => {
	it.each([
		["the Tailor (its applications and their audit go; the Runner's run rows stay)", "tailor-a", { apps: 0, audit: 0, runs: 1 }],
		["the Runner (its runs go; the Tailor's application and audit stay)", "runner-a", { apps: 1, audit: 1, runs: 0 }],
	])("cascades cleanly for %s", async (_label, agentId, left) => {
		d1.exec("PRAGMA foreign_keys = ON");
		await call("POST", "/ap/application-runs", readyApp("lead-14"));
		await d1.DB.batch(agentDeleteStatements(d1.DB as never, agentId, { cascadeSubscribers: true }) as never);
		const n = async (t: string) => (await d1.DB.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first<{ n: number }>())?.n;
		expect({ apps: await n("job_applications"), audit: await n("job_application_events"), runs: await n("local_apply_runs") }).toEqual(left);
	});
});
