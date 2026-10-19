/**
 * #1240 — `github_list_issues` across several repos, without a new tool. The real handler, the real
 * search helper and the real schema for which repos an instance or account has; only GitHub (`fetch`)
 * is faked, by a stub that answers each `repo:` term from a table and refuses the repos it is told to.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { realSchemaD1, type RealSchemaD1 } from "../d1-sqlite.js";
import { GITHUB_TOOLS } from "./github.js";
import { SEARCH_QUERY_MAX, batchQueries, sharedQualifiers } from "../github-issues-multi.js";
import type { Env } from "../../types.js";

type Issue = { number: number; title: string; updated_at: string; labels?: string[]; pull_request?: unknown };
/** What GitHub holds, per repo. */
let held: Record<string, Issue[]>;
/** Repos GitHub refuses to search (as if the token cannot see them). */
let refused: Set<string>;
let queries: string[];
let tokensFor: string[];
let d1: RealSchemaD1;

const raw = (repo: string, i: Issue) => ({ number: i.number, title: i.title, state: "open", comments: 0, updated_at: i.updated_at, html_url: `https://github.com/${repo}/issues/${i.number}`, body: null, labels: (i.labels ?? []).map((name) => ({ name })), assignees: [], ...(i.pull_request ? { pull_request: {} } : {}) });

beforeEach(() => {
	held = {};
	refused = new Set();
	queries = [];
	tokensFor = [];
	d1 = realSchemaD1();
	d1.exec(`INSERT INTO users (id, github_login) VALUES ('u1', 'u1'), ('u2', 'u2')`);
	d1.exec(`INSERT INTO agents (id, owner_id, slug, name, config) VALUES ('coder', 'u1', 'repo-coder', 'Repo Coder', '{}')`);
	d1.exec(`INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES ('pas', 'coder', 'u1', 'active', '{}'), ('heart', 'coder', 'u1', 'active', '{}'), ('gone', 'coder', 'u1', 'canceled', '{}'), ('theirs', 'coder', 'u2', 'active', '{}')`);
	d1.exec(`INSERT INTO coding_repos (id, instance_id, user_id, name, github_repo) VALUES
	  ('r1', 'pas', 'u1', 'platform', 'proappstore-online/platform'),
	  ('r2', 'pas', 'u1', 'console', 'proappstore-online/console'),
	  ('r3', 'pas', 'u1', 'template-app', 'proappstore-online/template-app'),
	  ('r4', 'pas', 'u1', 'local only', NULL),
	  ('r5', 'heart', 'u1', 'platform', 'HeartFull-online/platform'),
	  ('r6', 'heart', 'u1', 'console again', 'proappstore-online/console'),
	  ('r7', 'gone', 'u1', 'old', 'ChessClubs-online/old'),
	  ('r8', 'theirs', 'u2', 'not yours', 'Someone/private')`);
	vi.stubGlobal("fetch", async (url: string) => {
		const q = new URL(url).searchParams.get("q") ?? "";
		queries.push(q);
		const repos = [...q.matchAll(/repo:(\S+)/g)].map((m) => m[1]);
		if (repos.some((r) => refused.has(r))) return new Response(JSON.stringify({ message: "The listed users and repositories cannot be searched" }), { status: 422 });
		const excluded = [...q.matchAll(/-label:(\S+)/g)].map((m) => m[1]);
		const items = repos.flatMap((r) => (held[r] ?? []).filter((i) => !(i.labels ?? []).some((l) => excluded.includes(l))).map((i) => raw(r, i)));
		items.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
		return new Response(JSON.stringify({ total_count: items.length, incomplete_results: false, items }), { status: 200 });
	});
});
afterEach(() => {
	vi.unstubAllGlobals();
	d1.close();
});

const ctx = (instanceId = "pas") =>
	({
		env: { DB: d1.DB, GITHUB_APP_ID: "123", GITHUB_APP_PRIVATE_KEY: "pk" } as unknown as Env,
		userId: "u1",
		instanceId,
		connectorClient: () => ({
			token: async (o: { resourceId: string }) => {
				tokensFor.push(o.resourceId.split("/")[0]);
				return "gh-token";
			},
		}),
	}) as never;
const list = (input: Record<string, unknown>, c = ctx()) => (GITHUB_TOOLS.find((t) => t.name === "github_list_issues") as { handler: (c: never, i: Record<string, unknown>) => Promise<{ content: string; success: boolean }> }).handler(c, input);
// biome-ignore lint/suspicious/noExplicitAny: a JSON reply read field by field.
const body = async (input: Record<string, unknown>, c = ctx()): Promise<any> => {
	const r = await list(input, c);
	expect(r.success, r.content).toBe(true);
	return JSON.parse(r.content);
};

function seedPas() {
	held["proappstore-online/platform"] = [{ number: 12, title: "Billing page 500s", updated_at: "2026-10-19T09:00:00Z" }, { number: 7, title: "Pick pricing", updated_at: "2026-10-19T11:00:00Z", labels: ["needs-human"] }];
	held["proappstore-online/console"] = [{ number: 40, title: "Dark mode toggle", updated_at: "2026-10-20T01:00:00Z" }];
	held["proappstore-online/template-app"] = [{ number: 3, title: "Bump SDK", updated_at: "2026-10-18T08:00:00Z" }];
}

describe("github_list_issues across repos (#1240)", () => {
	it("`*` (or no repo) lists every repo bound to this instance in ONE search, each issue tagged with its repo, newest first", async () => {
		seedPas();
		for (const input of [{ repo: "*" }, {}]) {
			queries = [];
			const b = await body(input);
			expect(b.repos).toEqual(["proappstore-online/console", "proappstore-online/platform", "proappstore-online/template-app"]);
			expect(b.issues.map((i: { repo: string; number: number }) => `${i.repo}#${i.number}`)).toEqual(["proappstore-online/console#40", "proappstore-online/platform#12", "proappstore-online/template-app#3"]);
			expect(b.per_repo_counts).toEqual({ "proappstore-online/console": 1, "proappstore-online/platform": 1, "proappstore-online/template-app": 1 });
			expect(b).toMatchObject({ failures: [], total_count: 3, counts_complete: true, page: 1, hasMore: false, nextPage: null });
			expect(queries).toHaveLength(1); // one owner, one batch
		}
	});

	it("a comma list is read as given, batched by owner (one installation token each)", async () => {
		seedPas();
		held["HeartFull-online/platform"] = [{ number: 9, title: "Streak resets", updated_at: "2026-10-19T10:00:00Z" }];
		const b = await body({ repo: "proappstore-online/platform, proappstore-online/console,HeartFull-online/platform" });
		expect(b.issues.map((i: { repo: string }) => i.repo)).toEqual(["proappstore-online/console", "HeartFull-online/platform", "proappstore-online/platform"]);
		expect(queries).toHaveLength(2);
		expect(queries[0]).toMatch(/^repo:proappstore-online\/platform repo:proappstore-online\/console is:issue state:open -label:needs-human$/);
		expect(tokensFor.sort()).toEqual(["HeartFull-online", "proappstore-online"]);
	});

	it("scope account: every repo across your live coding instances, de-duplicated — never a canceled instance or someone else's", async () => {
		seedPas();
		const b = await body({ scope: "account" });
		expect(b.repos).toEqual(["HeartFull-online/platform", "proappstore-online/console", "proappstore-online/platform", "proappstore-online/template-app"]);
		expect(b.repos).not.toContain("ChessClubs-online/old");
		expect(b.repos).not.toContain("Someone/private");
	});

	it("one unreadable repo is a `failures` row: the rest of its batch is retried alone and kept", async () => {
		seedPas();
		refused.add("proappstore-online/console");
		const b = await body({ repo: "*" });
		expect(b.failures).toEqual([{ repo: "proappstore-online/console", error: expect.stringMatching(/GitHub search refused the query \(422\): The listed users and repositories cannot be searched/) }]);
		expect(b.issues.map((i: { repo: string }) => i.repo)).toEqual(["proappstore-online/platform", "proappstore-online/template-app"]);
		expect(b.per_repo_counts).not.toHaveProperty("proappstore-online/console");
		// A repo the GitHub connector cannot get a token for fails alone too.
		const noToken = { ...(ctx() as object), connectorClient: () => ({ token: async () => null }) } as never;
		const n = await body({ repo: "proappstore-online/platform" , assignee: "serge-ivo" }, noToken);
		expect(n.failures).toHaveLength(1);
		expect(n.issues).toEqual([]);
	});

	it("`needs-human` is left out by default across repos; exclude_labels overrides it, \"\" keeps everything", async () => {
		seedPas();
		expect((await body({ repo: "*" })).issues.map((i: { number: number }) => i.number)).not.toContain(7);
		expect(queries.at(-1)).toContain("-label:needs-human");
		expect((await body({ repo: "*", exclude_labels: "" })).issues.map((i: { number: number }) => i.number)).toContain(7);
		await body({ repo: "*", exclude_labels: "blocked, wontfix" });
		expect(queries.at(-1)).toMatch(/-label:blocked -label:wontfix/);
		expect(queries.at(-1)).not.toContain("needs-human");
	});

	it("assignee and updated_since reach the query (updated_since inclusive; `none` = unassigned)", async () => {
		seedPas();
		await body({ repo: "*", assignee: "serge-ivo", updated_since: "2026-10-01" });
		expect(queries.at(-1)).toMatch(/assignee:serge-ivo updated:>=2026-10-01$/);
		await body({ repo: "*", assignee: "none" });
		expect(queries.at(-1)).toContain("no:assignee");
		expect(queries.at(-1)).not.toContain("assignee:none");
	});

	it("pages the merged list, and a pull request in the results is never an issue", async () => {
		held["acme/a"] = [1, 2, 3, 4, 5].map((n) => ({ number: n, title: `a${n}`, updated_at: `2026-10-0${n}T00:00:00Z` }));
		held["acme/b"] = [{ number: 6, title: "a PR", updated_at: "2026-10-09T00:00:00Z", pull_request: {} }];
		const p1 = await body({ repo: "acme/a,acme/b", per_page: 2 });
		expect(p1.issues.map((i: { number: number }) => i.number)).toEqual([5, 4]);
		expect(p1).toMatchObject({ hasMore: true, nextPage: 2 });
		const p3 = await body({ repo: "acme/a,acme/b", per_page: 2, page: 3 });
		expect(p3.issues.map((i: { number: number }) => i.number)).toEqual([1]);
		expect(p3).toMatchObject({ hasMore: false, nextPage: null });
	});

	it("an unknown scope is an error, not a crash; a malformed repo in a list is a failure row", async () => {
		expect(await list({ scope: "org" })).toMatchObject({ success: false, content: expect.stringMatching(/^Unknown scope "org" — the only scope is "account"/) });
		seedPas();
		const b = await body({ repo: "proappstore-online/platform,not a repo" });
		expect(b.failures).toEqual([{ repo: "not a repo", error: 'not an "owner/name" repository' }]);
	});

	it("an instance with no GitHub repo says so", async () => {
		d1.exec("DELETE FROM coding_repos WHERE instance_id = 'pas'");
		expect(await body({ repo: "*" })).toMatchObject({ issues: [], repos: [], note: expect.stringMatching(/no GitHub repo bound/) });
	});

	it("ONE repo with no new filter is the original path: the REST listing, the original reply shape, no search", async () => {
		const urls: string[] = [];
		vi.stubGlobal("fetch", async (url: string) => {
			urls.push(url);
			return new Response(JSON.stringify([raw("acme/a", { number: 1, title: "old way", updated_at: "2026-10-01T00:00:00Z" })]), { status: 200 });
		});
		const b = await body({ repo: "acme/a" });
		expect(Object.keys(b).sort()).toEqual(["hasMore", "issues", "nextPage", "page", "per_page"]);
		expect(b.issues[0]).not.toHaveProperty("repo");
		expect(urls.every((u) => u.includes("/repos/acme/a/issues") && !u.includes("/search/"))).toBe(true);
	});

	it("long repo lists split into queries that stay within GitHub's 256-character limit", () => {
		const repos = Array.from({ length: 12 }, (_, i) => `proappstore-online/a-fairly-long-repository-name-${i}`);
		const batches = batchQueries(repos, sharedQualifiers({ excludeLabels: ["needs-human"] }));
		expect(batches.length).toBeGreaterThan(1);
		for (const b of batches) expect(b.q.length).toBeLessThanOrEqual(SEARCH_QUERY_MAX);
		expect(batches.flatMap((b) => b.repos)).toEqual(repos);
	});
});
