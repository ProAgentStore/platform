/**
 * Original Finder (#1608) - its settings and what it has done. The Finder is fed by a connection (the Scout's
 * `job.lead.original_missing` -> `find_original_posting`); these routes only read its queue and set its scope and budget.
 * Owner-scoped throughout.
 */
import type { Context, Hono } from "hono";
import { requireUser } from "../lib/auth.js";
import { patchInstanceConfig, readInstanceConfigPair } from "../lib/instance-config.js";
import { runsStartedToday } from "../lib/original-finder/health.js";
import { FINDER_DEFAULTS, FINDER_SETTINGS_KEY, effectiveFinderSettings, finderScope, mergeFinderSettings } from "../lib/original-finder/settings.js";
import type { Env } from "../types.js";
import { requireOwnedInstance } from "./instances-runtime.js";

type C = Context<{ Bindings: Env }>;

async function owned(c: C): Promise<{ uid: string; instanceId: string }> {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId") ?? "";
	await requireOwnedInstance(c.env, instanceId, session.uid);
	return { uid: session.uid, instanceId };
}

async function stored(c: C, instanceId: string, uid: string): Promise<unknown> {
	return ((await readInstanceConfigPair(c.env, instanceId, uid))?.config as Record<string, unknown> | undefined)?.[FINDER_SETTINGS_KEY];
}

export function registerOriginalFinderRoutes(router: Hono<{ Bindings: Env }>): void {
	router.get("/:instanceId/original-finder/settings", async (c) => {
		const { uid, instanceId } = await owned(c);
		const effective = effectiveFinderSettings(await stored(c, instanceId, uid));
		return c.json("error" in effective ? { settings: FINDER_DEFAULTS, error: effective.error } : { settings: effective.settings });
	});

	/** Patch semantics: only the fields sent change. */
	router.put("/:instanceId/original-finder/settings", async (c) => {
		const { uid, instanceId } = await owned(c);
		const current = effectiveFinderSettings(await stored(c, instanceId, uid));
		const merged = mergeFinderSettings("error" in current ? FINDER_DEFAULTS : current.settings, await c.req.json().catch(() => null));
		if ("error" in merged) return c.json({ error: merged.error }, 400);
		await patchInstanceConfig(c.env, instanceId, uid, FINDER_SETTINGS_KEY, merged.settings);
		return c.json({ settings: merged.settings });
	});

	/** The queue, the budget and the scope in force. */
	router.get("/:instanceId/original-finder", async (c) => {
		const { uid, instanceId } = await owned(c);
		const effective = effectiveFinderSettings(await stored(c, instanceId, uid));
		const settings = "error" in effective ? FINDER_DEFAULTS : effective.settings;
		const [counts, recent, used, scope] = await Promise.all([
			c.env.DB.prepare("SELECT state, COUNT(*) AS n FROM original_finder_leads WHERE instance_id = ?1 AND user_id = ?2 GROUP BY state").bind(instanceId, uid).all<{ state: string; n: number }>(),
			c.env.DB.prepare("SELECT lead_id, source_instance_id, state, attempts, next_attempt_at, run_id, detail, original_url, updated_at FROM original_finder_leads WHERE instance_id = ?1 AND user_id = ?2 ORDER BY updated_at DESC LIMIT 50").bind(instanceId, uid).all(),
			runsStartedToday(c.env, instanceId, uid),
			finderScope(c.env, uid, settings),
		]);
		return c.json({
			settings,
			scope,
			budget: { dailyCap: settings.dailyCap, usedToday: used, remaining: Math.max(0, settings.dailyCap - used) },
			counts: Object.fromEntries((counts.results ?? []).map((r) => [r.state, r.n])),
			leads: recent.results ?? [],
		});
	});
}
