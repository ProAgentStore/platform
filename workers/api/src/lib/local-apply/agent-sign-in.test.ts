/**
 * #1412: a fill paused `login_required` is signed in by the agent itself, with the login handed to the runner as
 * NAMED secrets. The cloud half, over the real schema and the REAL vault (a credential encrypted with a key and
 * read back by `findCredentialForHost`); only the runner (the relay to `pags up`) and the mailbox are faked.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../types.js";
import { createCredential, findCredentialForHost, listCredentials, passwordLoginForHost } from "../credentials.js";
import { type RealSchemaD1, realSchemaD1, seedTenant } from "../d1-sqlite.js";
import { type AgentSignInDeps, advanceAgentSignIn, agentSignInApplies, agentSignInWillTry, failExpiredCodeWaits, parseRunnerSignIn, mailLinkIn, senderQuery, signedInEventIn, signInCodeIn } from "./agent-sign-in.js";
import { type ApplyRun, type ApplyTraceEvent, getApplyRun } from "./store.js";

const UID = "u1";
const INSTANCE = "runner-1";
const RUN = "run-1";
const KEK = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const USERNAME = "owner@example.com";
const PASSWORD = "Tr0ub4dor&3-vault-secret";
const JOB_MAILBOX = "owner@example.com";
const T0 = Date.parse("2026-11-02T08:00:00Z");
const INDEED_PAUSE = { reason: "login_required", domain: "secure.indeed.com", url: "https://secure.indeed.com/auth", question: "Sign in to indeed.com in this browser." };
const SEEK_PAUSE = { reason: "login_required", domain: "login.seek.com", url: "https://login.seek.com/login", question: "Sign in to seek.com in this browser." };
const CODE_MAIL = { id: "msg-new", date: new Date(T0 + 40_000).toUTCString(), subject: "Your SEEK sign in code", text: "Hi Owner, your sign in code is 482913. It expires in 10 minutes." };
const STALE_MAIL = { id: "msg-old", date: new Date(T0 - 3_600_000).toUTCString(), subject: "Your SEEK sign in code", text: "Your sign in code is 111111." };
const SIGNED_IN: ApplyTraceEvent = { type: "policy.decision", at: new Date(T0).toISOString(), domain: "login.seek.com", detail: { tool: "agent_sign_in", class: "session", decision: "signed_in", site: "seek.com" } };

let d1: RealSchemaD1;
let emailPermission: boolean;
const env = () => ({ DB: d1.DB, KEY_ENCRYPTION_KEY: KEK, AGENT: { idFromName: (n: string) => n, get: () => ({ fetch: async () => Response.json({ permissions: { email: emailPermission } }) }) } }) as unknown as Env;

const running = (secrets: string[], codeRequested = false, more: { newPasswordRequested?: boolean; linkRequested?: boolean } = {}) => ({ signIn: { state: "signing_in", origin: "login.seek.com", secrets, codeRequested, ...more } });

/** A fake runner that records every request, and a fake mailbox of SEEK mail. */
function fakes(opts: { answer?: unknown; status?: number; mail?: Array<{ id: string; date: string; subject: string; text: string }> } = {}) {
	const sent: Array<{ path: string; body: Record<string, unknown> }> = [];
	const read: string[] = [];
	const mail = opts.mail ?? [];
	const deps: AgentSignInDeps = {
		identity: async () => (emailPermission ? JOB_MAILBOX : null),
		credential: (host) => findCredentialForHost(env(), INSTANCE, UID, host),
		hasCredential: async (host) => (await passwordLoginForHost(env(), INSTANCE, UID, host)) !== null,
		runner: async (path, body) => {
			sent.push({ path, body: body as Record<string, unknown> });
			if (opts.answer === null) return null;
			const names = Object.keys(((body as { secrets?: Record<string, string> }).secrets ?? {}) as object);
			return { status: opts.status ?? 200, body: opts.answer ?? running(names) };
		},
		mailbox: async () => ({
			list: async () => mail.map(({ id, date }) => ({ id, date })),
			read: async (id) => {
				read.push(id);
				const m = mail.find((x) => x.id === id) as (typeof mail)[number];
				return { subject: m.subject, text: m.text };
			},
		}),
	};
	return { deps, sent, read };
}

const run = async (id = RUN): Promise<ApplyRun> => (await getApplyRun(env(), INSTANCE, UID, id)) as ApplyRun;
const row = (id = RUN) => d1.DB.prepare("SELECT * FROM local_apply_agent_sign_ins WHERE run_id = ?1").bind(id).first<Record<string, unknown>>();
const insertRun = (id: string, pause: object, policy: object = {}) =>
	d1.exec(
		`INSERT INTO local_apply_runs (id, instance_id, user_id, application_id, request_id, status, policy, pause, created_at, updated_at)
		 VALUES ('${id}', '${INSTANCE}', '${UID}', 'app-${id}', 'req-${id}', 'paused', '${JSON.stringify(policy)}', '${JSON.stringify(pause)}', ${T0}, ${T0})`,
	);
const setRunning = (id = RUN) => d1.exec(`UPDATE local_apply_runs SET status = 'running', pause = NULL WHERE id = '${id}'`);
const store = () => createCredential(env(), INSTANCE, UID, { domain: "indeed.com", username: USERNAME, password: PASSWORD } as Parameters<typeof createCredential>[3]);
const none = { signIn: null, events: [] as ApplyTraceEvent[] };

/** Every row of every table EXCEPT the vault itself (which holds the username in clear and the password encrypted), as one string. */
function dumpD1(): string {
	const tables = (d1.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name <> 'agent_credentials'").all() as Array<{ name: string }>).map((t) => t.name);
	return tables.map((t) => JSON.stringify(d1.sqlite.prepare(`SELECT * FROM "${t}"`).all())).join("\n");
}

beforeEach(() => {
	d1 = realSchemaD1();
	emailPermission = true;
	seedTenant(d1, { userId: UID, instanceIds: [INSTANCE] });
	d1.exec(`UPDATE agent_instances SET config = '{"connectorAccounts":{"gmail":"${JOB_MAILBOX}"}}' WHERE id = '${INSTANCE}'`);
	d1.exec(`INSERT INTO user_api_keys (user_id, provider, account_id, account_label, key_ciphertext, dek_wrapped, iv, granted_scopes) VALUES ('${UID}', 'gmail', '${JOB_MAILBOX}', '${JOB_MAILBOX}', x'00', x'00', x'00', 'https://www.googleapis.com/auth/gmail.readonly')`);
});
afterEach(() => d1.close());

describe("the agent-driven sign-in (#1412 acceptance)", () => {
	it("a vault login: the names and values reach the runner in ONE request, the row and trace carry names only, the use is logged", async () => {
		insertRun(RUN, INDEED_PAUSE);
		const id = await store();
		const f = fakes();
		const out = await advanceAgentSignIn(env(), UID, await run(), { signInEmail: null }, none, T0, f.deps);
		expect(out.outcome).toBe("provisioned");
		expect(f.sent).toEqual([{ path: "/local-apply/sign-in-secrets", body: { runId: RUN, secrets: { PAGS_LOGIN_USERNAME: USERNAME, PAGS_LOGIN_PASSWORD: PASSWORD } } }]);
		expect(await row()).toMatchObject({ state: "signing_in", host: "secure.indeed.com", credential_id: id, failure: null });
		const trace = (await run()).trace;
		expect(trace).toHaveLength(1);
		expect(trace[0].detail).toMatchObject({ tool: "agent_sign_in", class: "session", source: "platform", decision: "provisioned", reason: "PAGS_LOGIN_USERNAME,PAGS_LOGIN_PASSWORD", basis: "vault" });
		const events = (await d1.DB.prepare("SELECT context FROM agent_events WHERE event = 'credential.use'").all<{ context: string }>()).results ?? [];
		expect(events).toHaveLength(1);
		expect(JSON.parse(events[0].context)).toMatchObject({ host: "secure.indeed.com", credentialId: id, runId: RUN, via: "local_apply_agent", outcome: "provisioned" });
		expect(JSON.stringify(trace) + dumpD1()).not.toContain(PASSWORD);
		// A second sync does not provision again — neither while the release is landing nor once the run is running.
		expect((await advanceAgentSignIn(env(), UID, await run(), { signInEmail: null }, none, T0 + 1000, f.deps)).outcome).toBe("waiting");
		setRunning();
		const again = await advanceAgentSignIn(env(), UID, await run(), { signInEmail: null }, none, T0 + 1000, f.deps);
		expect(again.outcome).toBe("waiting");
		expect(f.sent).toHaveLength(1);
	});

	it("SEEK with no stored login: the account address goes as PAGS_LOGIN_USERNAME when email access is on, and nothing at all when it is off", async () => {
		insertRun(RUN, SEEK_PAUSE);
		emailPermission = false;
		const off = fakes();
		expect((await advanceAgentSignIn(env(), UID, await run(), { signInEmail: JOB_MAILBOX }, none, T0, off.deps)).outcome).toBe("not_applicable");
		expect(off.sent).toEqual([]);
		expect(await row()).toBeNull();
		emailPermission = true;
		expect((await advanceAgentSignIn(env(), UID, await run(), { signInEmail: null }, none, T0, off.deps)).outcome).toBe("not_applicable");
		const on = fakes();
		expect((await advanceAgentSignIn(env(), UID, await run(), { signInEmail: JOB_MAILBOX }, none, T0, on.deps)).outcome).toBe("provisioned");
		expect(on.sent).toEqual([{ path: "/local-apply/sign-in-secrets", body: { runId: RUN, secrets: { PAGS_LOGIN_USERNAME: JOB_MAILBOX } } }]);
		expect((await run()).trace[0].detail).toMatchObject({ decision: "provisioned", reason: "PAGS_LOGIN_USERNAME", basis: "sign_in_email" });
	});

	it("the emailed code: when the runner says the CLI asked, the newest code mail after the request is read once and provisioned as PAGS_LOGIN_CODE — never kept", async () => {
		insertRun(RUN, SEEK_PAUSE);
		const f = fakes({ mail: [CODE_MAIL, STALE_MAIL] });
		await advanceAgentSignIn(env(), UID, await run(), { signInEmail: JOB_MAILBOX }, none, T0, f.deps);
		setRunning();
		const asked = await advanceAgentSignIn(env(), UID, await run(), { signInEmail: null }, { signIn: parseRunnerSignIn(running(["PAGS_LOGIN_USERNAME"], true).signIn), events: [] }, T0 + 30_000, f.deps);
		expect(asked.outcome).toBe("waiting");
		expect(f.sent[1]).toEqual({ path: "/local-apply/sign-in-secrets", body: { runId: RUN, secrets: { PAGS_LOGIN_CODE: "482913" } } });
		expect(f.read).toEqual(["msg-new"]);
		expect(await row()).toMatchObject({ state: "signing_in", code_requested_at: T0 + 30_000, code_message_id: "msg-new" });
		const trace = (await run()).trace;
		expect(trace.map((e) => e.detail?.decision)).toEqual(["provisioned", "code_requested", "code_read"]);
		expect(trace[2].detail).toMatchObject({ tool: "agent_sign_in", mailbox: JOB_MAILBOX, messageId: "msg-new" });
		expect(JSON.stringify(trace) + dumpD1()).not.toContain("482913");
		// The runner still says the code is wanted (the CLI has not typed it yet): nothing is read twice.
		const again = await advanceAgentSignIn(env(), UID, await run(), { signInEmail: null }, { signIn: parseRunnerSignIn(running(["PAGS_LOGIN_USERNAME", "PAGS_LOGIN_CODE"], true).signIn), events: [] }, T0 + 60_000, f.deps);
		expect(again.outcome).toBe("waiting");
		expect(f.sent).toHaveLength(2);
		expect(f.read).toEqual(["msg-new"]);
	});

	it("no code mail within the wait fails it with its reason; email access off fails it at once", async () => {
		insertRun(RUN, SEEK_PAUSE);
		const f = fakes({ mail: [STALE_MAIL] });
		await advanceAgentSignIn(env(), UID, await run(), { signInEmail: JOB_MAILBOX }, none, T0, f.deps);
		setRunning();
		const want = { signIn: parseRunnerSignIn(running(["PAGS_LOGIN_USERNAME"], true).signIn), events: [] };
		expect((await advanceAgentSignIn(env(), UID, await run(), { signInEmail: null }, want, T0 + 30_000, f.deps)).outcome).toBe("waiting");
		const late = await advanceAgentSignIn(env(), UID, await run(), { signInEmail: null }, want, T0 + 30_000 + 5 * 60_000 + 1, f.deps);
		expect(late.outcome).toBe("failed");
		expect(await row()).toMatchObject({ state: "failed", failure: "code_not_received" });
		expect(f.sent).toHaveLength(1);

		insertRun("run-2", SEEK_PAUSE);
		const g = fakes({ mail: [CODE_MAIL] });
		await advanceAgentSignIn(env(), UID, await run("run-2"), { signInEmail: JOB_MAILBOX }, none, T0, g.deps);
		setRunning("run-2");
		emailPermission = false;
		expect((await advanceAgentSignIn(env(), UID, await run("run-2"), { signInEmail: null }, want, T0 + 30_000, g.deps)).outcome).toBe("failed");
		expect(await row("run-2")).toMatchObject({ state: "failed", failure: "email_not_permitted" });
	});

	it("the runner's own signed_in event settles the row; a wall again while the sign-in was the agent's fails it, once", async () => {
		insertRun(RUN, INDEED_PAUSE);
		await store();
		const f = fakes();
		await advanceAgentSignIn(env(), UID, await run(), { signInEmail: null }, none, T0, f.deps);
		setRunning();
		const done = await advanceAgentSignIn(env(), UID, await run(), { signInEmail: null }, { signIn: null, events: [SIGNED_IN] }, T0 + 20_000, f.deps);
		expect(done.outcome).toBe("signed_in");
		expect(await row()).toMatchObject({ state: "signed_in" });
		expect((await run()).trace.map((e) => e.detail?.decision)).toEqual(["provisioned", "signed_in"]);
		expect((await advanceAgentSignIn(env(), UID, await run(), { signInEmail: null }, none, T0 + 30_000, f.deps)).outcome).toBe("not_applicable");

		insertRun("run-2", INDEED_PAUSE);
		const g = fakes();
		await advanceAgentSignIn(env(), UID, await run("run-2"), { signInEmail: null }, none, T0, g.deps);
		// Still paused at the wall well after the release landed: the agent did not get in.
		const wall = await advanceAgentSignIn(env(), UID, await run("run-2"), { signInEmail: null }, none, T0 + 60_000, g.deps);
		expect(wall.outcome).toBe("failed");
		expect(await row("run-2")).toMatchObject({ state: "failed", failure: "not_signed_in" });
		expect((await run("run-2")).trace.at(-1)?.detail).toMatchObject({ decision: "failed", rule: "not_signed_in" });
		expect((await advanceAgentSignIn(env(), UID, await run("run-2"), { signInEmail: null }, none, T0 + 40_000, g.deps)).outcome).toBe("not_applicable");
		expect(g.sent).toHaveLength(1);
	});

	it("an older runner that does not know the route records the attempt and fails it (#1422: no macro left to step aside for)", async () => {
		insertRun(RUN, INDEED_PAUSE);
		await store();
		const f = fakes({ status: 404, answer: { error: "no such route" } });
		expect((await advanceAgentSignIn(env(), UID, await run(), { signInEmail: null }, none, T0, f.deps)).outcome).toBe("failed");
		expect(await row()).toMatchObject({ state: "failed", failure: "runner_outdated" });
		expect((await run()).trace.at(-1)?.detail).toMatchObject({ decision: "failed", rule: "runner_outdated" });
		expect((await advanceAgentSignIn(env(), UID, await run(), { signInEmail: null }, none, T0 + 1000, f.deps)).outcome).toBe("not_applicable");
		expect(f.sent).toHaveLength(1);
		const gone = fakes({ answer: null });
		insertRun("run-2", INDEED_PAUSE);
		expect((await advanceAgentSignIn(env(), UID, await run("run-2"), { signInEmail: null }, none, T0, gone.deps)).outcome).toBe("failed");
		expect(await row("run-2")).toMatchObject({ state: "failed", failure: "runner_unavailable" });
	});

	it.each([
		[409, { code: "sign_in_secrets_unavailable", error: PASSWORD }, "sign_in_secrets_unavailable"],
		[409, { error: "This run's browser cannot take secret placeholders" }, "sign_in_secrets_unavailable"],
		[409, { code: "sign_in_not_at_wall", error: PASSWORD }, "not_at_wall"],
		[409, { error: "The run is not paused for a sign-in" }, "not_at_wall"],
		[409, { error: PASSWORD }, "sign_in_rejected"],
		[500, { error: PASSWORD }, "sign_in_rejected"],
		[200, { unexpected: PASSWORD }, "sign_in_rejected"],
	])("classifies sign-in refusal %s %j without persisting runner text", async (status, answer, failure) => {
		insertRun(RUN, SEEK_PAUSE);
		const f = fakes({ status, answer });
		const result = await advanceAgentSignIn(env(), UID, await run(), { signInEmail: JOB_MAILBOX }, none, T0, f.deps);
		expect(result.outcome).toBe("failed");
		expect(await row()).toMatchObject({ state: "failed", failure });
		expect((await run()).trace.at(-1)?.detail).toMatchObject({ decision: "failed", rule: failure });
		expect((await run()).status).toBe("paused");
		expect(dumpD1()).not.toContain(PASSWORD);
		await advanceAgentSignIn(env(), UID, await run(), { signInEmail: JOB_MAILBOX }, none, T0 + 1000, f.deps);
		expect(f.sent).toHaveLength(1);
	});

	it("agentSignInWillTry answers from the vault's presence and the SEEK address without reading the vault", async () => {
		insertRun(RUN, INDEED_PAUSE);
		const f = fakes();
		expect(await agentSignInWillTry(env(), UID, await run(), { signInEmail: null }, f.deps)).toBe(false);
		const id = await store();
		expect(await agentSignInWillTry(env(), UID, await run(), { signInEmail: null }, f.deps)).toBe(true);
		const cred = await d1.DB.prepare("SELECT last_used_at FROM agent_credentials WHERE id = ?1").bind(id).first<{ last_used_at: string | null }>();
		expect(cred?.last_used_at).toBeNull();
		insertRun("run-2", SEEK_PAUSE);
		expect(await agentSignInWillTry(env(), UID, await run("run-2"), { signInEmail: JOB_MAILBOX }, f.deps)).toBe(true);
		emailPermission = false;
		expect(await agentSignInWillTry(env(), UID, await run("run-2"), { signInEmail: JOB_MAILBOX }, f.deps)).toBe(false);
		expect(f.sent).toEqual([]);
	});

	it("the pure pieces: the gate, the status parser, the signed-in event and the sender query", () => {
		expect(agentSignInApplies({ status: "paused", pause: INDEED_PAUSE as ApplyRun["pause"] })).toBe(true);
		expect(agentSignInApplies({ status: "running", pause: null })).toBe(false);
		expect(agentSignInApplies({ status: "paused", pause: { reason: "captcha" } as ApplyRun["pause"] })).toBe(false);
		expect(parseRunnerSignIn(running(["PAGS_LOGIN_USERNAME"], true).signIn)).toEqual({ origin: "login.seek.com", secrets: ["PAGS_LOGIN_USERNAME"], codeRequested: true, newPasswordRequested: false, linkRequested: false });
		expect(parseRunnerSignIn({ state: "other" })).toBeNull();
		expect(parseRunnerSignIn(undefined)).toBeNull();
		expect(signedInEventIn([SIGNED_IN])).toBe(true);
		expect(signedInEventIn([{ ...SIGNED_IN, detail: { tool: "agent_sign_in", decision: "provisioned" } }])).toBe(false);
		expect(senderQuery("login.seek.com")).toBe("from:(seek.com.au OR seek.com OR seek.co.nz)");
		expect(senderQuery("secure.indeed.com")).toBe("from:indeed.com");
	});
});

describe("signInCodeIn", () => {
	it("reads a code named as one, either way round", () => {
		expect(signInCodeIn("Your SEEK sign in code", "Your sign in code is 482913.")).toBe("482913");
		expect(signInCodeIn("482913 is your SEEK sign in code", "")).toBe("482913");
	});
	it("never takes a job id or a salary for a code", () => {
		expect(signInCodeIn("20 new jobs for Software Developer", "Job 95289924 pays $120000")).toBeNull();
	});
});

describe("failExpiredCodeWaits — the 5-minute wait evaluated independently of any runner sync (#1467)", () => {
	/** Provision, then move the sign-in into "waiting on a code" exactly as the reactive test above does — up to and including the moment `code_requested_at` is set — but never call `advanceAgentSignIn` again: the live gap was a runner that stopped syncing, not one that synced and got a wrong answer. */
	const requestCode = async (f: ReturnType<typeof fakes>) => {
		insertRun(RUN, SEEK_PAUSE);
		await advanceAgentSignIn(env(), UID, await run(), { signInEmail: JOB_MAILBOX }, none, T0, f.deps);
		setRunning();
		const want = { signIn: parseRunnerSignIn(running(["PAGS_LOGIN_USERNAME"], true).signIn), events: [] };
		await advanceAgentSignIn(env(), UID, await run(), { signInEmail: null }, want, T0 + 30_000, f.deps);
	};

	it("marks a code wait that elapsed with the runner never syncing again, and writes the same trace event advanceAgentSignIn would have", async () => {
		const f = fakes({ mail: [STALE_MAIL] });
		await requestCode(f);
		expect(await row()).toMatchObject({ state: "signing_in", failure: null });

		expect(await failExpiredCodeWaits(env(), T0 + 30_000 + 5 * 60_000 + 1)).toBe(1);
		expect(await row()).toMatchObject({ state: "failed", failure: "code_not_received" });
		expect((await run()).trace.at(-1)?.detail).toMatchObject({ decision: "failed", rule: "code_not_received" });
		// Only the original provisioning call ever reached the runner — the sweep never resends or retries anything.
		expect(f.sent).toHaveLength(1);
	});

	it("leaves a code wait alone while it is still within its five minutes", async () => {
		const f = fakes({ mail: [STALE_MAIL] });
		await requestCode(f);
		expect(await failExpiredCodeWaits(env(), T0 + 30_000 + 5 * 60_000 - 1)).toBe(0);
		expect(await row()).toMatchObject({ state: "signing_in" });
	});

	it("leaves a sign-in alone once its code already arrived — nothing to time out", async () => {
		const f = fakes({ mail: [CODE_MAIL] });
		await requestCode(f);
		expect(await row()).toMatchObject({ state: "signing_in", code_message_id: "msg-new" });
		expect(await failExpiredCodeWaits(env(), T0 + 30_000 + 5 * 60_000 + 1)).toBe(0);
		expect(await row()).toMatchObject({ state: "signing_in" });
	});

	it("is idempotent — a second sweep over an already-settled row changes nothing further", async () => {
		const f = fakes({ mail: [STALE_MAIL] });
		await requestCode(f);
		const deadline = T0 + 30_000 + 5 * 60_000 + 1;
		expect(await failExpiredCodeWaits(env(), deadline)).toBe(1);
		expect(await failExpiredCodeWaits(env(), deadline + 60_000)).toBe(0);
		expect((await run()).trace.filter((e) => (e.detail as { rule?: string })?.rule === "code_not_received")).toHaveLength(1);
	});

	it("never touches a run with no sign-in row at all", async () => {
		expect(await failExpiredCodeWaits(env(), T0 + 10 * 60_000)).toBe(0);
	});
});

describe("account registration and password reset by the agent (#1619)", () => {
	const AUTH = { accountOperations: true };
	const ATS_PAUSE = { reason: "login_required", domain: "careers.ats-fixture.test", url: "https://careers.ats-fixture.test/signin", question: "Sign in." };
	const ask = (more: { newPasswordRequested?: boolean; linkRequested?: boolean; codeRequested?: boolean }) => ({ signIn: parseRunnerSignIn({ state: "signing_in", origin: ATS_PAUSE.domain, secrets: ["PAGS_LOGIN_USERNAME"], codeRequested: more.codeRequested === true, ...more }), events: [] as ApplyTraceEvent[] });
	const advance = (t: number, sync: Parameters<typeof advanceAgentSignIn>[4], f: ReturnType<typeof fakes>) => run().then((r) => advanceAgentSignIn(env(), UID, r, { signInEmail: null }, sync, t, f.deps));
	const ATS_SIGNED_IN: ApplyTraceEvent = { type: "policy.decision", at: new Date(T0).toISOString(), detail: { tool: "agent_sign_in", class: "session", decision: "signed_in", basis: "model_observed" } };
	const RESET_MAIL = { id: "reset-1", date: new Date(T0 + 40_000).toUTCString(), subject: "Reset your password", text: '<a href="https://www.ats-fixture.test/account/reset?token=abcdef0123456789abcdef">Reset</a> <a href="https://www.ats-fixture.test/help">Help</a> <a href="https://tracker.other.test/reset?token=zzzzzzzzzzzzzzzzzzzz">x</a>' };
	const LINK = "https://www.ats-fixture.test/account/reset?token=abcdef0123456789abcdef";

	it("no saved login and the run is authorized: the broker answers at once with the Profile address and no password", async () => {
		insertRun(RUN, ATS_PAUSE, AUTH);
		const f = fakes();
		expect((await advance(T0, none, f)).outcome).toBe("provisioned");
		expect(f.sent).toEqual([{ path: "/local-apply/sign-in-secrets", body: { runId: RUN, secrets: { PAGS_LOGIN_USERNAME: JOB_MAILBOX } } }]);
		expect((await run()).trace[0].detail).toMatchObject({ decision: "provisioned", reason: "PAGS_LOGIN_USERNAME", basis: "account_operations" });
		expect(await agentSignInWillTry(env(), UID, await run(), { signInEmail: null }, f.deps)).toBe(true);
	});

	it("authorization is the run's frozen policy: a run without it, or with email off or no identity, is left to the owner", async () => {
		insertRun(RUN, ATS_PAUSE);
		const f = fakes();
		expect((await advance(T0, none, f)).outcome).toBe("not_applicable");
		insertRun("run-2", ATS_PAUSE, AUTH);
		emailPermission = false;
		expect((await advance(T0, none, f).then(() => run("run-2")).then((r) => advanceAgentSignIn(env(), UID, r, { signInEmail: null }, none, T0, f.deps))).outcome).toBe("not_applicable");
		expect(f.sent).toEqual([]);
		// Even if a runner claims the agent asked, an unauthorized run issues no password and reads no link.
		emailPermission = true;
		insertRun("run-3", ATS_PAUSE);
		await store();
		const g = fakes({ mail: [RESET_MAIL] });
		await advanceAgentSignIn(env(), UID, await run("run-3"), { signInEmail: null }, none, T0, g.deps);
		d1.exec("UPDATE local_apply_runs SET status = 'running', pause = NULL WHERE id = 'run-3'");
		await advanceAgentSignIn(env(), UID, await run("run-3"), { signInEmail: null }, ask({ newPasswordRequested: true, linkRequested: true }), T0 + 30_000, g.deps);
		expect(g.sent).toHaveLength(0);
	});

	it("registration: a generated password is held pending (never used to sign in), issued once, and confirmed into the vault when the agent reports signed in", async () => {
		insertRun(RUN, ATS_PAUSE, AUTH);
		const f = fakes();
		await advance(T0, none, f);
		setRunning();
		expect((await advance(T0 + 10_000, ask({ newPasswordRequested: true }), f)).outcome).toBe("waiting");
		const issued = (f.sent[1].body.secrets as Record<string, string>).PAGS_NEW_PASSWORD;
		expect(issued).toHaveLength(15);
		expect(await findCredentialForHost(env(), INSTANCE, UID, ATS_PAUSE.domain)).toBeNull();
		const [pending] = await listCredentials(env(), INSTANCE, UID);
		expect(pending).toMatchObject({ domain: "careers.ats-fixture.test", username: JOB_MAILBOX });
		expect(await row()).toMatchObject({ pending_credential_id: pending.id, replaces_credential_id: null });
		// Asked again: no second password, no second account row.
		await advance(T0 + 20_000, ask({ newPasswordRequested: true }), f);
		expect(f.sent).toHaveLength(2);
		expect(await listCredentials(env(), INSTANCE, UID)).toHaveLength(1);

		const done = await advance(T0 + 60_000, { signIn: null, events: [ATS_SIGNED_IN] }, f);
		expect(done.outcome).toBe("signed_in");
		expect(await findCredentialForHost(env(), INSTANCE, UID, ATS_PAUSE.domain)).toMatchObject({ username: JOB_MAILBOX, password: issued });
		const trace = (await run()).trace;
		expect(trace.map((e) => e.detail?.decision)).toEqual(["provisioned", "new_password_issued", "signed_in", "credential_saved"]);
		expect(JSON.stringify(trace) + dumpD1()).not.toContain(issued);
	});

	it("#1422 acceptance: a pre-existing vault row for an unrelated host is untouched by a registration on another host", async () => {
		const unrelatedId = await createCredential(env(), INSTANCE, UID, { domain: "indeed.com", username: USERNAME, password: PASSWORD } as Parameters<typeof createCredential>[3]);
		const before = await findCredentialForHost(env(), INSTANCE, UID, "indeed.com");

		insertRun(RUN, ATS_PAUSE, AUTH);
		const f = fakes();
		await advance(T0, none, f);
		setRunning();
		await advance(T0 + 10_000, ask({ newPasswordRequested: true }), f);
		await advance(T0 + 60_000, { signIn: null, events: [ATS_SIGNED_IN] }, f);

		const after = await findCredentialForHost(env(), INSTANCE, UID, "indeed.com");
		expect(after).toEqual(before);
		const rows = await listCredentials(env(), INSTANCE, UID);
		expect(rows.find((r) => r.id === unrelatedId)).toMatchObject({ domain: "indeed.com", username: USERNAME });
	});

	it("reset: the new password replaces the saved one on the same credential, keeping one row, only after the agent reports signed in", async () => {
		insertRun(RUN, ATS_PAUSE, AUTH);
		const old = await createCredential(env(), INSTANCE, UID, { domain: "ats-fixture.test", username: "me@example.test", password: "stale-password-1!" } as Parameters<typeof createCredential>[3]);
		const f = fakes();
		await advance(T0, none, f);
		expect(f.sent[0].body.secrets).toEqual({ PAGS_LOGIN_USERNAME: "me@example.test", PAGS_LOGIN_PASSWORD: "stale-password-1!" });
		setRunning();
		await advance(T0 + 10_000, ask({ newPasswordRequested: true }), f);
		const issued = (f.sent[1].body.secrets as Record<string, string>).PAGS_NEW_PASSWORD;
		expect(await row()).toMatchObject({ replaces_credential_id: old });
		// Not yet confirmed: the old password is still what signs in.
		expect((await findCredentialForHost(env(), INSTANCE, UID, ATS_PAUSE.domain))?.password).toBe("stale-password-1!");
		await advance(T0 + 60_000, { signIn: null, events: [ATS_SIGNED_IN] }, f);
		const rows = await listCredentials(env(), INSTANCE, UID);
		expect(rows.map((r) => r.id)).toEqual([old]);
		expect(await findCredentialForHost(env(), INSTANCE, UID, ATS_PAUSE.domain)).toMatchObject({ id: old, username: "me@example.test", password: issued });
		expect((await run()).trace.at(-1)?.detail).toMatchObject({ decision: "credential_saved", basis: "password_reset" });
	});

	it("a pending password left by an unfinished attempt is overwritten, not duplicated, and never signed in with", async () => {
		const left = await createCredential(env(), INSTANCE, UID, { domain: "ats-fixture.test", username: JOB_MAILBOX, password: "left-over-1!", provisional: true } as Parameters<typeof createCredential>[3]);
		insertRun(RUN, ATS_PAUSE, AUTH);
		const f = fakes();
		await advance(T0, none, f);
		setRunning();
		await advance(T0 + 10_000, ask({ newPasswordRequested: true }), f);
		expect((await listCredentials(env(), INSTANCE, UID)).map((r) => r.id)).toEqual([left]);
		expect(await row()).toMatchObject({ pending_credential_id: left, replaces_credential_id: null });
	});

	it("the reset link: the fresh same-site purpose link is sent to the runner once and never recorded; stale mail, other sites and plain links are ignored", async () => {
		insertRun(RUN, ATS_PAUSE, AUTH);
		const f = fakes({ mail: [RESET_MAIL, { ...CODE_MAIL, id: "old", date: new Date(T0 - 3_600_000).toUTCString(), text: "https://www.ats-fixture.test/reset?token=oldoldoldoldoldoldold" }] });
		await advance(T0, none, f);
		setRunning();
		expect((await advance(T0 + 30_000, ask({ linkRequested: true }), f)).outcome).toBe("waiting");
		expect(f.sent[1]).toEqual({ path: "/local-apply/sign-in-secrets", body: { runId: RUN, link: LINK } });
		expect(await row()).toMatchObject({ link_requested_at: T0 + 30_000, link_message_id: "reset-1" });
		await advance(T0 + 60_000, ask({ linkRequested: true }), f);
		expect(f.sent).toHaveLength(2);
		const trace = (await run()).trace;
		expect(trace.map((e) => e.detail?.decision)).toEqual(["provisioned", "link_requested", "link_read"]);
		expect(JSON.stringify(trace) + dumpD1()).not.toContain("abcdef0123456789");
		expect(mailLinkIn(RESET_MAIL.text, ATS_PAUSE.domain)).toBe(LINK);
		expect(mailLinkIn('<a href="https://www.ats-fixture.test/about">About</a>', ATS_PAUSE.domain)).toBeNull();
	});

	it("no link within five minutes fails with its reason", async () => {
		insertRun(RUN, ATS_PAUSE, AUTH);
		const f = fakes({ mail: [] });
		await advance(T0, none, f);
		setRunning();
		await advance(T0 + 30_000, ask({ linkRequested: true }), f);
		expect((await advance(T0 + 30_000 + 5 * 60_000 + 1, ask({ linkRequested: true }), f)).outcome).toBe("failed");
		expect(await row()).toMatchObject({ state: "failed", failure: "link_not_received" });
	});
});
