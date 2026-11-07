/**
 * The Original Finder's per-instance settings (#1608), stored at `agent_instances.config.originalFinder`, and the
 * scope that decides which leads are worth researching.
 *
 * Scope: the target roles, locations and exclusions the owner already gave the Application Runner for auto-submit
 * (`applicationRunner.autoSubmit`), unless this Finder has `roles` of its own. A lead outside it is not researched
 * (`no_original_reason: out_of_scope`) and costs no budget.
 */
import type { Env } from "../../types.js";
import { readInstanceConfigPair } from "../instance-config.js";
import { includesAny } from "../local-apply/policy.js";
import { runnerSettingsFor } from "../local-apply/runner-settings.js";

export const FINDER_SETTINGS_KEY = "originalFinder";

export interface OriginalFinderSettings {
	/** Research runs started per rolling 24 hours (retries count). */
	dailyCap: number;
	/** Empty = follow the Application Runner's auto-submit roles. */
	roles: string[];
	locations: string[];
	exclude: string[];
}

export const FINDER_DEFAULTS: OriginalFinderSettings = { dailyCap: 10, roles: [], locations: [], exclude: [] };
export const FINDER_MAX_DAILY_CAP = 50;

const terms = (v: unknown, field: string): string[] | { error: string } => {
	if (!Array.isArray(v) || v.length > 50 || v.some((x) => typeof x !== "string" || !x.trim() || x.length > 100)) return { error: `${field} must be a list of up to 50 short phrases` };
	return [...new Set((v as string[]).map((x) => x.trim().toLowerCase()))];
};

/** Merge a patch over the current settings, REFUSING (never clamping) anything invalid. */
export function mergeFinderSettings(current: OriginalFinderSettings, patch: unknown): { settings: OriginalFinderSettings } | { error: string } {
	if (!patch || typeof patch !== "object" || Array.isArray(patch)) return { error: "settings must be an object" };
	const p = patch as Record<string, unknown>;
	const next = { ...current };
	if (p.dailyCap !== undefined) {
		if (typeof p.dailyCap !== "number" || !Number.isInteger(p.dailyCap) || p.dailyCap < 0 || p.dailyCap > FINDER_MAX_DAILY_CAP) return { error: `dailyCap must be a whole number from 0 to ${FINDER_MAX_DAILY_CAP}` };
		next.dailyCap = p.dailyCap;
	}
	for (const key of ["roles", "locations", "exclude"] as const) {
		if (p[key] === undefined) continue;
		const list = terms(p[key], key);
		if ("error" in list) return list;
		next[key] = list;
	}
	return { settings: next };
}

export function effectiveFinderSettings(stored: unknown): { settings: OriginalFinderSettings } | { error: string } {
	return stored === undefined || stored === null ? { settings: FINDER_DEFAULTS } : mergeFinderSettings(FINDER_DEFAULTS, stored);
}

export async function finderSettingsFor(env: Env, instanceId: string, uid: string): Promise<OriginalFinderSettings> {
	const pair = await readInstanceConfigPair(env, instanceId, uid);
	const eff = effectiveFinderSettings((pair?.config as Record<string, unknown> | undefined)?.[FINDER_SETTINGS_KEY]);
	return "error" in eff ? FINDER_DEFAULTS : eff.settings;
}

export interface FinderScope {
	roles: string[];
	locations: string[];
	exclude: string[];
	/** Where it came from, for the reason a lead is out of scope. */
	source: "finder" | "runner" | "none";
}

/** The Finder's own roles, else the owner's Application Runner(s) auto-submit criteria: roles and exclusions united, locations only if every Runner restricts them. */
export async function finderScope(env: Env, uid: string, settings: OriginalFinderSettings): Promise<FinderScope> {
	if (settings.roles.length) return { roles: settings.roles, locations: settings.locations, exclude: settings.exclude, source: "finder" };
	const { results } = await env.DB.prepare("SELECT DISTINCT target_instance_id AS id FROM agent_connections WHERE user_id = ?1 AND enabled = 1 AND action = 'start_application_fill'").bind(uid).all<{ id: string }>();
	const runners = (await Promise.all((results ?? []).map((r) => runnerSettingsFor(env, r.id, uid).catch(() => null)))).flatMap((s) => (s ? [s.autoSubmit] : []));
	if (!runners.length) return { roles: [], locations: settings.locations, exclude: settings.exclude, source: "none" };
	const unrestricted = runners.some((r) => !r.locations.length);
	return {
		roles: [...new Set(runners.flatMap((r) => r.roles))],
		locations: settings.locations.length ? settings.locations : unrestricted ? [] : [...new Set(runners.flatMap((r) => r.locations))],
		exclude: [...new Set([...settings.exclude, ...runners.flatMap((r) => r.exclude)])],
		source: "runner",
	};
}

/** Null when the lead is worth researching, else why not. The same tests the Runner's auto-submit gate applies to a lead. */
export function outOfScope(lead: { title?: string; company?: string; location?: string; match_rationale?: string }, scope: FinderScope): string | null {
	if (!scope.roles.length) return "no target roles are configured (set roles on this Finder, or on the Application Runner's auto-submit)";
	if (!includesAny(lead.title, scope.roles)) return "the title matches none of the target roles";
	if (scope.locations.length && !includesAny(lead.location, scope.locations)) return "the location matches none of the target locations";
	if ([lead.title, lead.company, lead.match_rationale].some((t) => includesAny(t, scope.exclude))) return "the lead matches an exclusion";
	return null;
}
