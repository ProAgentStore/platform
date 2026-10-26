/**
 * The re-check of a held provider key (#1318, #1326, #1344): the probe side of what used to be `credit-auto-resume.ts` (#1356).
 *
 * A held key is probed with the same four-token request the console's Verify button sends (`provider-key-verify.ts`), on the
 * model the refused request named. A success clears the hold exactly as any real call does. The schedule is `retry-policy.ts`.
 * The runs stopped behind a hold are continued by `account-stop-resume.ts`, which reads the hold this module clears.
 */
import type { Env } from "../types.js";
import { clipMarked } from "./clip-marked.js";
import { decryptKey } from "./crypto.js";
import { logEvent } from "./events.js";
import { providerCredentialId, type HeldProvider } from "./provider-account-hold.js";
import { verifyProviderKey } from "./provider-key-verify.js";
import { AUTO_RESUME_WINDOW_MS, PROBE_GIVE_UP_MS, probeDelayMs } from "./retry-policy.js";

export interface ProbeOutcome { ok: boolean; error?: string }

export interface ProbeDeps {
	now?: () => number;
	/** The four-token probe of this owner's key on `provider`; true when it worked (which also clears the hold). */
	probe?: (env: Env, userId: string, provider: HeldProvider, model?: string | null) => Promise<boolean | ProbeOutcome>;
	windowMs?: number;
}

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


/**
 * The hold's re-check: the verify request (`lib/provider-key-verify.ts`, the same one the console's Verify button sends) on the MODEL the
 * refused request named (#1344). A success clears the hold as any real call does; a failure is "not yet", with the provider's words for the record.
 */
export async function probeProviderKey(env: Env, userId: string, provider: HeldProvider, model?: string | null): Promise<ProbeOutcome> {
	try {
		const verdict = await verifyProviderKey(env, userId, provider, { model });
		if (verdict.ok) return { ok: true };
		return { ok: false, error: clipMarked(verdict.reason === "unavailable" ? verdict.message : verdict.error.message, 400, { within: true }) };
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
export async function probeFailingKeys(env: Env, deps: ProbeDeps = {}): Promise<{ probed: number; recovered: number }> {
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
