/**
 * #1412: a fill paused `login_required` is signed in by the agent itself, with the login handed to the runner as
 * NAMED secrets. The cloud half, over the real schema and the REAL vault (a credential encrypted with a key and
 * read back by `findCredentialForHost`); only the runner (the relay to `pags up`) and the mailbox are faked.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../types.js";
import { createCredential, findCredentialForHost, passwordLoginForHost } from "../credentials.js";
import { type RealSchemaD1, realSchemaD1, seedTenant } from "../d1-sqlite.js";
import { type AgentSignInDeps, advanceAgentSignIn, agentSignInApplies, agentSignInWillTry, parseRunnerSignIn, senderQuery, signedInEventIn, signInCodeIn } from "./agent-sign-in.js";
import { type ApplyRun, type ApplyTraceEvent, getApplyRun } from "./store.js";

const UID = "u1";
const INSTANCE = "runner-1";
const RUN = "run-1";
const KEK = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const USERNAME = "serge.pro.job@gmail.com";
const PASSWORD = "Tr0ub4dor&3-vault-secret";
const JOB_MAILBOX = "serge.pro.job@gmail.com";
const T0 = Date.parse("2026-11-02T08:00:00Z");
const INDEED_PAUSE = { reason: "login_required", domain: "secure.indeed.com", url: "https://secure.indeed.com/auth", question: "Sign in to indeed.com in this browser." };
const SEEK_PAUSE = { reason: "login_required", domain: "login.seek.com", url: "https://login.seek.com/login", question: "Sign in to seek.com in this browser." };
const CODE_MAIL = { id: "msg-new", date: new Date(T0 + 40_000).toUTCString(), subject: "Your SEEK sign in code", text: "Hi Serge, your sign in code is 482913. It expires in 10 minutes." };
const STALE_MAIL = { id: "msg-old", date: new Date(T0 - 3_600_000).toUTCString(), subject: "Your SEEK sign in code", text: "Your sign in code is 111111." };
const SIGNED_IN: ApplyTraceEvent = { type: "policy.decision", at: new Date(T0).toISOString(), domain: "login.seek.com", detail: { tool: "agent_sign_in", class: "session", decision: "signed_in", site: "seek.com" } };

let d1: RealSchemaD1;
let emailPermission: boolean;
const env = () => ({ DB: d1.DB, KEY_ENCRYPTION_KEY: KEK, AGENT: { idFromName: (n: string) => n, get: () => ({ fetch: async () => Response.json({ permissions: { email: emailPermission } }) }) } }) as unknown as Env;

const running = (secrets: string[], codeRequested = false) => ({ signIn: { state: "signing_in", origin: "login.seek.com", secrets, codeRequested } });

/** A fake runner that records every request, and a fake mailbox of SEEK mail. */
function fakes(opts: { answer?: unknown; status?: number; mail?: Array<{ id: string; date: string; subject: string; text: string }> } = {}) {
	const sent: Array<{ path: string; body: Record<string, unknown> }> = [];
	const read: string[] = [];
	const mail = opts.mail ?? [];
	const deps: AgentSignInDeps = {
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
const insertRun = (id: string, pause: object) =>
	d1.exec(
		`INSERT INTO local_apply_runs (id, instance_id, user_id, application_id, request_id, status, policy, pause, created_at, updated_at)
		 VALUES ('${id}', '${INSTANCE}', '${UID}', 'app-${id}', 'req-${id}', 'paused', '{}', '${JSON.stringify(pause)}', ${T0}, ${T0})`,
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
		expect(parseRunnerSignIn(running(["PAGS_LOGIN_USERNAME"], true).signIn)).toEqual({ origin: "login.seek.com", secrets: ["PAGS_LOGIN_USERNAME"], codeRequested: true });
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
