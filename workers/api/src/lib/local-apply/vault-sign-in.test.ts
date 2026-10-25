/**
 * #1229: a fill paused `login_required` on a host with a stored password login signs itself in from the vault.
 * The cloud half, over the real schema and the REAL vault (a credential encrypted with a key and read back by `findCredentialForHost`);
 * only the runner — the relay to `pags up` — is faked.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../types.js";
import { createCredential } from "../credentials.js";
import { type RealSchemaD1, realSchemaD1, seedTenant } from "../d1-sqlite.js";
import { advanceVaultSignIn, vaultSignInApplies, vaultSignInCanTry, vaultSignInWillTry, type VaultSignInDeps } from "./vault-sign-in.js";
import { type ApplyRun, getApplyRun } from "./store.js";
import { findCredentialForHost } from "../credentials.js";

const UID = "u1";
const INSTANCE = "runner-1";
const RUN = "run-1";
const KEK = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const USERNAME = "serge.pro.job@gmail.com";
const PASSWORD = "Tr0ub4dor&3-vault-secret";
const NOW = Date.now();
const PAUSE = { reason: "login_required", domain: "secure.indeed.com", url: "https://secure.indeed.com/auth", question: "Sign in to indeed.com in this browser." };

let d1: RealSchemaD1;
const env = () => ({ DB: d1.DB, KEY_ENCRYPTION_KEY: KEK }) as unknown as Env;

function fakes(answer: unknown = { state: "signed_in" }, credentialOverride?: Awaited<ReturnType<VaultSignInDeps["credential"]>>) {
	const sent: Array<{ path: string; body: Record<string, unknown> }> = [];
	const deps: VaultSignInDeps = {
		credential: (host) => (credentialOverride !== undefined ? Promise.resolve(credentialOverride) : findCredentialForHost(env(), INSTANCE, UID, host)),
		runner: async (path, body) => {
			sent.push({ path, body: body as Record<string, unknown> });
			return answer === null ? null : { status: 200, body: answer };
		},
	};
	return { deps, sent };
}

const run = async (id = RUN): Promise<ApplyRun> => (await getApplyRun(env(), INSTANCE, UID, id)) as ApplyRun;
const row = (id = RUN) => d1.DB.prepare("SELECT * FROM local_apply_vault_sign_ins WHERE run_id = ?1").bind(id).first<Record<string, unknown>>();
const settings = { signInEmail: null as string | null };
const insertRun = (id: string, pause: object = PAUSE) =>
	d1.exec(
		`INSERT INTO local_apply_runs (id, instance_id, user_id, application_id, request_id, status, policy, pause, created_at, updated_at)
		 VALUES ('${id}', '${INSTANCE}', '${UID}', 'app-${id}', 'req-${id}', 'paused', '{}', '${JSON.stringify(pause)}', ${NOW}, ${NOW})`,
	);
const store = (input: Partial<{ domain: string; username: string; password: string }> = {}) =>
	createCredential(env(), INSTANCE, UID, { domain: input.domain ?? "indeed.com", username: input.username ?? USERNAME, password: input.password ?? PASSWORD } as Parameters<typeof createCredential>[3]);

/** Every row of every table EXCEPT the vault itself (which holds the username in clear and the password encrypted), as one string. */
function dumpD1(): string {
	const tables = (d1.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name <> 'agent_credentials'").all() as Array<{ name: string }>).map((t) => t.name);
	return tables.map((t) => JSON.stringify(d1.sqlite.prepare(`SELECT * FROM "${t}"`).all())).join("\n");
}

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: UID, instanceIds: [INSTANCE] });
	insertRun(RUN);
});
afterEach(() => d1.close());

describe("signing in from the vault (#1229 acceptance)", () => {
	it("a paused sign-in on a host whose login is stored: the cloud reads it, the runner gets it in ONE request, and the run is signed in", async () => {
		const id = await store();
		const f = fakes();
		const out = await advanceVaultSignIn(env(), UID, await run(), settings, NOW, f.deps);
		expect(out.outcome).toBe("signed_in");
		// The credential reaches the runner exactly once, for the paused page's own host.
		expect(f.sent).toEqual([{ path: "/local-apply/vault-sign-in", body: { runId: RUN, host: "secure.indeed.com", username: USERNAME, password: PASSWORD } }]);
		expect(await row()).toMatchObject({ state: "signed_in", host: "secure.indeed.com", credential_id: id, failure: null });
	});

	it("records the use: lastUsedAt on the credential, and a credential.use event naming the host and credential — no value", async () => {
		const id = await store();
		await advanceVaultSignIn(env(), UID, await run(), settings, NOW, fakes().deps);
		const cred = await d1.DB.prepare("SELECT last_used_at FROM agent_credentials WHERE id = ?1").bind(id).first<{ last_used_at: string | null }>();
		expect(cred?.last_used_at).not.toBeNull();
		const events = (await d1.DB.prepare("SELECT event, context FROM agent_events WHERE event = 'credential.use'").all<{ event: string; context: string }>()).results ?? [];
		expect(events).toHaveLength(1);
		expect(JSON.parse(events[0].context)).toMatchObject({ host: "secure.indeed.com", credentialId: id, runId: RUN, via: "local_apply", outcome: "signed_in" });
	});

	it("keeps neither the username nor the password anywhere but the vault: not the row, the trace, the events or any other table", async () => {
		await store();
		await advanceVaultSignIn(env(), UID, await run(), settings, NOW, fakes().deps);
		const everything = dumpD1();
		expect(everything).not.toContain(PASSWORD);
		expect(everything).not.toContain(USERNAME);
		const trace = (await run()).trace;
		expect(trace.at(-1)?.detail).toMatchObject({ tool: "vault_sign_in", decision: "signed_in" });
	});

	it("is one attempt per run: a second sync does not type the credential again", async () => {
		await store();
		const f = fakes();
		await advanceVaultSignIn(env(), UID, await run(), settings, NOW, f.deps);
		const again = await advanceVaultSignIn(env(), UID, await run(), settings, NOW + 60_000, f.deps);
		expect(again.outcome).toBe("not_applicable");
		expect(f.sent).toHaveLength(1);
	});

	it("a racing sync that finds the attempt under way waits instead of typing it twice; a step a Worker died in is closed after three minutes", async () => {
		await store();
		d1.exec(`INSERT INTO local_apply_vault_sign_ins (run_id, instance_id, user_id, host, state, created_at, updated_at) VALUES ('${RUN}', '${INSTANCE}', '${UID}', 'secure.indeed.com', 'signing_in', ${NOW}, ${NOW})`);
		const f = fakes();
		expect((await advanceVaultSignIn(env(), UID, await run(), settings, NOW + 1_000, f.deps)).outcome).toBe("waiting");
		expect(f.sent).toEqual([]);
		const stale = await advanceVaultSignIn(env(), UID, await run(), settings, NOW + 4 * 60_000, f.deps);
		expect(stale.outcome).toBe("failed");
		expect(await row()).toMatchObject({ state: "failed", failure: "interrupted" });
	});
});

describe("when there is nothing to sign in with", () => {
	it("no stored login for the host: not applicable, the runner is asked nothing, no attempt is recorded", async () => {
		const f = fakes();
		expect((await advanceVaultSignIn(env(), UID, await run(), settings, NOW, f.deps)).outcome).toBe("not_applicable");
		expect(f.sent).toEqual([]);
		expect(await row()).toBeNull();
	});

	it("a login for another site is not offered to this one", async () => {
		await store({ domain: "linkedin.com" });
		const f = fakes();
		expect((await advanceVaultSignIn(env(), UID, await run(), settings, NOW, f.deps)).outcome).toBe("not_applicable");
		expect(f.sent).toEqual([]);
	});

	it("a credential with no password (a note about the account) is not a login", async () => {
		await createCredential(env(), INSTANCE, UID, { domain: "indeed.com", username: USERNAME } as Parameters<typeof createCredential>[3]);
		expect(await vaultSignInCanTry(env(), UID, await run())).toBe(false);
	});

	it("another owner's credential is never read", async () => {
		d1.exec(`INSERT OR IGNORE INTO users (id, github_login) VALUES ('u2', 'u2')`);
		d1.exec(`INSERT INTO agent_instances (id, agent_id, user_id) VALUES ('other-instance', 'agent-1', 'u2')`);
		await createCredential(env(), "other-instance", "u2", { domain: "indeed.com", username: "someone@else.com", password: "theirs" } as Parameters<typeof createCredential>[3]);
		expect(await vaultSignInCanTry(env(), UID, await run())).toBe(false);
	});

	it("a pause that is not a sign-in, or has no host, is not applicable", async () => {
		await store();
		const f = fakes();
		expect(vaultSignInApplies({ status: "paused", pause: { reason: "missing_answer" } as ApplyRun["pause"] })).toBe(false);
		expect(vaultSignInApplies({ status: "running", pause: null })).toBe(false);
		expect(vaultSignInApplies({ status: "paused", pause: { reason: "login_required" } as ApplyRun["pause"] })).toBe(false);
		expect((await advanceVaultSignIn(env(), UID, { ...(await run()), status: "running" }, settings, NOW, f.deps)).outcome).toBe("not_applicable");
	});
});

describe("when the site does not let it in — the owner gets the ordinary handoff, with the reason", () => {
	for (const reason of ["captcha", "two_factor", "wrong_password", "not_signed_in", "no_password_field"] as const) {
		it(`${reason}: the attempt ends failed, the reason is in the trace, and the credential value is nowhere`, async () => {
			await store();
			const out = await advanceVaultSignIn(env(), UID, await run(), settings, NOW, fakes({ state: "failed", reason }).deps);
			expect(out.outcome).toBe("failed");
			expect(await row()).toMatchObject({ state: "failed", failure: reason });
			const last = (await run()).trace.at(-1);
			expect(last?.detail).toMatchObject({ tool: "vault_sign_in", decision: "failed", rule: reason });
			expect(String(last?.detail?.reason)).toContain("indeed.com");
			expect(dumpD1()).not.toContain(PASSWORD);
		});
	}

	it("a runner that does not answer (an older CLI) says to update it", async () => {
		await store();
		expect((await advanceVaultSignIn(env(), UID, await run(), settings, NOW, fakes(null).deps)).outcome).toBe("failed");
		expect(String((await run()).trace.at(-1)?.detail?.reason)).toContain("npm i -g @proagentstore/cli");
	});

	it("a credential that cannot be read is a failure, not a silent skip", async () => {
		await store();
		expect((await advanceVaultSignIn(env(), UID, await run(), settings, NOW, fakes({ state: "signed_in" }, null).deps)).outcome).toBe("failed");
		expect(await row()).toMatchObject({ failure: "credential_unreadable" });
	});
});

describe("a refused password is never retried until the owner changes it", () => {
	it("a later run on the same host is not tried again; once the credential is changed, it is", async () => {
		const id = await store();
		await advanceVaultSignIn(env(), UID, await run(), settings, NOW + 60_000, fakes({ state: "failed", reason: "wrong_password" }).deps);
		insertRun("run-2");
		expect(await vaultSignInCanTry(env(), UID, await run("run-2"))).toBe(false);
		// The owner replaces the password under Knowledge → Credentials.
		await d1.DB.prepare("UPDATE agent_credentials SET updated_at = datetime(?2 / 1000, 'unixepoch') WHERE id = ?1").bind(id, NOW + 3_600_000).run();
		expect(await vaultSignInCanTry(env(), UID, await run("run-2"))).toBe(true);
	});

	it("other failures (a CAPTCHA, say) do not bar the next run", async () => {
		await store();
		await advanceVaultSignIn(env(), UID, await run(), settings, NOW, fakes({ state: "failed", reason: "captcha" }).deps);
		insertRun("run-2");
		expect(await vaultSignInCanTry(env(), UID, await run("run-2"))).toBe(true);
	});
});

describe("alongside the SEEK email code (#1106)", () => {
	const SEEK = { reason: "login_required", domain: "au.seek.com", url: "https://au.seek.com/job/1", question: "Sign in to seek.com in this browser." };
	const withEmail = { signInEmail: "serge.pro.job@gmail.com" };

	it("with the SEEK sign-in email set, the email code goes first: the vault waits", async () => {
		insertRun("seek-run", SEEK);
		await store({ domain: "seek.com" });
		const f = fakes();
		expect((await advanceVaultSignIn(env(), UID, await run("seek-run"), withEmail, NOW, f.deps)).outcome).toBe("not_applicable");
		expect(f.sent).toEqual([]);
		expect(await vaultSignInWillTry(env(), UID, await run("seek-run"), withEmail)).toBe(false);
	});

	it("once the email code has FAILED, the vault gets its try", async () => {
		insertRun("seek-run", SEEK);
		await store({ domain: "seek.com" });
		d1.exec(`INSERT INTO local_apply_email_sign_ins (run_id, instance_id, user_id, site, state, created_at, updated_at) VALUES ('seek-run', '${INSTANCE}', '${UID}', 'seek.com', 'failed', ${NOW}, ${NOW})`);
		expect((await advanceVaultSignIn(env(), UID, await run("seek-run"), withEmail, NOW, fakes().deps)).outcome).toBe("signed_in");
	});

	it("without a SEEK sign-in email, SEEK is signed in from the vault like any site", async () => {
		insertRun("seek-run", SEEK);
		await store({ domain: "seek.com" });
		expect(await vaultSignInWillTry(env(), UID, await run("seek-run"), settings)).toBe(true);
	});
});
