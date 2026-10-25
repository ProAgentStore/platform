/**
 * Continue runs that stopped on `provider_credit` once the owner's key works again (#1318) — and, since #1326, runs that
 * stopped on `provider_credentials`: a 403 `permission_error` "Request not allowed" was measured coming and going on a key that
 * worked minutes either side of it, and its hold used to be a deadlock — the hold paused every automatic start, so no call was
 * ever made that could clear it. Refused keys are now probed on the same backoff, whether or not a run is waiting, because the
 * hold itself is what is waiting.
 *
 * A credit stop is correct for the run that hit it — replaying a call the provider refuses for want of balance spends nothing and
 * fixes nothing (#773) — but nothing used to come back for it afterwards, so every stopped run waited for a person to press
 * Continue after the top-up. This is the thing that comes back. It runs from the cron tick and does two things:
 *
 *   1. PROBE a failing key, only while it has credit-stopped runs waiting, with backoff (5m, 15m, 1h, then 6h, for at most 7 days).
 *      The probe is the verify request (four tokens). A success clears the provider-account hold exactly as any real call does.
 *   2. CONTINUE the stopped runs of every owner whose key has recovered — through `startAutomaticContinuation`, the same start
 *      path as the Continue button, so the resume note, landed commits and Pilot notes are carried, not reinvented.
 *
 * The same handler is the deploy's one-time backfill: it finds recovered keys by state, not by transition, so a key that recovered
 * before this shipped is handled on the first tick, and a second pass is a no-op.
 *
 * ── What stops it from doing the wrong thing
 *   • once per stopped run, durably: `auto_resume_at` is claimed by one conditional UPDATE before anything starts;
 *   • not superseded: a newer run on the same instance and repo (the owner got there first, or cancelled and restarted) ends it;
 *   • not paused or archived instances, and not an instance or account that opted out;
 *   • only runs stopped inside the window (7 days), because the continue path's reach back is limited;
 *   • paced: at most {@link PER_OWNER_PER_MINUTE} per owner per minute, counted from the claims themselves;
 *   • the one-run-per-repo lock is respected: a refusal that waiting fixes is deferred with a backed-off retry, never dropped.
 */
import { startAutomaticContinuation } from "../routes/loop-continue-routes.js";
import { PROVIDER_ACCOUNT_STOP_REASONS, stopReasonsSql } from "./stop-reasons.js";
import type { Env } from "../types.js";
import { clipMarked } from "./clip-marked.js";
import { logEvent } from "./events.js";
import { getLoopRun, type LoopRunView } from "./agent-loop-store.js";
import { startRefusalIsWaitable } from "./loop-drivers.js";
import { readProviderAccountHealth } from "./provider-account-health.js";
import { providerCredentialId, selectedProviderAccount, type HeldProvider } from "./provider-account-hold.js";
import { runUserWorkersAi } from "./user-ai.js";
import { decryptKey } from "./crypto.js";
import { anthropicModelProblem, type AnthropicModelId } from "./anthropic-model-routing.js";
import { readInstanceConfigPair } from "./instance-config.js";
import { parseAccountPreferences } from "./preferences.js";

export const AUTO_RESUME_WINDOW_MS = 7 * 86_400_000;
export const PER_OWNER_PER_MINUTE = 3;
/** A claim whose successor never started (a crash between the two writes) is released after this. */
export const CLAIM_TTL_MS = 10 * 60_000;
export const MAX_RESUME_ATTEMPTS = 10;
/** Probe backoff: 5m, 15m, 1h, then every 6h. A key failing for longer than {@link PROBE_GIVE_UP_MS} is left to a real call. */
export const PROBE_BACKOFF_MS = [5 * 60_000, 15 * 60_000, 60 * 60_000, 6 * 3_600_000] as const;
export const PROBE_GIVE_UP_MS = 7 * 86_400_000;
const BATCH = 50;

export const probeDelayMs = (attempts: number): number => PROBE_BACKOFF_MS[Math.min(Math.max(attempts, 1) - 1, PROBE_BACKOFF_MS.length - 1)];
/** Retry delay for a deferred continue: 1, 2, 4… minutes, capped at an hour. */
export const resumeDelayMs = (attempts: number): number => Math.min(2 ** Math.max(attempts - 1, 0) * 60_000, 3_600_000);

export interface CreditResumeDeps {
	now?: () => number;
	/** Start the successor. Defaults to the Continue path. */
	start?: (env: Env, run: LoopRunView, userId: string) => Promise<{ ok: true; runId: string } | { ok: false; reason?: string; error: string }>;
	/** The four-token probe of this owner's key on `provider`; true when it worked (which also clears the hold). */
	probe?: (env: Env, userId: string, provider: HeldProvider, model?: string | null) => Promise<boolean | ProbeOutcome>;
	windowMs?: number;
}

interface Candidate {
	run_id: string;
	user_id: string;
	instance_id: string;
	finished_at: number;
	auto_resume_attempts: number;
}

/** Recent credit-stopped runs nothing has continued, on active instances, not superseded. */
async function candidates(env: Env, now: number, windowMs: number, userId?: string): Promise<Candidate[]> {
	const { results } = await env.DB.prepare(
		`SELECT r.run_id, r.user_id, r.instance_id, r.finished_at, r.auto_resume_attempts
		   FROM agent_loop_runs r
		   JOIN agent_instances i ON i.id = r.instance_id AND i.status = 'active'
		   LEFT JOIN coding_sessions s ON s.id = r.session_id
		  WHERE r.stop_reason IN (${stopReasonsSql(PROVIDER_ACCOUNT_STOP_REASONS)}) AND r.finished_at IS NOT NULL AND r.finished_at > ?1
		    AND r.auto_resume_at IS NULL AND (r.auto_resume_next_at IS NULL OR r.auto_resume_next_at <= ?2)
		    AND (?3 IS NULL OR r.user_id = ?3)
		    AND NOT EXISTS (SELECT 1 FROM agent_loop_runs n LEFT JOIN coding_sessions ns ON ns.id = n.session_id
		                     WHERE n.instance_id = r.instance_id AND n.run_id <> r.run_id AND n.started_at >= r.finished_at
		                       AND COALESCE(ns.repo_id, '') = COALESCE(s.repo_id, ''))
		  ORDER BY r.finished_at ASC LIMIT ?4`,
	)
		.bind(now - windowMs, now, userId ?? null, BATCH)
		.all<Candidate>();
	return results ?? [];
}

/** Is automatic continuing on for this instance and account? Default on; either can opt out. */
export async function autoResumeEnabled(env: Env, userId: string, instanceId: string): Promise<boolean> {
	const [pair, row] = await Promise.all([
		readInstanceConfigPair(env, instanceId, userId).catch(() => null),
		env.DB.prepare("SELECT preferences FROM users WHERE id = ?1").bind(userId).first<{ preferences: string | null }>().catch(() => null),
	]);
	return pair?.config.autoResumeOnCredit !== false && parseAccountPreferences(row?.preferences).coding?.autoResumeOnCredit !== false;
}

/** Has the key this instance runs on recovered since the run stopped? A hold, when there is one, is the authority; else the account's health record. */
async function keyRecoveredSince(env: Env, userId: string, instanceId: string, stoppedAt: number): Promise<{ recovered: boolean; label: string; at: number | null }> {
	const account = await selectedProviderAccount(env, instanceId, userId).catch(() => null);
	if (!account) return { recovered: false, label: "", at: null };
	const hold = await env.DB.prepare("SELECT failure_class, failed_at, cleared_at FROM provider_account_holds WHERE user_id = ?1 AND provider = ?2 AND credential_id = ?3")
		.bind(userId, account.provider, account.credentialId)
		.first<{ failure_class: string; failed_at: number; cleared_at: number | null }>();
	// The key's real last four, as the owner sees it in Profile and at the provider — never a slice of the credential's hash (#1344).
	const hint = await env.DB.prepare("SELECT key_hint FROM user_api_keys WHERE user_id = ?1 AND provider = ?2").bind(userId, account.provider).first<{ key_hint: string | null }>().catch(() => null);
	const label = hint?.key_hint ? `…${hint.key_hint}` : "the stored key";
	// Either class: a run stopped on credit whose key was later refused (or the other way round) recovers when THIS key works.
	if (hold) return hold.cleared_at !== null && hold.cleared_at >= stoppedAt ? { recovered: true, label, at: hold.cleared_at } : { recovered: false, label, at: null };
	// No hold on THIS key, but a REFUSED-key hold on a different key of this provider from before the stop, and this key was
	// stored after it: the owner replaced the refused key, as that notice asks (#1362). Only for a refusal — a credit
	// stop's remedy is a top-up, and its run still waits for a key that has actually worked (#1318). A new key has nothing against it, so the
	// stopped run continues; if the new key is refused too, that run stops on a hold of its own. Before this a replaced
	// Cloudflare key never continued anything, and an Anthropic one waited for a real call to succeed first.
	const replaced = await env.DB.prepare(
		`SELECT k.created_at AS at FROM user_api_keys k
		  WHERE k.user_id = ?1 AND k.provider = ?2
		    AND EXISTS (SELECT 1 FROM provider_account_holds h WHERE h.user_id = ?1 AND h.provider = ?2 AND h.credential_id <> ?3
		                AND h.failure_class = 'provider_credentials' AND h.failed_at <= ?4)`,
	).bind(userId, account.provider, account.credentialId, stoppedAt).first<{ at: string }>().catch(() => null);
	const replacedAt = replaced ? Date.parse(`${replaced.at.replace(" ", "T")}Z`) : Number.NaN;
	if (Number.isFinite(replacedAt) && replacedAt > stoppedAt) return { recovered: true, label, at: replacedAt };
	if (account.provider !== "anthropic") return { recovered: false, label, at: null };
	// No hold row: the key failed before holds were recorded. The older record says whether it has succeeded since.
	const health = await readProviderAccountHealth(env, userId).catch(() => null);
	const succeededAt = health?.lastSuccessAt ? Date.parse(health.lastSuccessAt.includes("T") ? health.lastSuccessAt : `${health.lastSuccessAt.replace(" ", "T")}Z`) : NaN;
	return health?.state === "recovered" && Number.isFinite(succeededAt) && succeededAt > stoppedAt ? { recovered: true, label, at: succeededAt } : { recovered: false, label, at: null };
}

async function releaseStaleClaims(env: Env, now: number): Promise<void> {
	await env.DB.prepare("UPDATE agent_loop_runs SET auto_resume_at = NULL, auto_resume_state = 'deferred', auto_resume_note = 'the claim was never completed; retrying' WHERE auto_resume_state = 'claimed' AND auto_resume_successor IS NULL AND auto_resume_at < ?1")
		.bind(now - CLAIM_TTL_MS)
		.run();
}

export interface ResumeSummary { considered: number; resumed: number; deferred: number; gaveUp: number; skipped: number }

/** Continue the stopped runs whose key has recovered. Idempotent; safe to call from the cron and the backfill alike. */
export async function resumeRecoveredCreditRuns(env: Env, deps: CreditResumeDeps = {}, userId?: string): Promise<ResumeSummary> {
	const now = (deps.now ?? Date.now)();
	const summary: ResumeSummary = { considered: 0, resumed: 0, deferred: 0, gaveUp: 0, skipped: 0 };
	await releaseStaleClaims(env, now).catch(() => undefined);
	const start = deps.start ?? startAutomaticContinuation;
	const perOwner = new Map<string, { resumed: string[]; deferred: number; label: string; at: number | null }>();
	for (const c of await candidates(env, now, deps.windowMs ?? AUTO_RESUME_WINDOW_MS, userId)) {
		summary.considered++;
		try {
			if (!(await autoResumeEnabled(env, c.user_id, c.instance_id))) { summary.skipped++; continue; }
			const key = await keyRecoveredSince(env, c.user_id, c.instance_id, c.finished_at);
			if (!key.recovered) { summary.skipped++; continue; }
			// Pacing, counted from the claims themselves so a cron overlap cannot exceed it.
			const recent = await env.DB.prepare("SELECT COUNT(*) AS n FROM agent_loop_runs WHERE user_id = ?1 AND auto_resume_at > ?2").bind(c.user_id, now - 60_000).first<{ n: number }>();
			if ((recent?.n ?? 0) >= PER_OWNER_PER_MINUTE) { summary.skipped++; continue; }
			// The durable once-only guard.
			const claim = await env.DB.prepare("UPDATE agent_loop_runs SET auto_resume_at = ?2, auto_resume_state = 'claimed' WHERE run_id = ?1 AND auto_resume_at IS NULL").bind(c.run_id, now).run();
			if ((claim.meta?.changes ?? 0) === 0) { summary.skipped++; continue; }
			const run = await getLoopRun(env, c.user_id, c.run_id);
			if (!run) { summary.skipped++; continue; }
			const agg = perOwner.get(c.user_id) ?? { resumed: [], deferred: 0, label: key.label, at: key.at };
			perOwner.set(c.user_id, agg);
			let outcome: Awaited<ReturnType<typeof start>>;
			try {
				outcome = await start(env, run, c.user_id);
			} catch (e) {
				outcome = { ok: false, reason: "busy", error: `the continue could not start: ${e instanceof Error ? e.message : String(e)}` };
			}
			if (outcome.ok) {
				await env.DB.prepare("UPDATE agent_loop_runs SET auto_resume_state = 'resumed', auto_resume_successor = ?2, auto_resume_note = NULL WHERE run_id = ?1").bind(c.run_id, outcome.runId).run();
				await env.DB.prepare("UPDATE agent_loop_runs SET auto_resumed_from = ?2 WHERE run_id = ?1").bind(outcome.runId, c.run_id).run();
				summary.resumed++;
				agg.resumed.push(outcome.runId);
				await logEvent(env, { source: "auto-resume", event: "credit_resume.resumed", level: "info", userId: c.user_id, instanceId: c.instance_id, traceId: outcome.runId, message: `auto-continued after key ${key.label} recovered${key.at ? ` at ${new Date(key.at).toISOString()}` : ""}; successor ${outcome.runId}`, context: { stoppedRunId: c.run_id, successorRunId: outcome.runId, key: key.label } });
				continue;
			}
			const attempts = c.auto_resume_attempts + 1;
			const note = clipMarked(outcome.error, 300, { within: true });
			const waitable = startRefusalIsWaitable(outcome.reason);
			if (waitable && attempts < MAX_RESUME_ATTEMPTS) {
				await env.DB.prepare("UPDATE agent_loop_runs SET auto_resume_at = NULL, auto_resume_state = 'deferred', auto_resume_attempts = ?2, auto_resume_next_at = ?3, auto_resume_note = ?4 WHERE run_id = ?1").bind(c.run_id, attempts, now + resumeDelayMs(attempts), note).run();
				summary.deferred++;
				agg.deferred++;
				// One line per run, on the first deferral: a held repo lock is routine and must not fill the log every minute.
				if (attempts === 1) await logEvent(env, { source: "auto-resume", event: "credit_resume.deferred", level: "info", userId: c.user_id, instanceId: c.instance_id, message: `auto-continue deferred (${outcome.reason ?? "refused"}): ${note}`, context: { stoppedRunId: c.run_id, reason: outcome.reason ?? null } });
			} else {
				// Not something waiting fixes, or out of tries: stop, say why, leave it for the owner's Continue.
				await env.DB.prepare("UPDATE agent_loop_runs SET auto_resume_state = 'gave_up', auto_resume_attempts = ?2, auto_resume_note = ?3 WHERE run_id = ?1").bind(c.run_id, attempts, note).run();
				summary.gaveUp++;
				await logEvent(env, { source: "auto-resume", event: "credit_resume.gave_up", level: "warn", userId: c.user_id, instanceId: c.instance_id, message: `auto-continue stopped (${outcome.reason ?? "refused"}): ${note}`, context: { stoppedRunId: c.run_id, reason: outcome.reason ?? null, attempts } });
			}
		} catch {
			summary.skipped++; // the next tick looks again
		}
	}
	for (const [uid, agg] of perOwner) {
		await logEvent(env, { source: "auto-resume", event: "credit_resume.summary", level: "info", userId: uid, message: `key ${agg.label} recovered: ${agg.resumed.length} run(s) auto-continued, ${agg.deferred} deferred`, context: { successors: agg.resumed.slice(-20), deferred: agg.deferred } }).catch(() => undefined);
	}
	return summary;
}

/** The fingerprint of the key stored for `provider` now, or null when none is. A probe always spends the CURRENT key. */
/**
 * The fingerprint of the key stored for `provider` now; null ONLY when no key is stored. A key that cannot be read (a D1
 * or decryption error) THROWS, so a caller can tell "removed" from "unknown" (#1362) — reading an error as "replaced"
 * retired a refused key's hold. The same row and decryption as `selectedProviderAccount`, so the fingerprints match.
 */
async function currentCredentialId(env: Env, userId: string, provider: HeldProvider): Promise<string | null> {
	const row = await env.DB.prepare("SELECT key_ciphertext, dek_wrapped, iv FROM user_api_keys WHERE user_id = ?1 AND provider = ?2")
		.bind(userId, provider)
		.first<{ key_ciphertext: ArrayBuffer; dek_wrapped: ArrayBuffer; iv: ArrayBuffer }>();
	if (!row) return null;
	if (!env.KEY_ENCRYPTION_KEY) throw new Error("key encryption is not configured");
	const credential = await decryptKey(new Uint8Array(row.key_ciphertext), new Uint8Array(row.dek_wrapped), new Uint8Array(row.iv), env.KEY_ENCRYPTION_KEY);
	return providerCredentialId(provider, credential);
}

/** The model each held provider's probe names when the hold recorded none — the same pair `POST /v1/keys/:provider/verify` uses. */
const PROBE_MODEL: Record<HeldProvider, string> = { anthropic: "claude-sonnet-4-6", cloudflare: "@cf/meta/llama-3.2-3b-instruct" };

export interface ProbeOutcome { ok: boolean; error?: string }

/**
 * The verify request: four tokens against the owner's key, on the MODEL the refused request named (#1344) — a 403 that only
 * one model gets used to pass a probe on the default model, clear the hold, and fail again. A success clears the hold as any
 * real call does; a failure is "not yet", with the provider's words for the record.
 */
export async function probeProviderKey(env: Env, userId: string, provider: HeldProvider, model?: string | null): Promise<ProbeOutcome> {
	const anthropicModel = provider === "anthropic" && model && !anthropicModelProblem(model) ? (model as AnthropicModelId) : undefined;
	try {
		await runUserWorkersAi(env, userId, model && provider === "cloudflare" ? model : PROBE_MODEL[provider], { messages: [{ role: "system", content: "Reply with exactly: ok" }, { role: "user", content: "verify" }], max_tokens: 4, maxTokens: 4 }, undefined, { provider, ...(anthropicModel ? { anthropicModel } : {}) });
		return { ok: true };
	} catch (e) {
		return { ok: false, error: clipMarked(e instanceof Error ? e.message : String(e), 400, { within: true }) };
	}
}

/**
 * Probe the held keys something is waiting on. A credit hold is probed only while credit-stopped runs wait — a key nobody waits
 * on is never spent on. A refused-key hold (#1326) is probed while its owner has any active instance, because that hold is
 * itself what pauses their automatic starts, and nothing else would ever call the key to clear it. A key failing for a week is
 * left for a real call to find out.
 */
export async function probeFailingKeys(env: Env, deps: CreditResumeDeps = {}): Promise<{ probed: number; recovered: number }> {
	const now = (deps.now ?? Date.now)();
	const probe = deps.probe ?? probeProviderKey;
	const out = { probed: 0, recovered: 0 };
	const { results } = await env.DB.prepare(
		`SELECT h.user_id, h.provider, h.credential_id, h.failed_at, h.probe_attempts, h.model FROM provider_account_holds h
		  WHERE h.cleared_at IS NULL AND COALESCE(h.first_failed_at, h.failed_at) > ?1 AND (h.next_probe_at IS NULL OR h.next_probe_at <= ?2)
		    AND (
		      (h.failure_class = 'provider_credit' AND h.provider = 'anthropic'
		        AND EXISTS (SELECT 1 FROM agent_loop_runs r JOIN agent_instances i ON i.id = r.instance_id AND i.status = 'active'
		                     WHERE r.user_id = h.user_id AND r.stop_reason = 'provider_credit' AND r.auto_resume_at IS NULL AND r.finished_at > ?3))
		      OR (h.failure_class = 'provider_credentials'
		        AND EXISTS (SELECT 1 FROM agent_instances i WHERE i.user_id = h.user_id AND i.status = 'active'))
		    )
		  LIMIT 25`,
	).bind(now - PROBE_GIVE_UP_MS, now, now - (deps.windowMs ?? AUTO_RESUME_WINDOW_MS)).all<{ user_id: string; provider: HeldProvider; credential_id: string; failed_at: number; probe_attempts: number; model: string | null }>();
	for (const h of results ?? []) {
		// A hold on a key since replaced (or removed) is retired, not probed: the probe would spend the NEW key, pass, and
		// leave the old row due again on the next tick — a real provider call every minute (review of #1326).
		let current: string | null;
		try {
			current = await currentCredentialId(env, h.user_id, h.provider);
		} catch {
			continue; // could not tell (#1362): leave the hold as it is and look again on the next tick
		}
		if (current !== h.credential_id) {
			await env.DB.prepare("UPDATE provider_account_holds SET cleared_at = ?4 WHERE user_id = ?1 AND provider = ?2 AND credential_id = ?3 AND cleared_at IS NULL").bind(h.user_id, h.provider, h.credential_id, now).run();
			continue;
		}
		out.probed++;
		const raw = await probe(env, h.user_id, h.provider, h.model).catch((e: unknown): ProbeOutcome => ({ ok: false, error: String(e) }));
		const res: ProbeOutcome = typeof raw === "boolean" ? { ok: raw } : raw;
		const attempts = res.ok ? 0 : h.probe_attempts + 1;
		const nextAt = res.ok ? null : now + probeDelayMs(attempts);
		if (res.ok) {
			out.recovered++;
			await env.DB.prepare("UPDATE provider_account_holds SET probe_attempts = 0, next_probe_at = NULL WHERE user_id = ?1 AND provider = ?2 AND credential_id = ?3").bind(h.user_id, h.provider, h.credential_id).run();
		} else {
			await env.DB.prepare("UPDATE provider_account_holds SET probe_attempts = ?4, next_probe_at = ?5 WHERE user_id = ?1 AND provider = ?2 AND credential_id = ?3").bind(h.user_id, h.provider, h.credential_id, attempts, nextAt).run();
		}
		// Every probe leaves a trace (#1344): a refused re-check was invisible, so "is the key still refused, and why" had no answer.
		await logEvent(env, {
			source: "auto-resume",
			event: "provider_hold.probe",
			level: res.ok ? "info" : "warn",
			userId: h.user_id,
			message: res.ok ? `${h.provider} key re-check passed — automatic runs resume` : `${h.provider} key still refused (attempt ${attempts}, next re-check ${new Date(nextAt as number).toISOString()}): ${res.error ?? "no detail"}`,
			context: { provider: h.provider, ok: res.ok, attempt: attempts, nextAt, model: h.model, error: res.error ?? null },
		}).catch(() => undefined);
	}
	return out;
}

/** The cron entry: probe what is waiting, continue what has recovered, and note the one-time backfill. */
export async function runCreditAutoResume(env: Env, deps: CreditResumeDeps = {}): Promise<ResumeSummary & { probed: number }> {
	const probes = await probeFailingKeys(env, deps).catch(() => ({ probed: 0, recovered: 0 }));
	const summary = await resumeRecoveredCreditRuns(env, deps);
	const first = await env.DB.prepare("INSERT OR IGNORE INTO credit_auto_resume_state (id, backfilled_at, backfill_resumed) VALUES (1, ?1, ?2)").bind((deps.now ?? Date.now)(), summary.resumed).run().catch(() => null);
	if ((first?.meta?.changes ?? 0) > 0) {
		await logEvent(env, { source: "auto-resume", event: "credit_resume.backfill", level: "info", message: `one-time backfill (first pass): ${summary.resumed} credit-stopped run(s) auto-continued, ${summary.deferred} deferred, ${summary.gaveUp} could not be`, context: { ...summary } }).catch(() => undefined);
	}
	return { ...summary, probed: probes.probed };
}
