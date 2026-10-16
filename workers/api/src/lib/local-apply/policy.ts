/**
 * Application Runner (#957) — the owner's settings and the auto-submit gate. Pure: no D1, no
 * runner, so the policy is tested as policy.
 *
 * The default is `fill_and_review`: the runner fills from the owner's own sources and stops before
 * the final Submit. `auto_submit` is never a setting on its own — it is the outcome of the gate
 * below, evaluated per application at dispatch, and EVERY check must pass:
 *
 *   auto_submit_enabled  the owner separately switched it on, acknowledging that submissions are
 *                        real and irreversible (#1039: `acknowledgedAt`, stamped by the server);
 *   materials_complete   a versioned profile and both approved artifacts, with hashes;
 *   domain_allowlisted   the job's site is on the instance's own allow list (not just "the job's URL");
 *   role / location / exclusion / salary   the lead matches the owner's approved criteria;
 *   daily_cap / concurrency                a submission slot is free;
 *   no_blocker           the application carries no block reason and no earlier submit attempt.
 *
 * A failed gate never blocks the application: it runs fill-and-review, and the verdict — with
 * each failing check — is on the run's trace.
 */
import { domainWithin, normalizeDomain } from "../local-browser/policy.js";
import { APPROVAL_SATISFIES } from "./approval.js";
import { LOCAL_APPLY_AUTH_MODES, LOCAL_APPLY_ENGINES, type LocalApplyAuthMode, type LocalApplyEngine, type LocalApplyProfile } from "./contract.js";
import { isHomeRelative, isWorkspaceRelative } from "../local-artifact/contract.js";

export interface AutoSubmitPolicy {
	enabled: boolean;
	/** A lead's title must contain one of these (case-insensitive). Empty = nothing qualifies. */
	roles: string[];
	/** When set, the lead's location must contain one of these. */
	locations: string[];
	/** No title, company or rationale may contain one of these. */
	exclude: string[];
	/** When set, the lead must carry a salary at or above it — leads without one do not qualify. */
	minSalary: number | null;
	/** Auto-submissions per rolling 24h. 0 = none. */
	dailyCap: number;
	/**
	 * When the owner acknowledged that auto-submit sends real, irreversible applications (#1039).
	 * Stamped by the server when it is enabled with `acknowledgeRealSubmissions: true`, cleared when it
	 * is disabled; a client cannot set it. Enabled without it, the gate refuses every submission.
	 */
	acknowledgedAt: string | null;
}

export interface ApplicationRunnerSettings {
	engine: LocalApplyEngine;
	authMode: LocalApplyAuthMode;
	browserProfile: LocalApplyProfile;
	workspace: string;
	sources: { profile?: string; answers?: string };
	/** Sites the runner may be on in addition to the job's own; also the auto-submit allow list. */
	allowDomains: string[];
	maxMinutes: number;
	/** Minutes without a new event before the owner is told the run stalled (#1107). Null: automatic (`stallMinutesFor`). */
	stallMinutes: number | null;
	maxPages: number;
	maxActions: number;
	autoSubmit: AutoSubmitPolicy;
	/**
	 * The address the owner's SEEK account is registered under (#1106). Set, a fill paused for a SEEK sign-in signs
	 * itself in with the code SEEK emails there, read from the Gmail this Runner is pinned to — which must be this
	 * same address. Null: every sign-in waits for the owner, as before.
	 */
	signInEmail: string | null;
}

export const RUNNER_DEFAULTS: ApplicationRunnerSettings = {
	engine: "claude",
	authMode: "machine",
	browserProfile: "isolated",
	workspace: "~/jobs",
	sources: { profile: "profile.md" },
	allowDomains: [],
	maxMinutes: 20,
	stallMinutes: null,
	maxPages: 30,
	maxActions: 300,
	autoSubmit: { enabled: false, roles: [], locations: [], exclude: [], minSalary: null, dailyCap: 0, acknowledgedAt: null },
	signInEmail: null,
};
export const RUNNER_SETTINGS_KEY = "applicationRunner";

const terms = (v: unknown, field: string): string[] | { error: string } => {
	if (!Array.isArray(v) || v.length > 50 || v.some((x) => typeof x !== "string" || !x.trim() || x.length > 100)) return { error: `${field} must be a list of up to 50 short phrases` };
	return [...new Set((v as string[]).map((x) => x.trim().toLowerCase()))];
};
const intIn = (v: unknown, min: number, max: number) => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

/** Merge a patch over the current settings, REFUSING (never clamping) anything invalid. */
export function mergeRunnerSettings(current: ApplicationRunnerSettings, patch: unknown): { settings: ApplicationRunnerSettings } | { error: string } {
	if (!patch || typeof patch !== "object" || Array.isArray(patch)) return { error: "settings must be an object" };
	const p = patch as Record<string, unknown>;
	const next: ApplicationRunnerSettings = { ...current, sources: { ...current.sources }, autoSubmit: { ...current.autoSubmit } };
	if (p.engine !== undefined) {
		if (!LOCAL_APPLY_ENGINES.includes(p.engine as LocalApplyEngine)) return { error: `engine must be one of ${LOCAL_APPLY_ENGINES.join(", ")}` };
		next.engine = p.engine as LocalApplyEngine;
	}
	if (p.authMode !== undefined) {
		if (!LOCAL_APPLY_AUTH_MODES.includes(p.authMode as LocalApplyAuthMode)) return { error: "authMode must be machine or subscription — applications run on the machine's own sign-in, never a provider API key" };
		next.authMode = p.authMode as LocalApplyAuthMode;
	}
	if (p.browserProfile !== undefined) {
		if (p.browserProfile !== "isolated" && p.browserProfile !== "default") return { error: "browserProfile must be isolated or default" };
		next.browserProfile = p.browserProfile;
	}
	if (p.workspace !== undefined) {
		if (typeof p.workspace !== "string" || !isHomeRelative(p.workspace.trim())) return { error: 'workspace must be a folder under the home folder, written "~/…" (no "..")' };
		next.workspace = p.workspace.trim();
	}
	if (p.sources !== undefined) {
		if (!p.sources || typeof p.sources !== "object" || Array.isArray(p.sources)) return { error: "sources must be an object of role → path" };
		for (const [role, path] of Object.entries(p.sources as Record<string, unknown>)) {
			if (role !== "profile" && role !== "answers") return { error: `unknown source role "${role}" (profile, answers)` };
			if (path === null || path === "") {
				delete next.sources[role];
				continue;
			}
			if (typeof path !== "string" || !isWorkspaceRelative(path.trim()) || path.trim().split("/")[0] === "applications") return { error: `source ${role} must be a path inside the workspace, outside applications/` };
			next.sources[role] = path.trim();
		}
	}
	if (p.allowDomains !== undefined) {
		if (!Array.isArray(p.allowDomains) || p.allowDomains.length > 50) return { error: "allowDomains must be a list of up to 50 hostnames" };
		const out: string[] = [];
		for (const d of p.allowDomains) {
			const n = normalizeDomain(d);
			if (!n) return { error: `allowDomains: "${String(d)}" is not a hostname ("example.com" also covers its subdomains)` };
			if (!out.includes(n)) out.push(n);
		}
		next.allowDomains = out;
	}
	if (p.signInEmail !== undefined) {
		const e = typeof p.signInEmail === "string" ? p.signInEmail.trim().toLowerCase() : p.signInEmail;
		if (e !== null && e !== "" && (typeof e !== "string" || e.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e))) return { error: "signInEmail must be an email address, or null" };
		next.signInEmail = e || null;
	}
	if (p.stallMinutes !== undefined) {
		if (p.stallMinutes !== null && !intIn(p.stallMinutes, 1, 60)) return { error: "stallMinutes must be a whole number from 1 to 60, or null for automatic" };
		next.stallMinutes = p.stallMinutes as number | null;
	}
	for (const [key, min, max] of [["maxMinutes", 1, 60], ["maxPages", 1, 200], ["maxActions", 1, 1000]] as const) {
		if (p[key] === undefined) continue;
		if (!intIn(p[key], min, max)) return { error: `${key} must be a whole number from ${min} to ${max}` };
		next[key] = p[key] as number;
	}
	if (p.autoSubmit !== undefined) {
		if (!p.autoSubmit || typeof p.autoSubmit !== "object" || Array.isArray(p.autoSubmit)) return { error: "autoSubmit must be an object" };
		const a = p.autoSubmit as Record<string, unknown>;
		if (a.enabled !== undefined) {
			if (typeof a.enabled !== "boolean") return { error: "autoSubmit.enabled must be true or false" };
			next.autoSubmit.enabled = a.enabled;
		}
		for (const key of ["roles", "locations", "exclude"] as const) {
			if (a[key] === undefined) continue;
			const list = terms(a[key], `autoSubmit.${key}`);
			if ("error" in list) return list;
			next.autoSubmit[key] = list;
		}
		if (a.minSalary !== undefined) {
			if (a.minSalary !== null && !intIn(a.minSalary, 1, 100_000_000)) return { error: "autoSubmit.minSalary must be a positive whole number, or null" };
			next.autoSubmit.minSalary = a.minSalary as number | null;
		}
		if (a.dailyCap !== undefined) {
			if (!intIn(a.dailyCap, 0, 50)) return { error: "autoSubmit.dailyCap must be a whole number from 0 to 50" };
			next.autoSubmit.dailyCap = a.dailyCap as number;
		}
		// Round-trips the stored stamp. The settings ROUTE strips any client-sent value first and stamps
		// it itself (`acknowledgeAutoSubmit`), so this is never how an acknowledgement is made.
		if (a.acknowledgedAt !== undefined) {
			if (a.acknowledgedAt !== null && (typeof a.acknowledgedAt !== "string" || Number.isNaN(Date.parse(a.acknowledgedAt)))) return { error: "autoSubmit.acknowledgedAt must be a timestamp, or null" };
			next.autoSubmit.acknowledgedAt = a.acknowledgedAt as string | null;
		}
	}
	// #953: auto-submit cannot be ENABLED until the policy it would run under exists. The gate would
	// refuse every application anyway; refusing the switch says so where the owner is looking.
	const missing = autoSubmitPrerequisites(next);
	if (next.autoSubmit.enabled && missing.length) return { error: `Auto-submit cannot be enabled yet — it needs ${missing.join(", ")}.` };
	// A disabled policy carries no acknowledgement: enabling again needs a new one.
	if (!next.autoSubmit.enabled) next.autoSubmit.acknowledgedAt = null;
	return { settings: next };
}

export const AUTO_SUBMIT_ACKNOWLEDGEMENT_REQUIRED =
	"Enabling auto-submit requires acknowledgeRealSubmissions: true in the request body. Auto-submit sends real job applications to third-party sites, and a submission cannot be undone.";

/**
 * The owner's explicit acknowledgement for STANDING auto-submit (#1039), applied by the settings route
 * to a merged change. Switching it ON — from off — requires `acknowledged` and stamps `acknowledgedAt`;
 * staying on keeps the stamp it was enabled with; switching off needs nothing. Pure, so the rule is
 * tested as a rule. Every other prerequisite and the per-application gate are unchanged.
 */
export function acknowledgeAutoSubmit(current: ApplicationRunnerSettings, next: ApplicationRunnerSettings, acknowledged: boolean, nowIso: string): { settings: ApplicationRunnerSettings } | { error: string } {
	const enabling = next.autoSubmit.enabled && !current.autoSubmit.enabled;
	if (enabling && !acknowledged) return { error: AUTO_SUBMIT_ACKNOWLEDGEMENT_REQUIRED };
	if (!next.autoSubmit.enabled) return { settings: { ...next, autoSubmit: { ...next.autoSubmit, acknowledgedAt: null } } };
	return { settings: { ...next, autoSubmit: { ...next.autoSubmit, acknowledgedAt: enabling ? nowIso : current.autoSubmit.acknowledgedAt } } };
}

/**
 * What an enabled auto-submit needs to exist first (#953): the owner's profile to answer from, and an
 * explicit submission policy — the roles they approve, the sites they allow, and a daily cap. The
 * profile FILE is checked on the owner's machine by the runner at every run (it ends `blocked` when
 * missing); here, it must at least be configured. Empty means ready.
 */
export function autoSubmitPrerequisites(s: ApplicationRunnerSettings): string[] {
	const missing: string[] = [];
	if (!s.sources.profile) missing.push("a profile source (sources.profile)");
	if (!s.autoSubmit.roles.length) missing.push("at least one approved role (autoSubmit.roles)");
	if (!s.allowDomains.length) missing.push("at least one allowed site (allowDomains)");
	if (s.autoSubmit.dailyCap < 1) missing.push("a daily cap of at least 1 (autoSubmit.dailyCap)");
	return missing;
}

export function effectiveRunnerSettings(stored: unknown): { settings: ApplicationRunnerSettings } | { error: string } {
	return stored === undefined || stored === null ? { settings: RUNNER_DEFAULTS } : mergeRunnerSettings(RUNNER_DEFAULTS, stored);
}

export function hostOfUrl(url: string): string | null {
	try {
		const u = new URL(url);
		return u.protocol === "https:" || u.protocol === "http:" ? u.hostname.toLowerCase().replace(/\.$/, "") : null;
	} catch {
		return null;
	}
}

export interface GateInput {
	settings: ApplicationRunnerSettings;
	/**
	 * The owner's per-application approval (#973), when one is usable. It stands in for the checks
	 * that INFER intent ({@link APPROVAL_SATISFIES}) and for nothing else: the safety and
	 * correctness checks below still have to pass, and so do the runner's own bridge checks.
	 */
	approval?: { id: string; usable: boolean } | null;
	application: {
		profileVersion: string | null;
		resumeSha: string | null;
		coverLetterSha: string | null;
		blockReason: string | null;
		submitAttemptedAt: number | null;
		leadUrl: string;
		lead: { title?: string; company?: string; location?: string; match_rationale?: string; salary?: unknown };
	};
	/** auto_submit runs this instance dispatched in the last 24h. */
	autoSubmitsToday: number;
	/** Fill runs of this instance still open. */
	activeRuns: number;
}

export interface GateCheck {
	check: string;
	ok: boolean;
	why?: string;
}

export function evaluateSubmitGate(i: GateInput): { allowed: boolean; checks: GateCheck[] } {
	const a = i.settings.autoSubmit;
	const app = i.application;
	const has = (text: string | undefined, list: string[]) => !!text && list.some((t) => text.toLowerCase().includes(t));
	const host = hostOfUrl(app.leadUrl);
	const salary = typeof app.lead.salary === "number" ? app.lead.salary : null;
	const approved = i.approval?.usable === true;
	const checks: GateCheck[] = [
		// #1039: enabled is not enough — the owner must have acknowledged that submissions are real. A
		// policy enabled before that existed fails here and runs fill-and-review until re-enabled.
		{ check: "auto_submit_enabled", ok: a.enabled && !!a.acknowledgedAt, why: a.enabled ? "auto-submit was enabled without the owner's acknowledgement that submissions are real and irreversible — enable it again with that acknowledgement" : "the owner has not enabled auto-submit" },
		{ check: "materials_complete", ok: !!app.profileVersion && !!app.resumeSha && !!app.coverLetterSha, why: "no versioned profile and complete artifact set" },
		{ check: "domain_allowlisted", ok: !!host && i.settings.allowDomains.some((d) => domainWithin(host, d)), why: `${host ?? "the job's site"} is not on the instance's allow list` },
		{ check: "role_matches", ok: has(app.lead.title, a.roles), why: "the title matches no approved role" },
		{ check: "location_matches", ok: a.locations.length === 0 || has(app.lead.location, a.locations), why: "the location matches no approved location" },
		{ check: "not_excluded", ok: ![app.lead.title, app.lead.company, app.lead.match_rationale].some((t) => has(t, a.exclude)), why: "the lead matches an exclusion" },
		{ check: "salary_matches", ok: a.minSalary === null || (salary !== null && salary >= a.minSalary), why: salary === null ? "the lead carries no salary to check" : "the salary is below the minimum" },
		{ check: "daily_cap", ok: a.dailyCap > 0 && i.autoSubmitsToday < a.dailyCap, why: `the daily cap (${a.dailyCap}) is used` },
		{ check: "concurrency", ok: i.activeRuns === 0, why: "another application run is open" },
		{ check: "no_blocker", ok: !app.blockReason && app.submitAttemptedAt === null, why: "the application carries a blocker or an earlier submit attempt" },
	]
		// A PASSING check drops its `why` (#985). Every check above is built with the sentence that
		// explains its FAILURE, so keeping it on a pass rendered the live gate as a contradiction:
		// `domain_allowlisted · ok: true · why: "au.seek.com is not on the instance's allow list"`,
		// `not_excluded · ok: true · why: "the lead matches an exclusion"`. An owner reading that
		// cannot tell which half to believe, and this record is the only account of why a submission
		// was allowed. Done BEFORE the approval rewrite below, so the one affirmative sentence there
		// is — the owner's own approval — survives.
		.map((c) => (c.ok ? { check: c.check, ok: true } : c))
		// An approval answers the intent checks. Rewritten rather than skipped so the recorded gate
		// still lists every check and says WHY each one passed — a gate whose checks vanish when a
		// flag is set cannot be audited afterwards, and this gate is the record of why a submit was
		// allowed to happen.
		.map((c) => (approved && (APPROVAL_SATISFIES as readonly string[]).includes(c.check) ? { check: c.check, ok: true, why: "approved for this application by the owner" } : c));
	if (i.approval) {
		checks.push(
			approved
				? { check: "submission_approved", ok: true, why: `authorization ${i.approval.id}` }
				: { check: "submission_approved", ok: false, why: "the approval for this application is no longer usable" },
		);
	}
	return { allowed: checks.every((c) => c.ok), checks };
}
