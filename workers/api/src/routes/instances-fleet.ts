/**
 * Instance tags and the fleet snapshot (#961).
 *
 * Getting a status picture across a group of coding instances took a `get_instance_state` and a
 * GitHub issue list PER instance, mostly to learn that an agent was idle with nothing to do. This
 * is one call: every instance carrying a tag, each with its live run, its open-issue backlog and a
 * single derived status (`lib/fleet-snapshot.ts`) — ordered most-needs-attention first.
 *
 * Every read is a flat query over the caller's account, whatever the instance count. The only
 * per-item work is GitHub, and it is per REPO (two instances on one repo read it once), capped, and
 * reported as unreadable rather than as "no issues" when it fails.
 */
import type { Hono } from "hono";
import { HttpError, requireUser } from "../lib/auth.js";
import { deriveFleetStatus, FLEET_STATUSES, type FleetStatus, fleetOrder, type RepoIssues, tallyIssues } from "../lib/fleet-snapshot.js";
import { listIssuesPage } from "../lib/github-issues.js";
import { instanceHealthFor } from "../lib/instance-activity.js";
import { readLatestRuns, readQueueDepths } from "../lib/instance-activity-read.js";
import { instanceListName, parseConfigBlob, patchInstanceConfig, readInstanceConfigPair } from "../lib/instance-config.js";
import { matchesTags, normalizeTags, tagsOf, wantedTags } from "../lib/instance-tags.js";
import { mapWithConcurrency } from "../lib/map-concurrency.js";
import { pendingOwnerInputs } from "../lib/secure-input.js";
import { sqlTime } from "../lib/sql-time.js";
import { waitClause } from "../lib/work-report.js";
import type { Env } from "../types.js";
import { requireOwnedInstance } from "./instances-runtime.js";

/** How far back a closed run still counts as an instance's latest — the dashboard's window. */
const LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
/** Repos read from GitHub in one snapshot. Past it, a repo is reported unread, never guessed empty. */
export const SNAPSHOT_MAX_REPOS = 30;
const GITHUB_CONCURRENCY = 6;

export function registerFleetRoutes(router: Hono<{ Bindings: Env }>): void {
	router.get("/:instanceId/tags", async (c) => {
		const session = await requireUser(c);
		const pair = await readInstanceConfigPair(c.env, c.req.param("instanceId"), session.uid);
		if (!pair) throw new HttpError(404, "Instance not found");
		return c.json({ tags: tagsOf(pair.config) });
	});

	/** Replace the instance's tags (`[]` clears them). Whole-list replace, like every list setting. */
	router.put("/:instanceId/tags", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		const body = (await c.req.json().catch(() => ({}))) as { tags?: unknown };
		const parsed = normalizeTags(body.tags);
		if ("error" in parsed) return c.json({ error: parsed.error }, 400);
		await patchInstanceConfig(c.env, instanceId, session.uid, "tags", parsed.tags);
		return c.json({ tags: parsed.tags });
	});

	/**
	 * `GET /my/snapshot?tag=store-coders&tag=pas-apps` (or `?tags=a,b`; none = every instance),
	 * optionally `&status=idle_needs_work,decision_blocked`.
	 */
	router.get("/my/snapshot", async (c) => {
		const session = await requireUser(c);
		const uid = session.uid;
		const now = Date.now();
		const wanted = wantedTags({ tag: c.req.queries("tag"), tags: c.req.query("tags") });
		const statusFilter = (c.req.query("status") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
		const badStatus = statusFilter.find((s) => !(FLEET_STATUSES as readonly string[]).includes(s));
		if (badStatus) return c.json({ error: `Unknown status "${badStatus}". One of: ${FLEET_STATUSES.join(", ")}.` }, 400);

		const roster = (
			await c.env.DB.prepare(
				`SELECT i.id, i.config, a.name, a.slug FROM agent_instances i JOIN agents a ON a.id = i.agent_id
				  WHERE i.user_id = ?1 AND i.status != 'canceled'`,
			)
				.bind(uid)
				.all<{ id: string; config: string | null; name: string | null; slug: string | null }>()
		).results ?? [];
		const members = roster
			.map((r) => ({ id: r.id, name: instanceListName(r.config, r.name), slug: r.slug, tags: tagsOf(parseConfigBlob(r.config)) }))
			.filter((m) => matchesTags(m.tags, wanted));
		const ids = new Set(members.map((m) => m.id));

		const [runs, queueDepths, decisionRows, owner, repoRows] = await Promise.all([
			readLatestRuns(c.env, uid, now - LOOKBACK_MS),
			readQueueDepths(c.env, uid),
			c.env.DB.prepare(
				`SELECT instance_id, COUNT(*) AS n, MIN(message) AS message FROM mcp_input_requests
				  WHERE user_id = ?1 AND status = 'pending' AND expires_at > ?2 GROUP BY instance_id`,
			)
				.bind(uid, sqlTime(now))
				.all<{ instance_id: string; n: number; message: string | null }>(),
			pendingOwnerInputs(c.env, uid, now),
			c.env.DB.prepare("SELECT instance_id, github_repo FROM coding_repos WHERE user_id = ?1 AND github_repo IS NOT NULL AND github_repo != ''")
				.bind(uid)
				.all<{ instance_id: string; github_repo: string }>(),
		]);
		const runOf = new Map(runs.map((r) => [r.instanceId, r] as const));
		const decisions = new Map((decisionRows.results ?? []).map((r) => [r.instance_id, { pending: Number(r.n) || 0, first: r.message ?? "" }] as const));
		const secrets = new Map(owner.map((o) => [o.instanceId, o.pending] as const));
		const reposOf = new Map<string, string[]>();
		for (const r of repoRows.results ?? []) {
			if (!ids.has(r.instance_id)) continue;
			const list = reposOf.get(r.instance_id) ?? [];
			if (!list.some((x) => x.toLowerCase() === r.github_repo.toLowerCase())) list.push(r.github_repo);
			reposOf.set(r.instance_id, list);
		}

		// Each repo once, however many instances share it; past the cap, unread and said so.
		const allRepos = [...new Set([...reposOf.values()].flat())];
		const toRead = allRepos.slice(0, SNAPSHOT_MAX_REPOS);
		const read = await mapWithConcurrency(toRead, GITHUB_CONCURRENCY, (repo) =>
			listIssuesPage(c.env, uid, repo, { limit: 100 }).then((p) => ({ repo, issues: p.issues, hasMore: p.hasMore, unreadable: !!p.unreadable })),
		);
		const byRepo = new Map<string, RepoIssues>(read.map((r) => [r.repo, r] as const));
		const repoIssues = (repo: string): RepoIssues => byRepo.get(repo) ?? { repo, issues: [], hasMore: false, unreadable: true };

		const instances = members.map((m) => {
			const run = runOf.get(m.id) ?? null;
			const health = instanceHealthFor(run, now);
			const open = run?.status === "running" ? run : null;
			const repos = reposOf.get(m.id);
			const issues = repos?.length ? tallyIssues(repos.map(repoIssues)) : null;
			const decision = decisions.get(m.id) ?? null;
			const verdict = deriveFleetStatus({
				health,
				waitingReason: open?.waitingReason ?? null,
				queueDepth: queueDepths.get(m.id) ?? 0,
				decisions: decision?.pending ?? 0,
				ownerSecrets: secrets.get(m.id) ?? 0,
				issues,
			});
			return {
				instanceId: m.id,
				name: m.name,
				slug: m.slug,
				tags: m.tags,
				status: verdict.status,
				reason: verdict.reason,
				health,
				// What it is working on now — the open run only; a finished one is history, not work.
				work: open ? { runId: open.runId, objective: open.objective, startedAt: open.startedAt, waitingReason: open.waitingReason, waitNote: waitClause(open, now) } : null,
				queueDepth: queueDepths.get(m.id) ?? 0,
				decision,
				ownerSecrets: secrets.get(m.id) ?? 0,
				issues,
			};
		});
		const shown = instances.filter((i) => !statusFilter.length || statusFilter.includes(i.status)).sort((a, b) => fleetOrder(a.status, b.status));
		const counts = Object.fromEntries(FLEET_STATUSES.map((s) => [s, instances.filter((i) => i.status === s).length])) as Record<FleetStatus, number>;
		return c.json({
			asOf: now,
			tags: wanted,
			total: instances.length,
			counts,
			...(allRepos.length > toRead.length ? { note: `${allRepos.length - toRead.length} of ${allRepos.length} repositories were not read (limit ${SNAPSHOT_MAX_REPOS} per snapshot) — narrow by tag.` } : {}),
			instances: shown,
		});
	});
}
