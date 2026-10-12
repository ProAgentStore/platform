/**
 * Browser verification, configured per instance (#1031).
 *
 * "Browser verification" is a browser-capable instance checking something the server cannot fetch
 * — a job posting behind a provider page (#1030) — in the owner's own local browser. The CAPABILITY
 * is the template's: an agent declares `runtime: "local_browser"` and its `localBrowser` ceiling
 * (`local-browser/policy.ts`). This module is the OWNER's half: whether this instance does it, where
 * it runs, what happens when it cannot, and how a person is brought in. It turns a declared
 * capability on without code; it never declares one.
 *
 * Three things stay separate, as the issue requires:
 *   - capability — declared on the agent; a setting here cannot add it (enabling refuses without it);
 *   - attachment — the runner pin (`config.runnerNode`, `PUT …/runner-node`) and the relay socket;
 *     `runtime: "pinned"` READS the pin, it does not hold a second copy (the rule `policy.ts` states);
 *   - consent — per-domain local-browser consent (`setDomainConsent`); nothing here grants any.
 *
 * Pure validation plus a one-key json_set store. Notification preferences are NOT stored here: the
 * events this feature raises are typed owner-attention events, so the instance's notification policy
 * (#992) decides them like every other — one place to say "push me", not two that can disagree.
 */
import type { Env } from "../types.js";

export const BROWSER_VERIFICATION_RUNTIMES = ["pinned", "any_eligible"] as const;
export const BROWSER_VERIFICATION_FALLBACKS = ["wait", "mark_unverifiable"] as const;
export const BROWSER_VERIFICATION_TAKEOVERS = ["prompt", "never"] as const;
/** The longest a verification may wait for an eligible runtime before its fallback ends it. */
export const WAIT_LIMIT_MINUTES = { min: 1, max: 1_440, default: 60 } as const;

export interface BrowserVerificationSettings {
	enabled: boolean;
	/** `pinned` — only the machine the instance is pinned to; `any_eligible` — any eligible machine. */
	runtime: (typeof BROWSER_VERIFICATION_RUNTIMES)[number];
	/** No eligible runtime: `wait` up to `waitLimitMinutes`, or `mark_unverifiable` at once. */
	fallback: (typeof BROWSER_VERIFICATION_FALLBACKS)[number];
	waitLimitMinutes: number;
	/** A run that needs a person: `prompt` requests a takeover; `never` ends the attempt instead. */
	takeover: (typeof BROWSER_VERIFICATION_TAKEOVERS)[number];
	/** May the takeover be answered from a phone, or only from the machine itself? */
	allowMobile: boolean;
}

export const BROWSER_VERIFICATION_DEFAULTS: BrowserVerificationSettings = {
	enabled: false,
	runtime: "pinned",
	fallback: "wait",
	waitLimitMinutes: WAIT_LIMIT_MINUTES.default,
	takeover: "prompt",
	allowMobile: true,
};

/** The owner-attention events this feature raises — decided by the instance's notification policy (#992). */
export const BROWSER_VERIFICATION_EVENTS = ["takeover_required", "approval_required", "browser_verification_failed", "browser_verification_completed"] as const;

const KEYS = Object.keys(BROWSER_VERIFICATION_DEFAULTS) as Array<keyof BrowserVerificationSettings>;
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => list.includes(v as T);

/** What is stored, read leniently: anything malformed falls back to the default for that field. */
export function resolveBrowserVerification(stored: unknown): BrowserVerificationSettings {
	const s = stored && typeof stored === "object" && !Array.isArray(stored) ? (stored as Record<string, unknown>) : {};
	const d = BROWSER_VERIFICATION_DEFAULTS;
	const wait = s.waitLimitMinutes;
	return {
		enabled: typeof s.enabled === "boolean" ? s.enabled : d.enabled,
		runtime: oneOf(BROWSER_VERIFICATION_RUNTIMES, s.runtime) ? s.runtime : d.runtime,
		fallback: oneOf(BROWSER_VERIFICATION_FALLBACKS, s.fallback) ? s.fallback : d.fallback,
		waitLimitMinutes: Number.isInteger(wait) && (wait as number) >= WAIT_LIMIT_MINUTES.min && (wait as number) <= WAIT_LIMIT_MINUTES.max ? (wait as number) : d.waitLimitMinutes,
		takeover: oneOf(BROWSER_VERIFICATION_TAKEOVERS, s.takeover) ? s.takeover : d.takeover,
		allowMobile: typeof s.allowMobile === "boolean" ? s.allowMobile : d.allowMobile,
	};
}

/**
 * Apply an owner's patch (absent field = unchanged). A value outside what is allowed is REFUSED with
 * the reason, never clamped — the rule `local-browser/policy.ts` holds to: a silently clamped setting
 * reads as accepted and then behaves differently.
 *
 * `declared` is whether the agent declares the local-browser capability. Without it, verification
 * cannot be turned ON — the capability is the template's to declare — but can always be turned off.
 */
export function mergeBrowserVerification(stored: unknown, patch: unknown, declared: boolean): { settings: BrowserVerificationSettings } | { error: string } {
	if (!patch || typeof patch !== "object" || Array.isArray(patch)) return { error: "Send an object with the fields to change." };
	const p = patch as Record<string, unknown>;
	const unknownKeys = Object.keys(p).filter((k) => !KEYS.includes(k as keyof BrowserVerificationSettings));
	if (unknownKeys.length) return { error: `Unknown field(s): ${unknownKeys.join(", ")}. Known: ${KEYS.join(", ")}.` };
	const next = { ...resolveBrowserVerification(stored) };
	if ("enabled" in p) {
		if (typeof p.enabled !== "boolean") return { error: "enabled must be true or false." };
		next.enabled = p.enabled;
	}
	if ("runtime" in p) {
		if (!oneOf(BROWSER_VERIFICATION_RUNTIMES, p.runtime)) return { error: `runtime must be one of ${BROWSER_VERIFICATION_RUNTIMES.join(", ")}.` };
		next.runtime = p.runtime;
	}
	if ("fallback" in p) {
		if (!oneOf(BROWSER_VERIFICATION_FALLBACKS, p.fallback)) return { error: `fallback must be one of ${BROWSER_VERIFICATION_FALLBACKS.join(", ")}.` };
		next.fallback = p.fallback;
	}
	if ("waitLimitMinutes" in p) {
		const w = p.waitLimitMinutes;
		if (!Number.isInteger(w) || (w as number) < WAIT_LIMIT_MINUTES.min || (w as number) > WAIT_LIMIT_MINUTES.max) {
			return { error: `waitLimitMinutes must be a whole number from ${WAIT_LIMIT_MINUTES.min} to ${WAIT_LIMIT_MINUTES.max}.` };
		}
		next.waitLimitMinutes = w as number;
	}
	if ("takeover" in p) {
		if (!oneOf(BROWSER_VERIFICATION_TAKEOVERS, p.takeover)) return { error: `takeover must be one of ${BROWSER_VERIFICATION_TAKEOVERS.join(", ")}.` };
		next.takeover = p.takeover;
	}
	if ("allowMobile" in p) {
		if (typeof p.allowMobile !== "boolean") return { error: "allowMobile must be true or false." };
		next.allowMobile = p.allowMobile;
	}
	if (next.enabled && !declared) {
		return { error: "This agent does not declare a local browser (capabilities.runtime \"local_browser\"), so browser verification cannot be turned on for it. The agent's creator declares the capability; this setting only turns a declared one on." };
	}
	return { settings: next };
}

export async function readBrowserVerification(env: Pick<Env, "DB">, instanceId: string, userId: string): Promise<{ settings: BrowserVerificationSettings; runnerNode: string | null }> {
	const row = await env.DB.prepare("SELECT config FROM agent_instances WHERE id = ?1 AND user_id = ?2").bind(instanceId, userId).first<{ config: string | null }>();
	let cfg: Record<string, unknown> = {};
	try {
		cfg = row?.config ? (JSON.parse(row.config) as Record<string, unknown>) : {};
	} catch {
		cfg = {};
	}
	return {
		settings: resolveBrowserVerification(cfg.browserVerification),
		runnerNode: typeof cfg.runnerNode === "string" && cfg.runnerNode ? cfg.runnerNode : null,
	};
}

/** One json_set on one key, so a concurrent write to another config key is not lost. */
export async function writeBrowserVerification(env: Pick<Env, "DB">, instanceId: string, userId: string, settings: BrowserVerificationSettings): Promise<void> {
	await env.DB.prepare(
		`UPDATE agent_instances
		    SET config = json_set(CASE WHEN config IS NULL OR config = '' OR NOT json_valid(config) THEN '{}' ELSE config END, '$.browserVerification', json(?1)),
		        updated_at = datetime('now')
		  WHERE id = ?2 AND user_id = ?3`,
	)
		.bind(JSON.stringify(settings), instanceId, userId)
		.run();
}
