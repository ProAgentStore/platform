/**
 * Read-only GitHub Pull Requests (#401) — the artefact the Coder's safest mode produces.
 *
 * The per-repo merge policy (#314) has a `pr` setting: the agent does the work, opens a pull
 * request and stops. That is the mode a careful owner picks, and having picked it the console
 * could show them the ISSUE that started the work and the BUILD that ran, but not the PR that is
 * the actual output — there was no `/pulls` call anywhere in `workers/api/src`. Worse than absent:
 * `github-issues.ts` receives PRs from the issues endpoint and filters them out.
 *
 * Shaped as the sibling of `github-issues.ts` on purpose — same auth path (a verified GitHub-App
 * installation token, unauthenticated fallback for public repos), same summary/detail split, same
 * never-throws contract (a GitHub or network error degrades to `[]`/`null` so the panel can say
 * "couldn't load" rather than crashing), and the same conditional-request cache.
 *
 * WRITES ARE DELIBERATELY ABSENT. There is no merge, no close, no review submission here. Merging
 * is what the per-repo merge policy governs, and a tool that bypassed it would hand the agent
 * exactly the authority #314 exists to withhold.
 */
import { githubConditionalJson, resolveGithubRead, type GithubAuthContext } from "./github-cache.js";
import { fetchWorkflowRuns } from "./github-actions.js";
import type { Env } from "../types.js";

const GH_HEADERS = (token: string | null) => ({
	...(token ? { Authorization: `token ${token}` } : {}),
	Accept: "application/vnd.github+json",
	"X-GitHub-Api-Version": "2022-11-28",
	"User-Agent": "proagentstore-coding/1.0",
});

// Same charset guard as github-issues.ts: validating here (not just the two-part shape) is what
// stops `owner/name?per_page=100` smuggling a query into an authenticated api.github.com path.
const SEGMENT = /^[A-Za-z0-9._-]+$/;

function parseRepo(githubRepo: string): { owner: string; name: string } | null {
	const parts = String(githubRepo || "").split("/");
	if (parts.length !== 2 || !SEGMENT.test(parts[0]) || !SEGMENT.test(parts[1])) return null;
	return { owner: parts[0], name: parts[1] };
}

/** Where a review has got to. `none` = nobody reviewed; `unknown` = we could not find out. */
export type ReviewState = "approved" | "changes_requested" | "commented" | "none" | "unknown";

/** A PR's CI, in the two raw fields `buildState()` in the console already maps. */
export interface PullChecks {
	status?: string; // queued | in_progress | completed
	conclusion?: string | null; // success | failure | cancelled | timed_out | null
	url?: string;
	name?: string;
}

export interface PullSummary {
	number: number;
	title: string;
	state: string; // open | closed
	draft: boolean;
	merged: boolean;
	author: string;
	/** The head branch — what the agent worked on. */
	branch: string;
	baseBranch: string;
	/** FULL head sha: what a workflow run is matched on. */
	headSha: string;
	labels: string[];
	comments: number;
	createdAt: string;
	updatedAt: string;
	url: string;
	reviewersRequested: number;
	/**
	 * `null` when it was not looked up (an unenriched row) — never `false`, because "we did not
	 * ask" and "GitHub says this PR conflicts" are the two answers a reader must not confuse.
	 * `false` from GitHub itself means conflicted; `true` means it merges cleanly.
	 */
	mergeable: boolean | null;
	/** clean | dirty | blocked | behind | unstable | unknown — GitHub's own word for the state. */
	mergeableState: string;
	review: ReviewState;
	checks: PullChecks | null;
}

export interface PullDetail extends PullSummary {
	body: string;
	additions: number;
	deletions: number;
	changedFiles: number;
}

interface RawPull {
	number: number;
	title?: string;
	state?: string;
	draft?: boolean;
	merged?: boolean;
	merged_at?: string | null;
	body?: string | null;
	created_at?: string;
	updated_at?: string;
	html_url?: string;
	comments?: number;
	additions?: number;
	deletions?: number;
	changed_files?: number;
	mergeable?: boolean | null;
	mergeable_state?: string;
	user?: { login?: string } | null;
	head?: { ref?: string; sha?: string } | null;
	base?: { ref?: string } | null;
	labels?: Array<{ name?: string } | string>;
	requested_reviewers?: unknown[];
}

interface RawReview {
	state?: string;
	submitted_at?: string;
	user?: { login?: string } | null;
}

const BODY_CAP = 8 * 1024;

/** How many open PRs a list answers with, and how many of them get the extra two calls. */
export const PULLS_PAGE_SIZE = 30;
export const PULLS_ENRICH_CAP = 8;

function labelNames(labels: RawPull["labels"]): string[] {
	if (!Array.isArray(labels)) return [];
	return labels
		.map((l) => (typeof l === "string" ? l : l?.name))
		.filter((n): n is string => typeof n === "string" && n.length > 0);
}

/**
 * Map GitHub's PR object to the summary the console renders.
 *
 * `mergeable` is `null` here for a reason: the LIST endpoint does not return it at all, so an
 * unenriched row genuinely does not know. GitHub also computes it lazily on the detail endpoint
 * and answers `null` until the background job finishes — which is the same "not known yet", so
 * both arrive as `null` and the panel renders "—" rather than inventing "conflicted".
 */
export function toPullSummary(raw: RawPull): PullSummary {
	return {
		number: raw.number,
		title: raw.title ?? "",
		state: raw.state ?? "open",
		draft: raw.draft === true,
		merged: raw.merged === true || !!raw.merged_at,
		author: raw.user?.login ?? "",
		branch: raw.head?.ref ?? "",
		baseBranch: raw.base?.ref ?? "",
		headSha: raw.head?.sha ?? "",
		labels: labelNames(raw.labels),
		comments: typeof raw.comments === "number" ? raw.comments : 0,
		createdAt: raw.created_at ?? "",
		updatedAt: raw.updated_at ?? "",
		url: raw.html_url ?? "",
		reviewersRequested: Array.isArray(raw.requested_reviewers) ? raw.requested_reviewers.length : 0,
		mergeable: typeof raw.mergeable === "boolean" ? raw.mergeable : null,
		mergeableState: typeof raw.mergeable_state === "string" && raw.mergeable_state ? raw.mergeable_state : "unknown",
		review: "unknown",
		checks: null,
	};
}

/**
 * The one answer a row can show for "where is the review up to".
 *
 * Only the LATEST review per person counts — someone who requested changes and then approved has
 * approved. `changes_requested` outranks `approved` because it is the blocking state and a row
 * that showed "approved" while another reviewer was blocking would be read as ready to merge.
 * Pure, so the precedence is testable without GitHub.
 */
export function resolveReviewState(reviews: RawReview[]): ReviewState {
	if (!Array.isArray(reviews) || reviews.length === 0) return "none";
	const latest = new Map<string, string>();
	for (const r of reviews) {
		const who = r.user?.login ?? "";
		const state = String(r.state ?? "").toUpperCase();
		// COMMENTED / DISMISSED / PENDING never REPLACE a decision — GitHub's own rule is that a
		// comment does not clear an approval.
		if (state !== "APPROVED" && state !== "CHANGES_REQUESTED") {
			if (!latest.has(who)) latest.set(who, state);
			continue;
		}
		latest.set(who, state);
	}
	const states = [...latest.values()];
	if (states.includes("CHANGES_REQUESTED")) return "changes_requested";
	if (states.includes("APPROVED")) return "approved";
	if (states.includes("COMMENTED")) return "commented";
	return "none";
}

/**
 * Attach each PR's CI from ONE workflow-runs page rather than a call per PR.
 *
 * The Builds panel already fetches these runs; this reads the same runs from the other angle, by
 * matching a run's `head_sha` to a PR's. One request covers every PR in the list, which is the
 * difference between the panel costing 2 requests and costing 2N. Pure.
 */
export function attachChecks(pulls: PullSummary[], runs: Array<Record<string, unknown>>): PullSummary[] {
	const bySha = new Map<string, Record<string, unknown>>();
	for (const run of runs) {
		const sha = typeof run.head_sha === "string" ? run.head_sha : "";
		if (!sha) continue;
		// The runs page is newest-first, so the FIRST run seen for a sha is the current one.
		if (!bySha.has(sha)) bySha.set(sha, run);
	}
	return pulls.map((p) => {
		const run = p.headSha ? bySha.get(p.headSha) : undefined;
		if (!run) return p;
		return {
			...p,
			checks: {
				status: typeof run.status === "string" ? run.status : undefined,
				conclusion: (run.conclusion ?? null) as string | null,
				url: typeof run.html_url === "string" ? run.html_url : undefined,
				name: typeof run.name === "string" ? run.name : undefined,
			},
		};
	});
}

interface ReadCtx {
	env: Env;
	userId: string;
	owner: string;
	name: string;
	token: string | null;
	authContext: GithubAuthContext | null;
}

/** One PR's `mergeable`/`mergeable_state`, which only the single-PR endpoint carries. */
async function fetchPullRaw(ctx: ReadCtx, number: number): Promise<RawPull | null> {
	const res = await githubConditionalJson<RawPull>(ctx.env, {
		identity: { userId: ctx.userId, authContext: ctx.authContext },
		repo: `${ctx.owner}/${ctx.name}`,
		resource: "pull",
		variant: String(number),
		url: `https://api.github.com/repos/${encodeURIComponent(ctx.owner)}/${encodeURIComponent(ctx.name)}/pulls/${number}`,
		headers: GH_HEADERS(ctx.token),
	});
	return res.ok && res.data && typeof res.data === "object" ? res.data : null;
}

async function fetchReviewState(ctx: ReadCtx, number: number): Promise<ReviewState> {
	const res = await githubConditionalJson<RawReview[]>(ctx.env, {
		identity: { userId: ctx.userId, authContext: ctx.authContext },
		repo: `${ctx.owner}/${ctx.name}`,
		resource: "reviews",
		variant: String(number),
		url: `https://api.github.com/repos/${encodeURIComponent(ctx.owner)}/${encodeURIComponent(ctx.name)}/pulls/${number}/reviews?per_page=100`,
		headers: GH_HEADERS(ctx.token),
	});
	return res.ok && Array.isArray(res.data) ? resolveReviewState(res.data) : "unknown";
}

export interface ListPullsOpts {
	state?: "open" | "closed" | "all";
	limit?: number;
	/**
	 * Fetch `mergeable` + review state for the first `PULLS_ENRICH_CAP` rows (2 extra conditional
	 * requests each). On by default because "can this merge, has anyone approved it" is most of
	 * why the panel exists; capped because a repo with sixty open PRs must not turn one panel poll
	 * into a hundred and twenty requests.
	 */
	enrich?: boolean;
}

/**
 * The repo's pull requests, newest-activity first. Returns [] on any failure — no App, no
 * installation, a GitHub error, a malformed repo.
 *
 * ALL PRs, not only the agent's. A panel that hid human PRs would answer "what did my agent do"
 * while failing to be a view of the repo; attribution is a per-row badge instead (see
 * `routes/coding-pulls.ts`).
 */
export async function listPulls(env: Env, userId: string, githubRepo: string, opts: ListPullsOpts = {}): Promise<PullSummary[]> {
	const parsed = parseRepo(githubRepo);
	if (!parsed) return [];
	try {
		const { token, authContext } = await resolveGithubRead(env, userId, parsed.owner);
		const ctx: ReadCtx = { env, userId, owner: parsed.owner, name: parsed.name, token, authContext };
		const state = opts.state ?? "open";
		const perPage = Math.min(Math.max(opts.limit ?? PULLS_PAGE_SIZE, 1), 100);
		const qs = new URLSearchParams({ state, per_page: String(perPage), sort: "updated", direction: "desc" }).toString();
		const res = await githubConditionalJson<RawPull[]>(env, {
			identity: { userId, authContext },
			repo: `${parsed.owner}/${parsed.name}`,
			resource: "pulls",
			variant: qs,
			url: `https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.name)}/pulls?${qs}`,
			headers: GH_HEADERS(token),
		});
		if (!res.ok || !Array.isArray(res.data)) return [];
		let pulls = res.data.map(toPullSummary);

		// One extra request for every PR's CI (see attachChecks). `event: pull_request` keeps this
		// off the push/schedule runs that the Builds panel shows and a PR's checks are not.
		const runs = await fetchWorkflowRuns(`${parsed.owner}/${parsed.name}`, token ?? undefined, {
			perPage: 50,
			event: "pull_request",
		});
		if (!("status" in runs)) pulls = attachChecks(pulls, runs.runs);

		if (opts.enrich === false) return pulls;
		const enrich = pulls.slice(0, PULLS_ENRICH_CAP);
		const settled = await Promise.allSettled(
			enrich.map(async (p) => {
				const [detail, review] = await Promise.all([fetchPullRaw(ctx, p.number), fetchReviewState(ctx, p.number)]);
				return { number: p.number, detail, review };
			}),
		);
		const byNumber = new Map<number, { detail: RawPull | null; review: ReviewState }>();
		for (const s of settled) if (s.status === "fulfilled") byNumber.set(s.value.number, { detail: s.value.detail, review: s.value.review });
		return pulls.map((p) => {
			const extra = byNumber.get(p.number);
			if (!extra) return p;
			return {
				...p,
				// A failed enrichment leaves the row's own honest "unknown"/null rather than
				// downgrading a PR to "conflicted" because one request timed out.
				mergeable: extra.detail && typeof extra.detail.mergeable === "boolean" ? extra.detail.mergeable : p.mergeable,
				mergeableState: extra.detail?.mergeable_state || p.mergeableState,
				review: extra.review,
			};
		});
	} catch {
		return [];
	}
}

/** One PR in full — body, diff size, mergeability and review state. `null` when not found. */
export async function readPull(env: Env, userId: string, githubRepo: string, number: number): Promise<PullDetail | null> {
	const parsed = parseRepo(githubRepo);
	if (!parsed || !Number.isFinite(number)) return null;
	try {
		const { token, authContext } = await resolveGithubRead(env, userId, parsed.owner);
		const ctx: ReadCtx = { env, userId, owner: parsed.owner, name: parsed.name, token, authContext };
		const raw = await fetchPullRaw(ctx, Number(number));
		if (!raw) return null;
		const review = await fetchReviewState(ctx, Number(number));
		const runs = await fetchWorkflowRuns(`${parsed.owner}/${parsed.name}`, token ?? undefined, { perPage: 50, event: "pull_request" });
		const summary = toPullSummary(raw);
		const withChecks = "status" in runs ? [summary] : attachChecks([summary], runs.runs);
		return {
			...withChecks[0],
			review,
			body: (raw.body ?? "").slice(0, BODY_CAP),
			additions: typeof raw.additions === "number" ? raw.additions : 0,
			deletions: typeof raw.deletions === "number" ? raw.deletions : 0,
			changedFiles: typeof raw.changed_files === "number" ? raw.changed_files : 0,
		};
	} catch {
		return null;
	}
}
