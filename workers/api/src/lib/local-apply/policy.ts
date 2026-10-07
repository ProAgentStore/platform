/**
 * Application Runner (#957) — the owner's settings and the auto-submit gate. Pure: no D1, no
 * runner, so the policy is tested as policy.
 *
 * The default is `fill_and_review`: the runner fills from the owner's own sources and stops before
 * the final Submit. `auto_submit` is never a setting on its own — it is the outcome of the gate
 * below, evaluated per application at dispatch, and EVERY check must pass:
 *
 *   auto_submit_enabled  the owner separately switched it on;
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
	maxPages: number;
	maxActions: number;
	autoSubmit: AutoSubmitPolicy;
}

export const RUNNER_DEFAULTS: ApplicationRunnerSettings = {
	engine: "claude",
	authMode: "machine",
	browserProfile: "isolated",
	workspace: "~/jobs",
	sources: { profile: "profile.md" },
	allowDomains: [],
	maxMinutes: 20,
	maxPages: 30,
	maxActions: 300,
	autoSubmit: { enabled: false, roles: [], locations: [], exclude: [], minSalary: null, dailyCap: 0 },
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
	}
	return { settings: next };
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
	const checks: GateCheck[] = [
		{ check: "auto_submit_enabled", ok: a.enabled, why: "the owner has not enabled auto-submit" },
		{ check: "materials_complete", ok: !!app.profileVersion && !!app.resumeSha && !!app.coverLetterSha, why: "no versioned profile and complete artifact set" },
		{ check: "domain_allowlisted", ok: !!host && i.settings.allowDomains.some((d) => domainWithin(host, d)), why: `${host ?? "the job's site"} is not on the instance's allow list` },
		{ check: "role_matches", ok: has(app.lead.title, a.roles), why: "the title matches no approved role" },
		{ check: "location_matches", ok: a.locations.length === 0 || has(app.lead.location, a.locations), why: "the location matches no approved location" },
		{ check: "not_excluded", ok: ![app.lead.title, app.lead.company, app.lead.match_rationale].some((t) => has(t, a.exclude)), why: "the lead matches an exclusion" },
		{ check: "salary_matches", ok: a.minSalary === null || (salary !== null && salary >= a.minSalary), why: salary === null ? "the lead carries no salary to check" : "the salary is below the minimum" },
		{ check: "daily_cap", ok: a.dailyCap > 0 && i.autoSubmitsToday < a.dailyCap, why: `the daily cap (${a.dailyCap}) is used` },
		{ check: "concurrency", ok: i.activeRuns === 0, why: "another application run is open" },
		{ check: "no_blocker", ok: !app.blockReason && app.submitAttemptedAt === null, why: "the application carries a blocker or an earlier submit attempt" },
	].map((c) => (c.ok ? { check: c.check, ok: true } : c));
	return { allowed: checks.every((c) => c.ok), checks };
}
