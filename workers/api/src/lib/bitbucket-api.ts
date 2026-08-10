/**
 * Read-only Bitbucket Cloud access — issues and pipelines — for the Coder's Issues and Builds
 * surfaces (#221, phase 4).
 *
 * ── What this is NOT
 *
 * It is not a generalisation of `github-issues.ts` / `gitlab-api.ts`. Each of the three answers
 * the same QUESTIONS against a different API, and `hosted-repo.ts` is the one place that decides
 * which of them a repo gets. The seam is the OUTPUT type (`IssueSummary` / `IssueDetail` /
 * `BuildRun`), exactly as `git-providers.ts` argues for the clone credential: GitHub's grant model
 * does not survive being made the interface, but its RESULT does. Nothing in this file touches
 * `installationTokenForOwner`, and nothing in the GitHub path changes because this file exists.
 *
 * ── The credential: an ACCESS TOKEN, and why that unblocks what was deferred
 *
 * #221 recorded Bitbucket as blocked on its credential, and the reasoning was right about the
 * credential it named: an **app password** is a username AND a secret, the vault is keyed
 * `(user, provider)` and holds ONE opaque value, so wiring an app password to it would 401 on
 * every private request while looking configured.
 *
 * The unblock is that an app password is not the only single-user credential Bitbucket issues.
 * A **Repository / Project / Workspace Access Token** is one opaque string: `Authorization:
 * Bearer <token>` on the API, and `x-token-auth:<token>@bitbucket.org` in an https clone URL —
 * which is exactly the `gitUsername` the provider table already declared. That fits the vault's
 * shape without stretching it, so PAGS supports access tokens and NOT app passwords. This is a
 * deliberate narrowing, stated in `routes/keys.ts` where the token is pasted: an app password
 * cannot be made to work through a one-value slot, and Atlassian is removing them anyway.
 *
 * With no token we still ask, UNauthenticated — a public repo's issues and pipelines are readable
 * without credentials, which is the same "public repos just work" behaviour both other providers
 * have. Every function degrades to `[]`/`null` rather than throwing.
 *
 * ── Four mappings that are decisions, verified against the live public API
 *
 * 1. ISSUE NUMBER is `id`. Unlike GitLab — where `id` is a global counter and `iid` the
 *    per-project one — a Bitbucket issue's `id` IS the number in `#72` and in its web URL. The
 *    two providers therefore disagree about what `id` means, which is why neither client is
 *    parameterised over the other.
 *
 * 2. THERE IS NO COMMENT COUNT. `links.comments` is a URL, not a number, and the list payload
 *    carries no count at all (verified live: an issue's keys are assignee, component, content,
 *    created_on, edited_on, id, kind, links, milestone, priority, reporter, repository, state,
 *    title, type, updated_on, version, votes, watches). So `comments` is 0 — "unknown", not
 *    "none". Fetching the link per issue would be an N+1 against a rate-limited API to populate
 *    a number the panel shows in grey.
 *
 * 3. THERE ARE NO LABELS. Bitbucket has `kind` (bug/enhancement/proposal/task) and `priority`
 *    (trivial…blocker), which are what a human sees as an issue's tags. They are surfaced AS
 *    labels, and a caller's `labels` filter is applied to that same synthesized list — in
 *    process, not as a `q` clause. Client-side is the honest half: it keeps the request URL built
 *    only from a closed state enum (the property `gitlab-api.ts` prizes — no caller-supplied
 *    field can move where an authenticated request goes), and it makes the labels a reader sees
 *    and the labels a filter matches provably the same vocabulary.
 *
 * 4. A PIPELINE HAS NO WEB URL. Verified live: `links` carries only `self` and `steps`, both
 *    UUID-form API URLs — there is no `links.html` at all. So the browser URL is CONSTRUCTED from
 *    the slug and `build_number`. This is the load-bearing one: transcribing `links.html.href`
 *    the way the other two clients do would have put an empty string in every Builds row, and
 *    every "open the build" link on this provider would have been dead. (`.../pipelines/results/5`
 *    on the probed repo returns 200.)
 *
 * And, as on GitLab, the pipeline's single state is WIDENED into GitHub's `(status, conclusion)`
 * pair rather than teaching the console a third vocabulary.
 */
import { readConnectorRefreshToken } from "./connector-oauth.js";
import type { BuildRun } from "./build-history.js";
import type { IssueDetail, IssueSummary, ListIssuesOpts } from "./github-issues.js";
import type { Env } from "../types.js";

/**
 * Fixed. `git-providers.ts` resolves any OTHER host — Bitbucket Server / Data Center included —
 * to provider `other`, which declares no hosted support and therefore never reaches this module.
 * That is what keeps these URLs constants: there is no request field on this path that can move
 * where an authenticated read is sent.
 */
const API_BASE = "https://api.bitbucket.org/2.0";
const WEB_BASE = "https://bitbucket.org";

/** Same cap the other two readers apply, for the same reason: a body goes into a model prompt. */
const BODY_CAP = 8 * 1024;

/**
 * A Bitbucket workspace / repository slug segment. Validating the charset here is defence in
 * depth, matching `github-issues.ts` and `gitlab-api.ts`: the segments are interpolated into an
 * authenticated URL, and a charset check means no crafted value can smuggle a query or an extra
 * path segment into it whatever a caller did upstream.
 */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * `workspace/repo` → the two URL-safe path segments Bitbucket's API takes, or null.
 *
 * Exactly two, unlike GitLab: Bitbucket namespaces do not nest, so a third segment is a browser
 * path that got kept, not a subgroup — and `git-providers.ts` already slices those off for any
 * provider without `nestedNamespaces`.
 */
export function bitbucketRepoPath(slug: string): { workspace: string; repo: string } | null {
	const segments = String(slug || "")
		.split("/")
		.filter(Boolean);
	if (segments.length !== 2) return null;
	if (!segments.every((s) => SEGMENT.test(s))) return null;
	return { workspace: encodeURIComponent(segments[0]), repo: encodeURIComponent(segments[1]) };
}

/**
 * The stored access token, or null. Never throws: an absent key is the ORDINARY state (a public
 * repo needs none), and `readConnectorRefreshToken` raises for both "no row" and "no KEK", which
 * mean the same thing to every caller here.
 */
async function bitbucketToken(env: Env, userId: string): Promise<string | null> {
	if (!userId) return null;
	return readConnectorRefreshToken(env, userId, "bitbucket", "Bitbucket").catch(() => null);
}

function headers(token: string | null): Record<string, string> {
	return {
		// `Bearer` is the scheme a Repository/Workspace/Project Access Token authenticates with —
		// NOT Basic, which is what an app password would need and is why app passwords are out.
		...(token ? { Authorization: `Bearer ${token}` } : {}),
		Accept: "application/json",
		"User-Agent": "proagentstore-coding/1.0",
	};
}

/**
 * One GET. Never throws; a non-OK response and a network error are both `null`.
 *
 * The status that matters most here is **410 Gone**, which is what Bitbucket answers when a
 * repository's issue tracker is switched OFF — the default for a new repo, and verified live. It
 * is not an error the owner can fix by re-authenticating, and it must degrade to "no issues"
 * rather than to a broken panel.
 */
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
	id?: number;
	title?: string;
	state?: string;
	kind?: string;
	priority?: string;
	updated_on?: string;
	links?: { html?: { href?: string } };
	content?: { raw?: string | null };
}

/**
 * Bitbucket's eight issue states → the two words every caller filters on.
 *
 * `new`, `open` and `on hold` are work still on the board; `resolved`, `closed`, `duplicate`,
 * `invalid` and `wontfix` are all ways of being done with it. Collapsing them to GitHub's
 * open/closed here — rather than teaching the console a third vocabulary — is what lets the
 * Issues panel render a Bitbucket repo with no console change at all.
 */
const CLOSED_STATES = ["resolved", "closed", "duplicate", "invalid", "wontfix"] as const;
const OPEN_STATES = ["new", "open", "on hold"] as const;

function normalizeState(state: string | undefined): string {
	return (CLOSED_STATES as readonly string[]).includes(String(state)) ? "closed" : "open";
}

/** `kind` + `priority` — the nearest thing Bitbucket has to a label (see the module header). */
function labelsOf(raw: RawIssue): string[] {
	return [raw.kind, raw.priority].filter((v): v is string => typeof v === "string" && v.length > 0);
}

function toSummary(raw: RawIssue): IssueSummary {
	return {
		number: typeof raw.id === "number" ? raw.id : 0,
		title: raw.title ?? "",
		state: normalizeState(raw.state),
		labels: labelsOf(raw),
		// No count exists in the payload. 0 means "unknown", and the alternative is an N+1.
		comments: 0,
		updatedAt: raw.updated_on ?? "",
		url: raw.links?.html?.href ?? "",
	};
}

/**
 * The `q` clause for a state filter, built ONLY from the closed enums above.
 *
 * `all` omits the filter entirely rather than naming every state — the same rule
 * `gitlab-api.ts` follows, and for a sharper reason here: Bitbucket answers a `q` it cannot
 * satisfy with **200 and an empty list**, not a 400, so a query built wrong would look exactly
 * like a repo with no issues. Deriving it from the enum is what makes that unreachable.
 *
 * `on hold` contains a space, and `URLSearchParams` writes a space as `+` rather than `%20`.
 * Whether an API's query parser accepts form encoding is a fact about that API, so it was checked
 * against the live one: both forms return the identical 200 and the identical rows.
 */
function stateQuery(state: "open" | "closed" | "all"): string | null {
	if (state === "all") return null;
	const wanted = state === "closed" ? CLOSED_STATES : OPEN_STATES;
	return `(${wanted.map((s) => `state="${s}"`).join(" OR ")})`;
}

/** List a repo's issues. `[]` on any failure — no tracker (410), private repo, Bitbucket error. */
export async function listBitbucketIssues(env: Env, userId: string, slug: string, opts: ListIssuesOpts = {}): Promise<IssueSummary[]> {
	const path = bitbucketRepoPath(slug);
	if (!path) return [];
	const pagelen = Math.min(Math.max(opts.limit ?? 30, 1), 100);
	const params = new URLSearchParams({ pagelen: String(pagelen), sort: "-updated_on" });
	const q = stateQuery(opts.state ?? "open");
	if (q) params.set("q", q);
	const data = await getJson<{ values?: RawIssue[] }>(`${API_BASE}/repositories/${path.workspace}/${path.repo}/issues?${params}`, await bitbucketToken(env, userId));
	if (!data || !Array.isArray(data.values)) return [];
	const issues = data.values.map(toSummary).filter((i) => i.number > 0);
	// The label filter runs against the SAME synthesized list a reader sees (module header, 3).
	const wanted = String(opts.labels ?? "")
		.split(",")
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);
	if (!wanted.length) return issues;
	return issues.filter((i) => i.labels.some((l) => wanted.includes(l.toLowerCase())));
}

/** Read one issue by the number a human sees. `null` when absent or unreadable. */
export async function readBitbucketIssue(env: Env, userId: string, slug: string, number: number): Promise<IssueDetail | null> {
	const path = bitbucketRepoPath(slug);
	if (!path || !Number.isFinite(number) || number <= 0) return null;
	const raw = await getJson<RawIssue>(`${API_BASE}/repositories/${path.workspace}/${path.repo}/issues/${Math.floor(number)}`, await bitbucketToken(env, userId));
	if (!raw || typeof raw !== "object" || typeof raw.id !== "number") return null;
	return { ...toSummary(raw), body: (raw.content?.raw ?? "").slice(0, BODY_CAP) };
}

interface RawPipeline {
	build_number?: number;
	state?: { name?: string; result?: { name?: string } };
	trigger?: { name?: string };
	target?: { ref_name?: string; commit?: { hash?: string } };
	created_on?: string;
	completed_on?: string;
}

/**
 * Bitbucket's `state.name` (+ `state.result.name` when complete) → GitHub's `(status,
 * conclusion)` pair.
 *
 * Only `COMPLETED` carries a verdict, and the verdict lives one level down in `result.name`;
 * everything else is work that has not finished, and saying so with a null conclusion is what
 * stops the console painting a queued pipeline as a failure. `HALTED` is a pipeline waiting on a
 * manual step — the same situation GitLab calls `manual`, and it is mapped the same way here so
 * the two providers do not describe one state with two words. An unrecognised state (Bitbucket
 * adds them) degrades to "in progress, no verdict" rather than being asserted as a result.
 */
export function mapPipelineState(state: RawPipeline["state"]): { status: string; conclusion: string | null } {
	switch (state?.name) {
		case "PENDING":
			return { status: "queued", conclusion: null };
		case "HALTED":
		case "PAUSED":
			return { status: "completed", conclusion: "action_required" };
		case "COMPLETED":
			switch (state?.result?.name) {
				case "SUCCESSFUL":
					return { status: "completed", conclusion: "success" };
				case "FAILED":
				case "ERROR":
					return { status: "completed", conclusion: "failure" };
				case "STOPPED":
					return { status: "completed", conclusion: "cancelled" };
				default:
					// Completed with a result we do not recognise: the run IS over — saying otherwise
					// would leave a finished build spinning forever — but we will not name a verdict.
					return { status: "completed", conclusion: null };
			}
		default:
			return { status: "in_progress", conclusion: null };
	}
}

function toBuildRun(slug: string, raw: RawPipeline): BuildRun {
	const mapped = mapPipelineState(raw.state);
	const buildNumber = typeof raw.build_number === "number" ? raw.build_number : null;
	return {
		status: mapped.status,
		conclusion: mapped.conclusion,
		// Bitbucket pipelines are unnamed. `trigger.name` (`PUSH`, `MANUAL`, `SCHEDULE`,
		// `PULLREQUEST`) is the nearest true answer to "what ran this" — the direct analogue of
		// GitLab's `source` fallback — and an empty label in the Builds panel reads as a bug.
		name: raw.trigger?.name || "Pipeline",
		runNumber: buildNumber,
		// CONSTRUCTED, not transcribed: the payload has no `links.html` (module header, 4).
		url: buildNumber != null ? `${WEB_BASE}/${slug}/pipelines/results/${buildNumber}` : "",
		branch: typeof raw.target?.ref_name === "string" ? raw.target.ref_name : "",
		sha: typeof raw.target?.commit?.hash === "string" ? raw.target.commit.hash.slice(0, 7) : "",
		// A finished pipeline's `completed_on` is the timestamp the panel sorts on; a running one
		// has none yet, so its start is the only true "last we heard" there is.
		updatedAt: raw.completed_on || raw.created_on || "",
	};
}

/**
 * A page of a repo's pipelines, newest first. `null` — not `[]` — when the repo cannot be read at
 * all, because the Builds surface distinguishes "no pipelines yet" (an empty array, a true and
 * useful answer) from "we could not ask" (`available:false`).
 */
export async function listBitbucketPipelines(env: Env, userId: string, slug: string, opts: { perPage?: number; page?: number } = {}): Promise<BuildRun[] | null> {
	const path = bitbucketRepoPath(slug);
	if (!path) return null;
	const pagelen = Math.min(Math.max(opts.perPage ?? 1, 1), 100);
	const page = Math.max(opts.page ?? 1, 1);
	const params = new URLSearchParams({ pagelen: String(pagelen), page: String(page), sort: "-created_on" });
	const data = await getJson<{ values?: RawPipeline[] }>(`${API_BASE}/repositories/${path.workspace}/${path.repo}/pipelines?${params}`, await bitbucketToken(env, userId));
	if (!data || !Array.isArray(data.values)) return null;
	// The slug — not the encoded path — builds the web URL: `bitbucket.org/workspace/repo/...`
	// is what a browser needs, and the API's own percent-encoded UUID form is not a page.
	const clean = String(slug).split("/").filter(Boolean).join("/");
	return data.values.map((p) => toBuildRun(clean, p));
}
