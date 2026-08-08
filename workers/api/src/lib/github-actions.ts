// The ONE place that talks to the GitHub Actions "runs" API + the ONE run→BuildRun mapper.
// Before this, the same `fetch(.../actions/runs)` + headers + run-mapping were copy-pasted in
// four spots (coding.ts's latestRunFor, /deployment, /deployments, and the github connector's
// github_workflow_runs handler). #88: de-hardwire Coder's build-status fetch onto a shared client
// so the github connector and the console routes read builds through the same code path.
import type { BuildRun } from "./build-history.js";
import { githubConditionalJson, type GithubCacheIdentity } from "./github-cache.js";
import type { Env } from "../types.js";

/** GitHub REST headers for the Actions API. `token` optional — a public repo's runs are
 *  readable unauthenticated (used by the /deployments public-repo fallback). */
function actionsHeaders(token?: string): Record<string, string> {
	return {
		...(token ? { Authorization: `token ${token}` } : {}),
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
		"User-Agent": "proagentstore-coding/1.0",
	};
}

/** Success carries the raw runs; failure carries the HTTP status (or `null` for a network
 *  error) so a caller can surface "GitHub returned 404" instead of a generic message. */
export type WorkflowRunsResult = { runs: Array<Record<string, unknown>> } | { status: number | null };

/**
 * Who is asking, and under what authority — the argument that turns a read into a CONDITIONAL
 * read (#418). Optional: a caller with no identity to hand keeps the plain fetch it always had.
 *
 * Both halves are required together because the cache key is a tenancy boundary. `env` alone
 * cannot say whose entry this is, and an identity must come from the SAME resolution that
 * produced `token` — a `userId` picked up from elsewhere in the request is exactly the
 * cross-tenant read `lib/github-cache.ts` is written to prevent.
 */
export interface WorkflowRunsCache {
	env: Env;
	identity: GithubCacheIdentity;
}

/**
 * Fetch a page of GitHub Actions runs for `owner/repo`. Never throws — a non-OK response or
 * network error resolves to `{ status }` so every caller can degrade gracefully. `perPage`
 * defaults to 1 (the latest run).
 *
 * Runs are the highest-frequency GitHub read the platform makes: the repos page polls deploy
 * status every ~25s and `/builds` fans out one Actions request PER REPO per poll. With `cache`
 * supplied each of those spends nothing when nothing changed — a 304 is exempt from the REST
 * primary rate limit — and stays exactly as fresh, which is why this is a conditional request and
 * not a TTL. The Builds panel's whole job is being current; a stale "✓ ready" over a failed build
 * is the defect, not the cost.
 */
export async function fetchWorkflowRuns(
	repo: string,
	token: string | undefined,
	opts: { perPage?: number; page?: number; branch?: string; event?: string; status?: string } = {},
	cache?: WorkflowRunsCache,
): Promise<WorkflowRunsResult> {
	const perPage = opts.perPage ?? 1;
	const page = opts.page ?? 1;
	// The query used to be per_page + page ONLY, so `runs[0]` meant "the newest run across every
	// workflow in the repo, on any branch, from any trigger" — which is how the deploy watcher
	// ended up calling a green `ci.yml` a deploy and re-firing as each of seven workflows landed
	// (#359). Filters are opt-in so the existing console/connector callers are unchanged.
	const qs = [
		`per_page=${perPage}`,
		page > 1 ? `page=${page}` : "",
		opts.branch ? `branch=${encodeURIComponent(opts.branch)}` : "",
		opts.event ? `event=${encodeURIComponent(opts.event)}` : "",
		opts.status ? `status=${encodeURIComponent(opts.status)}` : "",
	]
		.filter(Boolean)
		.join("&");
	const url = `https://api.github.com/repos/${repo}/actions/runs?${qs}`;
	try {
		if (cache) {
			// `qs` IS the variant: two reads of this resource differ only by their query, and the
			// answer to one is not the answer to the other (a `event=pull_request` page is not the
			// Builds panel's page). The cache's own failure asymmetry is passed through unchanged —
			// a 403/404 invalidated the entry and arrives here as a failure; a 5xx/network error
			// served the stored copy and arrives as a success flagged stale. `fromCache`/`stale` are
			// deliberately NOT surfaced on WorkflowRunsResult: no caller has a use for them today,
			// and widening this union is how the "never throws, always `{ status }` on failure"
			// contract every caller relies on starts to drift.
			const res = await githubConditionalJson<{ workflow_runs?: Array<Record<string, unknown>> }>(cache.env, {
				identity: cache.identity,
				repo,
				resource: "runs",
				variant: qs,
				url,
				headers: actionsHeaders(token),
			});
			if (!res.ok) return { status: res.status };
			return { runs: res.data?.workflow_runs ?? [] };
		}
		const res = await fetch(url, { headers: actionsHeaders(token) });
		if (!res.ok) return { status: res.status };
		const data = (await res.json()) as { workflow_runs?: Array<Record<string, unknown>> };
		return { runs: data.workflow_runs ?? [] };
	} catch {
		// The try/catch spans the cached branch too. `githubConditionalJson` is written not to
		// throw, but "never throws" here is a contract five call sites depend on for their
		// degradation, and it must not become conditional on another module keeping a promise.
		return { status: null };
	}
}

/** Map one raw GitHub Actions run into the compact BuildRun the console + connector consume. */
export function mapWorkflowRun(run: Record<string, unknown>): BuildRun {
	return {
		status: run.status, // queued | in_progress | completed
		conclusion: run.conclusion ?? null, // success | failure | cancelled | null
		name: run.name ?? "",
		runNumber: typeof run.run_number === "number" ? run.run_number : null,
		url: typeof run.html_url === "string" ? run.html_url : "",
		branch: typeof run.head_branch === "string" ? run.head_branch : "",
		sha: typeof run.head_sha === "string" ? run.head_sha.slice(0, 7) : "",
		updatedAt: typeof run.updated_at === "string" ? run.updated_at : "",
	};
}
