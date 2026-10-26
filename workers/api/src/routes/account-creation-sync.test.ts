/**
 * #1230 through the real sync path: a fill that pauses on a sign-in at an allow-listed site where the owner has NO stored login creates the account
 * (instead of alerting them to a sign-in there is nothing to sign in to), keeps the password in the vault from before the form is submitted, and
 * resumes the run; anywhere else, or when it cannot, the ordinary handoff happens (once). Real schema, routes, vault, profile, `syncApplyRun`
 * and Gmail gates; only the relay to `pags up` is faked. The state machine's edges are `local-apply/account-creation.test.ts`.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { realSchemaD1, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import { anyCredentialForHost, findCredentialForHost } from "../lib/credentials.js";
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
const env = () => ({ DB: d1.DB, RELAY: relay, AGENT: agentDO, KEY_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" }) as unknown as Env;

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

const PROFILE = "INSERT INTO user_profile (user_id, first_name, last_name) VALUES ('u1', 'Serge', 'Ivochkin')";
const PASSWORD_RE = /^[A-Za-z0-9!@#$%^&*\-_]{24}$/;

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
	answers["/local-apply/status"] = { status: 200, body: { state: "paused", lastSeq: 1, events: [], pause: { reason: "login_required", domain, url: `https://${domain}/auth`, question: `Sign in to ${domain} in this browser.` } } };
	return started.body.run;
}
const alerts = async () => (await d1.DB.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = 'u1' AND type = 'apply'").first<{ n: number }>())?.n ?? 0;
const handoff = (run: { id: string }, app: string) => ({ status: 200, body: { handoffId: "x", runId: run.id, applicationId: app, browserProfile: "isolated", state: "ready", expiresAt: "2026-10-11T01:00:00.000Z" } });

describe("a sign-in pause with no account creates one on an allow-listed site (#1230)", () => {
	beforeEach(() => {
		d1.exec(PROFILE);
	});

	it("with the setting on: prepare, the password is in the vault before submit, the account is created, the run is read back, the owner is not alerted", async () => {
		await call("PUT", "/ap/application-runner/settings", { accountCreation: true });
		const run = await pausedOnSignIn("lead-1230", "www.indeed.com");
		let atSubmit: unknown = "unset";
		answers["/local-apply/account-creation"] = { status: 200, body: { state: "prepared", needsPassword: true } };
		const realFetch = relay.get;
		relay.get = () => ({
			fetch: async (req: Request) => {
				const clone = req.clone();
				const cmd = (await clone.json()) as { path: string; body: string | Record<string, unknown> };
				const b = typeof cmd.body === "string" ? JSON.parse(cmd.body) : (cmd.body ?? {});
				if (cmd.path === "/local-apply/account-creation" && b.step === "submit") {
					atSubmit = await d1.DB.prepare("SELECT provisional FROM agent_credentials WHERE instance_id = 'ap'").first();
					answers["/local-apply/account-creation"] = { status: 200, body: { state: "created" } };
					// The runner has resumed the paused page, so its next status is "running".
					answers["/local-apply/status"] = { status: 200, body: { state: "running", lastSeq: 2, events: [] } };
				}
				return realFetch().fetch(req);
			},
		});
		try {
			await syncApplyRun(env(), "u1", run, Date.now());
		} finally {
			relay.get = realFetch;
		}
		const steps = sent.filter((s) => s.path === "/local-apply/account-creation").map((s) => s.body.step);
		expect(steps).toEqual(["prepare", "submit"]);
		expect(atSubmit).toMatchObject({ provisional: 1 });
		const submit = sent.filter((s) => s.path === "/local-apply/account-creation")[1].body;
		expect(String(submit.password)).toMatch(PASSWORD_RE);
		// Usable for this run at once, with the generated password and the pinned mailbox.
		expect(await findCredentialForHost(env(), "ap", "u1", "indeed.com")).toMatchObject({ username: JOB_MAILBOX, password: submit.password });
		expect(sent[sent.findIndex((s) => s.body.step === "prepare")].body.profile).toMatchObject({ firstName: "Serge", lastName: "Ivochkin", email: JOB_MAILBOX });
		expect(sent.some((s) => s.path === "/local-apply/handoff")).toBe(false);
		expect(await alerts()).toBe(0);
		expect(JSON.stringify((await call("GET", `/ap/application-runs/${run.id}`)).body)).not.toContain(String(submit.password));
	});

	it("a CAPTCHA falls back to the ordinary handoff, once, with the reason in the trace — and leaves no confirmed credential", async () => {
		await call("PUT", "/ap/application-runner/settings", { accountCreation: true });
		const run = await pausedOnSignIn("lead-1230-captcha", "www.indeed.com");
		answers["/local-apply/account-creation"] = { status: 200, body: { state: "failed", reason: "captcha" } };
		answers["/local-apply/handoff"] = handoff(run, "lead-1230-captcha");
		await syncApplyRun(env(), "u1", run, Date.now());
		await syncApplyRun(env(), "u1", (await call("GET", `/ap/application-runs/${run.id}`)).body.run, Date.now());
		expect(sent.filter((s) => s.path === "/local-apply/account-creation")).toHaveLength(1);
		expect(await alerts()).toBe(1);
		expect(JSON.stringify((await call("GET", `/ap/application-runs/${run.id}`)).body)).toContain("CAPTCHA");
		expect(await anyCredentialForHost(env(), "ap", "u1", "indeed.com")).toBeNull();
		const audit = ((await d1.DB.prepare("SELECT event FROM agent_events WHERE event LIKE 'credential.account_%'").all<{ event: string }>()).results ?? []).map((e) => e.event);
		expect(audit).toEqual(["credential.account_creation_started", "credential.account_creation_failed"]);
	});

	it("with the setting off (the default), a host that is not listed, or one that is listed but off: unchanged — alerted at once, the runner asked nothing", async () => {
		for (const [setting, domain] of [[false, "www.indeed.com"], [true, "example.com"], [true, "www.linkedin.com"]] as const) {
			sent = [];
			await call("PUT", "/ap/application-runner/settings", { accountCreation: setting });
			const id = `lead-1230-${domain}`;
			const run = await pausedOnSignIn(id, domain);
			answers["/local-apply/handoff"] = handoff(run, id);
			await syncApplyRun(env(), "u1", run, Date.now());
			expect(sent.some((s) => s.path === "/local-apply/account-creation")).toBe(false);
		}
		expect(await alerts()).toBe(3);
	});
});
