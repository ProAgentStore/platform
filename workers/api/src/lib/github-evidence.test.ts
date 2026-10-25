/**
 * #1349 — the two paged GitHub reads behind a production release note, driven with paginated GitHub fixtures.
 * What matters is behavior: complete evidence is returned; anything short of complete is either TRANSIENT (try
 * again later, nothing decided) or PERMANENT with a typed code. Nothing partial is ever returned as success.
 */
import { describe, expect, it } from "vitest";
import { classifyStatus, collectCommitRange, collectWorkflowRuns, COMPARE_COMMITS_MAX, nextLink, WORKFLOW_PAGES_MAX, type GithubPage, type PageFetcher } from "./github-evidence.js";

const REPO = "acme/app";
const BASE = "0".repeat(40);
/** A distinct full SHA per n whose first seven characters differ too (the runner records only a prefix). */
const hex = (n: number) => `${(n + 0x1000000).toString(16)}${"c".repeat(33)}`;

/** A linear history of `n` commits on top of BASE, oldest first, as GitHub's compare lists them. */
function chain(n: number, message = (i: number) => `feat: change ${i}`) {
	return Array.from({ length: n }, (_x, i) => ({ sha: hex(i + 1), commit: { message: message(i) }, parents: [{ sha: i === 0 ? BASE : hex(i) }] }));
}
type Commit = ReturnType<typeof chain>[number];
const page = (body: unknown, next: string | null = null): GithubPage => ({ ok: true, body, next });

/** GitHub's compare, paged 50 at a time, with knobs to corrupt exactly one thing. */
function compare(commits: Commit[], over: { total?: number; status?: string; base?: string; pages?: (p: number, items: Commit[]) => Commit[]; meta?: (p: number) => Record<string, unknown> } = {}) {
	const asked: number[] = [];
	const fetchPage: PageFetcher = async (path) => {
		if (!path.includes("/compare/")) return { ok: false, kind: "permanent", status: 404, message: "GitHub answered 404" };
		const p = Number(/[?&]page=(\d+)/.exec(path)?.[1] ?? 1);
		asked.push(p);
		const items = commits.slice((p - 1) * 50, p * 50);
		return page({ status: over.status ?? "ahead", base_commit: { sha: over.base ?? BASE }, total_commits: over.total ?? commits.length, commits: over.pages ? over.pages(p, items) : items, ...(over.meta?.(p) ?? {}) });
	};
	return { fetchPage, asked };
}
const head = (commits: Commit[]) => commits[commits.length - 1].sha;
const range = (f: PageFetcher, commits: Commit[], h = head(commits)) => collectCommitRange(f, REPO, "0000000", h.slice(0, 7));

describe("Link and status classification", () => {
	it("reads the next page from a Link header", () => {
		expect(nextLink('<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=9>; rel="last"')).toBe("https://api.github.com/x?page=2");
		expect(nextLink('<https://api.github.com/x?page=1>; rel="prev"')).toBeNull();
		expect(nextLink(null)).toBeNull();
	});
	it("treats rate limits and server errors as transient, and refusals as permanent", () => {
		const h = (v: Record<string, string> = {}) => ({ get: (k: string) => v[k.toLowerCase()] ?? null });
		for (const s of [408, 429, 500, 502, 503, 504]) expect(classifyStatus(s, h())).toBe("transient");
		expect(classifyStatus(403, h({ "x-ratelimit-remaining": "0" }))).toBe("transient");
		expect(classifyStatus(403, h({ "retry-after": "30" }))).toBe("transient");
		for (const s of [401, 403, 404, 410, 422]) expect(classifyStatus(s, h())).toBe("permanent");
	});
});

/** `total` workflow runs for one commit, 100 per page. */
function runsApi(total: number, make: (i: number) => Record<string, unknown>, over: { dropPage?: number; body?: (p: number) => Record<string, unknown> | null } = {}) {
	const asked: number[] = [];
	const fetchPage: PageFetcher = async (path) => {
		const p = Number(/[?&]page=(\d+)/.exec(path)?.[1] ?? 1);
		asked.push(p);
		const items = over.dropPage === p ? [] : Array.from({ length: Math.max(0, Math.min(100, total - (p - 1) * 100)) }, (_x, i) => make((p - 1) * 100 + i));
		return page(over.body?.(p) ?? { total_count: total, workflow_runs: items });
	};
	return { fetchPage, asked };
}
const run = (i: number, extra: Record<string, unknown> = {}) => ({ id: i + 1, path: `.github/workflows/w${i}.yml`, head_sha: "b".repeat(40), head_branch: "main", status: "completed", conclusion: "success", ...extra });

describe("every workflow run for the commit is read, across pages (#1349)", () => {
	it("finds a run that is only on page 3, and asks for exactly the pages it needs", async () => {
		const { fetchPage, asked } = runsApi(250, (i) => run(i));
		const result = await collectWorkflowRuns(fetchPage, REPO, "b".repeat(40));
		expect(result.ok && result.value).toHaveLength(250);
		expect(result.ok && result.value.some((r) => r.id === 250)).toBe(true);
		expect(asked).toEqual([1, 2, 3]);
	});
	it("reads a single short page once", async () => {
		const { fetchPage, asked } = runsApi(7, (i) => run(i));
		expect((await collectWorkflowRuns(fetchPage, REPO, "b".repeat(40))).ok).toBe(true);
		expect(asked).toEqual([1]);
	});
	it("a repeated run across pages (runs start while we read) is counted once", async () => {
		const fetchPage: PageFetcher = async (path) => {
			const p = Number(/[?&]page=(\d+)/.exec(path)?.[1] ?? 1);
			return page({ total_count: 101, workflow_runs: p === 1 ? Array.from({ length: 100 }, (_x, i) => run(i)) : [run(99)].concat([run(100)]) });
		};
		const result = await collectWorkflowRuns(fetchPage, REPO, "b".repeat(40));
		expect(result.ok && result.value).toHaveLength(101);
	});
	it("a missing middle page is incomplete evidence, never success", async () => {
		const { fetchPage } = runsApi(250, (i) => run(i), { dropPage: 2 });
		expect(await collectWorkflowRuns(fetchPage, REPO, "b".repeat(40))).toMatchObject({ ok: false, kind: "permanent", code: "workflow_runs_incomplete" });
	});
	it("stops at the documented bound and says so, instead of waiting forever", async () => {
		const { fetchPage, asked } = runsApi(5000, (i) => run(i));
		const result = await collectWorkflowRuns(fetchPage, REPO, "b".repeat(40));
		expect(result).toMatchObject({ ok: false, kind: "permanent", code: "workflow_runs_over_limit" });
		expect(result.ok === false && result.message).toContain(String(WORKFLOW_PAGES_MAX * 100));
		expect(asked).toHaveLength(WORKFLOW_PAGES_MAX);
	});
	it("a body without its run list or total is permanent, not guessed", async () => {
		for (const body of [{ workflow_runs: [run(1)] }, { total_count: 1 }, { total_count: "1", workflow_runs: [] }]) {
			const { fetchPage } = runsApi(1, (i) => run(i), { body: () => body });
			expect(await collectWorkflowRuns(fetchPage, REPO, "b".repeat(40))).toMatchObject({ ok: false, kind: "permanent", code: "workflow_runs_incomplete" });
		}
	});
	it("a rate limit or server error on any page is transient and decides nothing", async () => {
		for (const status of [429, 500, 503]) {
			const fetchPage: PageFetcher = async (path) => /[?&]page=2\b/.test(path) ? { ok: false, kind: classifyStatus(status, { get: () => null }), status, message: `GitHub answered ${status}` } : page({ total_count: 150, workflow_runs: Array.from({ length: 100 }, (_x, i) => run(i)) });
			expect(await collectWorkflowRuns(fetchPage, REPO, "b".repeat(40))).toMatchObject({ ok: false, kind: "transient", message: expect.stringContaining(String(status)) });
		}
	});
	it("a refusal (404) is permanent", async () => {
		const fetchPage: PageFetcher = async () => ({ ok: false, kind: "permanent", status: 404, message: "GitHub answered 404" });
		expect(await collectWorkflowRuns(fetchPage, REPO, "b".repeat(40))).toMatchObject({ ok: false, kind: "permanent", code: "github_refused" });
	});
});

describe("the whole base...head range is read and verified (#1349)", () => {
	it("verifies a 51-commit range across two pages, ends at the true pushed head, oldest first", async () => {
		const commits = chain(51);
		const { fetchPage, asked } = compare(commits);
		const result = await range(fetchPage, commits);
		expect(result.ok && result.value.total).toBe(51);
		expect(result.ok && result.value.commits[50].sha).toBe(head(commits));
		expect(result.ok && result.value.commits[0].sha).toBe(commits[0].sha);
		expect(asked).toEqual([1, 2]);
	});
	it("verifies exactly the maximum, 250 commits over five pages", async () => {
		const commits = chain(COMPARE_COMMITS_MAX);
		const { fetchPage, asked } = compare(commits);
		expect((await range(fetchPage, commits)).ok).toBe(true);
		expect(asked).toEqual([1, 2, 3, 4, 5]);
	});
	it("a range above 250 holds on the first page's total and reads nothing more", async () => {
		const commits = chain(251);
		const { fetchPage, asked } = compare(commits);
		const result = await range(fetchPage, commits);
		expect(result).toMatchObject({ ok: false, kind: "permanent", code: "commit_range_over_limit" });
		expect(result.ok === false && result.message).toContain("251");
		expect(asked).toEqual([1]);
	});
	it("a merge keeps its side-branch commits in range as long as nothing precedes its own parent", async () => {
		const c = chain(3);
		const merge = { sha: hex(4), commit: { message: "Merge side" }, parents: [{ sha: hex(3) }, { sha: hex(99) }] };
		const side = { sha: hex(99), commit: { message: "side: work" }, parents: [{ sha: BASE }] };
		const commits = [c[0], c[1], side, c[2], merge];
		const { fetchPage } = compare(commits);
		expect((await range(fetchPage, commits, merge.sha)).ok).toBe(true);
	});

	const held = async (f: PageFetcher, commits: Commit[], code: string, text?: RegExp, h?: string) => {
		const result = await range(f, commits, h);
		expect(result).toMatchObject({ ok: false, kind: "permanent", code });
		if (text) expect(result.ok === false && result.message).toMatch(text);
	};
	it("a missing middle page never verifies", async () => {
		const commits = chain(120);
		await held(compare(commits, { pages: (p, items) => (p === 2 ? [] : items) }).fetchPage, commits, "commit_range_inconsistent", /page 2 has 0 commits where 50 were expected/);
	});
	it("a short last page never verifies", async () => {
		const commits = chain(120);
		await held(compare(commits, { pages: (p, items) => (p === 3 ? items.slice(0, 5) : items) }).fetchPage, commits, "commit_range_inconsistent", /page 3 has 5 commits where 20/);
	});
	it("a total that changes between pages never verifies", async () => {
		const commits = chain(120);
		await held(compare(commits, { meta: (p) => (p === 2 ? { total_commits: 121 } : {}) }).fetchPage, commits, "commit_range_inconsistent", /changed between pages/);
	});
	it("a base commit that changes between pages never verifies", async () => {
		const commits = chain(120);
		await held(compare(commits, { meta: (p) => (p === 2 ? { base_commit: { sha: `0000000${"1".repeat(33)}` } } : {}) }).fetchPage, commits, "commit_range_inconsistent", /changed between pages/);
	});
	it("a status that changes between pages never verifies", async () => {
		const commits = chain(120);
		await held(compare(commits, { meta: (p) => (p === 3 ? { status: "diverged" } : {}) }).fetchPage, commits, "commit_range_inconsistent", /changed between pages/);
	});
	it("a base that is not the one the runner recorded never verifies", async () => {
		const commits = chain(10);
		const result = await collectCommitRange(compare(commits, { base: "9".repeat(40) }).fetchPage, REPO, "0000000", head(commits).slice(0, 7));
		expect(result).toMatchObject({ ok: false, kind: "permanent", code: "commit_range_inconsistent" });
	});
	it("a duplicate commit never verifies", async () => {
		const commits = chain(60);
		const dup = [...commits.slice(0, 59), commits[10]]; // 60 entries, one repeated, head replaced
		await held(compare(dup).fetchPage, dup, "commit_range_inconsistent", /twice/, head(commits));
	});
	it("a commit listed before its own parent never verifies", async () => {
		const commits = chain(60);
		const swapped = [...commits];
		[swapped[20], swapped[21]] = [swapped[21], swapped[20]];
		await held(compare(swapped).fetchPage, swapped, "commit_range_inconsistent", /before its parent/);
	});
	it("a range that does not end at the pushed head never verifies, and the branch HEAD is never substituted", async () => {
		const commits = chain(60);
		await held(compare(commits).fetchPage, commits, "commit_range_wrong_head", /not at the pushed head/, hex(59));
	});
	it("a range that does not attach to the pushed base never verifies", async () => {
		const detached = chain(5).map((c, i) => (i === 0 ? { ...c, parents: [{ sha: hex(500) }] } : c));
		await held(compare(detached).fetchPage, detached, "commit_range_inconsistent", /never reaches the pushed base/);
	});
	it("a range that is not a fast-forward never verifies", async () => {
		const commits = chain(5);
		await held(compare(commits, { status: "diverged" }).fetchPage, commits, "commit_range_inconsistent", /not a fast-forward/);
	});
	it.each([
		["a short SHA", (c: Commit) => ({ ...c, sha: c.sha.slice(0, 7) })],
		["no message", (c: Commit) => ({ ...c, commit: { message: "  " } })],
		["no parents", (c: Commit) => ({ ...c, parents: undefined as never })],
		["a short parent SHA", (c: Commit) => ({ ...c, parents: [{ sha: "abc" }] })],
	])("a commit with %s never verifies", async (_name, corrupt) => {
		const commits = chain(10).map((c, i) => (i === 4 ? corrupt(c) : c));
		await held(compare(commits).fetchPage, commits, "commit_range_inconsistent", /without a full SHA, a message or its parents/, hex(10));
	});
	it("a body without its status, base, total or list is malformed", async () => {
		const commits = chain(5);
		for (const meta of [{ status: undefined }, { base_commit: undefined }, { total_commits: "5" }, { commits: "nope" }]) {
			await held(compare(commits, { meta: () => meta as Record<string, unknown> }).fetchPage, commits, "commit_range_inconsistent", /malformed/);
		}
	});
	it("a rate limit or server error on a later page is transient, and a 404 permanent", async () => {
		const commits = chain(120);
		const ok = compare(commits).fetchPage;
		for (const status of [429, 502]) {
			const f: PageFetcher = async (path) => (/[?&]page=2\b/.test(path) ? { ok: false, kind: classifyStatus(status, { get: () => null }), status, message: `GitHub answered ${status}` } : ok(path));
			expect(await range(f, commits)).toMatchObject({ ok: false, kind: "transient" });
		}
		const gone: PageFetcher = async () => ({ ok: false, kind: "permanent", status: 404, message: "GitHub answered 404" });
		expect(await range(gone, commits)).toMatchObject({ ok: false, kind: "permanent", code: "github_refused" });
	});
});
