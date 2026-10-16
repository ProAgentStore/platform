/**
 * The email-code sign-in (#1106): a fill run paused for a SEEK sign-in signs itself in, with no takeover.
 *
 * SEEK signs a jobseeker in with a one-time code emailed to the account address. Before this, a SEEK
 * fill with no session paused `login_required` (#1094) and only the owner, taking the browser over,
 * could move it — four runs of application b8586cf8 (2026-10-15) each sat 20 minutes and ended
 * `blocked`. Now each sync of such a pause moves one durable state machine forward:
 *
 *   requesting ──runner: enter the address, "Email me a sign in code"──▶ code_requested
 *   code_requested ──the code read from the pinned Gmail──▶ entering ──runner: type it──▶ signed_in
 *
 * The runner releases its own pause once SEEK lets the browser in, and the bridge records the session
 * as after an owner's sign-in, so the next fill presses without asking.
 *
 * ## Which address, which inbox
 *
 * The code goes to whatever address the SEEK ACCOUNT uses, so it is never guessed from the profile or
 * the résumé: the owner names it (`applicationRunner.signInEmail`). It must also be the Gmail mailbox
 * this Runner is pinned to (#715) — otherwise the code lands in an inbox PAGS does not read, and the run
 * says so (`mailbox_mismatch`) instead of waiting for a mail that cannot arrive.
 *
 * ## What is read and kept
 *
 * One search (SEEK senders, the last day) and ONE message: the newest SEEK mail that arrived after the
 * code was asked for and names a code. Through the owner's `permissions.email` switch and the pinned
 * account, the same gates as the Gmail tools (#1095). The trace and the row keep the mailbox and the
 * Gmail message id; the code passes through one request to the runner and is never stored or traced.
 *
 * Anything else — no permission, a mailbox that is not the SEEK address, an older runner, a page that is
 * not as expected, no code within {@link CODE_WAIT_MS} — ends `failed` with its reason, and the caller
 * sends the owner the ordinary sign-in handoff, once. One attempt per run.
 */
import { listConnectorAccounts, pinnedAccountFor, resolveConnectorAccount } from "../connector-accounts.js";
import { connectorClient } from "../connectors/client.js";
import { emailPermitted } from "../connectors/gmail.js";
import { getMessage, listMessages } from "../gmail.js";
import type { Env } from "../../types.js";
import { callRuntime, getLiveRuntime, runtimeJson } from "../../routes/instances-runtime.js";
import { EMAIL_CODE_SIGN_IN_SITES, LOCAL_APPLY_EMAIL_CODE_PATH, type LocalApplyEmailCodeResult } from "./contract.js";
import { type ApplicationRunnerSettings } from "./policy.js";
import { type ApplyRun, type ApplyTraceEvent, updateApplyRun } from "./store.js";

/** How long after asking for a code it may take to arrive. SEEK's mail usually lands within a minute. */
export const CODE_WAIT_MS = 5 * 60_000;
/** A step a Worker died in the middle of is not waited on forever. */
const STALE_STEP_MS = 3 * 60_000;
const SEEK_SENDERS = "from:(seek.com.au OR seek.com OR seek.co.nz)";

type State = "requesting" | "code_requested" | "entering" | "signed_in" | "failed";
export type EmailSignInOutcome = "not_applicable" | "waiting" | "signed_in" | "failed";

interface Row {
	state: State;
	mailbox: string | null;
	requested_at: number | null;
	updated_at: number;
}

/** What the state machine needs from the outside: the runner and the mailbox. Injected in tests. */
export interface EmailSignInDeps {
	runner(path: string, body: unknown): Promise<{ status: number; body: unknown } | null>;
	mailbox(): Promise<{ list(query: string, max: number): Promise<readonly { id: string; date: string }[]>; read(id: string): Promise<{ subject: string; text: string }> }>;
}

function defaultDeps(env: Env, run: ApplyRun, uid: string): EmailSignInDeps {
	return {
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

/** `au.seek.com` → `seek.com`, `www.seek.com.au` → `seek.com.au`: the longest listed site the host is on. */
function seekSite(domain: string | undefined): string | null {
	const host = (domain ?? "").toLowerCase();
	return [...EMAIL_CODE_SIGN_IN_SITES].sort((a, b) => b.length - a.length).find((s) => host === s || host.endsWith(`.${s}`)) ?? null;
}

/** Does this pause go to the email-code sign-in at all? Pure, so the gate is tested as a gate. */
export function emailCodeApplies(run: Pick<ApplyRun, "status" | "pause">, settings: Pick<ApplicationRunnerSettings, "signInEmail">): boolean {
	return run.status === "paused" && run.pause?.reason === "login_required" && !!settings.signInEmail && !!seekSite(run.pause.domain);
}

/** Will this pause be tried with the email code — so the owner is not alerted yet? Not when this run already tried once. */
export async function emailCodeWillTry(env: Pick<Env, "DB">, run: Pick<ApplyRun, "id" | "status" | "pause">, settings: Pick<ApplicationRunnerSettings, "signInEmail">): Promise<boolean> {
	if (!emailCodeApplies(run, settings)) return false;
	return !(await env.DB.prepare("SELECT 1 FROM local_apply_email_sign_ins WHERE run_id = ?1").bind(run.id).first());
}

/**
 * The sign-in code in a SEEK mail, or null. Anchored to the word "code" — a SEEK mail is full of job ids
 * and salaries, and a bare six-digit number is not a code.
 */
export function signInCodeIn(subject: string, text: string): string | null {
	for (const s of [subject, text.replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/gi, " ")]) {
		const after = s.match(/\bcode\b\D{0,40}?\b(\d{4,8})\b/i);
		if (after) return after[1];
		const before = s.match(/\b(\d{4,8})\b\s*(?:is|was)\s+your\b[^.\n]{0,40}\bcode\b/i);
		if (before) return before[1];
	}
	return null;
}

const FAILURE_TEXT: Record<string, (ctx: { email: string; mailbox: string | null }) => string> = {
	email_not_permitted: () => "Email access is off for the Application Runner, so it cannot read SEEK's sign-in code. Turn it on under Settings → Permissions & Connections.",
	mailbox_unresolved: () => "The Application Runner cannot tell which Gmail mailbox to read. Pin one under its connector accounts.",
	mailbox_mismatch: ({ email, mailbox }) => `SEEK sends its sign-in code to ${email}, but this Application Runner reads ${mailbox ?? "another mailbox"}. Connect ${email}'s Gmail and pin it to the Runner, or correct the SEEK sign-in email.`,
	runner_unavailable: () => "The runner did not answer the email-code sign-in. If this machine's CLI is older than this feature, update it (npm i -g @proagentstore/cli) and sign in through the handoff.",
	code_not_received: ({ email, mailbox }) => `No SEEK sign-in code reached ${mailbox ?? email} within ${CODE_WAIT_MS / 60_000} minutes of asking for one for ${email}. If your SEEK account uses another address, set that as the SEEK sign-in email and connect its Gmail.`,
	interrupted: () => "The email-code sign-in was interrupted part-way.",
	mailbox_unreadable: ({ mailbox }) => `The Application Runner could not read ${mailbox ?? "its Gmail mailbox"}. Reconnect Gmail under Preferences → Connections.`,
	unsupported_site: () => "The email-code sign-in only runs on SEEK.",
	no_email_field: () => "SEEK's sign-in page had no email box where one was expected.",
	no_send_button: () => "SEEK's sign-in page had no \"Email me a sign in code\" button.",
	no_code_field: () => "SEEK did not show a box for the code after it was asked to send one.",
	code_rejected: () => "SEEK did not accept the code read from the mailbox.",
};

/**
 * Move the email-code sign-in of one paused run forward by at most one step. Never throws: a failure is
 * an outcome, and `failed` is the caller's cue to hand the sign-in to the owner. Returns the run with
 * any trace events this step wrote, so the caller does not write back a stale trace.
 */
export async function advanceEmailCodeSignIn(
	env: Env,
	uid: string,
	run: ApplyRun,
	settings: Pick<ApplicationRunnerSettings, "signInEmail">,
	now: number,
	deps: EmailSignInDeps = defaultDeps(env, run, uid),
): Promise<{ outcome: EmailSignInOutcome; run: ApplyRun }> {
	if (!emailCodeApplies(run, settings)) return { outcome: "not_applicable", run };
	const email = settings.signInEmail as string;
	const site = seekSite(run.pause?.domain) as string;
	const trace = async (decision: string, detail: Record<string, string | number | boolean> = {}): Promise<ApplyRun> => {
		const event: ApplyTraceEvent = { type: "policy.decision", at: new Date(now).toISOString(), domain: run.pause?.domain, detail: { tool: "email_code_sign_in", class: "session", source: "platform", decision, site, ...detail } };
		run = (await updateApplyRun(env, run, { events: [event] }, now)) ?? run;
		return run;
	};
	const move = (from: State, to: State, set: { mailbox?: string; requestedAt?: number; messageId?: string; failure?: string } = {}) =>
		env.DB.prepare(
			`UPDATE local_apply_email_sign_ins SET state = ?3, mailbox = COALESCE(?4, mailbox), requested_at = COALESCE(?5, requested_at), message_id = COALESCE(?6, message_id), failure = COALESCE(?7, failure), updated_at = ?8
			  WHERE run_id = ?1 AND state = ?2`,
		)
			.bind(run.id, from, to, set.mailbox ?? null, set.requestedAt ?? null, set.messageId ?? null, set.failure ?? null, now)
			.run()
			.then((r) => (r.meta?.changes ?? 0) > 0);
	const fail = async (from: State, reason: string, mailbox: string | null = null): Promise<{ outcome: EmailSignInOutcome; run: ApplyRun }> => {
		if (!(await move(from, "failed", { failure: reason }))) return { outcome: "waiting", run };
		await trace("failed", { reason: FAILURE_TEXT[reason]?.({ email, mailbox }) ?? reason, rule: reason, ...(mailbox ? { mailbox } : {}) });
		return { outcome: "failed", run };
	};

	try {
		// One attempt per run: whoever inserts the row runs the first step; everyone else reads it.
		const claimed = ((await env.DB.prepare(
			"INSERT INTO local_apply_email_sign_ins (run_id, instance_id, user_id, site, state, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'requesting', ?5, ?5) ON CONFLICT DO NOTHING",
		)
			.bind(run.id, run.instanceId, uid, site, now)
			.run()).meta?.changes ?? 0) > 0;
		const row = (await env.DB.prepare("SELECT state, mailbox, requested_at, updated_at FROM local_apply_email_sign_ins WHERE run_id = ?1").bind(run.id).first<Row>()) as Row;

		if (claimed) {
			if (!(await emailPermitted(env, run.instanceId))) return fail("requesting", "email_not_permitted");
			const resolved = resolveConnectorAccount(await listConnectorAccounts(env, uid, "gmail"), await pinnedAccountFor(env, run.instanceId, "gmail"), "Gmail");
			if (!resolved.ok || !resolved.account.accountId) return fail("requesting", "mailbox_unresolved");
			const mailbox = resolved.account.accountId.toLowerCase();
			if (mailbox !== email) return fail("requesting", "mailbox_mismatch", mailbox);
			const res = await deps.runner(LOCAL_APPLY_EMAIL_CODE_PATH, { runId: run.id, step: "request", email });
			const result = res?.status === 200 ? (res.body as LocalApplyEmailCodeResult | null) : null;
			if (!result) return fail("requesting", "runner_unavailable", mailbox);
			if (result.state !== "code_requested") return fail("requesting", result.state === "failed" ? result.reason : "interrupted", mailbox);
			await move("requesting", "code_requested", { mailbox, requestedAt: now });
			await trace("code_requested", { mailbox });
			return { outcome: "waiting", run };
		}

		if ((row.state === "requesting" || row.state === "entering") && now - row.updated_at > STALE_STEP_MS) return fail(row.state, "interrupted", row.mailbox);
		// Settled earlier: nothing more to do here, and the owner was told when it failed.
		if (row.state === "failed" || row.state === "signed_in") return { outcome: "not_applicable", run };
		if (row.state !== "code_requested") return { outcome: "waiting", run };

		const requestedAt = row.requested_at ?? row.updated_at;
		const mail = await deps.mailbox();
		// A mail sent before the code was asked for is an old code; two minutes of clock skew either way.
		const hits = (await mail.list(`${SEEK_SENDERS} newer_than:1d`, 5)).filter((h) => Date.parse(h.date) >= requestedAt - 120_000);
		for (const hit of hits) {
			const msg = await mail.read(hit.id);
			const code = signInCodeIn(msg.subject, msg.text);
			if (!code) continue;
			if (!(await move("code_requested", "entering", { messageId: hit.id }))) return { outcome: "waiting", run };
			await trace("code_read", { mailbox: row.mailbox ?? email, messageId: hit.id });
			const res = await deps.runner(LOCAL_APPLY_EMAIL_CODE_PATH, { runId: run.id, step: "enter", code });
			const result = res?.status === 200 ? (res.body as LocalApplyEmailCodeResult | null) : null;
			if (result?.state !== "signed_in") return fail("entering", result?.state === "failed" ? result.reason : "runner_unavailable", row.mailbox);
			await move("entering", "signed_in");
			return { outcome: "signed_in", run };
		}
		if (now - requestedAt > CODE_WAIT_MS) return fail("code_requested", "code_not_received", row.mailbox);
		return { outcome: "waiting", run };
	} catch {
		const row = await env.DB.prepare("SELECT state, mailbox FROM local_apply_email_sign_ins WHERE run_id = ?1").bind(run.id).first<Row>().catch(() => null);
		if (!row || row.state === "failed" || row.state === "signed_in") return { outcome: "failed", run };
		return fail(row.state, row.state === "code_requested" ? "mailbox_unreadable" : "interrupted", row.mailbox);
	}
}
