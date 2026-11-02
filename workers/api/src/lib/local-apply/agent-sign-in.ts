/**
 * #1412: the agent-driven sign-in — the cloud half.
 *
 * A fill run paused `login_required` used to be signed in by one of three hardcoded macros (the emailed
 * code, the vault password, account creation), each a fixed script over one page shape, each typing the
 * secret through the runner's raw browser tools. This hands the sign-in to the agent instead: the cloud
 * resolves what it may give the runner for that host — the vault login, or on SEEK the account address the
 * code goes to — and provisions it as NAMED secrets (`PAGS_LOGIN_USERNAME`, `PAGS_LOGIN_PASSWORD`, later
 * `PAGS_LOGIN_CODE`). The runner's Playwright MCP substitutes a name the CLI types with the value, so the
 * CLI signs in through its ordinary tools and never sees, says or stores a secret. When the CLI asks for an
 * emailed code (`request_sign_in_code`), the runner's status says so, this reads the code from the pinned
 * Gmail exactly as the email-code step does, and provisions it the same way.
 *
 * ## What is kept
 *
 * One row per run (migration 0311): the host, the vault credential id if one was used, when the code was
 * asked for and which message carried it, and the outcome. The trace names the secrets provisioned, never a
 * value. The macros stay beside this for an older runner that does not know the route; they go in #1422.
 */
import { callRuntime, getLiveRuntime, runtimeJson } from "../../routes/instances-runtime.js";
import type { Env } from "../../types.js";
import { listConnectorAccounts, pinnedAccountFor, resolveConnectorAccount } from "../connector-accounts.js";
import { connectorClient } from "../connectors/client.js";
import { emailPermitted } from "../connectors/gmail.js";
import { findCredentialForHost, passwordLoginForHost } from "../credentials.js";
import { logEvent } from "../events.js";
import { getMessage, listMessages } from "../gmail.js";
import { EMAIL_CODE_SIGN_IN_SITES, LOCAL_APPLY_SIGN_IN_SECRETS_PATH, type LocalApplySignInSecretName } from "./contract.js";
import { CODE_WAIT_MS, signInCodeIn } from "./email-code-sign-in.js";
import type { ApplicationRunnerSettings } from "./policy.js";
import { type ApplyRun, type ApplyTraceEvent, updateApplyRun } from "./store.js";

/** `provisioned` is the first sync's answer (the secrets just went over, read the run back now); `waiting` every later one. */
export type AgentSignInOutcome = "not_applicable" | "provisioned" | "waiting" | "signed_in" | "failed";

/** The runner's `signIn` status field (contract `LocalApplySignInState`), as the sync parsed it. */
export interface RunnerSignIn {
	origin: string;
	secrets: string[];
	codeRequested: boolean;
}

/** What one status sync brought back that this step reads: the sign-in state and the page of events. */
export interface AgentSignInSync {
	signIn: RunnerSignIn | null;
	events: ApplyTraceEvent[];
}

export interface AgentSignInDeps {
	credential(host: string): Promise<{ id: string; username?: string; password?: string } | null>;
	/** Is a password login stored for the host? Side-effect free, for the "will anything try" question. */
	hasCredential(host: string): Promise<boolean>;
	runner(path: string, body: unknown): Promise<{ status: number; body: unknown } | null>;
	mailbox(): Promise<{ list(query: string, max: number): Promise<readonly { id: string; date: string }[]>; read(id: string): Promise<{ subject: string; text: string }> }>;
}

type State = "signing_in" | "signed_in" | "failed";
interface Row {
	state: State;
	host: string;
	credential_id: string | null;
	code_requested_at: number | null;
	code_message_id: string | null;
	failure: string | null;
	updated_at: number;
}

/** A sign-in the runner stopped reporting on, with the run no longer running, is not still happening. */
const STALE_MS = 20 * 60_000;
/** How long after provisioning a `login_required` pause still reads as the one just answered, not a new wall. */
const WALL_GRACE_MS = 30_000;

const FAILURE_TEXT: Record<string, (host: string) => string> = {
	runner_outdated: () => "This machine's CLI is older than the agent-driven sign-in; update it (npm i -g @proagentstore/cli).",
	runner_unavailable: () => "The runner did not take the sign-in secrets.",
	not_at_wall: (h) => `The run was no longer paused at ${h}'s sign-in when the secrets were ready.`,
	not_signed_in: (h) => `The agent did not get past ${h}'s sign-in with the login it was given.`,
	email_not_permitted: () => "Email access is off for the Application Runner, so it cannot read the sign-in code. Turn it on under Settings → Permissions & Connections.",
	mailbox_unresolved: () => "No Gmail account is connected and pinned to the Application Runner, so the sign-in code could not be read.",
	mailbox_unreadable: () => "The mailbox could not be read for the sign-in code.",
	code_not_received: (h) => `${h} did not email a sign-in code within five minutes of the agent asking for one.`,
	interrupted: () => "The agent's sign-in was interrupted part-way.",
};

function defaultDeps(env: Env, run: ApplyRun, uid: string): AgentSignInDeps {
	return {
		credential: (host) => findCredentialForHost(env, run.instanceId, uid, host),
		hasCredential: async (host) => (await passwordLoginForHost(env, run.instanceId, uid, host)) !== null,
		runner: async (path, body) => {
			const runtime = await getLiveRuntime(env, run.instanceId, uid).catch(() => null);
			if (!runtime) return null;
			const res = await callRuntime(env, runtime, path, { method: "POST", body: JSON.stringify(body) }).catch(() => null);
			return res ? { status: res.status, body: await runtimeJson(res).catch(() => null) } : null;
		},
		mailbox: async () => {
			const token = await connectorClient(env, "gmail", { userId: uid, instanceId: run.instanceId }).token({ scope: "read" });
			return { list: (q, max) => listMessages(token, q, max), read: (id) => getMessage(token, id, 20_000) };
		},
	};
}

/** `au.seek.com` → `seek.com`: the longest listed emailed-code site the host is on, else null. */
function seekSite(domain: string): string | null {
	const d = domain.toLowerCase();
	return [...EMAIL_CODE_SIGN_IN_SITES].sort((a, b) => b.length - a.length).find((s) => d === s || d.endsWith(`.${s}`)) ?? null;
}

/** The Gmail search for the host's sign-in mail: SEEK's three senders, else the host's registrable domain. */
export function senderQuery(host: string): string {
	if (seekSite(host)) return "from:(seek.com.au OR seek.com OR seek.co.nz)";
	return `from:${host.split(".").slice(-2).join(".")}`;
}

/** A paused sign-in with a host to sign in to. Pure, so the gate is tested as a gate. */
export function agentSignInApplies(run: Pick<ApplyRun, "status" | "pause">): boolean {
	return run.status === "paused" && run.pause?.reason === "login_required" && typeof run.pause.domain === "string" && run.pause.domain.length > 0;
}

/** The runner's status `signIn` field, or null when absent or not the shape the contract states. */
export function parseRunnerSignIn(raw: unknown): RunnerSignIn | null {
	const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
	if (!o) return null;
	if (o.state !== "signing_in") return null;
	return {
		// A hostname, or nothing: a value longer than one is not cut into a wrong one.
		origin: typeof o.origin === "string" && o.origin.length <= 253 ? o.origin : "",
		secrets: Array.isArray(o.secrets) ? o.secrets.filter((s): s is string => typeof s === "string") : [],
		codeRequested: o.codeRequested === true,
	};
}

/** Did this page of runner events carry the runner's own "signed in" verdict for the agent's sign-in? */
export function signedInEventIn(events: readonly ApplyTraceEvent[]): boolean {
	return events.some((e) => e.type === "policy.decision" && e.detail?.tool === "agent_sign_in" && e.detail?.decision === "signed_in");
}

/** What the cloud may hand over for the paused host: the vault login first, else on SEEK the account address the code goes to. */
async function provisionable(env: Env, run: ApplyRun, settings: Pick<ApplicationRunnerSettings, "signInEmail">, deps: AgentSignInDeps, peek: boolean): Promise<{ secrets: Partial<Record<LocalApplySignInSecretName, string>>; credentialId: string | null } | null> {
	const host = run.pause?.domain as string;
	if (peek) {
		// The "will it try" question must not read the vault: a read stamps the credential as used.
		if (await deps.hasCredential(host).catch(() => false)) return { secrets: {}, credentialId: null };
	} else {
		const cred = await deps.credential(host).catch(() => null);
		if (cred?.username && cred.password) return { secrets: { PAGS_LOGIN_USERNAME: cred.username, PAGS_LOGIN_PASSWORD: cred.password }, credentialId: cred.id };
	}
	if (seekSite(host) && settings.signInEmail && (await emailPermitted(env, run.instanceId).catch(() => false))) return { secrets: { PAGS_LOGIN_USERNAME: settings.signInEmail }, credentialId: null };
	return null;
}

/** Will the agent-driven sign-in act on this pause (so the owner is not alerted yet)? Reads nothing it would type. */
export async function agentSignInWillTry(env: Env, uid: string, run: ApplyRun, settings: Pick<ApplicationRunnerSettings, "signInEmail">, deps: AgentSignInDeps = defaultDeps(env, run, uid)): Promise<boolean> {
	if (!agentSignInApplies(run)) return false;
	const row = await env.DB.prepare("SELECT state FROM local_apply_agent_sign_ins WHERE run_id = ?1").bind(run.id).first<Pick<Row, "state">>().catch(() => null);
	if (row) return row.state === "signing_in";
	return (await provisionable(env, run, settings, deps, true)) !== null;
}

/**
 * Advance the agent-driven sign-in by one sync. On the first `login_required` pause it provisions the login
 * and returns `waiting`; while the runner reports `signing_in` it reads the emailed code when asked for;
 * the runner's own `signed_in` event settles it. A second wall while it was the agent's job is a failure.
 */
export async function advanceAgentSignIn(
	env: Env,
	uid: string,
	run: ApplyRun,
	settings: Pick<ApplicationRunnerSettings, "signInEmail">,
	sync: AgentSignInSync,
	now: number,
	deps: AgentSignInDeps = defaultDeps(env, run, uid),
): Promise<{ outcome: AgentSignInOutcome; run: ApplyRun }> {
	const row = await env.DB.prepare("SELECT state, host, credential_id, code_requested_at, code_message_id, failure, updated_at FROM local_apply_agent_sign_ins WHERE run_id = ?1").bind(run.id).first<Row>();
	const host = row?.host ?? (typeof run.pause?.domain === "string" ? run.pause.domain : "");
	const trace = async (decision: string, detail: Record<string, string | number | boolean> = {}): Promise<void> => {
		const event: ApplyTraceEvent = { type: "policy.decision", at: new Date(now).toISOString(), ...(host ? { domain: host } : {}), detail: { tool: "agent_sign_in", class: "session", source: "platform", decision, ...detail } };
		run = (await updateApplyRun(env, run, { events: [event] }, now)) ?? run;
	};
	const settle = (from: State, to: State, set: { failure?: string } = {}) =>
		env.DB.prepare("UPDATE local_apply_agent_sign_ins SET state = ?3, failure = COALESCE(?4, failure), updated_at = ?5 WHERE run_id = ?1 AND state = ?2")
			.bind(run.id, from, to, set.failure ?? null, now)
			.run()
			.then((r) => (r.meta?.changes ?? 0) > 0);
	const fail = async (reason: string): Promise<{ outcome: AgentSignInOutcome; run: ApplyRun }> => {
		if (!(await settle("signing_in", "failed", { failure: reason }))) return { outcome: "waiting", run };
		await trace("failed", { reason: FAILURE_TEXT[reason]?.(host) ?? reason, rule: reason });
		return { outcome: "failed", run };
	};

	try {
		if (!row) {
			if (!agentSignInApplies(run)) return { outcome: "not_applicable", run };
			const offer = await provisionable(env, run, settings, deps, false);
			if (!offer) return { outcome: "not_applicable", run };
			// One attempt per run: whoever inserts the row provisions; a racing sync reads it and waits.
			const claimed = ((await env.DB.prepare(
				"INSERT INTO local_apply_agent_sign_ins (run_id, instance_id, user_id, host, credential_id, state, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, 'signing_in', ?6, ?6) ON CONFLICT DO NOTHING",
			)
				.bind(run.id, run.instanceId, uid, host, offer.credentialId, now)
				.run()).meta?.changes ?? 0) > 0;
			if (!claimed) return { outcome: "waiting", run };
			const names = Object.keys(offer.secrets);
			const res = await deps.runner(LOCAL_APPLY_SIGN_IN_SECRETS_PATH, { runId: run.id, secrets: offer.secrets });
			const taken = res?.status === 200 && !!parseRunnerSignIn((res.body as { signIn?: unknown } | null)?.signIn);
			// Each use of a stored login is recorded: the host and what came of it, never the username or the password.
			if (offer.credentialId) await logEvent(env, { source: "credentials", event: "credential.use", message: `Handed the login for ${host} to the agent's sign-in: ${taken ? "provisioned" : "not taken"}`, userId: uid, instanceId: run.instanceId, context: { host, credentialId: offer.credentialId, runId: run.id, via: "local_apply_agent", outcome: taken ? "provisioned" : "not_taken" } }).catch(() => undefined);
			if (!taken) {
				// The macros still get their turn (#1422 retires them): this attempt is recorded and stays out of their way.
				await fail(res === null ? "runner_unavailable" : res.status === 404 ? "runner_outdated" : "not_at_wall");
				return { outcome: "not_applicable", run };
			}
			await trace("provisioned", { reason: names.join(","), ...(offer.credentialId ? { basis: "vault" } : { basis: "sign_in_email" }) });
			return { outcome: "provisioned", run };
		}
		if (row.state !== "signing_in") return { outcome: "not_applicable", run };
		if (signedInEventIn(sync.events)) {
			if (!(await settle("signing_in", "signed_in"))) return { outcome: "waiting", run };
			await trace("signed_in");
			return { outcome: "signed_in", run };
		}
		// A wall again while the sign-in was the agent's: it did not get in. The owner hears of it from the caller. The
		// first half-minute is the provisioning's own release landing in the run record, not a new wall.
		if (run.status === "paused" && run.pause?.reason === "login_required") return now - row.updated_at < WALL_GRACE_MS ? { outcome: "waiting", run } : fail("not_signed_in");
		if (sync.signIn?.codeRequested && !row.code_message_id) {
			const requestedAt = row.code_requested_at ?? now;
			if (!row.code_requested_at) {
				await env.DB.prepare("UPDATE local_apply_agent_sign_ins SET code_requested_at = ?2, updated_at = ?2 WHERE run_id = ?1").bind(run.id, now).run();
				await trace("code_requested");
			}
			if (!(await emailPermitted(env, run.instanceId))) return fail("email_not_permitted");
			const resolved = resolveConnectorAccount(await listConnectorAccounts(env, uid, "gmail"), await pinnedAccountFor(env, run.instanceId, "gmail"), "Gmail");
			if (!resolved.ok || !resolved.account.accountId) return fail("mailbox_unresolved");
			const mailbox = resolved.account.accountId.toLowerCase();
			const mail = await deps.mailbox();
			// A mail sent before the code was asked for is an old code; two minutes of clock skew either way.
			const hits = (await mail.list(`${senderQuery(host)} newer_than:1d`, 5)).filter((h) => Date.parse(h.date) >= requestedAt - 120_000);
			for (const hit of hits) {
				const msg = await mail.read(hit.id);
				const code = signInCodeIn(msg.subject, msg.text);
				if (!code) continue;
				const res = await deps.runner(LOCAL_APPLY_SIGN_IN_SECRETS_PATH, { runId: run.id, secrets: { PAGS_LOGIN_CODE: code } });
				if (res?.status !== 200) return fail("runner_unavailable");
				await env.DB.prepare("UPDATE local_apply_agent_sign_ins SET code_message_id = ?2, updated_at = ?3 WHERE run_id = ?1").bind(run.id, hit.id, now).run();
				await trace("code_read", { mailbox, messageId: hit.id });
				return { outcome: "waiting", run };
			}
			if (now - requestedAt > CODE_WAIT_MS) return fail("code_not_received");
			return { outcome: "waiting", run };
		}
		if (run.status !== "running" && now - row.updated_at > STALE_MS) return fail("interrupted");
		return { outcome: "waiting", run };
	} catch {
		const current = await env.DB.prepare("SELECT state, code_requested_at FROM local_apply_agent_sign_ins WHERE run_id = ?1").bind(run.id).first<Pick<Row, "state" | "code_requested_at">>().catch(() => null);
		if (current?.state !== "signing_in") return { outcome: current ? "not_applicable" : "failed", run };
		return fail(current.code_requested_at ? "mailbox_unreadable" : "interrupted");
	}
}
