/**
 * #1408: one readiness snapshot for a `login_required` pause, computed from settings and the
 * vault before any of the three sign-in mechanisms acts. Over the real schema; only the Gmail
 * permission check (the AGENT DO) is faked, the same way email-code-sign-in.test.ts fakes it.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../types.js";
import { createCredential } from "../credentials.js";
import { type RealSchemaD1, realSchemaD1, seedTenant } from "../d1-sqlite.js";
import { computeLoginReadiness, loginReadinessDetail, loginReadinessNextAction, nextActionText } from "./login-readiness.js";

const UID = "u1";
const INSTANCE = "runner-1";
const JOB_MAILBOX = "serge.pro.job@gmail.com";
const OTHER_MAILBOX = "sivochkin@gmail.com";
const USERNAME = "serge.pro.job@gmail.com";
const PASSWORD = "Tr0ub4dor&3-vault-secret";
const NOW = Date.now();

let d1: RealSchemaD1;
let emailPermission: boolean;
let runSeq = 0;
const env = () => ({ DB: d1.DB, AGENT: { idFromName: (n: string) => n, get: () => ({ fetch: async () => Response.json({ permissions: { email: emailPermission } }) }) }, KEY_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" }) as unknown as Env;

/** Pin a Gmail account to the instance and make it listable, mirroring email-code-sign-in.test.ts. */
function pinGmail(mailbox: string | null) {
	d1.exec(`UPDATE agent_instances SET config = '${JSON.stringify({ connectorAccounts: mailbox ? { gmail: mailbox } : {} })}' WHERE id = '${INSTANCE}'`);
	for (const account of [OTHER_MAILBOX, JOB_MAILBOX]) {
		d1.exec(`INSERT INTO user_api_keys (user_id, provider, account_id, account_label, key_ciphertext, dek_wrapped, iv, granted_scopes) VALUES ('${UID}', 'gmail', '${account}', '${account}', x'00', x'00', x'00', 'https://www.googleapis.com/auth/gmail.readonly')`);
	}
}

/** A real `local_apply_runs` row — `local_apply_vault_sign_ins.run_id` is a foreign key to it. */
function insertRun(domain: string): string {
	const id = `run-${++runSeq}`;
	const pause = JSON.stringify({ reason: "login_required", domain });
	d1.exec(
		`INSERT INTO local_apply_runs (id, instance_id, user_id, application_id, request_id, status, policy, pause, created_at, updated_at)
		 VALUES ('${id}', '${INSTANCE}', '${UID}', 'app-${id}', 'req-${id}', 'paused', '{}', '${pause}', ${NOW}, ${NOW})`,
	);
	return id;
}
const run = (pause: { domain?: string } = { domain: "au.seek.com" }) => ({ id: insertRun(pause.domain ?? ""), instanceId: INSTANCE, pause: pause as never });
const store = (domain: string, username = USERNAME, password = PASSWORD) => createCredential(env(), INSTANCE, UID, { domain, username, password } as Parameters<typeof createCredential>[3]);
const refuse = (domain: string, at: number) =>
	d1.exec(`INSERT INTO local_apply_vault_sign_ins (run_id, instance_id, user_id, host, state, failure, created_at, updated_at) VALUES ('${insertRun(domain)}', '${INSTANCE}', '${UID}', '${domain}', 'failed', 'wrong_password', ${at}, ${at})`);

beforeEach(() => {
	d1 = realSchemaD1();
	emailPermission = true;
	runSeq = 0;
	seedTenant(d1, { userId: UID, instanceIds: [INSTANCE] });
});
afterEach(() => d1.close());

describe("the email gate (#1408)", () => {
	it("not_supported_site: not a SEEK host, whatever else is set", async () => {
		const r = await computeLoginReadiness(env(), UID, run({ domain: "secure.indeed.com" }), { signInEmail: JOB_MAILBOX, accountCreation: false });
		expect(r.email).toBe("not_supported_site");
	});

	it("sign_in_email_unset: a SEEK host, no signInEmail configured", async () => {
		const r = await computeLoginReadiness(env(), UID, run(), { signInEmail: null, accountCreation: false });
		expect(r.email).toBe("sign_in_email_unset");
	});

	it("not_permitted: signInEmail set, but email access is off", async () => {
		emailPermission = false;
		pinGmail(JOB_MAILBOX);
		const r = await computeLoginReadiness(env(), UID, run(), { signInEmail: JOB_MAILBOX, accountCreation: false });
		expect(r.email).toBe("not_permitted");
	});

	it("mailbox_mismatch: signInEmail set, email on, but the pinned mailbox is a different address", async () => {
		pinGmail(OTHER_MAILBOX);
		const r = await computeLoginReadiness(env(), UID, run(), { signInEmail: JOB_MAILBOX, accountCreation: false });
		expect(r.email).toBe("mailbox_mismatch");
	});

	it("mailbox_mismatch: signInEmail set, but no Gmail is pinned at all (folded into the same fixed value)", async () => {
		pinGmail(null);
		const r = await computeLoginReadiness(env(), UID, run(), { signInEmail: JOB_MAILBOX, accountCreation: false });
		expect(r.email).toBe("mailbox_mismatch");
	});

	it("permitted: signInEmail set, email on, and the pinned mailbox matches it (case-insensitively)", async () => {
		pinGmail(JOB_MAILBOX);
		const r = await computeLoginReadiness(env(), UID, run(), { signInEmail: JOB_MAILBOX.toUpperCase(), accountCreation: false });
		expect(r.email).toBe("permitted");
	});
});

describe("the vault gate (#1408)", () => {
	const settings = { signInEmail: null, accountCreation: false };

	it("absent: no credential at all for the host", async () => {
		const r = await computeLoginReadiness(env(), UID, run({ domain: "secure.indeed.com" }), settings);
		expect(r.vault).toBe("absent");
	});

	it("stored: a credential exists and was never refused", async () => {
		await store("secure.indeed.com");
		const r = await computeLoginReadiness(env(), UID, run({ domain: "secure.indeed.com" }), settings);
		expect(r.vault).toBe("stored");
	});

	it("wrong_password_earlier: the site refused this exact password after it was stored", async () => {
		const id = await store("secure.indeed.com");
		const cred = await d1.DB.prepare("SELECT updated_at FROM agent_credentials WHERE id = ?1").bind(id).first<{ updated_at: string }>();
		refuse("secure.indeed.com", Date.parse(`${cred?.updated_at.replace(" ", "T")}Z`) + 1_000);
		const r = await computeLoginReadiness(env(), UID, run({ domain: "secure.indeed.com" }), settings);
		expect(r.vault).toBe("wrong_password_earlier");
	});

	it("stored again: a password STORED AFTER an earlier refusal is retried (the owner changed it)", async () => {
		// The refusal is backdated well before the credential (inserted at real `datetime('now')`),
		// so no real sleep is needed to prove "stored after" — only that the ordering holds.
		refuse("secure.indeed.com", NOW - 60_000);
		await store("secure.indeed.com");
		const r = await computeLoginReadiness(env(), UID, run({ domain: "secure.indeed.com" }), settings);
		expect(r.vault).toBe("stored");
	});

	it("absent: no pause domain at all", async () => {
		const r = await computeLoginReadiness(env(), UID, run({ domain: undefined }), settings);
		expect(r.vault).toBe("absent");
	});
});

describe("the account-creation gate (#1408)", () => {
	it("disabled: the owner's setting is off, whatever the host", async () => {
		const r = await computeLoginReadiness(env(), UID, run({ domain: "indeed.com" }), { signInEmail: null, accountCreation: false });
		expect(r.accountCreation).toBe("disabled");
	});

	it("enabled: the setting is on and the host is allow-listed (indeed.com, per account-creation-hosts.json)", async () => {
		const r = await computeLoginReadiness(env(), UID, run({ domain: "indeed.com" }), { signInEmail: null, accountCreation: true });
		expect(r.accountCreation).toBe("enabled");
	});

	it("host_not_allowed: the setting is on but the host is not on the allow-list (linkedin.com is OFF there)", async () => {
		const r = await computeLoginReadiness(env(), UID, run({ domain: "linkedin.com" }), { signInEmail: null, accountCreation: true });
		expect(r.accountCreation).toBe("host_not_allowed");
	});

	it("host_not_allowed: an unlisted host entirely", async () => {
		const r = await computeLoginReadiness(env(), UID, run({ domain: "some-random-ats.example" }), { signInEmail: null, accountCreation: true });
		expect(r.accountCreation).toBe("host_not_allowed");
	});
});

describe("host is a hostname only (#1408)", () => {
	it("carries the pause's domain verbatim, never a full URL", async () => {
		const r = await computeLoginReadiness(env(), UID, run({ domain: "secure.indeed.com" }), { signInEmail: null, accountCreation: false });
		expect(r.host).toBe("secure.indeed.com");
	});

	it("is empty when the pause has no domain", async () => {
		const r = await computeLoginReadiness(env(), UID, run({ domain: undefined }), { signInEmail: null, accountCreation: false });
		expect(r.host).toBe("");
	});
});

describe("loginReadinessNextAction: the single best lever, pure (#1408)", () => {
	it("an email code applies and is ready: wait_for_code", () => {
		expect(loginReadinessNextAction({ email: "permitted", vault: "absent", accountCreation: "disabled" })).toBe("wait_for_code");
	});

	it("no sign-in email configured for a SEEK pause: set_sign_in_email, even with a vault login available", () => {
		expect(loginReadinessNextAction({ email: "sign_in_email_unset", vault: "stored", accountCreation: "enabled" })).toBe("set_sign_in_email");
	});

	it("the configured email doesn't match the pinned mailbox: set_sign_in_email (correct it)", () => {
		expect(loginReadinessNextAction({ email: "mailbox_mismatch", vault: "absent", accountCreation: "disabled" })).toBe("set_sign_in_email");
	});

	it("not a SEEK site, no vault login, account creation not allow-listed for this host: store_login_for_host", () => {
		expect(loginReadinessNextAction({ email: "not_supported_site", vault: "absent", accountCreation: "host_not_allowed" })).toBe("store_login_for_host");
	});

	it("not a SEEK site, the stored password was refused: store_login_for_host (a fresh one), whatever account creation is set to", () => {
		expect(loginReadinessNextAction({ email: "not_supported_site", vault: "wrong_password_earlier", accountCreation: "disabled" })).toBe("store_login_for_host");
	});

	it("not a SEEK site, a vault login IS stored and will be tried: take_over (nothing more specific to suggest yet)", () => {
		expect(loginReadinessNextAction({ email: "not_supported_site", vault: "stored", accountCreation: "enabled" })).toBe("take_over");
	});

	it("no vault credential at all and account creation is off: enable_account_creation (the simpler toggle)", () => {
		expect(loginReadinessNextAction({ email: "not_supported_site", vault: "absent", accountCreation: "disabled" })).toBe("enable_account_creation");
	});

	it("no vault credential at all and account creation is on for this host: take_over (it will be tried automatically)", () => {
		expect(loginReadinessNextAction({ email: "not_supported_site", vault: "absent", accountCreation: "enabled" })).toBe("take_over");
	});

	it("a vault credential IS stored, so it wins over account creation being off: take_over, not enable_account_creation", () => {
		expect(loginReadinessNextAction({ email: "not_permitted", vault: "stored", accountCreation: "disabled" })).toBe("take_over");
	});

	it("truly nothing applicable: take_over, the universal fallback the pause already offers", () => {
		expect(loginReadinessNextAction({ email: "not_permitted", vault: "stored", accountCreation: "host_not_allowed" })).toBe("take_over");
	});

	it("every value has non-empty owner-facing text", () => {
		for (const action of ["set_sign_in_email", "store_login_for_host", "enable_account_creation", "take_over", "wait_for_code"] as const) {
			expect(nextActionText(action).length).toBeGreaterThan(0);
		}
	});
});

describe("redaction (#1408): the readiness detail never carries a secret, whatever is in the vault", () => {
	it("no @, no digit run longer than 4, and never the stored username or password", async () => {
		await store("secure.indeed.com", USERNAME, PASSWORD);
		const r = await computeLoginReadiness(env(), UID, run({ domain: "secure.indeed.com" }), { signInEmail: JOB_MAILBOX, accountCreation: true });
		const json = JSON.stringify(loginReadinessDetail(r));
		expect(json).not.toContain("@");
		expect(json).not.toMatch(/\d{5,}/);
		expect(json).not.toContain(USERNAME);
		expect(json).not.toContain(PASSWORD);
	});

	it("holds even with a mismatched mailbox address configured as signInEmail", async () => {
		pinGmail(OTHER_MAILBOX);
		const r = await computeLoginReadiness(env(), UID, run(), { signInEmail: JOB_MAILBOX, accountCreation: false });
		const json = JSON.stringify(loginReadinessDetail(r));
		expect(json).not.toContain("@");
		expect(json).not.toContain(JOB_MAILBOX);
		expect(json).not.toContain(OTHER_MAILBOX);
	});

	it("the detail is a flat record of exactly the five documented fields", async () => {
		const r = await computeLoginReadiness(env(), UID, run({ domain: "secure.indeed.com" }), { signInEmail: null, accountCreation: false });
		expect(Object.keys(loginReadinessDetail(r)).sort()).toEqual(["accountCreation", "email", "host", "nextAction", "vault"]);
	});
});
