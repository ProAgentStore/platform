/**
 * Read-only GitLab MERGE REQUESTS — the Coder's Pulls surface, on a second host (#221, phase 3
 * completed).
 *
 * ── What this is NOT
 *
 * It is not a generalisation of `github-prs.ts`. That file keeps its shape byte-for-byte; this
 * one answers the same QUESTIONS against a different API, and `hosted-repo.ts` is the single
 * place that decides which of them a repo gets — exactly the shape `gitlab-api.ts` and
 * `bitbucket-api.ts` already established for issues and builds. The seam is the OUTPUT type
 * (`PullSummary` / `PullDetail` / `PullChecks` / `ReviewState`), not an auth interface.
 * Nothing here touches `installationTokenForOwner`, and no GitHub behaviour changes because
 * this file exists. #221's own deferral comment is explicit about why: GitHub's grant model is
 * installation-scoped and owner-keyed, GitLab's token is user-scoped over an arbitrarily nested
 * namespace, and an interface written against the first would force the second to lie to it.
 *
 * ── Auth
 *
 * The same vault PAT `gitlab-api.ts` reads (`user_api_keys` provider `gitlab`), sent as
 * `PRIVATE-TOKEN`, and the same unauthenticated fallback: a public project's merge requests are
 * readable with no credential at all, which is how every probe below was taken. `userId` comes
 * from the route's owner check, never from a request field.
 *
 * ── Six mappings that are decisions, each verified against the live gitlab.com API
 *
 * Probed unauthenticated against `gitlab-org/gitlab-runner`, with the exact URL shapes built
 * below, because the condition #221's deferral comment named still holds: nobody here has a
 * GitLab account, so the shapes had to come off the wire rather than out of documentation.
 *
 * 1. NUMBER is `iid`, never `id` — MR !6886 is `iid:6886`, `id:500829467`. The same decision
 *    `gitlab-api.ts` records for issues, and load-bearing for the same reason: `id` is a global
 *    counter that appears nowhere a human looks, so a PR link built from it points at a
 *    different project's merge request.
 *
 * 2. CHECKS come from `head_pipeline` on the DETAIL endpoint — they cannot be correlated by sha
 *    the way `attachChecks` does on GitHub. Verified: MR !6886's head pipeline lives in the
 *    FORK (`gourabsingha1/gitlab-runner`), and asking the TARGET project for
 *    `pipelines?sha=40daaba…` returns `[]` — a 200 with an empty list, so the "cheap" one-call
 *    version would have silently reported "no checks" on every fork contribution. It is also
 *    why checks are only present on ENRICHED rows here, unlike GitHub where one runs page
 *    covers the whole list.
 *
 * 3. REVIEW STATE comes from `/merge_requests/:iid/reviewers`, whose entries carry
 *    `state: "approved" | "requested_changes" | …`. The trap is that the MR LIST also has a
 *    `reviewers[]`, whose `state` is the USER ACCOUNT's state — every entry probed reads
 *    `"active"`. Reading that field would report a review state on every row and be wrong on
 *    every row, with nothing in the shape to give it away.
 *
 * 4. MERGEABILITY is read from `merge_status` + `has_conflicts` (git-level, the same question
 *    GitHub's `mergeable` answers), while `detailed_merge_status` supplies the POLICY word.
 *    Live, !6886 reads `merge_status:"can_be_merged"` with `detailed_merge_status:
 *    "requested_changes"` — it has no conflicts AND cannot be merged, which is precisely
 *    GitHub's `mergeable:true, mergeable_state:"blocked"`. Collapsing the two would have shown
 *    a blocked MR as ready to merge.
 *
 * 5. `state=closed` MEANS SOMETHING ELSE HERE. GitHub's `closed` includes merged PRs; GitLab's
 *    does not — `state=closed` returned only `closed` MRs and `state=merged` only `merged`
 *    ones. And `not[state]=opened`, the obvious workaround, is SILENTLY IGNORED: it answered
 *    200 with five `opened` MRs. So "closed" is two requests, unioned. (`state=all` IS accepted
 *    here, unlike the issues endpoint which 400s on it — the two endpoints genuinely differ.)
 *
 * 6. `changes_count` IS A STRING — live value `"2"`, and GitLab caps it as `"1000+"` on large
 *    diffs. `PullDetail.changedFiles` is a number, so it is parsed, and the `+` form is read as
 *    the lower bound it is rather than becoming `NaN` or `0`.
 *
 * And what GitLab does NOT have is left absent rather than invented: there is no per-MR line
 * count anywhere in these payloads, so `additions`/`deletions` stay `0` — the same "0 means
 * unknown" the Bitbucket issue client records for its missing comment count, and the panel
 * greys it out.
 */
import { PULLS_ENRICH_CAP, PULLS_PAGE_SIZE, type ListPullsOpts, type PullChecks, type PullDetail, type PullSummary, type ReviewState } from "./github-prs.js";
import { gitlabProjectId, mapPipelineStatus } from "./gitlab-api.js";
import { readConnectorRefreshToken } from "./connector-oauth.js";
import type { Env } from "../types.js";

/**
 * Fixed, for the reason `gitlab-api.ts` states: any other host — self-managed GitLab included —
 * resolves to provider `other`, declares no hosted support, and never reaches this module. No
 * request field on this path can move where an authenticated read is sent.
 */
const API_BASE = "https://gitlab.com/api/v4";

/** Same cap every reader on this seam applies: a body goes into a model prompt. */
const BODY_CAP = 8 * 1024;

/**
 * The stored PAT, or null. A three-line read rather than an import because `gitlab-api.ts`
 * keeps its own copy private; it is the identical call, and an absent key is the ORDINARY state
 * (a public project needs none). `readConnectorRefreshToken` raises for both "no row" and "no
 * KEK", which mean the same thing to every caller here.
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

interface RawPipeline {
	status?: string;
	name?: string | null;
	source?: string;
	web_url?: string;
}

interface RawMr {
	id?: number;
	iid?: number;
	title?: string;
	state?: string;
	draft?: boolean;
	work_in_progress?: boolean;
	merged_at?: string | null;
	sha?: string;
	source_branch?: string;
	target_branch?: string;
	labels?: unknown;
	user_notes_count?: number;
	created_at?: string;
	updated_at?: string;
	web_url?: string;
	description?: string | null;
	merge_status?: string;
	detailed_merge_status?: string;
	has_conflicts?: boolean;
	changes_count?: string | number | null;
	author?: { username?: string } | null;
	reviewers?: unknown[];
	head_pipeline?: RawPipeline | null;
}

/** One entry of `/merge_requests/:iid/reviewers` — NOT of the MR list's `reviewers[]` (see 3). */
interface RawReviewer {
	state?: string;
}

/**
 * GitLab's four MR states → the two words every caller filters on.
 *
 * `locked` means a merge is in flight, so the MR is still OPEN to a reader; `merged` and
 * `closed` are both ways of being done with it, which is exactly what GitHub's `closed` means
 * for a pull request. `merged` is then carried separately by `PullSummary.merged`, so nothing is
 * lost by the collapse.
 */
function normalizeState(state: string | undefined): string {
	return state === "opened" || state === "locked" ? "open" : "closed";
}

/**
 * GitLab's `detailed_merge_status` → the word the console's `mergeTone` reads.
 *
 * Only `blocked` and `behind` change what a reader sees, and everything mapped to `blocked`
 * below is the same situation GitHub names that way: no conflict, but a required approval,
 * discussion, or check is unsatisfied. Transcribing GitLab's own vocabulary instead would have
 * rendered `not_approved` as "Mergeable" — a green label on a merge request that cannot be
 * merged, which is the one thing this panel exists not to do.
 */
const MERGEABLE_STATE: Record<string, string> = {
	mergeable: "clean",
	conflict: "dirty",
	need_rebase: "behind",
	draft_status: "draft",
	not_approved: "blocked",
	requested_changes: "blocked",
	discussions_not_resolved: "blocked",
	status_checks_must_pass: "blocked",
	external_status_checks: "blocked",
	jira_association_missing: "blocked",
	blocked_status: "blocked",
	broken_status: "blocked",
	ci_must_pass: "blocked",
	ci_still_running: "blocked",
	// Not yet computed. GitLab answers these while its background job runs, which is the same
	// "we do not know" GitHub expresses with a null `mergeable` — and it must not read as a
	// verdict in either direction.
	checking: "unknown",
	unchecked: "unknown",
	preparing: "unknown",
	approvals_syncing: "unknown",
	not_open: "unknown",
};

/**
 * Can this merge, and what is GitLab's word for the state? Pure.
 *
 * `mergeable` answers the GIT-level question only — the one GitHub's `mergeable` answers — so an
 * MR that merges cleanly but is blocked on review is `true` + `"blocked"`, exactly as it would
 * be on GitHub. `null` is reserved for "not computed yet" and is never `false`: telling an owner
 * their branch conflicts because nobody has checked is the false alarm the console's own
 * `mergeTone` comment names.
 */
export function mergeability(raw: Pick<RawMr, "merge_status" | "detailed_merge_status" | "has_conflicts">): { mergeable: boolean | null; mergeableState: string } {
	const detailed = String(raw.detailed_merge_status ?? "");
	const mergeable = raw.has_conflicts === true ? false : raw.merge_status === "can_be_merged" ? true : raw.merge_status === "cannot_be_merged" ? false : null;
	const state = MERGEABLE_STATE[detailed] ?? (mergeable === true ? "clean" : mergeable === false ? "dirty" : "unknown");
	return { mergeable, mergeableState: state };
}

/**
 * The one answer a row shows for "where is the review up to", from `/reviewers`.
 *
 * Same precedence as `resolveReviewState` in `github-prs.ts`, and for the same reason:
 * `changes_requested` is the BLOCKING state, so a row that showed "approved" while another
 * reviewer was blocking would be read as ready to merge. Unrecognised states contribute
 * nothing — which is also what makes feeding this the MR list's `reviewers[]` (whose `state` is
 * the user account's, `"active"`) produce an honest "none" rather than a fabricated verdict.
 */
export function resolveGitlabReviewState(reviewers: RawReviewer[] | null | undefined): ReviewState {
	if (!Array.isArray(reviewers) || reviewers.length === 0) return "none";
	const states = reviewers.map((r) => String(r?.state ?? ""));
	if (states.includes("requested_changes")) return "changes_requested";
	if (states.includes("approved")) return "approved";
	// `reviewed` / `review_started` mean somebody engaged without deciding — GitHub's
	// `COMMENTED`. `unreviewed` / `unapproved` mean they have not, which is "none".
	if (states.some((s) => s === "reviewed" || s === "review_started")) return "commented";
	return "none";
}

/**
 * `head_pipeline` → the two raw fields the console's `buildState()` already maps.
 *
 * Reuses `mapPipelineStatus` from `gitlab-api.ts` so the Builds panel and a PR row cannot
 * disagree about what `running` means on the same host. The name fallback is the same one the
 * Builds panel takes and for the same measured reason: phase 3's live probe found
 * `pipeline.name` null on every real pipeline, so `source` (`"merge_request_event"`) is the
 * nearest true answer to "what ran this" — and the head-pipeline objects probed here have no
 * `name` key at all.
 */
export function toPullChecks(pipeline: RawPipeline | null | undefined): PullChecks | null {
	if (!pipeline || typeof pipeline !== "object") return null;
	const mapped = mapPipelineStatus(pipeline.status);
	return {
		status: mapped.status,
		conclusion: mapped.conclusion,
		url: typeof pipeline.web_url === "string" ? pipeline.web_url : undefined,
		name: pipeline.name || pipeline.source || "Pipeline",
	};
}

/** `"2"` → 2, `"1000+"` → 1000, anything else → 0. GitLab reports this as a STRING (see 6). */
export function parseChangesCount(value: string | number | null | undefined): number {
	if (typeof value === "number") return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
	const m = String(value ?? "").match(/^(\d+)/);
	return m ? Number(m[1]) : 0;
}

/** Map a merge request onto the summary the console renders. Pure. */
export function toGitlabPullSummary(raw: RawMr): PullSummary {
	const merge = mergeability(raw);
	return {
		number: typeof raw.iid === "number" ? raw.iid : 0,
		title: raw.title ?? "",
		state: normalizeState(raw.state),
		// GitLab kept `work_in_progress` alongside `draft` for compatibility; either being true
		// means the author is not asking for a merge yet.
		draft: raw.draft === true || raw.work_in_progress === true,
		merged: raw.state === "merged" || !!raw.merged_at,
		author: raw.author?.username ?? "",
		branch: raw.source_branch ?? "",
		baseBranch: raw.target_branch ?? "",
		// The FULL 40-character diff head sha, verified live — the same shape GitHub's `head.sha`
		// carries, even though nothing on this provider correlates by it (see 2).
		headSha: typeof raw.sha === "string" ? raw.sha : "",
		labels: Array.isArray(raw.labels) ? raw.labels.filter((l): l is string => typeof l === "string" && l.length > 0) : [],
		// A real count, present on the list — unlike Bitbucket's issues, this one is not a guess.
		comments: typeof raw.user_notes_count === "number" ? raw.user_notes_count : 0,
		createdAt: raw.created_at ?? "",
		updatedAt: raw.updated_at ?? "",
		url: raw.web_url ?? "",
		reviewersRequested: Array.isArray(raw.reviewers) ? raw.reviewers.length : 0,
		mergeable: merge.mergeable,
		mergeableState: merge.mergeableState,
		// Both are lookups, not fields: an unenriched row has NOT asked, and says so.
		review: "unknown",
		checks: toPullChecks(raw.head_pipeline),
	};
}

/** The GitLab `state` values a caller's `open` / `closed` / `all` becomes (see 5). */
function statesFor(state: "open" | "closed" | "all"): string[] {
	if (state === "open") return ["opened"];
	// GitLab's `closed` EXCLUDES merged, and `not[state]` is silently ignored — so the union is
	// two requests. One would have to drop either merged or declined work from the panel.
	if (state === "closed") return ["merged", "closed"];
	return ["all"];
}

function listUrl(project: string, state: string, perPage: number): string {
	const params = new URLSearchParams({ state, per_page: String(perPage), order_by: "updated_at", sort: "desc" });
	return `${API_BASE}/projects/${project}/merge_requests?${params}`;
}

async function fetchDetail(project: string, iid: number, token: string | null): Promise<RawMr | null> {
	return getJson<RawMr>(`${API_BASE}/projects/${project}/merge_requests/${iid}`, token);
}

async function fetchReviewState(project: string, iid: number, token: string | null): Promise<ReviewState> {
	const data = await getJson<RawReviewer[]>(`${API_BASE}/projects/${project}/merge_requests/${iid}/reviewers`, token);
	return Array.isArray(data) ? resolveGitlabReviewState(data) : "unknown";
}

/**
 * A project's merge requests, newest-activity first. `[]` on any failure — no token, a private
 * project (GitLab answers 404 rather than 403), a malformed slug, a network error.
 *
 * ALL merge requests, not only the agent's, for the reason `github-prs.ts` gives: a panel that
 * hid human MRs would answer "what did my agent do" while failing to be a view of the repo.
 */
export async function listGitlabPulls(env: Env, userId: string, slug: string, opts: ListPullsOpts = {}): Promise<PullSummary[]> {
	const project = gitlabProjectId(slug);
	if (!project) return [];
	const perPage = Math.min(Math.max(opts.limit ?? PULLS_PAGE_SIZE, 1), 100);
	const token = await gitlabToken(env, userId);
	const states = statesFor(opts.state ?? "open");
	const pages = await Promise.all(states.map((s) => getJson<RawMr[]>(listUrl(project, s, perPage), token)));
	if (pages.every((p) => !Array.isArray(p))) return [];
	let pulls = pages
		.flatMap((p) => (Array.isArray(p) ? p : []))
		.map(toGitlabPullSummary)
		.filter((p) => p.number > 0);
	// Two unioned pages are each sorted, their concatenation is not — and the panel's contract is
	// newest activity first.
	if (states.length > 1) pulls = pulls.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0)).slice(0, perPage);
	if (opts.enrich === false) return pulls;

	// Two extra requests each for the first N rows, matching GitHub's cap and its reason: "can
	// this merge, has anyone approved it" is most of why the panel exists, and a project with
	// sixty open MRs must not turn one poll into a hundred and twenty requests.
	const enrich = pulls.slice(0, PULLS_ENRICH_CAP);
	const settled = await Promise.allSettled(
		enrich.map(async (p) => {
			const [detail, review] = await Promise.all([fetchDetail(project, p.number, token), fetchReviewState(project, p.number, token)]);
			return { number: p.number, detail, review };
		}),
	);
	const byNumber = new Map<number, { detail: RawMr | null; review: ReviewState }>();
	for (const s of settled) if (s.status === "fulfilled") byNumber.set(s.value.number, { detail: s.value.detail, review: s.value.review });
	return pulls.map((p) => {
		const extra = byNumber.get(p.number);
		if (!extra) return p;
		// A failed enrichment leaves the row's own honest values rather than downgrading it.
		const merge = extra.detail ? mergeability(extra.detail) : null;
		return {
			...p,
			mergeable: merge && merge.mergeable !== null ? merge.mergeable : p.mergeable,
			mergeableState: merge && merge.mergeableState !== "unknown" ? merge.mergeableState : p.mergeableState,
			checks: toPullChecks(extra.detail?.head_pipeline) ?? p.checks,
			review: extra.review,
		};
	});
}

/**
 * One merge request in full — description, changed-file count, mergeability, review state and
 * head pipeline. `null` when absent or unreadable.
 */
export async function readGitlabPull(env: Env, userId: string, slug: string, number: number): Promise<PullDetail | null> {
	const project = gitlabProjectId(slug);
	if (!project || !Number.isFinite(number) || number <= 0) return null;
	const token = await gitlabToken(env, userId);
	const iid = Math.floor(number);
	const raw = await fetchDetail(project, iid, token);
	if (!raw || typeof raw !== "object" || typeof raw.iid !== "number") return null;
	const review = await fetchReviewState(project, iid, token);
	return {
		...toGitlabPullSummary(raw),
		review,
		body: (raw.description ?? "").slice(0, BODY_CAP),
		// GitLab carries no per-MR line counts on any of these payloads, and fetching the diff to
		// compute them would be a page-per-file walk for two numbers the panel greys out. 0 is
		// "unknown" here — the same representation the Bitbucket client records for its absent
		// comment count, and deliberately not an invented "no changes".
		additions: 0,
		deletions: 0,
		changedFiles: parseChangesCount(raw.changes_count),
	};
}
