/**
 * Why no automatic sign-in ran at a `login_required` pause (#1408).
 *
 * The three sign-in drivers (`email-code-sign-in.ts`, `vault-sign-in.ts`, `account-creation.ts`)
 * already decide, per pause, whether each of them has something to try — but a `not_applicable`
 * exit from any of them returns SILENTLY. `emailCodeApplies` requires a `signInEmail` the owner
 * never set; `accountCreationApplies` requires a setting that defaults off. Nothing told the owner
 * WHICH of those gates was closed, so a pause with no sign-in email configured looked exactly like
 * a pause on a site that genuinely needs a human — the owner could not tell a missing setting from
 * a site problem.
 *
 * This computes one read-only snapshot of all three gates, from settings and the vault, BEFORE any
 * mechanism acts — so it is a description of the DECISION, not a report of what happened to try it.
 * It changes which mechanism runs NOT AT ALL: every `*Applies`/`*CanTry` check this reads from is
 * untouched, called exactly as the drivers already call them.
 */
import type { Env } from "../../types.js";
import { listConnectorAccounts, pinnedAccountFor, resolveConnectorAccount } from "../connector-accounts.js";
import { emailPermitted } from "../connectors/gmail.js";
import { passwordLoginForHost } from "../credentials.js";
import { sqlTimeMs } from "../sql-time.js";
import { accountCreationHostFor } from "./account-creation-hosts.js";
import { seekSite } from "./email-code-sign-in.js";
import type { ApplicationRunnerSettings } from "./policy.js";
import type { ApplyRun } from "./store.js";

export type LoginReadinessEmail = "permitted" | "not_permitted" | "sign_in_email_unset" | "mailbox_mismatch" | "not_supported_site";
export type LoginReadinessVault = "stored" | "absent" | "wrong_password_earlier";
export type LoginReadinessAccountCreation = "enabled" | "disabled" | "host_not_allowed";
export type LoginReadinessNextAction = "set_sign_in_email" | "store_login_for_host" | "enable_account_creation" | "take_over" | "wait_for_code";

export interface LoginReadiness {
	/** Hostname only — never the full URL (#1069's own rule, applied here too). */
	host: string;
	email: LoginReadinessEmail;
	vault: LoginReadinessVault;
	accountCreation: LoginReadinessAccountCreation;
	nextAction: LoginReadinessNextAction;
}

/**
 * The single next-best lever — in the same priority order the mechanisms themselves try (the
 * email code first on a supported site, then the vault, then account creation) — so the owner is
 * never pointed at a setting that would not actually change anything right now.
 *
 * `wait_for_code` covers "an automatic attempt applies and has not failed yet" generally, not only
 * literally waiting on an emailed code: by the time this value is ever SHOWN to the owner (only
 * when nothing will clear the pause by itself — see `apply.ts:707`), nothing automatic is still in
 * flight, so this value never actually reaches them for the vault/account-creation cases below; it
 * only matters for what the readiness EVENT records at the moment of the pause, before that is known.
 *
 *   • `wrong_password_earlier` ALWAYS says `store_login_for_host` (a FRESH password), whatever
 *     account creation is set to: the site explicitly refused a login, which means an account
 *     already exists — creating a second one is not the fix.
 *   • `absent` (no credential at all, so it is genuinely unknown whether an account exists) looks
 *     at account creation to decide: disabled → the simpler toggle, `enable_account_creation`;
 *     host_not_allowed → the only thing left to suggest is `store_login_for_host`; enabled → it
 *     will be tried automatically, so `take_over` (nothing more specific, same as a stored vault
 *     login below).
 *
 * Pure.
 */
export function loginReadinessNextAction(r: Pick<LoginReadiness, "email" | "vault" | "accountCreation">): LoginReadinessNextAction {
	if (r.email === "permitted") return "wait_for_code";
	if (r.email === "sign_in_email_unset" || r.email === "mailbox_mismatch") return "set_sign_in_email";
	if (r.vault === "stored") return "take_over";
	if (r.vault === "wrong_password_earlier") return "store_login_for_host";
	// r.vault === "absent" from here.
	if (r.accountCreation === "disabled") return "enable_account_creation";
	if (r.accountCreation === "host_not_allowed") return "store_login_for_host";
	return "take_over"; // accountCreation === "enabled": it will be tried automatically.
}

/**
 * The email gate, read-only — the same checks `advanceEmailCodeSignIn`'s claimed branch makes
 * before it attempts anything, without claiming the run or sending the runner anything.
 */
async function readEmailReadiness(env: Env, uid: string, run: Pick<ApplyRun, "instanceId" | "pause">, settings: Pick<ApplicationRunnerSettings, "signInEmail">): Promise<LoginReadinessEmail> {
	if (!seekSite(run.pause?.domain)) return "not_supported_site";
	const signInEmail = settings.signInEmail;
	if (!signInEmail) return "sign_in_email_unset";
	if (!(await emailPermitted(env, run.instanceId))) return "not_permitted";
	const resolved = resolveConnectorAccount(await listConnectorAccounts(env, uid, "gmail"), await pinnedAccountFor(env, run.instanceId, "gmail"), "Gmail");
	const mailbox = resolved.ok && resolved.account.accountId ? resolved.account.accountId.toLowerCase() : null;
	// No resolvable mailbox at all is folded into `mailbox_mismatch`: the fixed vocabulary has no
	// separate slot for "unresolved", and "the configured address has no usable, pinned mailbox" is
	// the same owner-facing gap either way — connect/pin the right one, or correct the address.
	return mailbox && mailbox === signInEmail.toLowerCase() ? "permitted" : "mailbox_mismatch";
}

/** The vault gate, read-only — the same checks `vaultSignInCanTry` makes, without claiming the run. */
async function readVaultReadiness(env: Env, uid: string, run: Pick<ApplyRun, "id" | "instanceId" | "pause">): Promise<LoginReadinessVault> {
	const host = run.pause?.domain;
	if (!host) return "absent";
	const cred = await passwordLoginForHost(env, run.instanceId, uid, host);
	if (!cred) return "absent";
	const refused = await env.DB.prepare("SELECT MAX(created_at) AS at FROM local_apply_vault_sign_ins WHERE instance_id = ?1 AND host = ?2 AND failure = 'wrong_password'")
		.bind(run.instanceId, host)
		.first<{ at: number | null }>();
	return refused?.at && refused.at >= sqlTimeMs(cred.updatedAt) ? "wrong_password_earlier" : "stored";
}

/** The account-creation gate, read-only — the same three checks `accountCreationApplies` makes, in the same order. */
function readAccountCreationReadiness(run: Pick<ApplyRun, "pause">, settings: Pick<ApplicationRunnerSettings, "accountCreation">): LoginReadinessAccountCreation {
	if (settings.accountCreation !== true) return "disabled";
	const entry = run.pause?.domain ? accountCreationHostFor(run.pause.domain) : null;
	return entry?.enabled ? "enabled" : "host_not_allowed";
}

/**
 * One readiness snapshot for a `login_required` pause — values only, never a username, address,
 * code or password, and `host` is a hostname only. Read-only: every check here is the SAME gate
 * the real driver uses, called without claiming the run or sending the runner anything, so this
 * can be computed and recorded before any of them gets to act.
 */
export async function computeLoginReadiness(
	env: Env,
	uid: string,
	run: Pick<ApplyRun, "id" | "instanceId" | "pause">,
	settings: Pick<ApplicationRunnerSettings, "signInEmail" | "accountCreation">,
): Promise<LoginReadiness> {
	const host = run.pause?.domain ?? "";
	const [email, vault] = await Promise.all([readEmailReadiness(env, uid, run, settings), readVaultReadiness(env, uid, run)]);
	const accountCreation = readAccountCreationReadiness(run, settings);
	return { host, email, vault, accountCreation, nextAction: loginReadinessNextAction({ email, vault, accountCreation }) };
}

/** The readiness as a flat trace/action-log detail record — every value a fixed enum string or a hostname, nothing else. */
export function loginReadinessDetail(r: LoginReadiness): Record<string, string> {
	return { host: r.host, email: r.email, vault: r.vault, accountCreation: r.accountCreation, nextAction: r.nextAction };
}

const NEXT_ACTION_TEXT: Record<LoginReadinessNextAction, string> = {
	set_sign_in_email: "Set the sign-in email for this site under Application Runner settings so it can sign in by itself.",
	store_login_for_host: "Save a login for this site under Knowledge → Credentials so it can sign in by itself.",
	enable_account_creation: "Turn on account creation under Application Runner settings so it can register an account by itself.",
	wait_for_code: "It is already trying to sign in by itself; give it a moment.",
	take_over: "Open the live browser and sign in yourself.",
};

/** The one sentence a notification adds to name the readiness's next lever, in plain English. */
export function nextActionText(action: LoginReadinessNextAction): string {
	return NEXT_ACTION_TEXT[action];
}
