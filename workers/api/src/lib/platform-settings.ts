import type { Env } from "../types.js";

/**
 * Runtime operator settings that override deploy-time env vars (issue #46, migration
 * 0081). The first — and currently only — lever is the platform-paid AI kill switch.
 *
 * ## What the switch governs
 *
 * ONLY AI the PLATFORM pays for: `env.AI` (Cloudflare Workers AI on the platform's own
 * account) used for embeddings, conversation summaries and translation — the calls
 * ledgered as `provider="platform"` by `recordPlatformUsage`. It does NOT touch BYOK:
 * a user's Anthropic key, or Workers AI run against the user's OWN Cloudflare account
 * via `runUserWorkersAi`, is their spend and keeps working. Chat is BYOK, so turning
 * this off does not stop anyone talking to their agent.
 *
 * Known side effect, and the reason this is a lever rather than a default: with it off,
 * embeddings and summaries no-op, so RAG goes dark for new content until a BYOK
 * embedding path exists. Translation is the exception — it already falls back to BYOK.
 *
 * ## Immediacy vs the hot path
 *
 * These two pull against each other, and the resolution is to scope the read to the
 * WORK, never to time:
 *
 *  - No TTL cache. An operator killing runaway spend needs the next call stopped, not
 *    the next call after a cache expiry — and a warm Worker isolate can outlive many
 *    requests, so even a "short" TTL is unbounded from the operator's point of view.
 *    `requireUser`'s suspension lookup made the identical call for the identical reason.
 *  - The read is instead hoisted to the unit of work: `AgentDO.getStorageEngine()`
 *    resolves it once when it builds the storage engine, so a repo-ingest tick that
 *    embeds 60 chunks pays for ONE lookup, not 60. That is what keeps a per-call check
 *    cheap without making it stale.
 *  - The lookup itself is a single-row PK read on a table with a handful of rows —
 *    the same cost the platform already pays per authenticated request for
 *    `users.suspended`.
 *
 * ## Failure mode
 *
 * On a D1 error the ENV DEFAULT governs, matching `isSuspended`'s deliberate fail-open:
 * a D1 blip must not silently change platform behaviour, and "the deployed
 * configuration stands" is the one answer that is always defensible. The consequence is
 * honest and worth stating: if an operator has flipped the switch OFF and D1 is
 * unreachable, platform-paid AI resumes — so the deploy-time `PLATFORM_AI_ENABLED`
 * remains the backstop for a hard, D1-independent stop.
 */

/** The `platform_settings.key` for the platform-paid AI switch. */
export const PLATFORM_AI_KEY = "platform_ai_enabled";

export interface PlatformAiSetting {
	/** The value actually in force. */
	enabled: boolean;
	/** Where it came from — an operator override, or the deployed env var. */
	source: "override" | "env";
	/** What `PLATFORM_AI_ENABLED` says in wrangler.toml (the fallback). */
	envDefault: boolean;
	/** The stored override, or null when none is set. */
	override: boolean | null;
	updatedAt: string | null;
	updatedBy: string | null;
}

interface SettingRow {
	value: string;
	updated_at: string | null;
	updated_by: string | null;
}

/** `PLATFORM_AI_ENABLED` from the deployed config. */
export function platformAiEnvDefault(env: Pick<Env, "PLATFORM_AI_ENABLED">): boolean {
	return env.PLATFORM_AI_ENABLED === "true";
}

/**
 * Full resolution of the platform-AI switch, for the admin surface. Callers on the hot
 * path want {@link platformAiEnabled} instead.
 */
export async function readPlatformAiSetting(env: Env): Promise<PlatformAiSetting> {
	const envDefault = platformAiEnvDefault(env);
	let row: SettingRow | null = null;
	try {
		if (env.DB) {
			row = await env.DB.prepare(
				"SELECT value, updated_at, updated_by FROM platform_settings WHERE key = ?1",
			)
				.bind(PLATFORM_AI_KEY)
				.first<SettingRow>();
		}
	} catch {
		// Table missing (migration not yet applied) or D1 unavailable → env default.
		row = null;
	}
	// Only an exact "true"/"false" counts as an override. A junk value is treated as no
	// override rather than as `false`, so a bad write degrades to the deployed config
	// instead of silently taking RAG dark platform-wide.
	const override = row?.value === "true" ? true : row?.value === "false" ? false : null;
	return {
		enabled: override ?? envDefault,
		source: override === null ? "env" : "override",
		envDefault,
		override,
		updatedAt: override === null ? null : (row?.updated_at ?? null),
		updatedBy: override === null ? null : (row?.updated_by ?? null),
	};
}

/**
 * Is the platform allowed to pay for AI right now? The hot-path read — one indexed
 * single-row lookup, uncached, resolved once per unit of work by the caller.
 */
export async function platformAiEnabled(env: Env): Promise<boolean> {
	return (await readPlatformAiSetting(env)).enabled;
}

/**
 * Resolve the AI binding the platform is currently allowed to spend on: the binding
 * itself, or null when the switch is off (or there is no binding at all).
 *
 * Returning the binding rather than a boolean is deliberate — every call site's real
 * question is "which AI may I use", and a null binding is already the shape those code
 * paths handle ("indexing off"), so nothing downstream needs a second flag.
 */
export async function platformAiBinding(env: Env): Promise<Ai | null> {
	if (!env.AI) return null;
	return (await platformAiEnabled(env)) ? env.AI : null;
}

/**
 * Set (or with `enabled: null`, clear) the platform-AI override. Returns the setting as
 * it stands afterwards. Clearing is a first-class action: it hands control back to the
 * deployed config rather than pinning a value that then silently contradicts the next
 * deploy.
 */
export async function setPlatformAiOverride(
	env: Env,
	enabled: boolean | null,
	actorId: string,
): Promise<PlatformAiSetting> {
	if (enabled === null) {
		await env.DB.prepare("DELETE FROM platform_settings WHERE key = ?1").bind(PLATFORM_AI_KEY).run();
	} else {
		await env.DB.prepare(
			`INSERT INTO platform_settings (key, value, updated_at, updated_by)
			 VALUES (?1, ?2, datetime('now'), ?3)
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value,
			                                updated_at = excluded.updated_at,
			                                updated_by = excluded.updated_by`,
		)
			.bind(PLATFORM_AI_KEY, enabled ? "true" : "false", actorId)
			.run();
	}
	return readPlatformAiSetting(env);
}
