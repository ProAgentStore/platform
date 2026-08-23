/**
 * Read-only Bitbucket Cloud PULL REQUESTS — the Coder's Pulls surface, on a third host (#221,
 * phase 4 completed).
 *
 * ── What this is NOT
 *
 * It is not a generalisation of `github-prs.ts` or of `gitlab-mrs.ts`. Each answers the same
 * QUESTIONS against a different API, and `hosted-repo.ts` is the one place that decides which a
 * repo gets. The seam is the OUTPUT type (`PullSummary` / `PullDetail` / `PullChecks` /
 * `ReviewState`), never an auth interface: `installationTokenForOwner` is untouched, and the
 * three providers disagree about too much to be parameterised over one another — Bitbucket's
 * `id` IS the number a human sees, GitLab's `id` is a global counter beside a per-project
 * `iid`, and GitHub's grant model is installation-scoped where both others are not.
 *
 * ── Auth
 *
 * The same vault access token `bitbucket-api.ts` reads (`user_api_keys` provider `bitbucket`),
 * sent as `Authorization: Bearer` — a Repository / Project / Workspace Access Token, not an app
 * password, for the reason that file records at length. And the same unauthenticated fallback: a
 * public repo's pull requests are readable with no credential, which is how every probe below
 * was taken.
 *
 * ── Five mappings that are decisions, each verified against the live public API
 *
 * Probed unauthenticated against `atlassian/fugue` with the exact URL shapes built below,
 * because nobody here has a Bitbucket account — the condition #221's deferral comment named,
 * which has not changed.
 *
 * 1. `state` IS NOT OPTIONAL THE WAY IT IS FOR ISSUES. This is the trap, and it is the exact
 *    inverse of the precedent next door: `bitbucket-api.ts` omits the filter for `all` because
 *    naming every issue state would be fragile. Omitting `state` HERE returns **OPEN ONLY** —
 *    verified: no `state` answered `size: 0` on a repo that holds 139 pull requests, while
 *    naming all four answered `size: 139`. Copying the issue client's rule would have shown
 *    every repo as having no closed pull requests, with a 200 and no error anywhere.
 *
 * 2. THERE IS NO MERGEABILITY. Nothing in the payload answers "does this merge" — Bitbucket
 *    computes it only when you POST a merge attempt. So `mergeable` is `null` and
 *    `mergeableState` is `"unknown"`, which the console's `mergeTone` already renders as no
 *    badge at all. That is the honest half: `false` means "GitHub says this conflicts", and a
 *    provider that was never asked must not borrow that word.
 *
 * 3. CHECKS come from `/pullrequests/:id/statuses`, one call per PR, so they exist only on
 *    ENRICHED rows. Bitbucket has no cross-PR run listing to correlate — the same shape
 *    `gitlab-mrs.ts` ends up with, and unlike GitHub where one workflow-runs page covers the
 *    whole list. Live, PR #139 returns one `{type:"build", state:"SUCCESSFUL", name, url}`.
 *
 * 4. REVIEW STATE comes from `participants[]` on the DETAIL endpoint — `{role:"REVIEWER",
 *    approved:false, state:null}` — because the LIST payload carries neither `participants` nor
 *    `reviewers`. Which is also why `reviewersRequested` is 0 until a row is enriched: 0 here
 *    means "not looked up", the same representation the sibling issue client uses for its
 *    missing comment count.
 *
 * 5. `source.commit.hash` IS TRUNCATED to 12 characters (`"e45f5964a8c2"`), where GitHub's
 *    `head.sha` is the full 40. It is recorded as given rather than padded or dropped: nothing
 *    on this provider matches a run by sha, so the short form costs nothing, and inventing the
 *    missing 28 characters is not available.
 *
 * What Bitbucket DOES have and its issue tracker does not is a real `comment_count` — live
 * values 9 and 3 on this endpoint — so unlike `bitbucket-api.ts`'s issues, `comments` here is a
 * count and not a stand-in for "unknown". Labels are the other way round: an issue has
 * `kind`/`priority` to stand in for them, a pull request has nothing at all, so `labels` is
 * genuinely empty.
 */
import { PULLS_ENRICH_CAP, PULLS_PAGE_SIZE, type ListPullsOpts, type PullChecks, type PullDetail, type PullSummary, type ReviewState } from "./github-prs.js";
import { bitbucketRepoPath } from "./bitbucket-api.js";
import { readConnectorRefreshToken } from "./connector-oauth.js";
import type { Env } from "../types.js";

/**
 * Fixed, for the reason `bitbucket-api.ts` states: Bitbucket Server / Data Center resolves to
 * provider `other`, declares no hosted support, and never reaches this module. No request field
 * on this path can move where an authenticated read is sent.
 */
const API_BASE = "https://api.bitbucket.org/2.0";

/** Same cap every reader on this seam applies: a body goes into a model prompt. */
const BODY_CAP = 8 * 1024;

/**
 * The stored access token, or null. A three-line read rather than an import because
 * `bitbucket-api.ts` keeps its own copy private; it is the identical call, and an absent key is
 * the ORDINARY state (a public repo needs none).
 */
async function bitbucketToken(env: Env, userId: string): Promise<string | null> {
	if (!userId) return null;
	return readConnectorRefreshToken(env, userId, "bitbucket", "Bitbucket").catch(() => null);
}

function headers(token: string | null): Record<string, string> {
	return {
		...(token ? { Authorization: `Bearer ${token}` } : {}),
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

interface RawUser {
	nickname?: string;
	display_name?: string;
}

interface RawParticipant {
	role?: string;
	approved?: boolean;
	state?: string | null;
	participated_on?: string | null;
}

interface RawPull {
	id?: number;
	title?: string;
	state?: string;
	draft?: boolean;
	comment_count?: number;
	created_on?: string;
	updated_on?: string;
	description?: string | null;
	author?: RawUser | null;
	source?: { branch?: { name?: string }; commit?: { hash?: string } } | null;
	destination?: { branch?: { name?: string } } | null;
	links?: { html?: { href?: string } };
	summary?: { raw?: string | null };
	reviewers?: unknown[];
	participants?: RawParticipant[];
}

interface RawStatus {
	type?: string;
	state?: string;
	name?: string;
	url?: string;
}

/** Bitbucket's four PR states → the two words every caller filters on. */
const OPEN_STATE = "OPEN";
const PR_STATES = ["OPEN", "MERGED", "DECLINED", "SUPERSEDED"] as const;

function normalizeState(state: string | undefined): string {
	return state === OPEN_STATE ? "open" : "closed";
}

/**
 * The one answer a row shows for "where is the review up to", from the detail's `participants`.
 *
 * Same precedence as `resolveReviewState` in `github-prs.ts`: `changes_requested` is the
 * BLOCKING state and outranks an approval, because a row reading "approved" while another
 * reviewer blocks would be read as ready to merge. `approved:true` and `state:"approved"` are
 * the same claim in two fields — Bitbucket sets both — so either counts. Pure.
 */
export function resolveBitbucketReviewState(participants: RawParticipant[] | null | undefined): ReviewState {
	if (!Array.isArray(participants) || participants.length === 0) return "none";
	const states = participants.map((p) => String(p?.state ?? ""));
	if (states.includes("changes_requested")) return "changes_requested";
	if (states.includes("approved") || participants.some((p) => p?.approved === true)) return "approved";
	// Bitbucket has no "commented" review, but it does record whether a participant ever engaged.
	// That is the same thing GitHub's COMMENTED conveys, and it is the honest read of the field.
	if (participants.some((p) => !!p?.participated_on)) return "commented";
	return "none";
}

/**
 * A commit build status → the two raw fields the console's `buildState()` already maps.
 *
 * `SUCCESSFUL` / `FAILED` / `STOPPED` are terminal and carry the verdict; anything else is work
 * that has not finished, and saying so with a null conclusion is what stops the console painting
 * an in-flight check as a failure. Deliberately its OWN table rather than a reuse of
 * `mapPipelineState`: that one reads `state.name` from a PIPELINE (`COMPLETED` + a nested
 * `result`), and this is the flat commit-status vocabulary — same provider, different enum, and
 * sharing them would only work until one of the two changed.
 */
export function mapCommitStatus(state: string | undefined): { status: string; conclusion: string | null } {
	switch (state) {
		case "SUCCESSFUL":
			return { status: "completed", conclusion: "success" };
		case "FAILED":
		case "ERROR":
			return { status: "completed", conclusion: "failure" };
		case "STOPPED":
			return { status: "completed", conclusion: "cancelled" };
		case "INPROGRESS":
			return { status: "in_progress", conclusion: null };
		default:
			return { status: "in_progress", conclusion: null };
	}
}

/**
 * Several statuses, one row. The status REPORTED is the one that decided the verdict.
 *
 * A PR can carry a green Pipelines build beside a red external check. `PullChecks` holds one
 * answer, so picking the first — or the newest — would let a failing check hide behind a passing
 * one. Failure outranks in-flight outranks cancelled outranks success, and the name and URL come
 * from the same status as the verdict so the link goes to what the label is talking about. Pure.
 */
export function aggregateStatuses(statuses: RawStatus[] | null | undefined): PullChecks | null {
	if (!Array.isArray(statuses) || statuses.length === 0) return null;
	const rank = (s: RawStatus) => {
		const m = mapCommitStatus(s.state);
		if (m.conclusion === "failure") return 0;
		if (m.status !== "completed") return 1;
		if (m.conclusion === "cancelled") return 2;
		return 3;
	};
	const chosen = statuses.reduce((best, s) => (rank(s) < rank(best) ? s : best), statuses[0]);
	const mapped = mapCommitStatus(chosen.state);
	return {
		status: mapped.status,
		conclusion: mapped.conclusion,
		url: typeof chosen.url === "string" ? chosen.url : undefined,
		name: typeof chosen.name === "string" ? chosen.name : undefined,
	};
}

/** Map a pull request onto the summary the console renders. Pure. */
export function toBitbucketPullSummary(raw: RawPull): PullSummary {
	return {
		// `id` IS the number in `#139` and in the web URL — the opposite of GitLab, where `id` is
		// a global counter and `iid` is the human one.
		number: typeof raw.id === "number" ? raw.id : 0,
		title: raw.title ?? "",
		state: normalizeState(raw.state),
		draft: raw.draft === true,
		merged: raw.state === "MERGED",
		// Bitbucket removed usernames; `nickname` is the closest stable handle, and
		// `display_name` is what the web UI shows when there is none.
		author: raw.author?.nickname || raw.author?.display_name || "",
		branch: raw.source?.branch?.name ?? "",
		baseBranch: raw.destination?.branch?.name ?? "",
		// TWELVE characters, not forty — recorded as given (module header, 5).
		headSha: typeof raw.source?.commit?.hash === "string" ? raw.source.commit.hash : "",
		// A pull request has no labels on this provider at all — not even the `kind`/`priority`
		// pair an ISSUE has. Empty is the true answer, not a placeholder.
		labels: [],
		// A REAL count here, unlike this provider's issues.
		comments: typeof raw.comment_count === "number" ? raw.comment_count : 0,
		createdAt: raw.created_on ?? "",
		updatedAt: raw.updated_on ?? "",
		url: raw.links?.html?.href ?? "",
		// Absent from the list payload; filled by enrichment (module header, 4).
		reviewersRequested: Array.isArray(raw.reviewers) ? raw.reviewers.length : 0,
		// Bitbucket never answers this (module header, 2).
		mergeable: null,
		mergeableState: "unknown",
		review: "unknown",
		checks: null,
	};
}

/** The Bitbucket `state` values a caller's `open` / `closed` / `all` becomes (module header, 1). */
export function statesFor(state: "open" | "closed" | "all"): string[] {
	if (state === "open") return [OPEN_STATE];
	if (state === "closed") return PR_STATES.filter((s) => s !== OPEN_STATE);
	return [...PR_STATES];
}

function listUrl(workspace: string, repo: string, states: string[], pagelen: number): string {
	const params = new URLSearchParams({ pagelen: String(pagelen), sort: "-updated_on" });
	// Repeated `state` is how this endpoint expresses a union — a single comma-joined value is
	// not accepted, and omitting it silently narrows to OPEN.
	for (const s of states) params.append("state", s);
	return `${API_BASE}/repositories/${workspace}/${repo}/pullrequests?${params}`;
}

async function fetchDetail(workspace: string, repo: string, id: number, token: string | null): Promise<RawPull | null> {
	return getJson<RawPull>(`${API_BASE}/repositories/${workspace}/${repo}/pullrequests/${id}`, token);
}

async function fetchChecks(workspace: string, repo: string, id: number, token: string | null): Promise<PullChecks | null> {
	const data = await getJson<{ values?: RawStatus[] }>(`${API_BASE}/repositories/${workspace}/${repo}/pullrequests/${id}/statuses?pagelen=20`, token);
	return aggregateStatuses(data?.values);
}

/**
 * A repo's pull requests, newest-activity first. `[]` on any failure — a private repo, a
 * malformed slug, a Bitbucket error, a network error.
 */
export async function listBitbucketPulls(env: Env, userId: string, slug: string, opts: ListPullsOpts = {}): Promise<PullSummary[]> {
	const path = bitbucketRepoPath(slug);
	if (!path) return [];
	const pagelen = Math.min(Math.max(opts.limit ?? PULLS_PAGE_SIZE, 1), 100);
	const token = await bitbucketToken(env, userId);
	const states = statesFor(opts.state ?? "open");
	// ONE request whatever the filter is — unlike GitLab, this endpoint takes the union directly.
	const data = await getJson<{ values?: RawPull[] }>(listUrl(path.workspace, path.repo, states, pagelen), token);
	if (!data || !Array.isArray(data.values)) return [];
	const pulls = data.values.map(toBitbucketPullSummary).filter((p) => p.number > 0);
	if (opts.enrich === false) return pulls;

	// Two extra requests each for the first N rows, matching GitHub's cap and its reason.
	const settled = await Promise.allSettled(
		pulls.slice(0, PULLS_ENRICH_CAP).map(async (p) => {
			const [detail, checks] = await Promise.all([fetchDetail(path.workspace, path.repo, p.number, token), fetchChecks(path.workspace, path.repo, p.number, token)]);
			return { number: p.number, detail, checks };
		}),
	);
	const byNumber = new Map<number, { detail: RawPull | null; checks: PullChecks | null }>();
	for (const s of settled) if (s.status === "fulfilled") byNumber.set(s.value.number, { detail: s.value.detail, checks: s.value.checks });
	return pulls.map((p) => {
		const extra = byNumber.get(p.number);
		if (!extra) return p;
		// A failed enrichment leaves the row's own honest "unknown"/0 rather than a fabricated one.
		return {
			...p,
			review: extra.detail ? resolveBitbucketReviewState(extra.detail.participants) : p.review,
			reviewersRequested: Array.isArray(extra.detail?.reviewers) ? extra.detail.reviewers.length : p.reviewersRequested,
			checks: extra.checks ?? p.checks,
		};
	});
}

/** One pull request in full — description, review state and checks. `null` when unreadable. */
export async function readBitbucketPull(env: Env, userId: string, slug: string, number: number): Promise<PullDetail | null> {
	const path = bitbucketRepoPath(slug);
	if (!path || !Number.isFinite(number) || number <= 0) return null;
	const token = await bitbucketToken(env, userId);
	const id = Math.floor(number);
	const raw = await fetchDetail(path.workspace, path.repo, id, token);
	if (!raw || typeof raw !== "object" || typeof raw.id !== "number") return null;
	const checks = await fetchChecks(path.workspace, path.repo, id, token);
	return {
		...toBitbucketPullSummary(raw),
		review: resolveBitbucketReviewState(raw.participants),
		checks,
		// `description` and `summary.raw` held the IDENTICAL text on every probed pull request;
		// `description` is the documented field, and the other is the fallback rather than a
		// second source of truth.
		body: (raw.description || raw.summary?.raw || "").slice(0, BODY_CAP),
		// The diff SIZE is not on this payload. `/diffstat` exists but paginates per FILE, so
		// totalling it is a page-walk for three numbers the panel greys out. 0 is "unknown" —
		// the representation this provider's issue client already uses for its absent count.
		additions: 0,
		deletions: 0,
		changedFiles: 0,
	};
}
