/**
 * Bounded, typed GitHub reads for release-note evidence (#1349).
 *
 * Two reads decide whether a production note may post, and both are paged by GitHub:
 *   • the workflow runs of one commit (`actions/runs?head_sha=`), 100 per page;
 *   • the runner-recorded `base...head` compare, 50 commits per page.
 * Neither may be judged from the first page, and a partial answer is never "success". So each read
 * here follows every page up to an explicit bound, validates what it got, and answers one of three
 * things: the complete evidence, a TRANSIENT failure (rate limit, 5xx, network: try again on a later
 * tick, the row stays as it is), or a PERMANENT one (over the bound, inconsistent or malformed
 * evidence, a refusal: hold the row with a typed code the owner can read).
 *
 * Bounds, deliberately explicit:
 *   workflow runs   at most {@link WORKFLOW_PAGES_MAX} pages of {@link WORKFLOW_PER_PAGE} = 1,000 runs
 *   commit range    at most {@link COMPARE_COMMITS_MAX} commits, read {@link COMPARE_PER_PAGE} per page
 */
import { resolveGithubRead } from "./github-cache.js";
import { safeFetch } from "./ssrf.js";
import type { Env } from "../types.js";

/** The 7-character abbreviation a message uses for a commit (a label; the full SHA is always the value compared). */
export const shortSha = (sha: string) => sha.slice(0, 7);

export const WORKFLOW_PER_PAGE = 100;
export const WORKFLOW_PAGES_MAX = 10;
export const COMPARE_PER_PAGE = 50;
export const COMPARE_COMMITS_MAX = 250;

/** Why a row is held for good. The code is stored (`release_note_queue.hold_code`) and shown to the owner. */
export type HoldCode =
	| "workflow_runs_over_limit"
	| "workflow_runs_incomplete"
	| "commit_range_over_limit"
	| "commit_range_inconsistent"
	| "commit_range_wrong_head"
	| "default_branch_mismatch"
	| "github_refused"
	| "pr_merge_auto"
	| "pr_merge_old_runner"
	| "pr_merge_unverified"
	| "pr_range_not_contiguous";

export type GithubPage = { ok: true; body: unknown; next: string | null } | { ok: false; kind: "transient" | "permanent"; status: number; message: string };
/** GET a GitHub REST path (`/repos/…`), classified. Injected in tests. */
export type PageFetcher = (path: string) => Promise<GithubPage>;
export type Evidence<T> = { ok: true; value: T } | { ok: false; kind: "transient"; message: string } | { ok: false; kind: "permanent"; code: HoldCode; message: string };

/** The URL GitHub names as the next page in a `Link` header, if any. */
export function nextLink(header: string | null): string | null {
	for (const part of (header ?? "").split(",")) {
		const hit = /<([^>]+)>\s*;\s*rel="?next"?/.exec(part.trim());
		if (hit) return hit[1];
	}
	return null;
}

/**
 * Rate limits and server trouble clear by themselves; a 404, a 422 or a refused credential does not.
 * A 403 is a rate limit only when GitHub says so (`x-ratelimit-remaining: 0` or `retry-after`).
 */
export function classifyStatus(status: number, headers: Pick<Headers, "get">): "transient" | "permanent" {
	if (status === 408 || status === 429 || status >= 500) return "transient";
	if (status === 403 && (headers.get("x-ratelimit-remaining") === "0" || headers.get("retry-after") !== null)) return "transient";
	return "permanent";
}

/** The live fetcher: the owner's own GitHub read credential (no new one), through the SSRF-guarded fetch. */
export function liveFetcher(env: Env, userId: string, owner: string): PageFetcher {
	let token: Promise<string | null> | undefined;
	return async (path) => {
		token ??= resolveGithubRead(env, userId, owner).then((r) => r.token, () => null);
		const t = await token;
		let res: Response;
		try {
			res = await safeFetch(`https://api.github.com${path}`, { headers: { Accept: "application/vnd.github+json", "User-Agent": "ProAgentStore", ...(t ? { Authorization: `Bearer ${t}` } : {}) } });
		} catch (e) {
			return { ok: false, kind: "transient", status: 0, message: `GitHub could not be reached (${e instanceof Error ? e.message : String(e)})` };
		}
		if (!res.ok) return { ok: false, kind: classifyStatus(res.status, res.headers), status: res.status, message: `GitHub answered ${res.status}` };
		try {
			return { ok: true, body: await res.json(), next: nextLink(res.headers.get("link")) };
		} catch {
			return { ok: false, kind: "permanent", status: res.status, message: "GitHub returned a body that is not JSON" };
		}
	};
}

const failure = (r: Extract<GithubPage, { ok: false }>, what: string): Evidence<never> =>
	r.kind === "transient" ? { ok: false, kind: "transient", message: `${what}: ${r.message}; will retry` } : { ok: false, kind: "permanent", code: "github_refused", message: `${what}: ${r.message}` };

export type WorkflowRun = { id?: number; path?: string; name?: string; head_sha?: string; head_branch?: string; status?: string; conclusion?: string | null; updated_at?: string; run_attempt?: number; html_url?: string };

/**
 * Every workflow run GitHub reports for the commit, across pages. The caller then filters by branch and path and
 * picks the latest attempt per workflow, so a newer failed rerun on page 3 still beats a success on page 1.
 */
export async function collectWorkflowRuns(fetchPage: PageFetcher, repo: string, sha: string): Promise<Evidence<WorkflowRun[]>> {
	const runs = new Map<number, WorkflowRun>();
	let total = 0;
	for (let page = 1; ; page++) {
		if (page > WORKFLOW_PAGES_MAX) {
			return { ok: false, kind: "permanent", code: "workflow_runs_over_limit", message: `${shortSha(sha)} has more than ${WORKFLOW_PAGES_MAX * WORKFLOW_PER_PAGE} workflow runs, more than can be read to prove every required workflow, so the note is held` };
		}
		const r = await fetchPage(`/repos/${repo}/actions/runs?head_sha=${encodeURIComponent(sha)}&per_page=${WORKFLOW_PER_PAGE}&page=${page}`);
		if (!r.ok) return failure(r, "The workflow runs could not be read");
		const body = r.body as { workflow_runs?: unknown; total_count?: unknown } | null;
		if (!body || !Array.isArray(body.workflow_runs) || !Number.isSafeInteger(body.total_count) || (body.total_count as number) < 0) {
			return { ok: false, kind: "permanent", code: "workflow_runs_incomplete", message: "GitHub returned a workflow run list without its run list or total, so completeness cannot be shown" };
		}
		total = body.total_count as number; // runs can start while we read; the latest total is the one to reach
		for (const run of body.workflow_runs as WorkflowRun[]) if (Number.isSafeInteger(run?.id)) runs.set(run.id as number, run);
		const last = body.workflow_runs.length < WORKFLOW_PER_PAGE;
		if (last || (!r.next && runs.size >= total)) break;
	}
	if (runs.size < total) {
		return { ok: false, kind: "permanent", code: "workflow_runs_incomplete", message: `GitHub reports ${total} workflow runs for this commit but only ${runs.size} could be read, so completeness cannot be shown` };
	}
	return { ok: true, value: [...runs.values()] };
}

export interface RangeCommit { sha: string; message: string; parents: string[] }
export interface CommitRange { baseSha: string; total: number; /** Oldest first, exactly as GitHub lists them. */ commits: RangeCommit[] }

const FULL_SHA = /^[0-9a-f]{40}$/i;
const hasPrefix = (sha: string, prefix: string) => sha.toLowerCase().startsWith(prefix.toLowerCase());

/**
 * The runner-recorded `base...head` range, every page, verified. `head` and `base` are the prefixes git printed;
 * the branch's current HEAD is never substituted. Anything short of a complete, consistent, ordered range that ends
 * at the pushed head is permanent and holds.
 */
export async function collectCommitRange(fetchPage: PageFetcher, repo: string, base: string, head: string): Promise<Evidence<CommitRange>> {
	const bad = (message: string, code: HoldCode = "commit_range_inconsistent"): Evidence<never> => ({ ok: false, kind: "permanent", code, message: `The commit range ${base}...${head} ${message}` });
	const commits: RangeCommit[] = [];
	const seen = new Set<string>();
	let meta: { status: string; baseSha: string; total: number } | null = null;
	for (let page = 1; ; page++) {
		const r = await fetchPage(`/repos/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?per_page=${COMPARE_PER_PAGE}&page=${page}`);
		if (!r.ok) return failure(r, "The commit range could not be read");
		const body = r.body as { status?: unknown; base_commit?: { sha?: unknown }; total_commits?: unknown; commits?: unknown } | null;
		const total = body?.total_commits;
		const baseSha = body?.base_commit?.sha;
		if (!body || typeof body.status !== "string" || typeof baseSha !== "string" || !FULL_SHA.test(baseSha) || !hasPrefix(baseSha, base) || !Number.isSafeInteger(total) || (total as number) < 1 || !Array.isArray(body.commits)) {
			return bad("came back malformed (missing status, base commit, total or commit list)");
		}
		if (!meta) {
			if (body.status !== "ahead") return bad(`is not a fast-forward of the base (GitHub says "${body.status}")`);
			if ((total as number) > COMPARE_COMMITS_MAX) return bad(`has ${total} commits, more than the ${COMPARE_COMMITS_MAX} that can be verified, so the note is held`, "commit_range_over_limit");
			meta = { status: body.status, baseSha, total: total as number };
		} else if (body.status !== meta.status || baseSha !== meta.baseSha || total !== meta.total) {
			return bad(`changed between pages (status, base commit or total moved on page ${page})`);
		}
		const expected = Math.min(COMPARE_PER_PAGE, meta.total - (page - 1) * COMPARE_PER_PAGE);
		if (body.commits.length !== expected) return bad(`page ${page} has ${body.commits.length} commits where ${expected} were expected, so a page is missing or short`);
		for (const raw of body.commits as Array<{ sha?: unknown; commit?: { message?: unknown }; parents?: unknown }>) {
			const parents = Array.isArray(raw?.parents) ? raw.parents.map((p: { sha?: unknown }) => p?.sha) : null;
			if (typeof raw?.sha !== "string" || !FULL_SHA.test(raw.sha) || typeof raw.commit?.message !== "string" || !raw.commit.message.trim() || !parents || parents.some((p) => typeof p !== "string" || !FULL_SHA.test(p))) {
				return bad("contains a commit without a full SHA, a message or its parents");
			}
			const sha = raw.sha.toLowerCase();
			if (seen.has(sha)) return bad(`lists commit ${shortSha(sha)} twice`);
			seen.add(sha);
			commits.push({ sha, message: raw.commit.message, parents: (parents as string[]).map((p) => p.toLowerCase()) });
		}
		if (commits.length >= meta.total) break;
	}
	if (!meta || commits.length !== meta.total) return bad("did not yield every commit GitHub reports");
	const final = commits[commits.length - 1];
	if (!hasPrefix(final.sha, head)) return bad(`ends at ${shortSha(final.sha)}, not at the pushed head`, "commit_range_wrong_head");
	// A commit may not precede one of its own in-range parents; and the range must attach to the pushed base.
	const position = new Map(commits.map((c, i) => [c.sha, i]));
	for (const [i, c] of commits.entries()) {
		for (const p of c.parents) {
			const at = position.get(p);
			if (at !== undefined && at >= i) return bad(`lists commit ${shortSha(c.sha)} before its parent ${shortSha(p)}, so the order cannot be trusted`);
		}
	}
	if (!commits.some((c) => c.parents.includes(meta.baseSha.toLowerCase()))) return bad("never reaches the pushed base commit");
	return { ok: true, value: { baseSha: meta.baseSha.toLowerCase(), total: meta.total, commits } };
}
