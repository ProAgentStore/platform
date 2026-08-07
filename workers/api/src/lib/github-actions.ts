// The ONE place that talks to the GitHub Actions "runs" API + the ONE run→BuildRun mapper.
// Before this, the same `fetch(.../actions/runs)` + headers + run-mapping were copy-pasted in
// four spots (coding.ts's latestRunFor, /deployment, /deployments, and the github connector's
// github_workflow_runs handler). #88: de-hardwire Coder's build-status fetch onto a shared client
// so the github connector and the console routes read builds through the same code path.
import type { BuildRun } from "./build-history.js";

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
 * Fetch a page of GitHub Actions runs for `owner/repo`. Never throws — a non-OK response or
 * network error resolves to `{ status }` so every caller can degrade gracefully. `perPage`
 * defaults to 1 (the latest run).
 */
export async function fetchWorkflowRuns(
	repo: string,
	token: string | undefined,
	opts: { perPage?: number; page?: number; branch?: string; event?: string; status?: string } = {},
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
	try {
		const res = await fetch(`https://api.github.com/repos/${repo}/actions/runs?${qs}`, { headers: actionsHeaders(token) });
		if (!res.ok) return { status: res.status };
		const data = (await res.json()) as { workflow_runs?: Array<Record<string, unknown>> };
		return { runs: data.workflow_runs ?? [] };
	} catch {
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
