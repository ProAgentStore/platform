/**
 * #1230: a fill paused `login_required` on an allow-listed site where the owner has no account creates one, stores it in the vault and carries on.
 * The cloud half, over the real schema and the REAL vault; only the runner, the Gmail mailbox and the profile are faked.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../types.js";
import { anyCredentialForHost, createCredential, findCredentialForHost } from "../credentials.js";
import { type RealSchemaD1, realSchemaD1, seedTenant } from "../d1-sqlite.js";
import type { Profile } from "../profile.js";
import { type AccountCreationDeps, accountCreationApplies, accountCreationCanTry, advanceAccountCreation, generatePassword } from "./account-creation.js";
import { accountCreationHostFor } from "./account-creation-hosts.js";
import { type ApplyRun, getApplyRun } from "./store.js";

const UID = "u1";
const INSTANCE = "runner-1";
const RUN = "run-1";
const KEK = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const MAILBOX = "serge.pro.job@gmail.com";
const PASSWORD = "Gen3rated&Pa55word-for-the-test";
const NOW = Date.now();
const PAUSE = { reason: "login_required", domain: "secure.indeed.com", url: "https://secure.indeed.com/auth", question: "Sign in to indeed.com in this browser." };
const ON = { signInEmail: null as string | null, accountCreation: true };
const PROFILE = { firstName: "Serge", lastName: "Ivochkin", email: "other@example.com", phone: "0400 000 000", city: "Sydney", state: "NSW", linkedin: "https://linkedin.com/in/serge" } as unknown as Profile;

let d1: RealSchemaD1;
const env = () => ({ DB: d1.DB, KEY_ENCRYPTION_KEY: KEK }) as unknown as Env;

interface Script {
	prepare?: unknown;
	submit?: unknown;
	enter?: unknown;
	mail?: Array<{ id: string; date: string; subject: string; text: string }>;
	emailPermitted?: boolean;
	mailbox?: { ok: true; address: string } | { ok: false };
	profile?: Profile;
	runnerDown?: boolean;
}

function fakes(s: Script = {}) {
	const sent: Array<{ path: string; body: Record<string, unknown> }> = [];
	const atSubmit: { stored?: unknown; usable?: unknown } = {};
	const deps: AccountCreationDeps = {
		runner: async (path, body) => {
			const b = body as Record<string, unknown>;
			sent.push({ path, body: b });
			if (s.runnerDown) return null;
			if (b.step === "prepare") return { status: 200, body: s.prepare ?? { state: "prepared", needsPassword: true } };
			if (b.step === "submit") {
				// What the vault holds the instant the form is about to be submitted.
				atSubmit.stored = await d1.DB.prepare("SELECT provisional FROM agent_credentials WHERE domain = 'secure.indeed.com'").first();
				atSubmit.usable = await findCredentialForHost(env(), INSTANCE, UID, "secure.indeed.com");
				return { status: 200, body: s.submit ?? { state: "created" } };
			}
			return { status: 200, body: s.enter ?? { state: "created" } };
		},
		emailPermitted: async () => s.emailPermitted ?? true,
		mailboxAddress: async () => s.mailbox ?? { ok: true, address: MAILBOX },
		mailbox: async () => ({ list: async () => (s.mail ?? []).map(({ id, date }) => ({ id, date })), read: async (id) => (s.mail ?? []).find((m) => m.id === id) as { subject: string; text: string } }),
		profile: async () => s.profile ?? PROFILE,
		password: () => PASSWORD,
	};
	return { deps, sent, atSubmit };
}

const run = async (id = RUN): Promise<ApplyRun> => (await getApplyRun(env(), INSTANCE, UID, id)) as ApplyRun;
const row = () => d1.DB.prepare("SELECT * FROM local_apply_account_creations WHERE run_id = ?1").bind(RUN).first<Record<string, unknown>>();
const events = async (name: string) => ((await d1.DB.prepare("SELECT context, message FROM agent_events WHERE event = ?1").bind(name).all<{ context: string; message: string }>()).results ?? []).map((e) => ({ ...JSON.parse(e.context), message: e.message }));
const insertRun = (id: string, pause: object = PAUSE) =>
	d1.exec(
		`INSERT INTO local_apply_runs (id, instance_id, user_id, application_id, request_id, status, policy, pause, created_at, updated_at)
		 VALUES ('${id}', '${INSTANCE}', '${UID}', 'app-${id}', 'req-${id}', 'paused', '{}', '${JSON.stringify(pause)}', ${NOW}, ${NOW})`,
	);
function dumpD1(): string {
	const tables = (d1.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name <> 'agent_credentials'").all() as Array<{ name: string }>).map((t) => t.name);
	return tables.map((t) => JSON.stringify(d1.sqlite.prepare(`SELECT * FROM "${t}"`).all())).join("\n");
}
const go = async (f: ReturnType<typeof fakes>, at = NOW, settings = ON) => advanceAccountCreation(env(), UID, await run(), settings, at, f.deps);

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: UID, instanceIds: [INSTANCE] });
	insertRun(RUN);
});
afterEach(() => d1.close());

describe("the allow-list (#1230)", () => {
	it("a listed, enabled host applies; an unlisted host, a disabled host, and a setting that is off do not — they fall through to the handoff", async () => {
		const r = await run();
		expect(accountCreationApplies(r, ON)?.host).toBe("indeed.com");
		expect(accountCreationApplies(r, { ...ON, accountCreation: false })).toBeNull();
		expect(accountCreationApplies({ ...r, pause: { ...PAUSE, domain: "www.linkedin.com" } } as ApplyRun, ON)).toBeNull();
		expect(accountCreationApplies({ ...r, pause: { ...PAUSE, domain: "example.com" } } as ApplyRun, ON)).toBeNull();
		expect(accountCreationHostFor("notindeed.com")).toBeNull();
	});

	it("an unlisted host types nothing and writes nothing", async () => {
		d1.exec(`UPDATE local_apply_runs SET pause = '${JSON.stringify({ ...PAUSE, domain: "example.com" })}'`);
		const f = fakes();
		expect((await go(f)).outcome).toBe("not_applicable");
		expect(f.sent).toEqual([]);
		expect(await row()).toBeNull();
	});

	it("a SEEK pause with a sign-in email belongs to the email-code sign-in, not here", async () => {
		d1.exec(`UPDATE local_apply_runs SET pause = '${JSON.stringify({ ...PAUSE, domain: "www.seek.com.au" })}'`);
		expect(accountCreationApplies(await run(), { ...ON, signInEmail: MAILBOX })).toBeNull();
		expect(accountCreationApplies(await run(), ON)?.host).toBe("seek.com.au");
	});

	it("any existing credential for the host — even an unconfirmed one — means there is no account to create", async () => {
		await createCredential(env(), INSTANCE, UID, { domain: "indeed.com", username: MAILBOX, password: "x-existing-1A!" } as Parameters<typeof createCredential>[3]);
		expect(await accountCreationCanTry(env(), UID, await run(), ON)).toBe(false);
		const f = fakes();
		expect((await go(f)).outcome).toBe("not_applicable");
		expect(f.sent).toEqual([]);
	});
});

describe("creating the account (#1230 acceptance)", () => {
	it("the password is in the vault, unconfirmed and unusable, BEFORE the form is submitted", async () => {
		const f = fakes();
		await go(f);
		expect(f.sent.map((s) => s.body.step)).toEqual(["prepare", "submit"]);
		expect(f.atSubmit.stored).toMatchObject({ provisional: 1 });
		expect(f.atSubmit.usable).toBeNull();
		expect(f.sent[1].body).toMatchObject({ password: PASSWORD, acceptTerms: false });
	});

	it("registers under the pinned mailbox, with the profile's name, phone, location and LinkedIn", async () => {
		const f = fakes();
		await go(f);
		expect(f.sent[0].body.profile).toEqual({ firstName: "Serge", lastName: "Ivochkin", email: MAILBOX, phone: "0400 000 000", location: "Sydney, NSW", linkedin: "https://linkedin.com/in/serge" });
	});

	it("success: the credential is confirmed and usable for this run at once, the run reports created, and the trace and events carry no value", async () => {
		const f = fakes();
		const out = await go(f);
		expect(out.outcome).toBe("created");
		const cred = await findCredentialForHost(env(), INSTANCE, UID, "secure.indeed.com");
		expect(cred).toMatchObject({ username: MAILBOX, password: PASSWORD });
		expect(await row()).toMatchObject({ state: "created", host: "secure.indeed.com", mailbox: MAILBOX, credential_id: cred?.id });
		expect((await run()).trace.at(-1)?.detail).toMatchObject({ tool: "account_creation", decision: "created" });
		const everything = dumpD1();
		for (const secret of [PASSWORD, "0400 000 000"]) expect(everything).not.toContain(secret);
	});

	it("audit: a success is recorded as credential.account_created with host, credential and run — never a value", async () => {
		const f = fakes();
		await go(f);
		const started = await events("credential.account_creation_started");
		const created = await events("credential.account_created");
		expect(started).toHaveLength(1);
		expect(created).toHaveLength(1);
		expect(created[0]).toMatchObject({ host: "secure.indeed.com", runId: RUN, via: "local_apply" });
		expect(JSON.stringify([started, created])).not.toContain(PASSWORD);
	});

	it("is one attempt: a second sync, and a second run on the same site, do not type again", async () => {
		const f = fakes();
		await go(f);
		expect((await go(f, NOW + 60_000)).outcome).toBe("not_applicable");
		insertRun("run-2");
		expect((await advanceAccountCreation(env(), UID, await run("run-2"), ON, NOW + 70_000, f.deps)).outcome).toBe("not_applicable");
		expect(f.sent).toHaveLength(2);
	});

	it("a site with no password box: nothing is stored beforehand; a marker credential naming the address is saved once the account exists", async () => {
		const f = fakes({ prepare: { state: "prepared", needsPassword: false } });
		const out = await go(f);
		expect(out.outcome).toBe("created");
		expect(f.sent[1].body.password).toBeUndefined();
		expect(f.atSubmit.stored).toBeNull();
		expect(await anyCredentialForHost(env(), INSTANCE, UID, "secure.indeed.com")).not.toBeNull();
	});

	it("a verification code: waits, reads the code from the pinned mailbox, types it, and the account is created", async () => {
		const f = fakes({ submit: { state: "code_requested" }, mail: [{ id: "m1", date: new Date(NOW + 5_000).toISOString(), subject: "Your verification code", text: "Your code is 482913" }] });
		expect((await go(f)).outcome).toBe("waiting");
		expect(await row()).toMatchObject({ state: "code_requested" });
		expect((await findCredentialForHost(env(), INSTANCE, UID, "secure.indeed.com"))).toBeNull();
		const out = await go(f, NOW + 30_000);
		expect(out.outcome).toBe("created");
		expect(f.sent.at(-1)?.body).toMatchObject({ step: "enter", code: "482913" });
		expect(await findCredentialForHost(env(), INSTANCE, UID, "secure.indeed.com")).toMatchObject({ password: PASSWORD });
		expect(dumpD1()).not.toContain("482913");
	});

	it("a mail that predates the request is not used, and no mail within five minutes is a failure", async () => {
		const f = fakes({ submit: { state: "code_requested" }, mail: [{ id: "old", date: new Date(NOW - 3_600_000).toISOString(), subject: "code", text: "Your code is 111111" }] });
		await go(f);
		expect((await go(f, NOW + 60_000)).outcome).toBe("waiting");
		expect((await go(f, NOW + 6 * 60_000)).outcome).toBe("failed");
		expect(await row()).toMatchObject({ state: "failed", failure: "verification_not_received" });
		expect(f.sent.some((s) => s.body.step === "enter")).toBe(false);
	});
});

describe("when it cannot be done, the owner gets the ordinary handoff (#1230 acceptance)", () => {
	it("CAPTCHA: the attempt ends with the reason, nothing is created, and the run is told to fall back to the handoff", async () => {
		const f = fakes({ prepare: { state: "failed", reason: "captcha" } });
		const out = await go(f);
		expect(out.outcome).toBe("failed");
		expect(await row()).toMatchObject({ state: "failed", failure: "captcha" });
		expect(await anyCredentialForHost(env(), INSTANCE, UID, "secure.indeed.com")).toBeNull();
		expect((await run()).trace.at(-1)?.detail).toMatchObject({ decision: "failed", rule: "captcha" });
	});

	it("audit: a failure is recorded as credential.account_creation_failed with its reason", async () => {
		await go(fakes({ prepare: { state: "failed", reason: "captcha" } }));
		const failed = await events("credential.account_creation_failed");
		expect(failed).toHaveLength(1);
		expect(failed[0]).toMatchObject({ host: "secure.indeed.com", runId: RUN, reason: "captcha" });
	});

	it("a CAPTCHA after the password was stored: the password is kept, marked as unconfirmed, and still never used to sign in", async () => {
		const f = fakes({ submit: { state: "failed", reason: "captcha" } });
		expect((await go(f)).outcome).toBe("failed");
		const kept = await anyCredentialForHost(env(), INSTANCE, UID, "secure.indeed.com");
		expect(kept).not.toBeNull();
		expect(await findCredentialForHost(env(), INSTANCE, UID, "secure.indeed.com")).toBeNull();
		const note = await d1.DB.prepare("SELECT comments FROM agent_credentials WHERE domain = 'secure.indeed.com'").first<{ comments: string }>();
		expect(note?.comments).toContain("did not complete");
	});

	it("a failed site is not retried by a later run", async () => {
		await go(fakes({ prepare: { state: "failed", reason: "captcha" } }));
		insertRun("run-2");
		const f = fakes();
		expect((await advanceAccountCreation(env(), UID, await run("run-2"), ON, NOW + 1000, f.deps)).outcome).toBe("not_applicable");
		expect(f.sent).toEqual([]);
	});

	it.each([
		["email access is off", { emailPermitted: false }, "email_not_permitted"],
		["no mailbox is pinned", { mailbox: { ok: false } as const }, "mailbox_unresolved"],
		["the profile has no name", { profile: { ...PROFILE, firstName: "" } as Profile }, "profile_incomplete"],
		["the runner does not answer", { runnerDown: true }, "runner_unavailable"],
		["terms must be accepted", { submit: { state: "failed", reason: "terms_required" } }, "terms_required"],
		["the address already has an account", { submit: { state: "failed", reason: "email_taken" } }, "email_taken"],
	])("%s: failed with its reason, nothing typed before the gate", async (_n, script, reason) => {
		const f = fakes(script as Script);
		expect((await go(f)).outcome).toBe("failed");
		expect(await row()).toMatchObject({ state: "failed", failure: reason });
		if (["email_not_permitted", "mailbox_unresolved", "profile_incomplete"].includes(reason)) expect(f.sent).toEqual([]);
	});

	it("a racing sync waits instead of registering twice; a step a Worker died in is closed after three minutes", async () => {
		d1.exec(`INSERT INTO local_apply_account_creations (run_id, instance_id, user_id, host, state, created_at, updated_at) VALUES ('${RUN}', '${INSTANCE}', '${UID}', 'secure.indeed.com', 'submitting', ${NOW}, ${NOW})`);
		const f = fakes();
		expect((await go(f, NOW + 1000)).outcome).toBe("waiting");
		expect(f.sent).toEqual([]);
		expect((await go(f, NOW + 4 * 60_000)).outcome).toBe("failed");
		expect(await row()).toMatchObject({ state: "failed", failure: "interrupted" });
	});
});

describe("generatePassword", () => {
	it("is 24 characters with every class, and differs each time", () => {
		const a = generatePassword();
		expect(a).toHaveLength(24);
		expect(a).toMatch(/[A-Z]/);
		expect(a).toMatch(/[a-z]/);
		expect(a).toMatch(/[0-9]/);
		expect(a).toMatch(/[!@#$%^&*\-_]/);
		expect(generatePassword()).not.toBe(a);
	});
});
