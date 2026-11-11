/**
 * #1412/#1422 through the real sync path: a fill that pauses on a sign-in is handed to the AGENT — the login goes to the runner as
 * named secrets in one request, and the owner is alerted only once the agent's own attempt is spent (the three hardcoded macros this
 * used to fall back to are retired). Real schema, routes, vault and `syncApplyRun`; the relay to `pags up` is the only fake. The step's
 * own edges are `local-apply/agent-sign-in.test.ts`.
 */
import { Hono } from "hono";
import { completeRunnerBatch } from "../lib/local-apply/__fixtures__/status.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { realSchemaD1, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import { createCredential } from "../lib/credentials.js";
import type { Env } from "../types.js";

vi.mock("../lib/auth.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/auth.js")>("../lib/auth.js");
	return { ...actual, requireUser: async () => ({ uid: "u1", roles: [] }) };
});
const { getBoundRunnerConn } = vi.hoisted(() => ({ getBoundRunnerConn: vi.fn() }));
vi.mock("../lib/runner-client.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../lib/runner-client.js")>()), getBoundRunnerConn }));

const { instanceRoutes } = await import("./instances.js");
const { syncApplyRun } = await import("../lib/local-apply/apply.js");

const JOB_MAILBOX = "owner@example.com";
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
			return new Response(JSON.stringify(cmd.path === "/local-apply/status" && a.status === 200 ? completeRunnerBatch(a.body, body.afterSeq) : a.body), { status: a.status });
		},
	}),
};
const agentDO = { idFromName: (n: string) => n, get: () => ({ fetch: async (req: Request) => new URL(req.url).pathname === "/memory" ? Response.json({ memory: [] }) : Response.json({ ok: true, permissions: { email: true } }, { status: 201 }) }) };
const env = () => ({ DB: d1.DB, RELAY: relay, AGENT: agentDO, KEY_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" }) as unknown as Env;

beforeEach(() => {
	d1 = realSchemaD1();
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

const USERNAME = "owner@example.com";
const PASSWORD = "Tr0ub4dor&3-vault-secret";
const paused = (domain: string) => ({ status: 200, body: { state: "paused", lastSeq: 1, events: [], pause: { reason: "login_required", domain, url: `https://${domain}/auth`, question: `Sign in to ${domain} in this browser.` } } });
const signingIn = (names: string[]) => ({ status: 200, body: { state: "running", lastSeq: 2, events: [], signIn: { state: "signing_in", origin: "www.indeed.com", secrets: names, codeRequested: false } } });

/** An application started on the Runner, then reported paused on a sign-in gate at `domain`. */
async function pausedOnSignIn(id: string, domain: string) {
	const lead = { eventId: `scout:${id}:1`, sourceInstanceId: "scout", leadId: id, leadUrl: `https://${domain}/job/1`, lifecycleVersion: 1, requestedAt: "2026-10-07T00:00:00Z", lead: { title: "Software Engineer", company: "Gentrack" } };
	const artifact = (kind: string, c: string) => JSON.stringify({ kind, path: `~/jobs/applications/${id}/r/${kind}.md`, sha256: c.repeat(64), bytes: 9 });
	d1.DB.prepare(
		`INSERT INTO job_applications (id, instance_id, user_id, source_instance_id, lead_id, lifecycle_version, idempotency_key, status, lead, resume_artifact, cover_letter_artifact, profile_version, generated_at, created_at, updated_at)
		 VALUES (?1, 't1', 'u1', 'scout', ?1, 1, ?2, 'materials_ready', ?3, ?4, ?5, '0123456789abcdef', '2026-10-07T00:05:00Z', 1, 1)`,
	)
		.bind(id, lead.eventId, JSON.stringify(lead), artifact("resume", "a"), artifact("cover_letter", "b"))
		.run();
	const started = await call("POST", "/ap/application-runs", { eventType: "job.application.materials_ready", eventId: `t1:${id}:1:materials`, applicationId: id, tailorInstanceId: "t1", leadId: id });
	expect(started.status).toBeLessThan(300);
	answers["/local-apply/status"] = paused(domain);
	return started.body.run;
}
const alerts = async () => (await d1.DB.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = 'u1' AND type = 'apply'").first<{ n: number }>())?.n ?? 0;
const store = (domain = "indeed.com") => createCredential(env(), "ap", "u1", { domain, username: USERNAME, password: PASSWORD } as Parameters<typeof createCredential>[3]);
const agentRow = (runId: string) => d1.DB.prepare("SELECT state, host, failure FROM local_apply_agent_sign_ins WHERE run_id = ?1").bind(runId).first<{ state: string; host: string; failure: string | null }>();

describe("a sign-in pause is the agent's, and only then the owner's (#1412/#1422)", () => {
	it("with the host's login stored: the runner gets it as named secrets in ONE request, no macro runs, the owner is not alerted, the run is read back", async () => {
		await store();
		const run = await pausedOnSignIn("lead-1412", "www.indeed.com");
		answers["/local-apply/sign-in-secrets"] = signingIn(["PAGS_LOGIN_USERNAME", "PAGS_LOGIN_PASSWORD"]);
		await syncApplyRun(env(), "u1", run, Date.now());
		expect(sent.filter((s) => s.path === "/local-apply/sign-in-secrets").map((s) => s.body)).toEqual([{ runId: run.id, secrets: { PAGS_LOGIN_USERNAME: USERNAME, PAGS_LOGIN_PASSWORD: PASSWORD } }]);
		expect(sent.some((s) => s.path === "/local-apply/vault-sign-in" || s.path === "/local-apply/email-code" || s.path === "/local-apply/handoff")).toBe(false);
		expect(await alerts()).toBe(0);
		expect(await agentRow(run.id)).toEqual({ state: "signing_in", host: "www.indeed.com", failure: null });
		// The run was read back right after provisioning — and that read-back did not provision again.
		expect(sent.filter((s) => s.path === "/local-apply/status").length).toBeGreaterThanOrEqual(2);
		const shown = JSON.stringify((await call("GET", `/ap/application-runs/${run.id}`)).body) + JSON.stringify((await d1.DB.prepare("SELECT * FROM notifications").all()).results);
		expect(shown).not.toContain(PASSWORD);
		expect(shown).toContain("PAGS_LOGIN_PASSWORD");
	});

	it("the runner's signed_in event, read on a later sync, settles the sign-in", async () => {
		await store();
		const run = await pausedOnSignIn("lead-1412-done", "www.indeed.com");
		answers["/local-apply/sign-in-secrets"] = signingIn(["PAGS_LOGIN_USERNAME", "PAGS_LOGIN_PASSWORD"]);
		const synced = await syncApplyRun(env(), "u1", run, Date.now());
		answers["/local-apply/status"] = { status: 200, body: { state: "running", lastSeq: 3, events: [{ type: "policy.decision", at: new Date().toISOString(), seq: 3, domain: "www.indeed.com", detail: { tool: "agent_sign_in", class: "session", decision: "signed_in", site: "indeed.com" } }] } };
		await syncApplyRun(env(), "u1", synced, Date.now() + 5000);
		expect(await agentRow(run.id)).toMatchObject({ state: "signed_in" });
		expect(await alerts()).toBe(0);
	});

	it("a runner that does not know the route (#1422: no macro left to fall back to): the attempt is recorded and the owner is alerted", async () => {
		await store();
		const run = await pausedOnSignIn("lead-1412-old", "www.indeed.com");
		// No "/local-apply/sign-in-secrets" answer stubbed: the relay's default 404 stands in for an older runner.
		answers["/local-apply/handoff"] = { status: 200, body: { handoffId: "x", runId: run.id, applicationId: "lead-1412-old", browserProfile: "isolated", state: "ready", expiresAt: "2026-10-11T01:00:00.000Z" } };
		await syncApplyRun(env(), "u1", run, Date.now());
		expect(sent.some((s) => s.path === "/local-apply/sign-in-secrets")).toBe(true);
		expect(await agentRow(run.id)).toMatchObject({ state: "failed", failure: "runner_outdated" });
		expect(await alerts()).toBe(1);
	});

	it("nothing to hand over (no stored login, not a SEEK code site): straight to the owner", async () => {
		const run = await pausedOnSignIn("lead-1412-none", "www.indeed.com");
		answers["/local-apply/handoff"] = { status: 200, body: { handoffId: "x", runId: run.id, applicationId: "lead-1412-none", browserProfile: "isolated", state: "ready", expiresAt: "2026-10-11T01:00:00.000Z" } };
		await syncApplyRun(env(), "u1", run, Date.now());
		expect(sent.some((s) => s.path === "/local-apply/sign-in-secrets")).toBe(false);
		expect(await agentRow(run.id)).toBeNull();
		expect(await alerts()).toBe(1);
	});
});
