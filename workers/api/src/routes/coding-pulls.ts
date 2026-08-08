/**
 * The Coder's PULLS surface (#401) — the fourth panel beside Terminal · Issues · Builds.
 *
 * A separate module rather than two more handlers in `coding-repos.ts`, for the reason
 * `coding.contract.test.ts` gives about the #305 split: a module on this surface should be
 * readable as one answerable question. These two routes answer "what pull requests are open on
 * this repo, and did my agent open any of them" — GitHub reads plus the platform's own act trail.
 *
 * Registered from `routes/coding.ts` immediately after `registerRepoRoutes`, because Hono matches
 * in registration ORDER and `coding.contract.test.ts` pins that order. Nothing here shadows a
 * sibling pattern: `/repos/:repoId/pulls` has no earlier GET to hide behind.
 *
 * Both layers of caching are present, and they are different things:
 *   • Layer 1 (console → platform) — the weak ETag + 304 below, copied from `/deployments`. It
 *     saves bytes and a re-render.
 *   • Layer 2 (platform → GitHub) — `lib/github-cache.ts`, which is what actually stops the poll
 *     spending GitHub's rate limit. Neither layer changes the POLL INTERVAL: a 304 is exempt from
 *     the primary limit, not from secondary limits, and it is still a request.
 */
import type { Hono } from "hono";
import { HttpError } from "../lib/auth.js";
import { getRepo } from "../lib/coding-store.js";
import { gitProviderFor, hostedFeatureUnavailable } from "../lib/git-providers.js";
import { listPulls, readPull, type PullSummary } from "../lib/github-prs.js";
import { pullActsFor, type PullAttribution } from "../lib/pull-attribution.js";
import { requireOwned } from "./coding-shared.js";
import type { Env } from "../types.js";

/** A PR row plus what the platform knows that GitHub does not. */
export interface PullRow extends PullSummary {
	/** The agent run that opened or merged it, when we can say so EXACTLY. Else null. */
	agentAct: PullAttribution | null;
}

/**
 * Weak ETag over the serialised body — FNV-1a, 32 bits.
 *
 * `build-history.ts` derives its ETag from the newest run's fields, which works there because one
 * build is the only thing that changes. A PR list changes in a dozen places that are not the
 * newest row: a review lands, checks go green, one gets marked ready. Digesting the whole body is
 * the only version that cannot go stale while claiming freshness. Pure.
 */
export function pullsETag(body: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < body.length; i++) {
		h ^= body.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return `W/"pulls-${body.length}-${h.toString(16)}"`;
}

/** Attach agent attribution to each row. Exported: the "exact or absent" rule is worth pinning. */
export function withAttribution(pulls: PullSummary[], acts: Map<number, PullAttribution>): PullRow[] {
	return pulls.map((p) => ({ ...p, agentAct: acts.get(p.number) ?? null }));
}

export function registerPullRoutes(codingRoutes: Hono<{ Bindings: Env }>) {
	/**
	 * Open pull requests for a repo. `?state=open|closed|all` (default open), `?enrich=0` to skip
	 * the per-PR mergeable/review lookups.
	 *
	 * 400 for a repo with no GitHub coordinate, phrased by provider — the same honest failure the
	 * Issues route gives a GitLab repo rather than "isn't connected to GitHub".
	 */
	codingRoutes.get("/:instanceId/coding/repos/:repoId/pulls", async (c) => {
		const { uid, instanceId } = await requireOwned(c);
		const repo = await getRepo(c.env, instanceId, uid, c.req.param("repoId"));
		if (!repo) throw new HttpError(404, "Repo not found");
		if (!repo.githubRepo?.includes("/")) {
			return c.json({ error: hostedFeatureUnavailable(gitProviderFor(repo.provider), "pull requests") }, 400);
		}
		const state = c.req.query("state");
		const pulls = await listPulls(c.env, uid, repo.githubRepo, {
			state: state === "closed" || state === "all" ? state : "open",
			enrich: c.req.query("enrich") !== "0",
		});
		const rows = withAttribution(pulls, await pullActsFor(c.env, instanceId, uid));
		const payload = { repo: repo.githubRepo, pulls: rows };
		const body = JSON.stringify(payload);
		const etag = pullsETag(body);
		if (c.req.header("If-None-Match") === etag) return c.body(null, 304, { ETag: etag });
		return c.body(body, 200, { "Content-Type": "application/json", ETag: etag });
	});

	/** One pull request in full — body, diff size, mergeability, review state, checks. */
	codingRoutes.get("/:instanceId/coding/repos/:repoId/pulls/:number", async (c) => {
		const { uid, instanceId } = await requireOwned(c);
		const repo = await getRepo(c.env, instanceId, uid, c.req.param("repoId"));
		if (!repo) throw new HttpError(404, "Repo not found");
		if (!repo.githubRepo?.includes("/")) {
			return c.json({ error: hostedFeatureUnavailable(gitProviderFor(repo.provider), "pull requests") }, 400);
		}
		const number = Number.parseInt(c.req.param("number"), 10);
		if (!Number.isFinite(number)) return c.json({ error: "Invalid pull request number" }, 400);
		const pull = await readPull(c.env, uid, repo.githubRepo, number);
		if (!pull) throw new HttpError(404, "Pull request not found");
		const acts = await pullActsFor(c.env, instanceId, uid);
		return c.json({ pull: { ...pull, agentAct: acts.get(pull.number) ?? null } });
	});
}
