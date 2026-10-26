/**
 * `GET /v1/instances/my/disabled-instances` (#1383): the Disabled list — every instance the owner has switched off, with what they need to decide
 * whether to bring it back: its name, repos, pinned machine, when/by whom/why it was disabled, and its last run.
 *
 * "Disabled" is `status = 'paused'` (see `lib/instance-pause.ts` and migration 0306): the same state every gate already refuses work for. An
 * instance paused with plain `pause_instance` is listed too, with `disabled.{at,by,reason}` null — shown as paused with no record, never given
 * one. Read-only; flat queries over the caller's own rows, bounded, so a long Disabled list costs the same few reads as a short one.
 */
import type { Hono } from "hono";
import { requireUser } from "../lib/auth.js";
import { instanceListName } from "../lib/instance-config.js";
import { resolveRunnerPins } from "../lib/runtime-nodes.js";
import type { Env } from "../types.js";

/** Disabled instances returned. Past it `truncated` is true; the owner can enable some and read again. */
export const DISABLED_LIST_MAX = 200;
const IN_CHUNK = 80;

async function readIn<T>(env: Env, userId: string, ids: readonly string[], sql: (list: string) => string): Promise<T[]> {
	const out: T[] = [];
	for (let i = 0; i < ids.length; i += IN_CHUNK) {
		const part = ids.slice(i, i + IN_CHUNK);
		const list = part.map((_, k) => `?${k + 2}`).join(",");
		out.push(...((await env.DB.prepare(sql(list)).bind(userId, ...part).all<T>()).results ?? []));
	}
	return out;
}

export function registerDisabledInstancesRoutes(router: Hono<{ Bindings: Env }>): void {
	router.get("/my/disabled-instances", async (c) => {
		const session = await requireUser(c);
		const uid = session.uid;
		const rows =
			(
				await c.env.DB.prepare(
					`SELECT i.id, i.config, i.disabled_at, i.disabled_by, i.disabled_reason, i.last_activity_at, i.updated_at, a.name, a.slug
					   FROM agent_instances i JOIN agents a ON a.id = i.agent_id
					  WHERE i.user_id = ?1 AND i.status = 'paused'
					  ORDER BY COALESCE(i.disabled_at, i.updated_at) DESC, i.id LIMIT ?2`,
				)
					.bind(uid, DISABLED_LIST_MAX + 1)
					.all<{ id: string; config: string | null; disabled_at: string | null; disabled_by: string | null; disabled_reason: string | null; last_activity_at: string | null; updated_at: string | null; name: string | null; slug: string | null }>()
			).results ?? [];
		const truncated = rows.length > DISABLED_LIST_MAX;
		const page = rows.slice(0, DISABLED_LIST_MAX);
		const ids = page.map((r) => r.id);

		const [repoRows, runRows, queueRows, pins] = await Promise.all([
			readIn<{ instance_id: string; name: string; github_repo: string | null }>(c.env, uid, ids, (list) => `SELECT instance_id, name, github_repo FROM coding_repos WHERE user_id = ?1 AND instance_id IN (${list}) ORDER BY name`),
			readIn<{ instance_id: string; run_id: string; status: string; stop_reason: string | null; started_at: number; finished_at: number | null }>(
				c.env,
				uid,
				ids,
				(list) =>
					`SELECT instance_id, run_id, status, stop_reason, started_at, finished_at FROM (
					   SELECT r.*, ROW_NUMBER() OVER (PARTITION BY r.instance_id ORDER BY r.started_at DESC) AS rn
					     FROM agent_loop_runs r WHERE r.user_id = ?1 AND r.instance_id IN (${list})
					 ) WHERE rn = 1`,
			),
			readIn<{ instance_id: string; n: number }>(c.env, uid, ids, (list) => `SELECT instance_id, COUNT(*) AS n FROM instance_objective_queue WHERE user_id = ?1 AND status = 'pending' AND instance_id IN (${list}) GROUP BY instance_id`),
			resolveRunnerPins(c.env, uid, page.map((r) => ({ id: r.id, config: r.config }))),
		]);
		const repos = new Map<string, Array<{ name: string; githubRepo: string | null }>>();
		for (const r of repoRows) repos.set(r.instance_id, [...(repos.get(r.instance_id) ?? []), { name: r.name, githubRepo: r.github_repo }]);
		const lastRun = new Map(runRows.map((r) => [r.instance_id, { runId: r.run_id, status: r.status, stopReason: r.stop_reason, startedAt: r.started_at, finishedAt: r.finished_at }] as const));
		const queued = new Map(queueRows.map((r) => [r.instance_id, Number(r.n)] as const));

		return c.json({
			asOf: Date.now(),
			total: page.length,
			truncated,
			instances: page.map((r) => {
				const pin = pins.get(r.id);
				return {
					id: r.id,
					name: instanceListName(r.config, r.name),
					slug: r.slug,
					status: "paused",
					repos: repos.get(r.id) ?? [],
					pinnedMachine: pin?.node ? { node: pin.node, machineId: pin.machineId || null } : null,
					disabled: { at: r.disabled_at, by: r.disabled_by, reason: r.disabled_reason },
					lastActivityAt: r.last_activity_at,
					lastRun: lastRun.get(r.id) ?? null,
					queuedObjectives: queued.get(r.id) ?? 0,
				};
			}),
		});
	});
}
