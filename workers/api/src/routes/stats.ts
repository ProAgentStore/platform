/**
 * Stats routes (#310/#312/#313) — the resolved card set, and its values.
 *
 * Three writers, ONE validator: the creator schema (`PUT /v1/agents/:id/stats-schema`), the
 * subscriber override (`PUT /v1/instances/:id/stats`) and the agent's own `set_stats_card` all go
 * through `stats-store.ts` → `stats-schema.ts`. There is no privileged path that skips validation,
 * which is why a card the agent added is byte-identical to the same card a human added.
 *
 * Rejections are returned, never swallowed. A card that silently vanishes looks like a save that
 * worked, which is how `validateConnectionFilter`'s absence let a never-matching filter stop a
 * chain while the connection still looked healthy.
 */
import { Hono } from "hono";
import { HttpError, requireUser } from "../lib/auth.js";
import { computeStats } from "../lib/stats-report.js";
import { completedDay, statsHistoryStart } from "../lib/stats-rollup.js";
import { familyForKind, MAX_STATS_CARDS, parseStatsWindow, STATS_SOURCES } from "../lib/stats-schema.js";
import { patchInstanceStats, putInstanceStatsOverride, readAgentStatsSchema, readInstanceStats, writeAgentStatsSchema } from "../lib/stats-store.js";
import { requireOwnedInstance } from "./instances-runtime.js";
import type { Env } from "../types.js";

export const statsRoutes = new Hono<{ Bindings: Env }>();

/**
 * The source vocabulary itself.
 *
 * Served rather than duplicated in the console build or in a tool description, so the labels, the
 * supported kinds and — above all — the CAVEATS a surface displays are literally the strings the
 * queries are documented with. A copy in the UI would drift, and the thing that drifts here is the
 * sentence saying what a number does not count.
 *
 * Public: a static description of the product with nothing user-specific in it, exactly like
 * `/v1/instances/behaviour-schema`.
 */
statsRoutes.get("/stats/sources", (c) =>
	c.json({
		sources: STATS_SOURCES.map((s) => ({ ...s, families: s.kinds.map(familyForKind) })),
		maxCards: MAX_STATS_CARDS,
	}),
);

/** The resolved card set with no values — what a config UI edits. */
statsRoutes.get("/instances/:id/stats/schema", async (c) => {
	const session = await requireUser(c);
	const id = c.req.param("id");
	await requireOwnedInstance(c.env, id, session.uid);
	const stats = await readInstanceStats(c.env, id, session.uid);
	return c.json({ ...stats, historyStart: await statsHistoryStart(c.env, id, session.uid) });
});

/** Replace the subscriber's whole override. */
statsRoutes.put("/instances/:id/stats", async (c) => {
	const session = await requireUser(c);
	const id = c.req.param("id");
	await requireOwnedInstance(c.env, id, session.uid);
	const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
	const { stats, rejected } = await putInstanceStatsOverride(c.env, id, session.uid, body.stats ?? body);
	return c.json({ ...stats, rejected });
});

/** Patch semantics: an array of `{ id, card }` ops; `card: null` clears. The ops that validate
 *  still apply, and the ones that do not are named. */
statsRoutes.post("/instances/:id/stats/cards", async (c) => {
	const session = await requireUser(c);
	const id = c.req.param("id");
	await requireOwnedInstance(c.env, id, session.uid);
	const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
	const { stats, rejected } = await patchInstanceStats(c.env, id, session.uid, body.ops ?? body.cards ?? body);
	return c.json({ ...stats, rejected });
});

/** The resolved cards AND their current values, for one page-level window. */
statsRoutes.get("/instances/:id/stats", async (c) => {
	const session = await requireUser(c);
	const id = c.req.param("id");
	await requireOwnedInstance(c.env, id, session.uid);
	const window = parseStatsWindow(c.req.query("window"));
	const { cards } = await readInstanceStats(c.env, id, session.uid);
	const values = await computeStats({ env: c.env, instanceId: id, userId: session.uid }, cards, window);
	return c.json({
		window,
		// Where the ROLLUP's history begins for this instance. There is no backfill, so a short
		// series is a young rollup and not an idle agent; a surface that omits this is implying the
		// second. `null` = nothing rolled up yet.
		historyStart: await statsHistoryStart(c.env, id, session.uid),
		/** Trend series end at the last COMPLETED UTC day — today is deliberately absent. */
		throughDay: completedDay(new Date()),
		cards: values,
	});
});

/** Creator side: the default every subscriber inherits. */
statsRoutes.get("/agents/:id/stats-schema", async (c) => {
	const session = await requireUser(c);
	const agent = await requireOwnedAgent(c.env, c.req.param("id"), session.uid, session.roles);
	return c.json({ cards: await readAgentStatsSchema(c.env, agent.id) });
});

statsRoutes.put("/agents/:id/stats-schema", async (c) => {
	const session = await requireUser(c);
	const agent = await requireOwnedAgent(c.env, c.req.param("id"), session.uid, session.roles);
	const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
	const { cards, rejected } = await writeAgentStatsSchema(c.env, agent.id, body.cards ?? body.statsSchema ?? body);
	return c.json({ cards, rejected });
});

/** The creator's own agent, or an admin's. Mirrors `resolveAgent` in routes/storage.ts — this is
 *  a write to the template every subscriber inherits, so it is owner-only by construction. */
async function requireOwnedAgent(env: Env, idOrSlug: string, uid: string, roles: readonly string[]) {
	const agent = await env.DB.prepare("SELECT id, owner_id FROM agents WHERE (id = ?1 OR slug = ?1)")
		.bind(idOrSlug)
		.first<{ id: string; owner_id: string }>();
	if (!agent) throw new HttpError(404, "Agent not found");
	if (agent.owner_id !== uid && !roles.includes("admin")) throw new HttpError(403, "Not your agent");
	return agent;
}
