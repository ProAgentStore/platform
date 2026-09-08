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

/**
 * Success carries the raw runs; failure carries the HTTP status (or `null` for a network
 * error) so a caller can surface "GitHub returned 404" instead of a generic message.
 *
 * `stale` is set ONLY on the cached path, and only when the stored copy was served because
 * GitHub was unreachable (5xx/429/network) — see `githubConditionalJson`. It is optional and
 * absent on every other path, so the "never throws, `{ status }` on failure" contract the five
 * call sites rely on is unchanged and a caller that ignores it behaves exactly as before.
 *
 * It exists because a payload that is merely OLD is fine for a panel and wrong for a
 * notification: #708's deploy watcher fired "✅ Deployed 4c86d53" nineteen days after that run
 * finished, and a page served from store during a GitHub outage is one of the two ways it can
 * see an old run as the newest one.
 */
export type WorkflowRunsResult = { runs: Array<Record<string, unknown>>; stale?: boolean } | { status: number | null };

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
			// served the stored copy and arrives as a success flagged stale.
			//
			// `stale` used to be dropped here, on the reasoning that no caller had a use for it. The
			// deploy watcher does (#708): it is the one caller that INTERRUPTS someone, and a stored
			// page served during a GitHub outage can name an old run as the newest. `fromCache` is
			// still dropped — a 304 is fromCache and perfectly fresh, so it says nothing a caller
			// can act on.
			const res = await githubConditionalJson<{ workflow_runs?: Array<Record<string, unknown>> }>(cache.env, {
				identity: cache.identity,
				repo,
				resource: "runs",
				variant: qs,
				url,
				headers: actionsHeaders(token),
			});
			if (!res.ok) return { status: res.status };
			return { runs: res.data?.workflow_runs ?? [], stale: res.stale };
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

/**
 * One job of a run, with its steps (#781). The shape the log tool lists in its header so a
 * reader can name a different job on the next call.
 */
export interface WorkflowJob {
	id: number;
	name: string;
	/** queued | in_progress | completed */
	status: string;
	/** success | failure | cancelled | skipped | timed_out | action_required | null while running */
	conclusion: string | null;
	url: string;
	steps: Array<{ number: number; name: string; status: string; conclusion: string | null }>;
}

export type WorkflowJobsResult = { jobs: WorkflowJob[] } | { status: number | null };

export function mapWorkflowJob(raw: Record<string, unknown>): WorkflowJob {
	const steps = Array.isArray(raw.steps) ? (raw.steps as Array<Record<string, unknown>>) : [];
	return {
		id: typeof raw.id === "number" ? raw.id : Number(raw.id) || 0,
		name: typeof raw.name === "string" ? raw.name : "",
		status: typeof raw.status === "string" ? raw.status : "",
		conclusion: typeof raw.conclusion === "string" ? raw.conclusion : null,
		url: typeof raw.html_url === "string" ? raw.html_url : "",
		steps: steps.map((s) => ({
			number: typeof s.number === "number" ? s.number : Number(s.number) || 0,
			name: typeof s.name === "string" ? s.name : "",
			status: typeof s.status === "string" ? s.status : "",
			conclusion: typeof s.conclusion === "string" ? s.conclusion : null,
		})),
	};
}

/**
 * The jobs of one run. Never throws — same `{ status }` degradation as `fetchWorkflowRuns`, so
 * the connector can say "GitHub returned 404" rather than a generic failure. Not cached: a job
 * list is read once per log read, not polled.
 */
export async function fetchWorkflowJobs(repo: string, token: string | undefined, runId: number): Promise<WorkflowJobsResult> {
	try {
		const res = await fetch(`https://api.github.com/repos/${repo}/actions/runs/${runId}/jobs?per_page=100`, { headers: actionsHeaders(token), signal: AbortSignal.timeout(15_000) });
		if (!res.ok) return { status: res.status };
		const data = (await res.json()) as { jobs?: Array<Record<string, unknown>> };
		return { jobs: (data.jobs ?? []).map(mapWorkflowJob) };
	} catch {
		return { status: null };
	}
}

/**
 * How much of a job log is kept (#781). Logs are unbounded — a verbose install step alone can be
 * megabytes — and the failure is at the END, so when the cap binds the HEAD is dropped, never the
 * tail. Two megabytes is far past any window the tool will render and small enough to hold in a
 * Worker without thought; the number is stated in the tool's own header when it bites.
 */
export const JOB_LOG_FETCH_BYTES = 2 * 1024 * 1024;

export type JobLogResult = { text: string; size: number; headTruncated: boolean } | { status: number | null };

/**
 * The plain-text log of ONE job (#781).
 *
 * The per-JOB endpoint, deliberately: `…/runs/{id}/logs` answers with a ZIP of every job's
 * files, which a Worker would have to parse; `…/jobs/{id}/logs` answers with a redirect to a
 * single text file, and a job is the unit a failure lives in anyway.
 *
 * `redirect: "manual"`, then a second fetch with NO headers. The redirect target is a pre-signed
 * blob URL on another host; following it automatically would forward the installation token to
 * that host, and whether a runtime strips `Authorization` on a cross-origin redirect is exactly
 * the kind of thing not to depend on. Never throws.
 */
export async function fetchJobLog(repo: string, token: string | undefined, jobId: number, maxBytes = JOB_LOG_FETCH_BYTES): Promise<JobLogResult> {
	try {
		const first = await fetch(`https://api.github.com/repos/${repo}/actions/jobs/${jobId}/logs`, { headers: actionsHeaders(token), redirect: "manual", signal: AbortSignal.timeout(15_000) });
		let body: Response = first;
		if (first.status >= 300 && first.status < 400) {
			const location = first.headers.get("location");
			if (!location) return { status: first.status };
			// A deadline and nothing else: no headers, so the token never reaches the blob host.
			// Thirty seconds because this is the one download here that can be megabytes (#438).
			body = await fetch(location, { signal: AbortSignal.timeout(30_000) });
		}
		if (!body.ok) return { status: body.status };
		const full = await body.text();
		const headTruncated = full.length > maxBytes;
		return { text: headTruncated ? full.slice(full.length - maxBytes) : full, size: full.length, headTruncated };
	} catch {
		return { status: null };
	}
}

/**
 * Drop the `2026-09-08T09:10:09.1234567Z ` GitHub prefixes every log line with. Twenty-nine
 * characters a line, on lines whose useful part is often shorter than that: with the prefixes a
 * 20,000-character window holds roughly half the log lines it holds without them, and the
 * timestamps answer no question a failing step's text does. Stated in the tool's header.
 */
export function stripLogTimestamps(text: string): string {
	return text.replace(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z ?/gm, "");
}

/** Conclusions that mean "this is the job to read". `cancelled` is not one: it prints nothing diagnostic. */
const FAILED = new Set(["failure", "timed_out", "action_required"]);

/**
 * Which job to read when the caller named none (#781): the first that failed, else the one still
 * running, else the last — a green run's last job is the closest thing to "what happened". Null
 * only for an empty list.
 */
export function pickJob(jobs: readonly WorkflowJob[]): WorkflowJob | null {
	if (!jobs.length) return null;
	return jobs.find((j) => j.conclusion !== null && FAILED.has(j.conclusion)) ?? jobs.find((j) => j.status !== "completed") ?? jobs[jobs.length - 1];
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
