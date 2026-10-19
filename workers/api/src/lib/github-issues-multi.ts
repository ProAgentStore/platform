/**
 * `github_list_issues` across several repositories in one call (#1240) — a coder's repos, or every
 * repo across the owner's coding instances — without a new tool.
 *
 * Batched through GitHub's issue SEARCH (`repo:a repo:b …`), not one listing per repo: the search API
 * is the one endpoint that takes several repos and every filter (`-label:`, `assignee:`, `updated:`)
 * at once, and it sorts by update for us. One search per OWNER, because a GitHub App installation
 * token is per account, and each owner's repos split into batches whose query stays under GitHub's
 * 256-character limit.
 *
 * A failure is ONE repo's, never the call's. GitHub refuses a whole search when any `repo:` in it
 * cannot be seen (422 "cannot be searched"), so a refused batch is retried one repo at a time: the
 * repos that answer are kept, and each that does not is reported under `failures` with GitHub's reason.
 * The per-repo retry is a one-repo SEARCH, not the REST listing, so its filters mean the same thing.
 */
import { fetchGithubSearch, type IssueSummary, type RawIssue, toSummary } from "./github-issues.js";

/** GitHub's cap on a search query's length. */
export const SEARCH_QUERY_MAX = 256;
/** Repos one multi-repo call reads, at most — a bound on search calls (30/min), said in the reply when hit. */
export const MULTI_REPO_MAX = 60;
/** Issues one batch contributes, at most: GitHub search pages are 100, and paging past 1000 is refused. */
const BATCH_ITEMS_MAX = 300;

export interface MultiRepoFilters {
	state?: "open" | "closed" | "all";
	labels?: string[];
	excludeLabels?: string[];
	assignee?: string;
	updatedSince?: string;
	search?: string;
	page?: number;
	perPage?: number;
}

export type MultiRepoIssue = IssueSummary & { repo: string };

export interface MultiRepoResult {
	issues: MultiRepoIssue[];
	/** Every match across the repos that answered, as GitHub counted it. */
	total_count: number;
	/** Matches per repo among the issues read. `counts_complete: false` when a batch had more than it read. */
	per_repo_counts: Record<string, number>;
	counts_complete: boolean;
	failures: Array<{ repo: string; error: string }>;
	repos: string[];
	/** Repos left out because the call named more than {@link MULTI_REPO_MAX}. */
	repos_not_read: string[];
	page: number;
	per_page: number;
	hasMore: boolean;
	nextPage: number | null;
}

/** A token for one owner's repos, or why there is none — the same grant check the single-repo tool makes. */
export type OwnerToken = (owner: string, sampleRepo: string) => Promise<{ token: string | null } | { error: string }>;

const REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const quoted = (v: string) => (/^[\w.-]+$/.test(v) ? v : `"${v.replace(/"/g, "")}"`);
/** "owner/name" from an issue's html_url (https://github.com/owner/name/issues/N). */
const repoOfUrl = (url: string) => /github\.com\/([^/]+\/[^/]+)\/issues\//.exec(url)?.[1] ?? "";

/** The filter qualifiers every batch shares — everything but its `repo:` terms. */
export function sharedQualifiers(f: MultiRepoFilters): string[] {
	const state = f.state ?? "open";
	const out = ["is:issue"];
	if (state !== "all") out.push(`state:${state}`);
	for (const l of f.labels ?? []) out.push(`label:${quoted(l)}`);
	for (const l of f.excludeLabels ?? []) out.push(`-label:${quoted(l)}`);
	if (f.assignee) out.push(f.assignee.toLowerCase() === "none" ? "no:assignee" : `assignee:${f.assignee}`);
	if (f.updatedSince) out.push(`updated:>=${f.updatedSince}`);
	if (f.search?.trim()) out.push(f.search.trim());
	return out;
}

/** Split one owner's repos into queries that each stay within {@link SEARCH_QUERY_MAX}. */
export function batchQueries(repos: string[], shared: string[]): Array<{ repos: string[]; q: string }> {
	const tail = shared.join(" ");
	const batches: Array<{ repos: string[]; q: string }> = [];
	let current: string[] = [];
	const q = (rs: string[]) => [...rs.map((r) => `repo:${r}`), tail].join(" ");
	for (const r of repos) {
		if (current.length && q([...current, r]).length > SEARCH_QUERY_MAX) {
			batches.push({ repos: current, q: q(current) });
			current = [];
		}
		current.push(r);
	}
	if (current.length) batches.push({ repos: current, q: q(current) });
	return batches;
}

/** Read up to `want` matches of one query, a search page (100) at a time. */
async function readBatch(q: string, token: string | null, want: number): Promise<{ total: number; items: RawIssue[] } | { error: string }> {
	const items: RawIssue[] = [];
	let total = 0;
	for (let page = 1; items.length < want; page++) {
		const found = await fetchGithubSearch<RawIssue>(q, token, 100, page);
		if ("error" in found) return page === 1 ? found : { total, items };
		total = found.total_count;
		items.push(...found.items);
		if (found.items.length < 100 || items.length >= total) break;
	}
	return { total, items };
}

/**
 * List issues across `repos` (each "owner/name"), merged newest-updated first and paged. Never throws
 * for one repo: a repo that is malformed, ungranted, missing or refused is a `failures` row.
 */
export async function listIssuesMultiRepo(repos: string[], filters: MultiRepoFilters, tokenFor: OwnerToken): Promise<MultiRepoResult> {
	const page = Math.max(1, Math.trunc(filters.page ?? 1) || 1);
	const perPage = Math.min(Math.max(Math.trunc(filters.perPage ?? 30) || 30, 1), 100);
	const failures: MultiRepoResult["failures"] = [];
	const seen = new Set<string>();
	const unique: string[] = [];
	for (const raw of repos) {
		const r = raw.trim();
		if (!r) continue;
		if (!REPO.test(r)) {
			failures.push({ repo: r, error: 'not an "owner/name" repository' });
			continue;
		}
		if (seen.has(r.toLowerCase())) continue;
		seen.add(r.toLowerCase());
		unique.push(r);
	}
	// Past the cap a repo is not read, and the reply names it under `repos_not_read` — never a silent cut.
	const read = unique.filter((_, i) => i < MULTI_REPO_MAX);
	const notRead = unique.filter((_, i) => i >= MULTI_REPO_MAX);
	const want = Math.min(page * perPage, BATCH_ITEMS_MAX);
	const shared = sharedQualifiers(filters);

	const byOwner = new Map<string, string[]>();
	for (const r of read) {
		const owner = r.split("/")[0].toLowerCase();
		byOwner.set(owner, [...(byOwner.get(owner) ?? []), r]);
	}

	const issues = new Map<string, MultiRepoIssue>();
	let total = 0;
	let complete = true;
	const answered: string[] = [];
	const take = (found: { total: number; items: RawIssue[] }, batch: string[]) => {
		total += found.total;
		if (found.items.length < found.total) complete = false;
		answered.push(...batch);
		for (const raw of found.items) {
			if (raw.pull_request) continue;
			const repo = repoOfUrl(raw.html_url) || batch[0];
			issues.set(raw.html_url, { ...toSummary(raw), repo });
		}
	};

	for (const [, ownerRepos] of byOwner) {
		const auth = await tokenFor(ownerRepos[0].split("/")[0], ownerRepos[0]);
		if ("error" in auth) {
			for (const r of ownerRepos) failures.push({ repo: r, error: auth.error });
			continue;
		}
		for (const batch of batchQueries(ownerRepos, shared)) {
			const found = await readBatch(batch.q, auth.token, want);
			if (!("error" in found)) {
				take(found, batch.repos);
				continue;
			}
			// One unreadable repo refuses the whole batch: retry each alone, so the rest are kept.
			if (batch.repos.length === 1) {
				failures.push({ repo: batch.repos[0], error: found.error });
				continue;
			}
			for (const r of batch.repos) {
				const one = await readBatch(batchQueries([r], shared)[0].q, auth.token, want);
				if ("error" in one) failures.push({ repo: r, error: one.error });
				else take(one, [r]);
			}
		}
	}

	const merged = [...issues.values()].sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || "") || a.repo.localeCompare(b.repo) || b.number - a.number);
	const perRepo: Record<string, number> = {};
	for (const r of answered) perRepo[r] = 0;
	for (const i of merged) perRepo[i.repo] = (perRepo[i.repo] ?? 0) + 1;
	const start = (page - 1) * perPage;
	const hasMore = start + perPage < merged.length || (!complete && start + perPage >= merged.length && merged.length < total);
	return {
		issues: merged.slice(start, start + perPage),
		total_count: total,
		per_repo_counts: perRepo,
		counts_complete: complete,
		failures,
		repos: read,
		repos_not_read: notRead,
		page,
		per_page: perPage,
		hasMore,
		nextPage: hasMore ? page + 1 : null,
	};
}
