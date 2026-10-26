/**
 * Account creation (#1230, #1226 ask 2): a fill run paused `login_required` on an allow-listed site where the owner has NO account creates one,
 * stores it in the vault, and carries on — instead of handing the owner a sign-in they cannot do because there is nothing to sign in to.
 *
 * ## What has to be true before anything is typed
 *   • the owner turned it on (`applicationRunner.accountCreation`, OFF by default) — it registers them on a third-party site;
 *   • the host is in `account-creation-hosts.json` with `enabled: true`;
 *   • the owner has NO credential for the host, provisional or not, and no attempt on this host has been made before — one account per site, and
 *     one try: a failure goes to the owner, not to a retry loop that gets an address flagged;
 *   • this is not a SEEK pause the email-code sign-in covers (a `signInEmail` means the owner already has the account);
 *   • email access is on and the Runner is pinned to a Gmail mailbox, because the account is registered under THAT address so the verification
 *     mail can be read. The address is the mailbox's, never a guess from the profile.
 *
 * ## The order that makes a crash safe
 *   prepare ──(runner: open the sign-up form, fill the profile, say whether it wants a password)──▶
 *   store   ──(generate a strong password, put it in the vault as a PROVISIONAL credential)──▶
 *   submit  ──(runner: type it, press the form's button)──▶ created | code_requested ──(code read from the pinned Gmail, typed)──▶ created
 * The password is in the vault BEFORE the form is submitted, so a crash, a lost response or a page that dies mid-signup never leaves an account
 * nobody can sign in to. It stays provisional — never used to sign in — until the site has accepted the registration, then it is confirmed. A
 * passwordless site (an emailed code, no password field) has nothing to store first; a marker credential is saved once it is created.
 *
 * ## What is kept and recorded
 * The row keeps the host, the credential id, the mailbox and the outcome. Events (`credential.account_creation_*`) name the host and the
 * outcome — never a profile value, the password or the code, as `credential.reveal` and `credential.use` do. A CAPTCHA, a terms box the owner
 * did not authorise for the host, a field the profile cannot fill, an address that already has an account, or any page that is not as expected
 * ends the attempt with its reason and the owner gets the ordinary sign-in handoff — once.
 */
import { listConnectorAccounts, pinnedAccountFor, resolveConnectorAccount } from "../connector-accounts.js";
import { connectorClient } from "../connectors/client.js";
import { emailPermitted } from "../connectors/gmail.js";
import { anyCredentialForHost, confirmCredential, createCredential, noteCredential } from "../credentials.js";
import { logEvent } from "../events.js";
import { getMessage, listMessages } from "../gmail.js";
import { getProfile, type Profile } from "../profile.js";
import { callRuntime, getLiveRuntime, runtimeJson } from "../../routes/instances-runtime.js";
import type { Env } from "../../types.js";
import { type AccountCreationHost, accountCreationHostFor } from "./account-creation-hosts.js";
import { LOCAL_APPLY_ACCOUNT_CREATION_PATH, type LocalApplyAccountCreationResult, type LocalApplyAccountProfile } from "./contract.js";
import { emailCodeApplies, signInCodeIn } from "./email-code-sign-in.js";
import type { ApplicationRunnerSettings } from "./policy.js";
import { type ApplyRun, type ApplyTraceEvent, updateApplyRun } from "./store.js";

/** How long after submitting the sign-up form the verification mail may take. */
export const VERIFICATION_WAIT_MS = 5 * 60_000;
/** A step a Worker died in the middle of is not waited on forever. */
const STALE_STEP_MS = 3 * 60_000;

type State = "preparing" | "prepared" | "submitting" | "code_requested" | "entering" | "created" | "failed";
export type AccountCreationOutcome = "not_applicable" | "waiting" | "created" | "failed";

interface Row {
	state: State;
	host: string;
	credential_id: string | null;
	mailbox: string | null;
	requested_at: number | null;
	updated_at: number;
}

/** What the state machine needs from outside: the runner, the mailbox and its gates, the profile. Injected in tests. */
export interface AccountCreationDeps {
	runner(path: string, body: unknown): Promise<{ status: number; body: unknown } | null>;
	emailPermitted(): Promise<boolean>;
	/** The Gmail mailbox this Runner is pinned to — the address the account is registered under. */
	mailboxAddress(): Promise<{ ok: true; address: string } | { ok: false }>;
	mailbox(): Promise<{ list(query: string, max: number): Promise<readonly { id: string; date: string }[]>; read(id: string): Promise<{ subject: string; text: string }> }>;
	profile(): Promise<Profile>;
	password(): string;
}

function defaultDeps(env: Env, run: ApplyRun, uid: string): AccountCreationDeps {
	return {
		runner: async (path, body) => {
			const runtime = await getLiveRuntime(env, run.instanceId, uid).catch(() => null);
			if (!runtime) return null;
			const res = await callRuntime(env, runtime, path, { method: "POST", body: JSON.stringify(body) }).catch(() => null);
			return res ? { status: res.status, body: await runtimeJson(res).catch(() => null) } : null;
		},
		emailPermitted: () => emailPermitted(env, run.instanceId),
		mailboxAddress: async () => {
			const resolved = resolveConnectorAccount(await listConnectorAccounts(env, uid, "gmail"), await pinnedAccountFor(env, run.instanceId, "gmail"), "Gmail");
			return resolved.ok && resolved.account.accountId ? { ok: true, address: resolved.account.accountId.toLowerCase() } : { ok: false };
		},
		mailbox: async () => {
			const token = await connectorClient(env, "gmail", { userId: uid, instanceId: run.instanceId }).token({ scope: "read" });
			return { list: (q, max) => listMessages(token, q, max), read: (id) => getMessage(token, id, 20_000) };
		},
		profile: () => getProfile(env, uid),
		password: generatePassword,
	};
}

const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const LOWER = "abcdefghijkmnopqrstuvwxyz";
const DIGIT = "23456789";
const SYMBOL = "!@#$%^&*-_";

/** A strong random password: 24 characters, every class present, from the platform's own CSPRNG. Rejection sampling, so no modulo bias. */
export function generatePassword(length = 24): string {
	const pick = (set: string): string => {
		const limit = 256 - (256 % set.length);
		for (;;) {
			const b = crypto.getRandomValues(new Uint8Array(1))[0];
			if (b < limit) return set[b % set.length];
		}
	};
	const all = UPPER + LOWER + DIGIT + SYMBOL;
	const chars = [pick(UPPER), pick(LOWER), pick(DIGIT), pick(SYMBOL)];
	while (chars.length < length) chars.push(pick(all));
	// Fisher–Yates with the same unbiased draw.
	for (let i = chars.length - 1; i > 0; i--) {
		const limit = 256 - (256 % (i + 1));
		let b: number;
		do b = crypto.getRandomValues(new Uint8Array(1))[0];
		while (b >= limit);
		const j = b % (i + 1);
		[chars[i], chars[j]] = [chars[j], chars[i]];
	}
	return chars.join("");
}

const FAILURE_TEXT: Record<string, (host: string) => string> = {
	email_not_permitted: () => "Email access is off for the Application Runner, so it cannot read the verification mail. Turn it on under Settings → Permissions & Connections.",
	mailbox_unresolved: () => "The Application Runner cannot tell which Gmail mailbox to register the account under. Pin one under its connector accounts.",
	profile_incomplete: () => "Your profile has no first and last name, which a sign-up form needs. Fill them in under Profile.",
	runner_unavailable: () => "The runner did not answer the account creation. If this machine's CLI is older than this feature, update it (npm i -g @proagentstore/cli).",
	interrupted: () => "The account creation was interrupted part-way. If a password was generated it is saved, marked as not confirmed, under Knowledge → Credentials.",
	verification_not_received: (h) => `No verification mail from ${h} reached the Runner's mailbox within ${VERIFICATION_WAIT_MS / 60_000} minutes.`,
	mailbox_unreadable: () => "The Application Runner could not read its Gmail mailbox. Reconnect Gmail under Preferences → Connections.",
	host_mismatch: (h) => `The paused page was not on ${h}, so nothing was typed.`,
	no_signup_link: (h) => `${h}'s sign-in page had no "Create account" link the runner could use.`,
	no_signup_form: (h) => `${h} did not show a sign-up form after the "Create account" link.`,
	no_email_field: (h) => `${h}'s sign-up form had no email box.`,
	no_password_field: (h) => `${h}'s sign-up form had no password box where one was expected.`,
	password_not_prepared: (h) => `${h}'s sign-up form asked for a password on a page the runner had not prepared for. Nothing was made up.`,
	no_submit_button: (h) => `${h}'s sign-up form had no button the runner could tell from "sign up with Google" and the like.`,
	captcha: (h) => `${h} asked for a CAPTCHA or other proof of a human. It was not worked around.`,
	terms_required: (h) => `${h} requires agreeing to its terms. Accepting terms is yours to do: create the account yourself, or authorise it for ${h} in account-creation-hosts.json.`,
	field_required: (h) => `${h}'s sign-up form needs a value your profile does not have. Nothing was made up.`,
	email_taken: (h) => `${h} says an account already exists for that address. Sign in yourself, or save the login under Knowledge → Credentials.`,
	no_code_field: (h) => `${h} did not show a box for the verification code.`,
	code_rejected: (h) => `${h} did not accept the verification code read from the mailbox.`,
	not_created: (h) => `${h} did not accept the registration.`,
};

/** Does this pause go to account creation at all? Pure, so the gate is tested as a gate. */
export function accountCreationApplies(
	run: Pick<ApplyRun, "status" | "pause">,
	settings: Pick<ApplicationRunnerSettings, "signInEmail" | "accountCreation">,
): AccountCreationHost | null {
	if (run.status !== "paused" || run.pause?.reason !== "login_required" || !run.pause.domain) return null;
	if (settings.accountCreation !== true) return null;
	// A SEEK pause with a configured sign-in address belongs to the email-code sign-in: the owner already has that account.
	if (emailCodeApplies(run, settings)) return null;
	const entry = accountCreationHostFor(run.pause.domain);
	return entry?.enabled ? entry : null;
}

/** Is there something to do — allowed host, no credential at all for it, no earlier attempt on it, none yet on this run? */
export async function accountCreationCanTry(env: Env, uid: string, run: Pick<ApplyRun, "id" | "instanceId" | "status" | "pause">, settings: Pick<ApplicationRunnerSettings, "signInEmail" | "accountCreation">): Promise<boolean> {
	const entry = accountCreationApplies(run, settings);
	if (!entry) return false;
	const host = run.pause?.domain as string;
	if (await anyCredentialForHost(env, run.instanceId, uid, host)) return false;
	// One attempt per site, ever: a refused or half-finished attempt is the owner's, not a retry loop's.
	if (await env.DB.prepare("SELECT 1 FROM local_apply_account_creations WHERE instance_id = ?1 AND user_id = ?2 AND (host = ?3 OR host LIKE ?4)").bind(run.instanceId, uid, entry.host, `%.${entry.host}`).first()) return false;
	return true;
}

/** Will this pause be tried — so the owner is not alerted yet? Not once this run has tried. */
export async function accountCreationWillTry(env: Env, uid: string, run: Pick<ApplyRun, "id" | "instanceId" | "status" | "pause">, settings: Pick<ApplicationRunnerSettings, "signInEmail" | "accountCreation">): Promise<boolean> {
	return accountCreationCanTry(env, uid, run, settings);
}

/**
 * Move the account creation of one paused run forward by at most one step. Never throws: a failure is an outcome, and `failed` is the caller's cue
 * to hand the sign-in to the owner. Returns the run with any trace events this step wrote, so the caller does not write back a stale trace.
 */
export async function advanceAccountCreation(
	env: Env,
	uid: string,
	run: ApplyRun,
	settings: Pick<ApplicationRunnerSettings, "signInEmail" | "accountCreation">,
	now: number,
	deps: AccountCreationDeps = defaultDeps(env, run, uid),
): Promise<{ outcome: AccountCreationOutcome; run: ApplyRun }> {
	const entry = accountCreationApplies(run, settings);
	if (!entry) return { outcome: "not_applicable", run };
	const host = run.pause?.domain as string;
	const trace = async (decision: string, detail: Record<string, string | number | boolean> = {}): Promise<void> => {
		const event: ApplyTraceEvent = { type: "policy.decision", at: new Date(now).toISOString(), domain: host, detail: { tool: "account_creation", class: "session", source: "platform", decision, ...detail } };
		run = (await updateApplyRun(env, run, { events: [event] }, now)) ?? run;
	};
	const audit = (event: string, level: "info" | "warn", message: string, context: Record<string, string | number | boolean | null>) =>
		logEvent(env, { source: "credentials", event, level, message, userId: uid, instanceId: run.instanceId, context: { host, runId: run.id, via: "local_apply", ...context } }).catch(() => undefined);
	const move = (from: State, to: State, set: { credentialId?: string; mailbox?: string; requestedAt?: number; failure?: string } = {}) =>
		env.DB.prepare(
			`UPDATE local_apply_account_creations SET state = ?3, credential_id = COALESCE(?4, credential_id), mailbox = COALESCE(?5, mailbox),
			        requested_at = COALESCE(?6, requested_at), failure = COALESCE(?7, failure), updated_at = ?8 WHERE run_id = ?1 AND state = ?2`,
		)
			.bind(run.id, from, to, set.credentialId ?? null, set.mailbox ?? null, set.requestedAt ?? null, set.failure ?? null, now)
			.run()
			.then((r) => (r.meta?.changes ?? 0) > 0);
	let credentialId: string | null = null;
	const fail = async (from: State, reason: string): Promise<{ outcome: AccountCreationOutcome; run: ApplyRun }> => {
		if (!(await move(from, "failed", { failure: reason }))) return { outcome: "waiting", run };
		await trace("failed", { reason: FAILURE_TEXT[reason]?.(host) ?? reason, rule: reason });
		await audit("credential.account_creation_failed", "warn", `Account creation on ${host} failed: ${reason}`, { reason, credentialId });
		// A password stored before the attempt stays — marked, so the owner knows it belongs to an account that was never confirmed.
		if (credentialId) await noteCredential(env, run.instanceId, uid, credentialId, `Generated by the Application Runner on ${new Date(now).toISOString().split("T")[0]}, but the registration on ${host} did not complete (${reason}). The account may not exist; this password has not been used to sign in.`).catch(() => undefined);
		return { outcome: "failed", run };
	};
	const succeed = async (from: State, mailbox: string | null, credId: string | null, passwordless: boolean): Promise<{ outcome: AccountCreationOutcome; run: ApplyRun }> => {
		if (!(await move(from, "created"))) return { outcome: "waiting", run };
		const when = new Date(now).toISOString().split("T")[0];
		let finalId = credId;
		if (credId) await confirmCredential(env, run.instanceId, uid, credId, `Created by the Application Runner on ${when}; ${host} accepted the registration.`);
		else if (passwordless && mailbox) {
			// Nothing to store before the form (it asked for no password): record that the account exists, and under which address.
			finalId = await createCredential(env, run.instanceId, uid, { domain: host, username: mailbox, loginUrl: run.pause?.url, comments: `Created by the Application Runner on ${when}. ${host} signs in with an emailed code, not a password.` });
			await env.DB.prepare("UPDATE local_apply_account_creations SET credential_id = ?2 WHERE run_id = ?1").bind(run.id, finalId).run();
		}
		credentialId = finalId;
		await trace("created", { ...(finalId ? { credentialId: finalId } : {}), passwordless });
		await audit("credential.account_created", "info", `Created an account on ${host}`, { credentialId: finalId, mailbox, passwordless });
		return { outcome: "created", run };
	};
	const call = async (body: Record<string, unknown>): Promise<LocalApplyAccountCreationResult | null> => {
		const res = await deps.runner(LOCAL_APPLY_ACCOUNT_CREATION_PATH, { runId: run.id, host, ...body });
		return res?.status === 200 ? (res.body as LocalApplyAccountCreationResult | null) : null;
	};

	try {
		const existing = await env.DB.prepare("SELECT state, host, credential_id, mailbox, requested_at, updated_at FROM local_apply_account_creations WHERE run_id = ?1").bind(run.id).first<Row>();
		if (existing) {
			credentialId = existing.credential_id;
			const s = existing.state;
			if ((s === "preparing" || s === "prepared" || s === "submitting" || s === "entering") && now - existing.updated_at > STALE_STEP_MS) return fail(s, "interrupted");
			if (s === "created" || s === "failed") return { outcome: "not_applicable", run };
			if (s !== "code_requested") return { outcome: "waiting", run };

			// Waiting for the verification mail.
			const requestedAt = existing.requested_at ?? existing.updated_at;
			const mail = await deps.mailbox();
			const hits = (await mail.list(`from:(${host}) newer_than:1d`, 5)).filter((h) => Date.parse(h.date) >= requestedAt - 120_000);
			for (const hit of hits) {
				const msg = await mail.read(hit.id);
				const code = signInCodeIn(msg.subject, msg.text);
				if (!code) continue;
				if (!(await move("code_requested", "entering"))) return { outcome: "waiting", run };
				await trace("code_read", { mailbox: existing.mailbox ?? "", messageId: hit.id });
				const result = await call({ step: "enter", code });
				if (result?.state === "created") return succeed("entering", existing.mailbox, existing.credential_id, !existing.credential_id);
				return fail("entering", result?.state === "failed" ? result.reason : "runner_unavailable");
			}
			if (now - requestedAt > VERIFICATION_WAIT_MS) return fail("code_requested", "verification_not_received");
			return { outcome: "waiting", run };
		}

		if (!(await accountCreationCanTry(env, uid, run, settings))) return { outcome: "not_applicable", run };
		// One attempt per run: whoever inserts the row creates the account; a racing sync reads it and waits.
		const claimed = ((await env.DB.prepare(
			"INSERT INTO local_apply_account_creations (run_id, instance_id, user_id, host, state, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'preparing', ?5, ?5) ON CONFLICT DO NOTHING",
		)
			.bind(run.id, run.instanceId, uid, host, now)
			.run()).meta?.changes ?? 0) > 0;
		if (!claimed) return { outcome: "waiting", run };
		await audit("credential.account_creation_started", "info", `Trying to create an account on ${host}`, { site: entry.host });

		if (!(await deps.emailPermitted())) return fail("preparing", "email_not_permitted");
		const box = await deps.mailboxAddress();
		if (!box.ok) return fail("preparing", "mailbox_unresolved");
		const mailbox = box.address;
		await env.DB.prepare("UPDATE local_apply_account_creations SET mailbox = ?2 WHERE run_id = ?1").bind(run.id, mailbox).run();
		const p = await deps.profile();
		if (!p.firstName?.trim() || !p.lastName?.trim()) return fail("preparing", "profile_incomplete");
		const profile: LocalApplyAccountProfile = {
			firstName: p.firstName.trim(),
			lastName: p.lastName.trim(),
			email: mailbox,
			...(p.phone?.trim() ? { phone: p.phone.trim() } : {}),
			...([p.city, p.state].filter((x) => x?.trim()).length ? { location: [p.city, p.state].filter((x) => x?.trim()).join(", ") } : {}),
			...(p.linkedin?.trim() ? { linkedin: p.linkedin.trim() } : {}),
		};

		const prepared = await call({ step: "prepare", profile });
		if (!prepared) return fail("preparing", "runner_unavailable");
		if (prepared.state === "failed") return fail("preparing", prepared.reason);
		if (prepared.state !== "prepared") return fail("preparing", "interrupted");
		await trace("prepared", { needsPassword: prepared.needsPassword });

		// The password goes into the vault BEFORE the form is submitted. It is provisional until the site accepts the registration.
		let password: string | undefined;
		if (prepared.needsPassword) {
			password = deps.password();
			credentialId = await createCredential(env, run.instanceId, uid, {
				domain: host,
				username: mailbox,
				password,
				loginUrl: run.pause?.url,
				provisional: true,
				comments: `Generated by the Application Runner on ${new Date(now).toISOString().split("T")[0]} for a registration on ${host} that has not been confirmed yet. Do not rely on it until this note changes.`,
			});
		}
		if (!(await move("preparing", "submitting", { mailbox, ...(credentialId ? { credentialId } : {}) }))) return { outcome: "waiting", run };

		const submitted = await call({ step: "submit", acceptTerms: entry.acceptTerms, ...(password ? { password } : {}) });
		if (!submitted) return fail("submitting", "runner_unavailable");
		if (submitted.state === "failed") return fail("submitting", submitted.reason);
		if (submitted.state === "created") return succeed("submitting", mailbox, credentialId, !credentialId);
		if (submitted.state === "code_requested") {
			await move("submitting", "code_requested", { requestedAt: now });
			await trace("code_requested", { mailbox });
			return { outcome: "waiting", run };
		}
		return fail("submitting", "interrupted");
	} catch {
		const row = await env.DB.prepare("SELECT state, credential_id FROM local_apply_account_creations WHERE run_id = ?1").bind(run.id).first<{ state: State; credential_id: string | null }>().catch(() => null);
		if (!row || row.state === "failed" || row.state === "created") return { outcome: "failed", run };
		credentialId = row.credential_id;
		return fail(row.state, row.state === "code_requested" ? "mailbox_unreadable" : "interrupted");
	}
}
