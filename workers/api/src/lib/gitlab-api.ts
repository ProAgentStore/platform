/**
 * Read-only GitLab access — issues and pipelines — for the Coder's Issues and Builds surfaces
 * (#221, phase 3).
 *
 * ── What this is NOT
 *
 * It is not a generalisation of `github-issues.ts` / `github-actions.ts`. Those two keep their
 * shapes byte-for-byte; this module answers the same QUESTIONS against a different API, and
 * `hosted-repo.ts` is the one place that decides which of them a repo gets. The seam is the
 * output type (`IssueSummary` / `IssueDetail` / `BuildRun`), exactly as `git-providers.ts`
 * argues for the clone credential: GitHub's grant model does not survive being made the
 * interface, but its RESULT does.
 *
 * ── Auth: a user-scoped PAT from the vault, and why there is no installation to bind to
 *
 * GitLab has no equivalent of a GitHub App installation, so there is nothing to verify a
 * binding against — a personal access token belongs to a USER and carries whatever that user
 * can see. The token is the one already stored for cloning (`user_api_keys` provider `gitlab`,
 * registered in `routes/keys.ts` with the `glpat-` prefix), read through the same encrypted
 * path, and it is sent as `PRIVATE-TOKEN`, which is what a PAT authenticates with. It is only
 * ever read here on behalf of the user it belongs to — `userId` comes from the route's owner
 * check, never from a request field.
 *
 * With no token we still ask, UNauthenticated: a public GitLab project's issues and pipelines
 * are readable without credentials, which is the same "public repos just work" behaviour the
 * GitHub path has. A private project answers 404 (GitLab hides existence rather than 403ing)
 * and every function here degrades to []/null.
 *
 * ── Two mappings that are decisions, not transcription
 *
 * ISSUE NUMBER is `iid`, never `id`. GitLab has both: `id` is globally unique across the whole
 * instance and appears nowhere a human looks; `iid` is the per-project number in `#42` and in
 * the web URL. Storing `id` would produce issue links and "work on #7" objectives that point at
 * a different project's issue, which is worse than not supporting GitLab at all.
 *
 * PIPELINE STATUS is widened into GitHub's two-field shape (`status` + `conclusion`) rather
 * than the reverse. The console and `build-history.ts` already read that pair, so collapsing it
 * would mean changing every consumer to serve the provider that has fewer users. GitLab's ten
 * statuses fold cleanly: five are terminal (they carry the conclusion), the rest are not.
 */
import { readConnectorRefreshToken } from "./connector-oauth.js";
import type { BuildRun } from "./build-history.js";
import type { IssueDetail, IssueSummary, ListIssuesOpts } from "./github-issues.js";
import type { Env } from "../types.js";

/**
 * Fixed. `git-providers.ts` resolves any OTHER host — self-managed GitLab included — to provider
 * `other`, which declares no hosted support and therefore never reaches this module. That is
 * what keeps the URL below a constant: there is no request field anywhere on this path that can
 * move where an authenticated read is sent.
 */
const API_BASE = "https://gitlab.com/api/v4";

/** Same cap the GitHub reader applies, for the same reason: a body goes into a model prompt. */
const BODY_CAP = 8 * 1024;

/**
 * A GitLab namespace segment. GitLab permits letters, digits, `_`, `-`, `.` and requires the
 * path to start alphanumeric. Validating here is defence in depth, matching `github-issues.ts`:
 * the slug is `encodeURIComponent`-ed into the path below, and a charset check means no crafted
 * value can smuggle a query or a path segment into an authenticated request whatever the caller
 * did upstream.
 */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * `group/project` or `group/subgroup/project` → the URL-encoded project id GitLab's API takes.
 *
 * Nesting is the whole reason `coding_repos.repo_slug` exists beside `github_repo` (migration
 * 0097): GitHub's column is `owner/name` and cannot hold `group/subgroup/project` without
 * lying about which part is the owner. Depth is capped because GitLab's own limit is 20 and an
 * unbounded loop over caller data has no business being here.
 */
export function gitlabProjectId(slug: string): string | null {
	const segments = String(slug || "")
		.split("/")
		.filter(Boolean);
	if (segments.length < 2 || segments.length > 20) return null;
	if (!segments.every((s) => SEGMENT.test(s))) return null;
	return encodeURIComponent(segments.join("/"));
}

/**
 * The stored PAT, or null. Never throws: an absent key is the ORDINARY state (a public project
 * needs none), and `readConnectorRefreshToken` raises for both "no row" and "no KEK", which
 * mean the same thing to every caller here.
 */
async function gitlabToken(env: Env, userId: string): Promise<string | null> {
	if (!userId) return null;
	return readConnectorRefreshToken(env, userId, "gitlab", "GitLab").catch(() => null);
}

function headers(token: string | null): Record<string, string> {
	return {
		...(token ? { "PRIVATE-TOKEN": token } : {}),
		Accept: "application/json",
		"User-Agent": "proagentstore-coding/1.0",
	};
}

/** One GET. Never throws; a non-OK response and a network error are both `null`. */
async function getJson<T>(url: string, token: string | null): Promise<T | null> {
	try {
		const res = await fetch(url, { headers: headers(token) });
		if (!res.ok) return null;
		return (await res.json()) as T;
	} catch {
		return null;
	}
}

interface RawIssue {
	iid?: number;
	title?: string;
	state?: string;
	labels?: unknown;
	user_notes_count?: number;
	updated_at?: string;
	web_url?: string;
	description?: string | null;
}

/**
 * GitLab says `opened`; GitHub says `open`; the console filters on GitHub's word and so does
 * every caller. Normalising here — rather than teaching the readers a second vocabulary — is
 * what lets the Issues panel render a GitLab repo with no console change at all.
 */
function normalizeState(state: string | undefined): string {
	return state === "opened" ? "open" : (state ?? "open");
}

function toSummary(raw: RawIssue): IssueSummary {
	return {
		number: typeof raw.iid === "number" ? raw.iid : 0,
		title: raw.title ?? "",
		state: normalizeState(raw.state),
		labels: Array.isArray(raw.labels) ? raw.labels.filter((l): l is string => typeof l === "string" && l.length > 0) : [],
		comments: typeof raw.user_notes_count === "number" ? raw.user_notes_count : 0,
		updatedAt: raw.updated_at ?? "",
		url: raw.web_url ?? "",
	};
}

/** List a project's issues. `[]` on any failure — no token, private project, GitLab error. */
export async function listGitlabIssues(env: Env, userId: string, slug: string, opts: ListIssuesOpts = {}): Promise<IssueSummary[]> {
	const project = gitlabProjectId(slug);
	if (!project) return [];
	const perPage = Math.min(Math.max(opts.limit ?? 30, 1), 100);
	const params = new URLSearchParams({ per_page: String(perPage), order_by: "updated_at", sort: "desc" });
	// `all` is expressed by OMITTING the filter, not by a value — GitLab rejects `state=all`
	// with a 400, which would arrive here as a silent empty list.
	const state = opts.state ?? "open";
	if (state === "open") params.set("state", "opened");
	else if (state === "closed") params.set("state", "closed");
	if (opts.labels) params.set("labels", opts.labels);
	const data = await getJson<RawIssue[]>(`${API_BASE}/projects/${project}/issues?${params}`, await gitlabToken(env, userId));
	if (!Array.isArray(data)) return [];
	// GitLab keeps merge requests on their own endpoint, so unlike GitHub there is nothing to
	// filter out here — an issue list is only ever issues.
	return data.map(toSummary).filter((i) => i.number > 0);
}

/** Read one issue by its per-project `iid`. `null` when absent or unreadable. */
export async function readGitlabIssue(env: Env, userId: string, slug: string, number: number): Promise<IssueDetail | null> {
	const project = gitlabProjectId(slug);
	if (!project || !Number.isFinite(number) || number <= 0) return null;
	const raw = await getJson<RawIssue>(`${API_BASE}/projects/${project}/issues/${Math.floor(number)}`, await gitlabToken(env, userId));
	if (!raw || typeof raw !== "object" || typeof raw.iid !== "number") return null;
	return { ...toSummary(raw), body: (raw.description ?? "").slice(0, BODY_CAP) };
}

interface RawPipeline {
	iid?: number;
	status?: string;
	name?: string;
	source?: string;
	ref?: string;
	sha?: string;
	web_url?: string;
	updated_at?: string;
}

/**
 * GitLab's single `status` → GitHub's `(status, conclusion)` pair.
 *
 * The five terminal states are the ones that carry a verdict; everything else is work that has
 * not finished, and saying so with a null conclusion is what stops the console painting a
 * queued pipeline as a failure. An unrecognised status (GitLab adds them) degrades to
 * "in_progress, no verdict" rather than being asserted as a result.
 */
export function mapPipelineStatus(status: string | undefined): { status: string; conclusion: string | null } {
	switch (status) {
		case "success":
			return { status: "completed", conclusion: "success" };
		case "failed":
			return { status: "completed", conclusion: "failure" };
		case "canceled":
		case "cancelled":
			return { status: "completed", conclusion: "cancelled" };
		case "skipped":
			return { status: "completed", conclusion: "skipped" };
		case "manual":
			return { status: "completed", conclusion: "action_required" };
		case "created":
		case "pending":
		case "waiting_for_resource":
		case "preparing":
		case "scheduled":
			return { status: "queued", conclusion: null };
		default:
			return { status: "in_progress", conclusion: null };
	}
}

function toBuildRun(raw: RawPipeline): BuildRun {
	const mapped = mapPipelineStatus(raw.status);
	return {
		status: mapped.status,
		conclusion: mapped.conclusion,
		// GitLab pipelines are unnamed unless the project sets `workflow:name`. `source` (`push`,
		// `merge_request_event`, `schedule`) is the nearest true answer to "what ran this", and an
		// empty label in the Builds panel reads as a bug.
		name: raw.name || raw.source || "Pipeline",
		// `iid` again, not `id`: the per-project counter is the analogue of GitHub's run_number,
		// and it is the number shown in GitLab's own UI.
		runNumber: typeof raw.iid === "number" ? raw.iid : null,
		url: typeof raw.web_url === "string" ? raw.web_url : "",
		branch: typeof raw.ref === "string" ? raw.ref : "",
		sha: typeof raw.sha === "string" ? raw.sha.slice(0, 7) : "",
		updatedAt: typeof raw.updated_at === "string" ? raw.updated_at : "",
	};
}

/**
 * A page of a project's pipelines, newest first. `null` — not `[]` — when the project cannot be
 * read at all, because the Builds surface distinguishes "no pipelines yet" (an empty array, a
 * true and useful answer) from "we could not ask" (`available:false`).
 */
export async function listGitlabPipelines(env: Env, userId: string, slug: string, opts: { perPage?: number; page?: number } = {}): Promise<BuildRun[] | null> {
	const project = gitlabProjectId(slug);
	if (!project) return null;
	const perPage = Math.min(Math.max(opts.perPage ?? 1, 1), 100);
	const page = Math.max(opts.page ?? 1, 1);
	const params = new URLSearchParams({ per_page: String(perPage), page: String(page) });
	const data = await getJson<RawPipeline[]>(`${API_BASE}/projects/${project}/pipelines?${params}`, await gitlabToken(env, userId));
	if (!Array.isArray(data)) return null;
	return data.map(toBuildRun);
}
