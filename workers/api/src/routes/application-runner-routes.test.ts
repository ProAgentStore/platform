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
const { syncActiveApplyRuns, syncApplyRun } = await import("../lib/local-apply/apply.js");
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

// ── #978: the run is on the owner's NORMAL board, linked to the application ──────────────────
//
// Before this the Board rendered only generic runtime tasks, so a Runner actively filling an
// employer's form had an EMPTY board and the work existed only on a separate Applications surface.
describe("an application execution appears on the normal Kanban (#978)", () => {
	const board = async (instance = "ap") => (await call("GET", `/${instance}/board`)).body;
	const appCard = async (instance = "ap") => {
		type Card = { application?: { applicationId: string; kind: string; stage: string; actions: string[]; traceUrl: string; checkpoint?: { checkpointId: string; directive: string | null }; blockReason?: string }; title: string; status: string; attempts: unknown[] };
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
		expect(card?.application).toMatchObject({ applicationId: "lead-b1", kind: "fill", stage: "Filling the application in the browser" });
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
		expect(card?.application?.stage).toMatch(/cloud supervisor's decision at a checkpoint/);
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

	it("refuses the fill before anything is claimed, naming the update", async () => {
		setRunnerVersion("0.4.83"); // one release below the #975 contract
		const ev = readyApp("lead-v1");
		const r = await call("POST", "/ap/application-runs", ev);
		expect(r.status).toBe(409);
		expect(r.body.error).toMatch(/predates this application contract/);
		expect(r.body.error).toMatch(/0\.4\.84 or newer/);
		expect(r.body.error).toMatch(/npm i -g @proagentstore\/cli|runner_update/);
		// Nothing was spent and nothing moved: no run row, no dispatch, and the application is still
		// materials_ready, so it retries cleanly once the machine is updated.
		expect((await d1.DB.prepare("SELECT COUNT(*) AS n FROM local_apply_runs").first<{ n: number }>())?.n).toBe(0);
		expect(dispatches()).toHaveLength(0);
		expect(await appRow("lead-v1")).toMatchObject({ status: "materials_ready", block_reason: null });
	});

	it("the same application runs once the machine is updated", async () => {
		setRunnerVersion("0.4.83");
		const ev = readyApp("lead-v2");
		expect((await call("POST", "/ap/application-runs", ev)).status).toBe(409);
		setRunnerVersion("0.4.84");
		const ok = await call("POST", "/ap/application-runs", ev);
		expect(ok.body.run.status).toBe("running");
		// And the record says WHICH runner executed it — the fact that was missing.
		expect(await runRow(ok.body.run.id as string)).toMatchObject({ runner_version: "0.4.84" });
	});

	it("stamps the executing runner's version on every run, and returns it over the API", async () => {
		setRunnerVersion("0.5.0");
		const started = await call("POST", "/ap/application-runs", readyApp("lead-v3"));
		const runId = started.body.run.id as string;
		expect(await runRow(runId)).toMatchObject({ runner_version: "0.5.0" });
		// The same row #971's `application_run` returns over MCP.
		expect((await call("GET", `/ap/application-runs/${runId}`)).body.run.runnerVersion).toBe("0.5.0");
	});

	it("a machine that reports no version is not judged — a missing fact is not evidence", async () => {
		// `instance_runtime_nodes.runner_version` is NOT NULL, so the reachable shape of "unreported"
		// is the empty string. Refusing on a fact we do not have is the worse failure, and is what
		// `cliAtLeast` and every other MIN_CLI gate in this codebase avoid.
		setRunnerVersion("");
		const r = await call("POST", "/ap/application-runs", readyApp("lead-v4"));
		expect(r.body.run.status).toBe("running");
		expect(await runRow(r.body.run.id as string)).toMatchObject({ runner_version: "" });
	});

	it("an up-to-date runner still reports the #975 zero-bridge diagnosis end to end", async () => {
		setRunnerVersion("0.4.84");
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
		expect(run.runnerVersion).toBe("0.4.84");
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

	it("an approved submission survives the wait — the authorization stays spent on that run", async () => {
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
		expect(approved.body.result.mode).toBe("auto_submit");
		expect(approved.body.result.authorizationConsumedBy).toBe(runId);
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
