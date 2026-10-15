/**
 * Browser verification of Gmail job leads (#1030) — the dispatcher (the issue's "Brain").
 *
 * A Gmail alert the server resolved to ONE canonical posting but could not check (`awaitingBrowser`
 * from `gmail-scout/provider-redirect.ts`) is stored `awaiting_browser_verification` and queued here.
 * The per-minute cron then:
 *
 *   1. reconciles every dispatched attempt whose browser run has ended, reading its TYPED outcome —
 *      active | expired | mismatch | temporarily_unverifiable — and applying it to the lead in the
 *      Scout's DO (`planBrowserVerificationOutcome`): active → `new` (now appliable, so the only
 *      route to the Tailor), expired / mismatch → closed, temporarily_unverifiable → retried with
 *      backoff, `unverifiable` after {@link MAX_ATTEMPTS};
 *   2. dispatches due leads as a local browser run on the Scout's own browser (#945), under the
 *      instance's browser verification settings (#1031) — off means it waits; no eligible runtime
 *      applies the owner's `fallback` (`wait` up to `waitLimitMinutes`, or `mark_unverifiable`).
 *
 * The run is given the canonical job identity ONLY — the posting URL that carries nothing but the
 * posting id — never the personalised alert URL, which never left the scan. Every attempt is a row in
 * `job_lead_browser_verification_attempts`: what was dispatched, which run, what came back.
 */
import { type BrowserVerificationSettings, readBrowserVerification } from "./browser-verification.js";
import { closeLiveTakeoverFor, requestTakeover } from "./browser-takeovers.js";
import { deepLinkFor } from "./console-links.js";
import { BROWSER_VERIFICATION_OUTCOMES, type BrowserVerificationOutcome } from "./job-lead-triage.js";
import { getLocalBrowserRun, listDomainConsent, type LocalBrowserRun, readLocalBrowserSettings } from "./local-browser/store.js";
import { localBrowserCapability, startLocalBrowserRun } from "./local-browser/start.js";
import { domainWithin, effectiveLocalBrowserPolicy, type LocalBrowserCapability } from "./local-browser/policy.js";
import { agentName } from "./local-browser/sync.js";
import { notifyUser } from "../routes/push.js";
import type { LeadVerification, LeadVerificationListResponse, VerificationAttempt, VerificationState } from "./job-lead-browser-verification-types.js";
import type { Env } from "../types.js";
import { clip } from "./job-lead-queue.js";

export const MAX_ATTEMPTS = 3;
/** Wait after the Nth temporarily_unverifiable outcome before trying again. */
export const RETRY_BACKOFF_MS = [5 * 60_000, 30 * 60_000, 2 * 60 * 60_000] as const;
/** How soon to look again when no browser could take it (off, offline, at capacity). */
export const WAIT_RETRY_MS = 5 * 60_000;
/** The field a verification run reports its outcome in. */
export const OUTCOME_FIELD = "verification_outcome";

type DB = Pick<Env, "DB">;
const iso = (ms: number | null): string | null => (ms ? new Date(ms).toISOString() : null);

interface LeadRow {
	instance_id: string;
	lead_id: string;
	user_id: string;
	work_key: string | null;
	canonical_url: string;
	expected_title: string | null;
	expected_company: string | null;
	state: VerificationState;
	attempts: number;
	next_attempt_at: number;
	awaiting_since: number;
	last_outcome: string | null;
	last_detail: string | null;
	updated_at: number;
}

const presentLead = (r: LeadRow): LeadVerification => ({
	instanceId: r.instance_id,
	leadId: r.lead_id,
	workKey: r.work_key,
	canonicalUrl: r.canonical_url,
	expectedTitle: r.expected_title,
	expectedCompany: r.expected_company,
	state: r.state,
	attempts: r.attempts,
	nextAttemptAt: iso(r.next_attempt_at) ?? "",
	awaitingSince: iso(r.awaiting_since) ?? "",
	lastOutcome: (BROWSER_VERIFICATION_OUTCOMES as readonly string[]).includes(r.last_outcome ?? "") ? (r.last_outcome as BrowserVerificationOutcome) : null,
	lastDetail: r.last_detail,
	updatedAt: iso(r.updated_at) ?? "",
});

interface AttemptRow {
	id: string;
	lead_id: string;
	attempt: number;
	run_id: string | null;
	state: VerificationAttempt["state"];
	outcome: string | null;
	detail: string | null;
	created_at: number;
	completed_at: number | null;
}

const presentAttempt = (r: AttemptRow): VerificationAttempt => ({
	id: r.id,
	leadId: r.lead_id,
	attempt: r.attempt,
	runId: r.run_id,
	state: r.state,
	outcome: (BROWSER_VERIFICATION_OUTCOMES as readonly string[]).includes(r.outcome ?? "") ? (r.outcome as BrowserVerificationOutcome) : null,
	detail: r.detail,
	createdAt: iso(r.created_at) ?? "",
	completedAt: iso(r.completed_at),
});

/**
 * What the browser is asked to do: the canonical posting, the job the email named, the four typed
 * outcomes, and read-only. Nothing else from the email — no alert link, no tracking parameter.
 */
export function verificationObjective(v: { canonicalUrl: string; expectedTitle: string | null; expectedCompany: string | null }): string {
	const job = [v.expectedTitle ? `"${v.expectedTitle}"` : "the job", v.expectedCompany ? `at "${v.expectedCompany}"` : ""].filter(Boolean).join(" ");
	return [
		`Verify one job posting, read-only. Open ${v.canonicalUrl} and decide whether it is ${job}, and whether it is still open.`,
		`Report exactly one finding with url ${v.canonicalUrl} and fields.${OUTCOME_FIELD} set to one of:`,
		`active (the posting is this job and is open), expired (it is closed, removed or redirects away), mismatch (it is a different job), temporarily_unverifiable (the page could not be read now).`,
		`Do not apply, sign up, sign in or submit anything.`,
	].join(" ");
}

/** The typed outcome a finished run reported — anything unreadable is temporarily_unverifiable, never a guess. */
export function outcomeFromRun(run: LocalBrowserRun | null): { outcome: BrowserVerificationOutcome; detail: string } {
	if (!run) return { outcome: "temporarily_unverifiable", detail: "The verification run could not be found." };
	if (run.status !== "completed") return { outcome: "temporarily_unverifiable", detail: `The verification run ended ${run.status}${run.errorCode ? ` (${run.errorCode})` : ""}.` };
	const reported = (run.result?.findings ?? []).map((f) => f.fields?.[OUTCOME_FIELD]).filter((o): o is string => typeof o === "string");
	const distinct = [...new Set(reported)];
	if (distinct.length !== 1 || !(BROWSER_VERIFICATION_OUTCOMES as readonly string[]).includes(distinct[0])) {
		return { outcome: "temporarily_unverifiable", detail: distinct.length > 1 ? "The run reported conflicting outcomes." : "The run reported no typed outcome." };
	}
	return { outcome: distinct[0] as BrowserVerificationOutcome, detail: clip(run.result?.summary, 200) ?? `Browser verification: ${distinct[0]}.` };
}


export async function listLeadVerifications(env: DB, instanceId: string, userId: string, limit = 50): Promise<LeadVerificationListResponse> {
	const lim = Math.max(1, Math.min(200, limit));
	const [leads, attempts] = await Promise.all([
		env.DB.prepare("SELECT * FROM job_lead_browser_verifications WHERE instance_id = ?1 AND user_id = ?2 ORDER BY updated_at DESC LIMIT ?3").bind(instanceId, userId, lim).all<LeadRow>(),
		env.DB.prepare("SELECT * FROM job_lead_browser_verification_attempts WHERE instance_id = ?1 AND user_id = ?2 ORDER BY created_at DESC LIMIT ?3").bind(instanceId, userId, lim).all<AttemptRow>(),
	]);
	return { leads: (leads.results ?? []).map(presentLead), attempts: (attempts.results ?? []).map(presentAttempt) };
}

async function getLeadRow(env: DB, instanceId: string, leadId: string): Promise<LeadRow | null> {
	return env.DB.prepare("SELECT * FROM job_lead_browser_verifications WHERE instance_id = ?1 AND lead_id = ?2").bind(instanceId, leadId).first<LeadRow>();
}

async function setLead(env: DB, row: LeadRow, patch: { state: VerificationState; attempts?: number; nextAttemptAt?: number; lastOutcome?: string | null; lastDetail?: string | null }, now: number): Promise<void> {
	await env.DB.prepare(
		`UPDATE job_lead_browser_verifications SET state = ?1, attempts = ?2, next_attempt_at = ?3, last_outcome = ?4, last_detail = ?5, updated_at = ?6
		  WHERE instance_id = ?7 AND lead_id = ?8`,
	)
		.bind(patch.state, patch.attempts ?? row.attempts, patch.nextAttemptAt ?? row.next_attempt_at, patch.lastOutcome !== undefined ? patch.lastOutcome : row.last_outcome, clip(patch.lastDetail !== undefined ? patch.lastDetail : row.last_detail), now, row.instance_id, row.lead_id)
		.run();
}

async function recordAttempt(env: DB, row: LeadRow, a: { attempt: number; state: VerificationAttempt["state"]; runId?: string | null; outcome?: string | null; detail?: string | null }, now: number): Promise<string> {
	const id = crypto.randomUUID();
	await env.DB.prepare(
		`INSERT INTO job_lead_browser_verification_attempts (id, instance_id, user_id, lead_id, attempt, run_id, state, outcome, detail, created_at, completed_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
	)
		.bind(id, row.instance_id, row.user_id, row.lead_id, a.attempt, a.runId ?? null, a.state, a.outcome ?? null, clip(a.detail), now, a.state === "dispatched" ? null : now)
		.run();
	return id;
}

/** Apply an outcome to the lead in the Scout's DO. `status` is where the lead is now, applied or not. */
async function applyToLead(env: Env, row: LeadRow, body: { outcome: BrowserVerificationOutcome; attempt: number; receipt_id: string; exhausted: boolean; detail: string }): Promise<{ transitioned: boolean; status: string } | null> {
	const stub = env.AGENT.get(env.AGENT.idFromName(row.instance_id));
	const res = await stub.fetch(
		new Request(`https://agent/job-leads/${encodeURIComponent(row.lead_id)}/browser-verification`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
	);
	if (!res.ok) return null;
	return (await res.json()) as { transitioned: boolean; status: string };
}

const VERDICT_WORDS: Partial<Record<VerificationState, string>> = {
	active: "is open — ready to triage",
	expired: "has closed",
	mismatch: "turned out to be a different job",
	unverifiable: "could not be verified",
};

/**
 * A verification reached its verdict (#1031), pushed as the event the instance's notification policy
 * decides: `browser_verification_failed` when it could not be verified — no eligible browser, or every
 * attempt unreadable — else `browser_verification_completed`. Only a FINAL verdict: an attempt that will be
 * retried is not one. The text names the job by title, never its URL; the link is Settings, by id.
 */
async function notifyVerdict(env: Env, row: LeadRow, state: VerificationState, why: string | null): Promise<void> {
	const words = VERDICT_WORDS[state];
	if (!words) return;
	const failed = state === "unverifiable";
	const agent = await agentName(env, row.user_id, row.instance_id);
	const job = row.expected_title ? `“${row.expected_title}”${row.expected_company ? ` at ${row.expected_company}` : ""}` : "A job lead";
	await notifyUser(
		env,
		row.user_id,
		"local-browser",
		failed ? `✕ ${agent} could not verify a job` : `✓ ${agent} verified a job`,
		`${job} ${words}${failed && why ? ` — ${why}` : ""}.`,
		deepLinkFor({ kind: "browser-verification", instanceId: row.instance_id }),
		{ kind: failed ? "alert" : "update", instanceId: row.instance_id, key: `lead-verification:${row.lead_id}`, event: failed ? "browser_verification_failed" : "browser_verification_completed" },
	);
}

/** Close a lead's verification with a final outcome, applied to the lead. */
async function settle(env: Env, row: LeadRow, outcome: BrowserVerificationOutcome, opts: { attempt: number; receiptId: string; exhausted: boolean; detail: string; why?: string }, now: number): Promise<VerificationState> {
	const applied = await applyToLead(env, row, { outcome, attempt: opts.attempt, receipt_id: opts.receiptId, exhausted: opts.exhausted, detail: opts.detail });
	// The owner moved the lead on first: recorded on the attempt, never applied to the lead.
	if (applied && !applied.transitioned && applied.status !== "awaiting_browser_verification") {
		await setLead(env, row, { state: "superseded", attempts: opts.attempt, lastOutcome: outcome, lastDetail: `The lead is ${applied.status} now; this outcome was recorded but not applied.` }, now);
		return "superseded";
	}
	if (outcome === "temporarily_unverifiable" && !opts.exhausted) {
		await setLead(env, row, { state: "awaiting", attempts: opts.attempt, nextAttemptAt: now + RETRY_BACKOFF_MS[Math.min(opts.attempt, RETRY_BACKOFF_MS.length) - 1], lastOutcome: outcome, lastDetail: opts.detail }, now);
		return "awaiting";
	}
	const state: VerificationState = outcome === "temporarily_unverifiable" ? "unverifiable" : outcome;
	await setLead(env, row, { state, attempts: opts.attempt, lastOutcome: outcome, lastDetail: opts.detail }, now);
	// Best-effort: a failed push never undoes the verdict it reports.
	await notifyVerdict(env, row, state, opts.why ?? (state === "unverifiable" ? `${opts.attempt} attempt(s) could not read the posting` : null)).catch(() => undefined);
	return state;
}

/**
 * No browser could take this lead now. `mark_unverifiable` closes it at once; `wait` looks again later,
 * until `waitLimitMinutes` after it started waiting, then closes it.
 */
async function noRuntime(env: Env, row: LeadRow, fallback: "wait" | "mark_unverifiable", waitLimitMinutes: number, detail: string, now: number): Promise<VerificationState> {
	const receiptId = await recordAttempt(env, row, { attempt: row.attempts, state: "no_runtime", detail }, now);
	if (fallback === "mark_unverifiable" || now - row.awaiting_since >= waitLimitMinutes * 60_000) {
		return settle(env, row, "temporarily_unverifiable", { attempt: row.attempts, receiptId, exhausted: true, detail: `${detail} The fallback (${fallback}) closed it as unverifiable.`, why: `no eligible browser was available (fallback: ${fallback})` }, now);
	}
	await setLead(env, row, { state: "awaiting", nextAttemptAt: now + WAIT_RETRY_MS, lastDetail: `${detail} Waiting (fallback: wait).` }, now);
	return "awaiting";
}

/** The site a posting is on — the host the browser would open. */
function hostOf(url: string): string {
	try {
		return new URL(url).hostname.toLowerCase();
	} catch {
		return "";
	}
}

/** The durable request for the owner's decision on one new site (#1049) — one per site, not per lead. */
const consentSubject = (host: string) => `site-consent:${host}`;

type SourceGate = { kind: "open" } | { kind: "refused"; detail: string; why: string } | { kind: "needs_consent"; state: VerificationState };

/**
 * May the Scout's browser open this posting's site (#1049)?
 *
 *   - denied (the instance's or the agent's denied sites, or the owner declined the site) → refused;
 *   - an allowed-sites list that does not cover it → refused;
 *   - an allowed-sites list that covers it, or the owner already allowed the site → open;
 *   - an EMPTY allowed-sites list and no decision yet → the owner is asked, once and durably (a takeover
 *     request, reason `consent_required`, pushed by the notification policy), and the lead waits — up to
 *     the browser verification `waitLimitMinutes`, after which it is closed as unverifiable.
 * Invalid saved settings are not a reason to open anything: the lead waits and says why (fail closed).
 */
async function sourceGate(env: Env, row: LeadRow, cap: LocalBrowserCapability, verification: BrowserVerificationSettings, now: number): Promise<SourceGate> {
	const host = hostOf(row.canonical_url);
	if (!host) return { kind: "refused", detail: "The posting has no site the browser could open.", why: "the posting has no readable site" };
	const { settings } = await readLocalBrowserSettings(env, row.instance_id, row.user_id);
	const policy = effectiveLocalBrowserPolicy(cap, settings);
	if ("error" in policy) {
		await setLead(env, row, { state: "awaiting", nextAttemptAt: now + WAIT_RETRY_MS, lastDetail: `${policy.error} Nothing was opened; fix them in Settings → Local browser research.` }, now);
		return { kind: "needs_consent", state: "awaiting" };
	}
	if (policy.denyDomains.some((d) => domainWithin(host, d))) {
		return { kind: "refused", detail: `${host} is on this Scout's denied sites.`, why: `${host} is on this Scout's denied sites` };
	}
	if (policy.allowDomains.length) {
		return policy.allowDomains.some((d) => domainWithin(host, d))
			? { kind: "open" }
			: { kind: "refused", detail: `${host} is outside this Scout's allowed sites (${policy.allowDomains.join(", ")}).`, why: `${host} is outside this Scout's allowed sites` };
	}
	const decision = (await listDomainConsent(env, row.instance_id, row.user_id, now)).find((c) => c.scope === "navigate" && domainWithin(host, c.domain));
	if (decision?.decision === "deny") return { kind: "refused", detail: `You declined ${host} for this Scout's browser.`, why: `you declined ${host}` };
	if (decision?.decision === "allow") {
		await closeLiveTakeoverFor(env, row.user_id, row.instance_id, "manual", consentSubject(host), "resumed", now).catch(() => undefined);
		return { kind: "open" };
	}
	if (now - row.awaiting_since >= verification.waitLimitMinutes * 60_000) {
		return { kind: "refused", detail: `Nobody allowed ${host} within ${verification.waitLimitMinutes} minutes, so it was not opened.`, why: `${host} was not allowed in time` };
	}
	const asked = await requestTakeover(env, { userId: row.user_id, instanceId: row.instance_id, subjectKind: "manual", subjectId: consentSubject(host), reason: "consent_required", mobileAllowed: verification.allowMobile, now }).catch(() => null);
	if (asked?.created) {
		const agent = await agentName(env, row.user_id, row.instance_id);
		await notifyUser(env, row.user_id, "local-browser", `${agent} wants to open a new job site`, `Allow or decline ${host} for this Scout's browser verification — nothing is opened until you decide.`, deepLinkFor({ kind: "browser-takeover", instanceId: row.instance_id, takeover: asked.takeover }), {
			kind: "alert",
			instanceId: row.instance_id,
			key: `site-consent:${row.instance_id}:${host}`,
			event: "takeover_required",
		}).catch(() => undefined);
	}
	await setLead(env, row, { state: "awaiting", nextAttemptAt: now + WAIT_RETRY_MS, lastDetail: `Waiting for you to allow or decline ${host} (Settings → Local browser research, or set_local_browser_consent). Nothing was opened.` }, now);
	return { kind: "needs_consent", state: "awaiting" };
}

/** Hand one due lead to the Scout's browser. */
export async function dispatchLeadVerification(env: Env, row: LeadRow, now = Date.now()): Promise<VerificationState> {
	const { settings } = await readBrowserVerification(env, row.instance_id, row.user_id);
	if (!settings.enabled) {
		await setLead(env, row, { state: "awaiting", nextAttemptAt: now + WAIT_RETRY_MS, lastDetail: "Browser verification is off for this Scout. Turn it on in Settings → Browser verification (set_instance_browser_verification)." }, now);
		return "awaiting";
	}
	// The agent must DECLARE a local browser (#1048). One that does not — a template changed after the owner
	// turned verification on — has no browser to be "unavailable": that is not the fallback's case, so the
	// lead waits and says why, rather than being closed as unverifiable by a `mark_unverifiable` fallback.
	const cap = await localBrowserCapability(env, row.instance_id, row.user_id);
	if ("error" in cap) {
		await setLead(env, row, { state: "awaiting", nextAttemptAt: now + WAIT_RETRY_MS, lastDetail: "This Scout's agent does not declare a local browser, so it cannot verify in a browser. Nothing was dispatched; the lead waits." }, now);
		return "awaiting";
	}
	// The Scout's browser source policy (#1049): THIS instance's allowed and denied sites (Settings → Local
	// browser research, or set_instance_local_browser_settings) within the agent's ceiling, and the owner's
	// per-site consent. Decided here, before a run or an attempt is spent, so a site the Scout may not
	// open is refused with its reason and a new one waits for the owner's durable decision.
	const gate = await sourceGate(env, row, cap.cap, settings, now);
	if (gate.kind === "refused") {
		const receiptId = await recordAttempt(env, row, { attempt: row.attempts, state: "refused", detail: gate.detail }, now);
		return settle(env, row, "temporarily_unverifiable", { attempt: row.attempts, receiptId, exhausted: true, detail: gate.detail, why: gate.why }, now);
	}
	if (gate.kind === "needs_consent") return gate.state;
	const attempt = row.attempts + 1;
	const started = await startLocalBrowserRun(env, row.instance_id, row.user_id, {
		objective: verificationObjective({ canonicalUrl: row.canonical_url, expectedTitle: row.expected_title, expectedCompany: row.expected_company }),
		requestId: `bv-${row.lead_id}-${attempt}`,
		source: "trigger",
	});
	if (started.kind === "at_capacity") {
		await setLead(env, row, { state: "awaiting", nextAttemptAt: now + WAIT_RETRY_MS, lastDetail: "The browser is busy with other runs; trying again shortly." }, now);
		return "awaiting";
	}
	if (started.kind === "refused") return noRuntime(env, row, settings.fallback, settings.waitLimitMinutes, `The Scout's browser cannot run it: ${started.error}`, now);
	const run = started.run;
	if (run.status === "failed" && (run.errorCode === "runner_offline" || run.errorCode === "runner_unsupported")) {
		return noRuntime(env, row, settings.fallback, settings.waitLimitMinutes, run.error ?? "No eligible browser is connected.", now);
	}
	await recordAttempt(env, row, { attempt, state: "dispatched", runId: run.id, detail: `Dispatched ${row.canonical_url} to run ${run.id}.` }, now);
	await setLead(env, row, { state: "dispatched", attempts: attempt, lastDetail: `Attempt ${attempt} of ${MAX_ATTEMPTS} is checking the posting.` }, now);
	return "dispatched";
}

/** Read back every dispatched attempt whose run has ended, and apply what it found. */
export async function reconcileVerificationAttempts(env: Env, now = Date.now(), limit = 25): Promise<number> {
	const { results } = await env.DB.prepare("SELECT * FROM job_lead_browser_verification_attempts WHERE state = 'dispatched' ORDER BY created_at LIMIT ?1").bind(limit).all<AttemptRow & { instance_id: string; user_id: string }>();
	let settled = 0;
	for (const a of results ?? []) {
		const run = a.run_id ? await getLocalBrowserRun(env, a.instance_id, a.user_id, a.run_id) : null;
		if (run && (run.status === "queued" || run.status === "running" || run.status === "paused")) continue;
		const row = await getLeadRow(env, a.instance_id, a.lead_id);
		if (!row) continue;
		const { outcome, detail } = outcomeFromRun(run);
		const claimed = await env.DB.prepare("UPDATE job_lead_browser_verification_attempts SET state = 'completed', outcome = ?1, detail = ?2, completed_at = ?3 WHERE id = ?4 AND state = 'dispatched'")
			.bind(outcome, clip(detail), now, a.id)
			.run();
		// Single writer: another tick that already claimed this attempt applies it, not this one.
		if ((claimed.meta?.changes ?? 0) === 0) continue;
		await settle(env, row, outcome, { attempt: a.attempt, receiptId: a.id, exhausted: outcome === "temporarily_unverifiable" && a.attempt >= MAX_ATTEMPTS, detail }, now);
		settled++;
	}
	return settled;
}

/** The per-minute tick: settle what came back, then dispatch what is due. */
export async function runLeadBrowserVerification(env: Env, now = Date.now(), limit = 10): Promise<{ settled: number; dispatched: number }> {
	const settled = await reconcileVerificationAttempts(env, now);
	const { results } = await env.DB.prepare("SELECT * FROM job_lead_browser_verifications WHERE state = 'awaiting' AND next_attempt_at <= ?1 ORDER BY next_attempt_at LIMIT ?2").bind(now, limit).all<LeadRow>();
	let dispatched = 0;
	for (const row of results ?? []) if ((await dispatchLeadVerification(env, row, now).catch(() => null)) === "dispatched") dispatched++;
	return { settled, dispatched };
}

/** An owner's "verify now": a waiting lead is dispatched at once instead of at its next turn. */
export async function verifyLeadNow(env: Env, instanceId: string, userId: string, leadId: string, now = Date.now()): Promise<{ state: VerificationState; lead: LeadVerification } | { error: string; status: 404 | 409 }> {
	const row = await getLeadRow(env, instanceId, leadId);
	if (!row || row.user_id !== userId) return { error: "This lead is not waiting for browser verification.", status: 404 };
	if (row.state !== "awaiting") return { error: `This lead's verification is ${row.state}; only a waiting one can be started now.`, status: 409 };
	const state = await dispatchLeadVerification(env, row, now);
	const after = await getLeadRow(env, instanceId, leadId);
	return { state, lead: presentLead(after ?? row) };
}
