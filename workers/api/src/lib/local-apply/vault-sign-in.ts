/**
 * The vault sign-in (#1229, #1226 asks 1/4): a fill run paused `login_required` on a host with a stored password login signs itself in.
 *
 * The Application Runner that hits sign-in walls is the `local_apply` runtime — a CLI driving the owner's browser — and it never read the
 * vault (only the legacy cloud apply route did). Now, at a `login_required` pause, the cloud reads the owner's credential for the host
 * (`findCredentialForHost`, owner-scoped), sends it in ONE request to the runner, which types it into the paused run's own page and
 * releases the pause once the site lets the browser in (packages/browser-runner/src/local-apply/vault-sign-in.ts). The CLI never sees it.
 *
 * ## One attempt, no loops
 *
 * A row per run is claimed BEFORE the credential is read, so two syncs never type it twice. A CAPTCHA, a second factor or a wrong password
 * ends the attempt with its reason and the caller sends the owner the ordinary sign-in handoff, once. A password the site REFUSED is also
 * not tried again on a later run until the owner changes it: repeated bad logins are how accounts get locked.
 *
 * ## Which sign-in goes first
 *
 * SEEK with a `signInEmail` is the email-code path (#1106) — a code needs no password. If that attempt FAILED, the vault is tried next.
 * Every other host goes straight here when a password login is stored for it.
 *
 * ## What is kept
 *
 * The host, the id of the credential, the outcome. Each use stamps the credential's `lastUsedAt` (inside `findCredentialForHost`) and
 * writes a `credential.use` event naming the host and the outcome — never the username or the password, as `credential.reveal` does.
 */
import type { Env } from "../../types.js";
import { callRuntime, getLiveRuntime, runtimeJson } from "../../routes/instances-runtime.js";
import { findCredentialForHost, passwordLoginForHost } from "../credentials.js";
import { logEvent } from "../events.js";
import { sqlTimeMs } from "../sql-time.js";
import { LOCAL_APPLY_VAULT_SIGN_IN_PATH, type LocalApplyVaultSignInResult } from "./contract.js";
import { emailCodeApplies } from "./email-code-sign-in.js";
import type { ApplicationRunnerSettings } from "./policy.js";
import { type ApplyRun, type ApplyTraceEvent, updateApplyRun } from "./store.js";

/** A step a Worker died in the middle of is not waited on forever. */
const STALE_STEP_MS = 3 * 60_000;

type State = "signing_in" | "signed_in" | "failed";
export type VaultSignInOutcome = "not_applicable" | "waiting" | "signed_in" | "failed";

interface Row {
	state: State;
	failure: string | null;
	updated_at: number;
}

/** What the attempt needs from the outside: the credential and the runner. Injected in tests. */
export interface VaultSignInDeps {
	credential(host: string): Promise<{ id: string; username?: string; password?: string } | null>;
	runner(path: string, body: unknown): Promise<{ status: number; body: unknown } | null>;
}

function defaultDeps(env: Env, run: ApplyRun, uid: string): VaultSignInDeps {
	return {
		credential: (host) => findCredentialForHost(env, run.instanceId, uid, host),
		runner: async (path, body) => {
			const runtime = await getLiveRuntime(env, run.instanceId, uid).catch(() => null);
			if (!runtime) return null;
			const res = await callRuntime(env, runtime, path, { method: "POST", body: JSON.stringify(body) }).catch(() => null);
			return res ? { status: res.status, body: await runtimeJson(res).catch(() => null) } : null;
		},
	};
}

const FAILURE_TEXT: Record<string, (host: string) => string> = {
	credential_unreadable: (h) => `The stored login for ${h} could not be read (it may need to be saved again under Knowledge → Credentials).`,
	runner_unavailable: () => "The runner did not answer the vault sign-in. If this machine's CLI is older than this feature, update it (npm i -g @proagentstore/cli).",
	interrupted: () => "The vault sign-in was interrupted part-way.",
	host_mismatch: (h) => `The paused page was not on ${h}, so the stored login was not typed.`,
	no_username_field: (h) => `${h}'s sign-in page had no username or email box where one was expected.`,
	no_password_field: (h) => `${h}'s sign-in page showed no password box after the username.`,
	no_submit_button: (h) => `${h}'s sign-in page had no sign-in button the runner could tell from "sign in with Google" and the like.`,
	captcha: (h) => `${h} asked for a CAPTCHA or other proof of a human. It was not worked around.`,
	two_factor: (h) => `${h} asked for a second factor (a code). Sign in yourself this once.`,
	wrong_password: (h) => `${h} refused the stored password. It will not be tried again until you change it under Knowledge → Credentials.`,
	not_signed_in: (h) => `${h} did not let the browser in after the stored login was entered.`,
};

/** A paused sign-in with a host to sign in to. Pure, so the gate is tested as a gate. */
export function vaultSignInApplies(run: Pick<ApplyRun, "status" | "pause">): boolean {
	return run.status === "paused" && run.pause?.reason === "login_required" && !!run.pause.domain;
}

/** Did the email-code sign-in already FAIL for this run (so the vault is the next try)? */
async function emailCodeFailed(env: Pick<Env, "DB">, runId: string): Promise<boolean> {
	return !!(await env.DB.prepare("SELECT 1 FROM local_apply_email_sign_ins WHERE run_id = ?1 AND state = 'failed'").bind(runId).first());
}

/**
 * Is there something the vault can try — a stored password login for the host, no attempt yet on this run, and a password the site has not
 * already refused? Asked before the owner is alerted, so a sign-in that may clear itself is not the owner's yet.
 */
export async function vaultSignInCanTry(env: Env, uid: string, run: Pick<ApplyRun, "id" | "instanceId" | "status" | "pause">): Promise<boolean> {
	if (!vaultSignInApplies(run)) return false;
	const host = run.pause?.domain as string;
	const cred = await passwordLoginForHost(env, run.instanceId, uid, host);
	if (!cred) return false;
	if (await env.DB.prepare("SELECT 1 FROM local_apply_vault_sign_ins WHERE run_id = ?1").bind(run.id).first()) return false;
	// A password the site refused is not tried again until the owner has changed it.
	const refused = await env.DB.prepare("SELECT MAX(created_at) AS at FROM local_apply_vault_sign_ins WHERE instance_id = ?1 AND host = ?2 AND failure = 'wrong_password'").bind(run.instanceId, host).first<{ at: number | null }>();
	if (refused?.at && refused.at >= sqlTimeMs(cred.updatedAt)) return false;
	return true;
}

/** Will this pause be tried from the vault — so the owner is not alerted yet? The email code goes first on SEEK when the owner set it up. */
export async function vaultSignInWillTry(env: Env, uid: string, run: Pick<ApplyRun, "id" | "instanceId" | "status" | "pause">, settings: Pick<ApplicationRunnerSettings, "signInEmail">): Promise<boolean> {
	if (emailCodeApplies(run, settings)) return false;
	return vaultSignInCanTry(env, uid, run);
}

/**
 * Try the vault sign-in for one paused run, at most once. Never throws: a failure is an outcome, and `failed` is the caller's cue to hand
 * the sign-in to the owner. Returns the run with any trace events written, so the caller does not write back a stale trace.
 */
export async function advanceVaultSignIn(
	env: Env,
	uid: string,
	run: ApplyRun,
	settings: Pick<ApplicationRunnerSettings, "signInEmail">,
	now: number,
	deps: VaultSignInDeps = defaultDeps(env, run, uid),
): Promise<{ outcome: VaultSignInOutcome; run: ApplyRun }> {
	if (!vaultSignInApplies(run)) return { outcome: "not_applicable", run };
	// The email code has the SEEK sign-in until it has failed.
	if (emailCodeApplies(run, settings) && !(await emailCodeFailed(env, run.id))) return { outcome: "not_applicable", run };
	const host = run.pause?.domain as string;
	const trace = async (decision: string, detail: Record<string, string | number | boolean> = {}): Promise<void> => {
		const event: ApplyTraceEvent = { type: "policy.decision", at: new Date(now).toISOString(), domain: host, detail: { tool: "vault_sign_in", class: "session", source: "platform", decision, ...detail } };
		run = (await updateApplyRun(env, run, { events: [event] }, now)) ?? run;
	};
	const settle = (from: State, to: State, set: { credentialId?: string; failure?: string } = {}) =>
		env.DB.prepare("UPDATE local_apply_vault_sign_ins SET state = ?3, credential_id = COALESCE(?4, credential_id), failure = COALESCE(?5, failure), updated_at = ?6 WHERE run_id = ?1 AND state = ?2")
			.bind(run.id, from, to, set.credentialId ?? null, set.failure ?? null, now)
			.run()
			.then((r) => (r.meta?.changes ?? 0) > 0);
	const fail = async (reason: string, credentialId: string | null = null): Promise<{ outcome: VaultSignInOutcome; run: ApplyRun }> => {
		if (!(await settle("signing_in", "failed", { failure: reason, ...(credentialId ? { credentialId } : {}) }))) return { outcome: "waiting", run };
		await trace("failed", { reason: FAILURE_TEXT[reason]?.(host) ?? reason, rule: reason });
		return { outcome: "failed", run };
	};

	try {
		const existing = await env.DB.prepare("SELECT state, failure, updated_at FROM local_apply_vault_sign_ins WHERE run_id = ?1").bind(run.id).first<Row>();
		if (existing) {
			if (existing.state === "signing_in" && now - existing.updated_at > STALE_STEP_MS) return fail("interrupted");
			// Settled earlier: nothing more to do here, and the owner was told when it failed.
			return { outcome: existing.state === "signing_in" ? "waiting" : "not_applicable", run };
		}
		if (!(await vaultSignInCanTry(env, uid, run))) return { outcome: "not_applicable", run };

		// One attempt per run: whoever inserts the row types the credential; a racing sync reads it and waits.
		const claimed = ((await env.DB.prepare(
			"INSERT INTO local_apply_vault_sign_ins (run_id, instance_id, user_id, host, state, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'signing_in', ?5, ?5) ON CONFLICT DO NOTHING",
		)
			.bind(run.id, run.instanceId, uid, host, now)
			.run()).meta?.changes ?? 0) > 0;
		if (!claimed) return { outcome: "waiting", run };

		const cred = await deps.credential(host);
		if (!cred?.username || !cred.password) return fail("credential_unreadable");
		await env.DB.prepare("UPDATE local_apply_vault_sign_ins SET credential_id = ?2 WHERE run_id = ?1").bind(run.id, cred.id).run();

		const res = await deps.runner(LOCAL_APPLY_VAULT_SIGN_IN_PATH, { runId: run.id, host, username: cred.username, password: cred.password });
		const result = res?.status === 200 ? (res.body as LocalApplyVaultSignInResult | null) : null;
		const outcome = result?.state === "signed_in" ? "signed_in" : result?.state === "failed" ? result.reason : "runner_unavailable";
		// Each use is recorded: the host and what came of it, never the username or the password (as `credential.reveal` does).
		await logEvent(env, { source: "credentials", event: "credential.use", message: `Signed in to ${host} from the vault: ${outcome}`, userId: uid, instanceId: run.instanceId, context: { host, credentialId: cred.id, runId: run.id, via: "local_apply", outcome } }).catch(() => undefined);
		if (result?.state !== "signed_in") return fail(outcome, cred.id);
		await settle("signing_in", "signed_in", { credentialId: cred.id });
		await trace("signed_in", { credentialId: cred.id });
		return { outcome: "signed_in", run };
	} catch {
		const row = await env.DB.prepare("SELECT state, failure, updated_at FROM local_apply_vault_sign_ins WHERE run_id = ?1").bind(run.id).first<Row>().catch(() => null);
		if (row?.state !== "signing_in") return { outcome: row ? "not_applicable" : "failed", run };
		return fail("interrupted");
	}
}
