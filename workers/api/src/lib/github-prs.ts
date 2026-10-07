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
import { fetchGithubSearch } from "./github-issues.js";
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

/** Review pages read before the verdict is called `unknown` rather than guessed. */
const REVIEW_MAX_PAGES = 5;

/**
 * Every review, not the first 100 (#898). GitHub lists reviews OLDEST first, so the first page of
 * a long-reviewed PR is exactly the part that no longer decides anything — the latest approval or
 * request for changes sat on a page nobody read. Past {@link REVIEW_MAX_PAGES} the answer is
 * `unknown`, never a verdict drawn from a partial history.
 */
async function fetchReviewState(ctx: ReadCtx, number: number): Promise<ReviewState> {
	const reviews: RawReview[] = [];
	for (let page = 1; page <= REVIEW_MAX_PAGES; page++) {
		const res = await githubConditionalJson<RawReview[]>(ctx.env, {
			identity: { userId: ctx.userId, authContext: ctx.authContext },
			repo: `${ctx.owner}/${ctx.name}`,
			resource: "reviews",
			variant: page === 1 ? String(number) : `${number}:p${page}`,
			url: `https://api.github.com/repos/${encodeURIComponent(ctx.owner)}/${encodeURIComponent(ctx.name)}/pulls/${number}/reviews?per_page=100${page > 1 ? `&page=${page}` : ""}`,
			headers: GH_HEADERS(ctx.token),
		});
		if (!res.ok || !Array.isArray(res.data)) return "unknown";
		reviews.push(...res.data);
		if (res.data.length < 100) return resolveReviewState(reviews);
	}
	return "unknown";
}

export interface ListPullsOpts {
	state?: "open" | "closed" | "all";
	limit?: number;
	/** 1-based page (#898) — without it only the newest page was reachable. */
	page?: number;
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
		const params = new URLSearchParams({ state, per_page: String(perPage), sort: "updated", direction: "desc" });
		if ((opts.page ?? 1) > 1) params.set("page", String(Math.trunc(opts.page ?? 1)));
		const qs = params.toString();
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
		const runs = await fetchWorkflowRuns(
			`${parsed.owner}/${parsed.name}`,
			token ?? undefined,
			{ perPage: 50, event: "pull_request" },
			// Same `authContext` the pulls read above was made under, from the same
			// `resolveGithubRead` that minted this token (#418).
			{ env, identity: { userId, authContext } },
		);
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

/** What `searchPulls` returns: the matches GitHub sent, and how many there are in all (#937). */
export interface SearchPullsResult {
	/** Every PR in the repo matching the query — may exceed `pulls.length`. */
	total_count: number;
	/** GitHub's own flag: the search timed out and the matches may be incomplete. */
	incomplete_results: boolean;
	pulls: PullSummary[];
}

/** A PR as the SEARCH endpoint returns it: issue-shaped, with merge state under `pull_request`. */
type RawSearchPull = RawPull & { pull_request?: { merged_at?: string | null } | null };

/** The `q` for a PR search, scoped to one repo and to pull requests only (#937). */
export function searchPullsQuery(owner: string, name: string, search: string, state: "open" | "closed" | "all" = "open"): string {
	return [`repo:${owner}/${name}`, "is:pr", state === "all" ? "" : `state:${state}`, "in:title,body", search.trim()].filter(Boolean).join(" ");
}

/**
 * Search a repo's pull requests — title AND body, across EVERY PR, not just the recent page (#937).
 *
 * The same design as `searchIssues` (#936), and the same shared request (`fetchGithubSearch`), so a
 * refusal is an ERROR and never `[]`. Search answers with ISSUE-shaped items — no head/base branch,
 * head sha, mergeable or review state — so the first {@link PULLS_ENRICH_CAP} matches are completed
 * from the PR endpoints `listPulls` already enriches with, and CI is attached with the same single
 * workflow-runs read. The rest keep `toPullSummary`'s honest "not known" values: an empty branch and
 * head sha, `mergeable: null`, `review: "unknown"` — never a guessed "conflicted" or "approved".
 */
export async function searchPulls(env: Env, userId: string, githubRepo: string, search: string, opts: Pick<ListPullsOpts, "state" | "limit" | "page"> = {}): Promise<SearchPullsResult | { error: string }> {
	const parsed = parseRepo(githubRepo);
	if (!parsed) return { error: `"${githubRepo}" is not an "owner/name" repository.` };
	const { token, authContext } = await resolveGithubRead(env, userId, parsed.owner).catch(() => ({ token: null, authContext: null }));
	const found = await fetchGithubSearch<RawSearchPull>(searchPullsQuery(parsed.owner, parsed.name, search, opts.state ?? "open"), token, opts.limit ?? PULLS_PAGE_SIZE, opts.page);
	if ("error" in found) return found;
	let pulls = found.items.map((i) => toPullSummary({ ...i, merged_at: i.merged_at ?? i.pull_request?.merged_at ?? null }));

	const ctx: ReadCtx = { env, userId, owner: parsed.owner, name: parsed.name, token, authContext };
	const settled = await Promise.allSettled(
		pulls.slice(0, PULLS_ENRICH_CAP).map(async (p) => {
			const [detail, review] = await Promise.all([fetchPullRaw(ctx, p.number), fetchReviewState(ctx, p.number)]);
			return { number: p.number, detail, review };
		}),
	);
	const byNumber = new Map<number, { detail: RawPull | null; review: ReviewState }>();
	for (const s of settled) if (s.status === "fulfilled") byNumber.set(s.value.number, { detail: s.value.detail, review: s.value.review });
	pulls = pulls.map((p) => {
		const extra = byNumber.get(p.number);
		// A failed enrichment keeps the search row's "not known" values rather than inventing any.
		return extra ? { ...(extra.detail ? toPullSummary(extra.detail) : p), review: extra.review } : p;
	});
	const runs = await fetchWorkflowRuns(`${parsed.owner}/${parsed.name}`, token ?? undefined, { perPage: 50, event: "pull_request" }, { env, identity: { userId, authContext } });
	if (!("status" in runs)) pulls = attachChecks(pulls, runs.runs);
	return { total_count: found.total_count, incomplete_results: found.incomplete_results, pulls };
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
		const summary = toPullSummary(raw);
		// By THIS PR's head commit (#898), not by searching the repo's newest 50 PR runs: a PR whose
		// run had scrolled out of that window read as having no CI at all.
		const runs = await fetchWorkflowRuns(
			`${parsed.owner}/${parsed.name}`,
			token ?? undefined,
			summary.headSha ? { perPage: 5, event: "pull_request", headSha: summary.headSha } : { perPage: 50, event: "pull_request" },
			{ env, identity: { userId, authContext } },
		);
		const withChecks = "status" in runs ? [summary] : attachChecks([summary], runs.runs);
		return {
			...withChecks[0],
			review,
			body: raw.body ?? "", // whole (#898): GitHub caps a body at 65,536 itself
			additions: typeof raw.additions === "number" ? raw.additions : 0,
			deletions: typeof raw.deletions === "number" ? raw.deletions : 0,
			changedFiles: typeof raw.changed_files === "number" ? raw.changed_files : 0,
		};
	} catch {
		return null;
	}
}

/** One changed file of a PR, as `github_read_pull files:true` returns it (#954). */
export interface PullFile {
	filename: string;
	status: string;
	previousFilename?: string;
	additions: number;
	deletions: number;
	/** The unified diff, or the part of it this page carries — see `patchFrom`/`patchLength`. */
	patch: string | null;
	/** Where in the file's whole diff `patch` starts, when it is not the whole of it. */
	patchFrom?: number;
	/** The whole diff's length, when `patch` is only part of it. */
	patchLength?: number;
	/** Why there is no diff — GitHub sends none for a binary file or one too large for it to render. */
	note?: string;
}

export interface PullFilesPage {
	number: number;
	/** Every file the PR changes, as GitHub counts them. */
	changedFiles: number;
	files: PullFile[];
	hasMore: boolean;
	/** The literal arguments of the next call, or null on the last page. */
	next: { file: number; patch_offset: number } | null;
	/** GitHub lists at most 3,000 files of a PR; set when this one has more. */
	note?: string;
}

interface RawPullFile {
	filename?: string;
	status?: string;
	previous_filename?: string;
	additions?: number;
	deletions?: number;
	patch?: string;
}

const jsonLength = (text: string): number => JSON.stringify(text).length;

/** GitHub's own page size for `/pulls/:n/files`, and the most files that endpoint will ever list. */
const FILES_PER_PAGE = 100;
const FILES_ENDPOINT_MAX = 3_000;

/**
 * The PR's diff, a page at a time (#954, #898 T15). Paged by a cursor — `file` (0-based index into
 * the PR's changed files) and `patchOffset` (into that file's diff) — under a CHARACTER budget, so
 * a page fits a tool result whole. Every file on a page is whole except when a single diff is larger
 * than the budget by itself: then the page is that slice of it, and `next` continues it. Nothing is
 * cut without the cursor that reaches the rest. `null` when the PR cannot be read.
 */
export async function readPullFiles(
	env: Env,
	userId: string,
	githubRepo: string,
	number: number,
	opts: { file?: number; patchOffset?: number; budget: number },
): Promise<PullFilesPage | null> {
	const parsed = parseRepo(githubRepo);
	if (!parsed || !Number.isFinite(number)) return null;
	try {
		const { token, authContext } = await resolveGithubRead(env, userId, parsed.owner);
		const ctx: ReadCtx = { env, userId, owner: parsed.owner, name: parsed.name, token, authContext };
		const raw = await fetchPullRaw(ctx, number);
		if (!raw) return null;
		const changedFiles = typeof raw.changed_files === "number" ? raw.changed_files : 0;
		const listed = Math.min(changedFiles, FILES_ENDPOINT_MAX);
		let index = Math.max(0, Math.trunc(opts.file ?? 0));
		let offset = Math.max(0, Math.trunc(opts.patchOffset ?? 0));
		const files: PullFile[] = [];
		let used = 0;
		let ghPage: RawPullFile[] = [];
		let ghPageNo = 0;
		while (index < listed) {
			const wantPage = Math.floor(index / FILES_PER_PAGE) + 1;
			if (wantPage !== ghPageNo) {
				const res = await githubConditionalJson<RawPullFile[]>(env, {
					identity: { userId, authContext },
					repo: `${parsed.owner}/${parsed.name}`,
					resource: "pull-files",
					variant: `${number}:p${wantPage}`,
					url: `https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.name)}/pulls/${number}/files?per_page=${FILES_PER_PAGE}&page=${wantPage}`,
					headers: GH_HEADERS(token),
				});
				if (!res.ok || !Array.isArray(res.data)) return null;
				ghPage = res.data;
				ghPageNo = wantPage;
			}
			const f = ghPage[index % FILES_PER_PAGE];
			if (!f) break; // GitHub listed fewer than it counted — stop where the list stops
			const whole = typeof f.patch === "string" ? f.patch : null;
			const base: PullFile = {
				filename: f.filename ?? "",
				status: f.status ?? "",
				...(f.previous_filename ? { previousFilename: f.previous_filename } : {}),
				additions: f.additions ?? 0,
				deletions: f.deletions ?? 0,
				patch: null,
			};
			if (whole === null) {
				files.push({ ...base, note: "GitHub sends no diff for this file — it is binary, or too large for GitHub to render one." });
				used += base.filename.length + 120;
				index++;
				offset = 0;
				continue;
			}
			// Measured as JSON — the reply is JSON, and escaping is what would push a page over the cap.
			// …plus the entry's own fields, so what is checked is what is then spent.
			const cost = jsonLength(whole) + base.filename.length + 120;
			// A whole file fits — or, as the first thing on the page, it is sliced rather than skipped.
			if (offset === 0 && used + cost <= opts.budget) {
				files.push({ ...base, patch: whole });
				used += cost;
				index++;
				continue;
			}
			if (files.length > 0) break; // the next file starts the next page, whole if it can
			const room = Math.max(1_000, opts.budget - used);
			let end = Math.min(whole.length, offset + room);
			// Shrink until the ESCAPED slice fits, then end it on a line so no diff line spans two pages.
			for (let cost = jsonLength(whole.slice(offset, end)); cost > room && end - offset > 1_000; cost = jsonLength(whole.slice(offset, end))) {
				end = offset + Math.max(1_000, Math.floor(((end - offset) * room) / cost));
			}
			if (end < whole.length) {
				const nl = whole.lastIndexOf("\n", end - 1);
				if (nl > offset) end = nl + 1;
			}
			files.push({ ...base, patch: whole.slice(offset, end), patchFrom: offset, patchLength: whole.length });
			if (end < whole.length) return page(files, { file: index, patch_offset: end });
			index++;
			break;
		}
		return page(files, index < listed ? { file: index, patch_offset: 0 } : null);

		function page(out: PullFile[], next: PullFilesPage["next"]): PullFilesPage {
			return {
				number,
				changedFiles,
				files: out,
				hasMore: next !== null,
				next,
				...(changedFiles > FILES_ENDPOINT_MAX
					? { note: `This PR changes ${changedFiles.toLocaleString("en-US")} files; GitHub lists only the first ${FILES_ENDPOINT_MAX.toLocaleString("en-US")}, so the rest cannot be read here.` }
					: {}),
			};
		}
	} catch {
		return null;
	}
}
