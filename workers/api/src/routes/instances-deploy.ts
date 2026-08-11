/**
 * Deployment status for ANY instance — the Operator's counterpart to the Coder's
 * `/coding/builds` surface (#488).
 *
 * The Coder's three `/coding/repos/:id/deployment(s)` and `/coding/builds` routes require a
 * `coding_repos` row: they are keyed by a persisted repo with its own session model. The
 * Operator (surfaces:['tmux']) has no such table — its only knowledge of a GitHub repo is a
 * `config.githubRepo` field the subscriber sets once.
 *
 * Rather than mixing Operator instances into `coding_repos`, these routes accept a TRANSIENT
 * `HostedRepoRef` built from that config field (or, for history, from the request query) and
 * pass it straight to the shared `latestHostedBuild` / `listHostedBuilds` dispatch in
 * `lib/hosted-repo.ts`. The Coder's KV build-history log and ETag are not used here: the log
 * is keyed by coding-repo id, and a lightweight route that never writes to D1 is the whole
 * point of the sub-option-A approach described in the issue.
 *
 * Route surface:
 *   GET  /:instanceId/deploy-status                  latest build for config.githubRepo
 *   GET  /:instanceId/deploy-history?repo=&perPage=  paginated run history (explicit repo)
 *   PUT  /:instanceId/deploy-status { repo }         save config.githubRepo
 */
import type { Hono } from "hono";
import { HttpError, requireUser } from "../lib/auth.js";
// The `owner/repo` test lives with the prompt that STATES the repo (#494), not here, so the route
// that stores the value and the agent that announces it cannot disagree about what counts as
// configured — an agent naming a repo this route refuses to poll is the same defect inverted.
import { isValidGithubRepo } from "../lib/deployment-prompt.js";
import { latestHostedBuild, listHostedBuilds } from "../lib/hosted-repo.js";
import { patchInstanceConfig } from "../lib/instance-config.js";
import type { Env } from "../types.js";

/** Minimal instance row needed to read the owner and config. */
interface InstanceRow {
	id: string;
	user_id: string;
	config: string | null;
}

/**
 * Read the instance row, verify ownership, and return the raw config blob.
 *
 * Returns null when the instance does not exist or is owned by a different user — the callers
 * surface a 404, which is the same response they'd get for any other missing resource.
 */
async function readOwnedInstanceConfig(
	env: Env,
	instanceId: string,
	userId: string,
): Promise<{ config: Record<string, unknown> } | null> {
	const row = await env.DB.prepare(
		"SELECT id, user_id, config FROM agent_instances WHERE id = ?1 AND user_id = ?2",
	)
		.bind(instanceId, userId)
		.first<InstanceRow>();
	if (!row) return null;
	let config: Record<string, unknown> = {};
	try {
		const parsed = row.config ? (JSON.parse(row.config) as unknown) : {};
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			config = parsed as Record<string, unknown>;
		}
	} catch {
		// malformed config → treat as empty
	}
	return { config };
}

export function registerDeployStatusRoutes(router: Hono<{ Bindings: Env }>): void {
	/**
	 * Latest GitHub Actions run for this instance's configured `config.githubRepo`.
	 *
	 * Response:
	 *   { repo: string|null, available: boolean, run: BuildRun|null }
	 *
	 * `repo` echoes back the stored value so the console can render the configure-prompt
	 * vs. the status card without a separate config fetch.
	 * `available:false` covers: no repo configured, GitHub App not installed, private repo
	 * with no installation token, or any transient error — never a 500.
	 */
	router.get("/:instanceId/deploy-status", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		const row = await readOwnedInstanceConfig(c.env, instanceId, session.uid);
		if (!row) throw new HttpError(404, "Instance not found");

		const repo = typeof row.config.githubRepo === "string" ? row.config.githubRepo : null;
		if (!repo || !isValidGithubRepo(repo)) {
			return c.json({ repo: repo ?? null, available: false, run: null });
		}

		const ref = { provider: "github" as const, githubRepo: repo, repoSlug: repo };
		const latest = await latestHostedBuild(c.env, session.uid, ref);
		return c.json({ repo, ...latest });
	});

	/**
	 * Paginated GitHub Actions run history for an explicit `?repo=owner/repo`.
	 *
	 * A separate route from the latest-build GET so the history poll does not need to re-save
	 * config: the console passes `repo` in the query string and the route resolves auth from
	 * the user's GitHub installation, same as the Coder's `/deployments` route.
	 *
	 * Response: { available: boolean, runs?: BuildRun[], nextPage?: number }
	 * `?perPage` 1..50, default 15.
	 */
	router.get("/:instanceId/deploy-history", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		// Ownership gate — the row contents are not needed, only that it exists and belongs to this user.
		const row = await readOwnedInstanceConfig(c.env, instanceId, session.uid);
		if (!row) throw new HttpError(404, "Instance not found");

		const repo = c.req.query("repo") ?? "";
		if (!isValidGithubRepo(repo)) return c.json({ available: false });

		const page = Math.max(1, Number.parseInt(c.req.query("page") ?? "1", 10) || 1);
		const perPage = Math.min(50, Math.max(1, Number.parseInt(c.req.query("perPage") ?? "15", 10) || 15));

		const ref = { provider: "github" as const, githubRepo: repo, repoSlug: repo };
		const runs = await listHostedBuilds(c.env, session.uid, ref, { page, perPage });
		if (!runs) return c.json({ available: false });

		const nextPage = runs.length === perPage ? page + 1 : undefined;
		return c.json(nextPage ? { available: true, runs, nextPage } : { available: true, runs });
	});

	/**
	 * Save the GitHub repo coordinate for this instance (stores in `config.githubRepo`).
	 *
	 * Body: { repo: string }  — "owner/repo" format; empty string or null clears it.
	 * Response: { repo: string|null }
	 */
	router.put("/:instanceId/deploy-status", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		const row = await readOwnedInstanceConfig(c.env, instanceId, session.uid);
		if (!row) throw new HttpError(404, "Instance not found");

		const body = (await c.req.json().catch(() => ({}))) as { repo?: unknown };
		const rawRepo = typeof body.repo === "string" ? body.repo.trim() : "";
		const repo = rawRepo && isValidGithubRepo(rawRepo) ? rawRepo : null;

		// Validate if non-empty — a bare word that isn't a coordinate is rejected rather than
		// silently stored (it would poll forever and return `available:false` with no indication why).
		if (rawRepo && !repo) {
			return c.json({ error: 'repo must be in "owner/repo" format' }, 400);
		}

		await patchInstanceConfig(c.env, instanceId, session.uid, "githubRepo", repo);
		return c.json({ repo });
	});
}
