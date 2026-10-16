/**
 * #1106 through the real sync path: a fill that pauses on a SEEK sign-in, for an owner who named the
 * SEEK address, is NOT handed to the owner — the runner is asked for a code first — and is handed to
 * them (once) when that cannot work. Real schema, routes and `syncApplyRun`; the relay to `pags up` and
 * the Agent DO's permission state are the only fakes. The mailbox half is `email-code-sign-in.test.ts`.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { realSchemaD1, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import type { Env } from "../types.js";

vi.mock("../lib/auth.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/auth.js")>("../lib/auth.js");
	return { ...actual, requireUser: async () => ({ uid: "u1", roles: [] }) };
});
const { getBoundRunnerConn } = vi.hoisted(() => ({ getBoundRunnerConn: vi.fn() }));
vi.mock("../lib/runner-client.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../lib/runner-client.js")>()), getBoundRunnerConn }));

const { instanceRoutes } = await import("./instances.js");
const { syncApplyRun } = await import("../lib/local-apply/apply.js");

const JOB_MAILBOX = "serge.pro.job@gmail.com";
let d1: RealSchemaD1;
let emailPermission: boolean;
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
const agentDO = { idFromName: (n: string) => n, get: () => ({ fetch: async () => Response.json({ ok: true, permissions: { email: emailPermission } }, { status: 201 }) }) };
const env = () => ({ DB: d1.DB, RELAY: relay, AGENT: agentDO }) as unknown as Env;

beforeEach(() => {
	d1 = realSchemaD1();
	emailPermission = true;
	d1.exec(`INSERT INTO users (id, github_login) VALUES ('u1', 'u1')`);
	d1.exec(`INSERT INTO agents (id, owner_id, slug, name, config) VALUES
	  ('tailor-a', 'u1', 't-tailor', 'Application Tailor', '{"capabilities":{"surfaces":[],"runtime":"local_artifact"}}'),
	  ('runner-a', 'u1', 't-runner', 'Job Application Runner', '{"capabilities":{"surfaces":[],"runtime":"local_apply","tools":["gmail_search","gmail_read_message"]}}')`);
	d1.exec(`INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES
	  ('t1', 'tailor-a', 'u1', 'active', '{"runnerNode":"mac"}'), ('ap', 'runner-a', 'u1', 'active', '{"runnerNode":"mac","connectorAccounts":{"gmail":"${JOB_MAILBOX}"}}')`);
	d1.exec(`INSERT INTO instance_runtime_nodes (instance_id, user_id, runner_node, endpoint_url, runner_version, status, last_seen_at) VALUES ('ap', 'u1', 'mac', 'relay://', '0.6.0', 'online', '2026-10-07 00:00:00')`);
	d1.exec(`INSERT INTO user_api_keys (user_id, provider, account_id, account_label, key_ciphertext, dek_wrapped, iv) VALUES ('u1', 'gmail', '${JOB_MAILBOX}', '${JOB_MAILBOX}', x'00', x'00', x'00')`);
	getBoundRunnerConn.mockReset();
	getBoundRunnerConn.mockImplementation(async (_env: unknown, instanceId: string) => ({ runnerNode: "mac", instanceId, userId: "u1", relayName: `${instanceId}:node:mac`, endpointUrl: "relay://", token: "", env: {} }));
	answers = { "/local-apply/run": { status: 202, body: { status: "running" } } };
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

/** A SEEK application at materials_ready, started on the Runner, then reported paused on SEEK's sign-in gate. */
async function pausedOnSeekSignIn(id: string) {
	const lead = { eventId: `scout:${id}:1`, sourceInstanceId: "scout", leadId: id, leadUrl: "https://au.seek.com/job/95289924", lifecycleVersion: 1, requestedAt: "2026-10-07T00:00:00Z", lead: { title: "Software Engineer", company: "Gentrack" } };
	const artifact = (kind: string, c: string) => JSON.stringify({ kind, path: `~/jobs/applications/${id}/r/${kind}.md`, sha256: c.repeat(64), bytes: 9 });
	d1.DB.prepare(
		`INSERT INTO job_applications (id, instance_id, user_id, source_instance_id, lead_id, lifecycle_version, idempotency_key, status, lead, resume_artifact, cover_letter_artifact, profile_version, generated_at, created_at, updated_at)
		 VALUES (?1, 't1', 'u1', 'scout', ?1, 1, ?2, 'materials_ready', ?3, ?4, ?5, '0123456789abcdef', '2026-10-07T00:05:00Z', 1, 1)`,
	)
		.bind(id, lead.eventId, JSON.stringify(lead), artifact("resume", "a"), artifact("cover_letter", "b"))
		.run();
	const started = await call("POST", "/ap/application-runs", { eventType: "job.application.materials_ready", eventId: `t1:${id}:1:materials`, applicationId: id, tailorInstanceId: "t1", leadId: id });
	expect(started.status).toBeLessThan(300);
	answers["/local-apply/status"] = { status: 200, body: { state: "paused", lastSeq: 1, events: [], pause: { reason: "login_required", domain: "au.seek.com", url: "https://au.seek.com/job/95289924", question: "Sign in to seek.com in this browser." } } };
	return started.body.run;
}
const alerts = async () => (await d1.DB.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = 'u1' AND type = 'apply'").first<{ n: number }>())?.n ?? 0;

describe("a SEEK sign-in pause signs itself in before the owner is asked (#1106)", () => {
	it("the settings route keeps the SEEK sign-in address, and refuses one that is not an address", async () => {
		expect((await call("PUT", "/ap/application-runner/settings", { signInEmail: " Serge.Pro.Job@gmail.com " })).status).toBe(200);
		expect((await call("GET", "/ap/application-runner/settings")).body.settings.signInEmail).toBe(JOB_MAILBOX);
		expect((await call("PUT", "/ap/application-runner/settings", { signInEmail: "not an address" })).status).toBe(400);
		expect((await call("PUT", "/ap/application-runner/settings", { signInEmail: null })).status).toBe(200);
		expect((await call("GET", "/ap/application-runner/settings")).body.settings.signInEmail).toBeNull();
	});

	it("with the address named: the runner is asked for a code and the owner is not alerted", async () => {
		await call("PUT", "/ap/application-runner/settings", { signInEmail: JOB_MAILBOX });
		const run = await pausedOnSeekSignIn("lead-1106");
		answers["/local-apply/email-code"] = { status: 200, body: { state: "code_requested" } };
		await syncApplyRun(env(), "u1", run, Date.now());
		expect(sent.find((s) => s.path === "/local-apply/email-code")?.body).toEqual({ runId: run.id, step: "request", email: JOB_MAILBOX });
		expect(sent.some((s) => s.path === "/local-apply/handoff")).toBe(false);
		expect(await alerts()).toBe(0);
	});

	it("when it cannot work — here, email access is off — the owner gets the ordinary sign-in handoff, once", async () => {
		emailPermission = false;
		await call("PUT", "/ap/application-runner/settings", { signInEmail: JOB_MAILBOX });
		const run = await pausedOnSeekSignIn("lead-1106-off");
		answers["/local-apply/handoff"] = { status: 200, body: { handoffId: "x", runId: run.id, applicationId: "lead-1106-off", browserProfile: "isolated", state: "ready", expiresAt: "2026-10-11T01:00:00.000Z" } };
		await syncApplyRun(env(), "u1", run, Date.now());
		expect(sent.some((s) => s.path === "/local-apply/email-code")).toBe(false);
		expect(await alerts()).toBe(1);
		const trace = JSON.stringify((await call("GET", `/ap/application-runs/${run.id}`)).body);
		expect(trace).toContain("Email access is off for the Application Runner");
		// The next sync does not alert again.
		const again = (await call("GET", `/ap/application-runs/${run.id}`)).body.run;
		await syncApplyRun(env(), "u1", again, Date.now());
		expect(await alerts()).toBe(1);
	});

	it("without the address: unchanged — the owner is alerted at once and no code is asked for", async () => {
		const run = await pausedOnSeekSignIn("lead-1106-none");
		answers["/local-apply/handoff"] = { status: 200, body: { handoffId: "x", runId: run.id, applicationId: "lead-1106-none", browserProfile: "isolated", state: "ready", expiresAt: "2026-10-11T01:00:00.000Z" } };
		await syncApplyRun(env(), "u1", run, Date.now());
		expect(sent.some((s) => s.path === "/local-apply/email-code")).toBe(false);
		expect(await alerts()).toBe(1);
	});
});
