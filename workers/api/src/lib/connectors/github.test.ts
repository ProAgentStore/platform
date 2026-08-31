import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the two GitHub-App-backed helpers the list/read handlers delegate to. github.ts's
// github_list_issues / github_read_issue call listIssues / readIssue (github-issues.js),
// which internally mint an installation token and fetch api.github.com. Mocking at that
// module seam keeps those tests about github.ts's own behaviour (resolve → delegate →
// serialise) without re-testing github-issues.ts. github_workflow_runs + github_create_issue
// fetch api.github.com directly, so those go through the stubbed globalThis.fetch.
// vi.hoisted so the fns exist when the hoisted vi.mock factory runs.
const { listIssues, readIssue, listIssueComments, invalidateIssuesCache, invalidateIssueCaches, listPulls, readPull } = vi.hoisted(() => ({
	listIssues: vi.fn(),
	readIssue: vi.fn(),
	listIssueComments: vi.fn(),
	// The cache drop `github_create_issue` performs after a successful POST (#401) — mocked at the
	// same seam, and ASSERTED below: an agent that opens an issue and then lists issues must not
	// read back its own pre-write copy.
	invalidateIssuesCache: vi.fn(async () => undefined),
	// The wider drop the issue-MUTATION tools perform (#507): a comment or a state change makes the
	// cached single-issue READ stale too, not just the list, so `github_read_issue` after a close
	// would otherwise still report `state: open`.
	invalidateIssueCaches: vi.fn(async () => undefined),
	listPulls: vi.fn(),
	readPull: vi.fn(),
}));
vi.mock("../github-issues.js", () => ({ listIssues, readIssue, listIssueComments, invalidateIssuesCache, invalidateIssueCaches }));
vi.mock("../github-prs.js", () => ({ listPulls, readPull }));

import { GITHUB_TOOLS } from "./github.js";
import { getRegistryTool, registryConnectorGroups, registryToolNameSet, runRegistryTool } from "../tool-registry.js";
import type { Env } from "../../types.js";

const tool = (name: string) => {
	const t = GITHUB_TOOLS.find((x) => x.name === name);
	if (!t) throw new Error(`no github tool ${name}`);
	return t;
};

// Env with the GitHub App configured so githubAppConfigured(env) is true. resolveRepo
// gates on GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY before it does anything else.
const APP_ENV = { GITHUB_APP_ID: "123", GITHUB_APP_PRIVATE_KEY: "pk" } as unknown as Env;

// A connectorClient factory that mints a fake installation token (the seam github.ts uses
// instead of importing installationTokenForOwner directly). Returning a token means "the
// owner authorized the App"; returning null means "no access".
const tokenClient = (token: string | null) => (_provider: string) => ({
	token: (_opts?: unknown) => Promise.resolve(token),
}) as never;

const ctx = (over: Record<string, unknown> = {}) =>
	({
		env: APP_ENV,
		userId: "u1",
		instanceId: "i1",
		agentId: "i1",
		connectorClient: tokenClient("gh-token-abc"),
		...over,
	}) as never;

// A canned fetch Response.
const jsonResponse = (body: unknown, ok = true, status = 200) =>
	({ ok, status, json: async () => body }) as unknown as Response;

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
	listIssues.mockReset();
	readIssue.mockReset();
	listIssueComments.mockReset();
	listPulls.mockReset();
	readPull.mockReset();
	invalidateIssuesCache.mockReset();
	invalidateIssuesCache.mockResolvedValue(undefined);
	invalidateIssueCaches.mockReset();
	invalidateIssueCaches.mockResolvedValue(undefined);
	fetchMock = vi.fn();
	vi.stubGlobal("fetch", fetchMock);
});

describe("github connector — registration", () => {
	it("registers all 9 tools with correct scopes (reads, plus the three issue writes)", () => {
		const names = registryToolNameSet();
		for (const n of [
			"github_workflow_runs",
			"github_list_issues",
			"github_read_issue",
			"github_list_issue_comments",
			"github_list_pulls",
			"github_read_pull",
			"github_create_issue",
			"github_comment_issue",
			"github_update_issue",
		]) {
			expect(names.has(n)).toBe(true);
		}
		expect(getRegistryTool("github_workflow_runs")?.scope).toBe("read");
		expect(getRegistryTool("github_list_issues")?.scope).toBe("read");
		expect(getRegistryTool("github_read_issue")?.scope).toBe("read");
		expect(getRegistryTool("github_list_issue_comments")?.scope).toBe("read");
		expect(getRegistryTool("github_list_pulls")?.scope).toBe("read");
		expect(getRegistryTool("github_read_pull")?.scope).toBe("read");
		expect(getRegistryTool("github_create_issue")?.scope).toBe("write");
		// The gate that matters. `runRegistryTool` requires per-instance write consent for any
		// `scope:"write"` connector tool; a new mutation registered as a read would reach GitHub
		// with nobody having consented, and no other test in this file would notice.
		expect(getRegistryTool("github_comment_issue")?.scope).toBe("write");
		expect(getRegistryTool("github_update_issue")?.scope).toBe("write");
	});

	it("groups the 9 tools under the github connector for the catalog", () => {
		const grp = registryConnectorGroups().find((g) => g.connector === "github");
		expect(grp).toBeDefined();
		expect(grp?.tools).toEqual(
			expect.arrayContaining([
				"github_workflow_runs",
				"github_list_issues",
				"github_read_issue",
				"github_list_issue_comments",
				"github_list_pulls",
				"github_read_pull",
				"github_create_issue",
				"github_comment_issue",
				"github_update_issue",
			]),
		);
		expect(grp?.tools).toHaveLength(9);
	});

	/**
	 * #401 proposes PR READS and deliberately does NOT propose `github_merge_pull`: merging is what
	 * the per-repo merge policy (#314) governs, and a tool that bypassed it would hand the agent
	 * the authority that ticket exists to withhold. Asserted rather than commented, because the
	 * obvious next contribution to this connector is the one that must not land here.
	 */
	it("exposes NO pull-request WRITE tool — merging is the merge policy's authority, not a tool's", () => {
		const grp = registryConnectorGroups().find((g) => g.connector === "github");
		const prWrites = (grp?.tools ?? []).filter((t) => t.includes("pull") && getRegistryTool(t)?.scope === "write");
		expect(prWrites).toEqual([]);
	});
});

describe("github connector — repo-format validation (before any fetch)", () => {
	it("accepts a well-formed owner/name and proceeds to fetch", async () => {
		fetchMock.mockResolvedValue(jsonResponse({ workflow_runs: [] }));
		const r = await tool("github_workflow_runs").handler(ctx(), { repo: "acme/widgets" });
		expect(r.success).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0][0]).toContain("/repos/acme/widgets/actions/runs");
	});

	it("rejects a query-smuggling repo WITHOUT fetching", async () => {
		const r = await tool("github_workflow_runs").handler(ctx(), { repo: "owner/name?per_page=100" });
		expect(r.success).toBe(false);
		expect(r.content).toMatch(/invalid repo/i);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("rejects a bad charset / wrong-arity repo WITHOUT fetching", async () => {
		for (const bad of ["justname", "a/b/c", "own er/name", "owner/na me"]) {
			const r = await tool("github_workflow_runs").handler(ctx(), { repo: bad });
			expect(r.success).toBe(false);
			expect(r.content).toMatch(/invalid repo/i);
			// Never a network call, and never an authorization claim about a string that is not an owner.
			expect(r.content).not.toMatch(/authoriz/i);
		}
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("github connector — resolveRepo error messages", () => {
	it('returns "GitHub not configured" when the App is not set up (no token minting attempted)', async () => {
		const noApp = ctx({ env: {} as Env });
		const r = await tool("github_workflow_runs").handler(noApp, { repo: "acme/widgets" });
		expect(r.success).toBe(false);
		expect(r.content).toMatch(/not connected|not configured/i);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("reports an unclassified empty mint honestly, blaming nothing (#321)", async () => {
		// This branch used to read `No GitHub access for "acme". Install/authorize the App` — an
		// AUTHORIZATION diagnosis emitted whenever the minter simply returned nothing. The minter
		// now classifies every failure itself and throws, so reaching here means we genuinely do
		// not know why, and the honest answer is to say so rather than name a cause.
		const r = await tool("github_workflow_runs").handler(ctx({ connectorClient: tokenClient(null) }), { repo: "acme/widgets" });
		expect(r.success).toBe(false);
		expect(r.content).toMatch(/no reason was reported/i);
		expect(r.content).not.toMatch(/authoriz|install/i);
		expect(r.content).not.toMatch(/try again/i);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("reports an UNCLASSIFIED throw as transient — a network blip is not a missing installation", async () => {
		// The same call failed at 11:17 and succeeded at 11:19 with no config change; telling the
		// owner to install an App that was already installed cost real time on a non-problem.
		const throwing = (_p: string) => ({ token: () => Promise.reject(new Error("boom")) }) as never;
		const r = await tool("github_workflow_runs").handler(ctx({ connectorClient: throwing }), { repo: "acme/widgets" });
		expect(r.success).toBe(false);
		expect(r.content).toMatch(/transient|try again/i);
		expect(r.content).not.toMatch(/^No GitHub access/);
		// Still swallowed — a throw must never escape the tool.
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("relays a PERMANENT failure verbatim and never appends \"try again\" (#321)", async () => {
		// The observed bug, exactly: `Couldn't reach GitHub for "fws" (No github access for
		// "fws".). This is usually transient — try again.` Retrying an owner that is not a GitHub
		// account fails identically, forever; the hint recommended the loop it should prevent.
		for (const status of [400, 403, 503]) {
			const denied = (_p: string) =>
				({ token: () => Promise.reject(Object.assign(new Error('"fws" is not a GitHub account or organisation.'), { status })) }) as never;
			const r = await tool("github_workflow_runs").handler(ctx({ connectorClient: denied }), { repo: "fws/platform" });
			expect(r.success).toBe(false);
			expect(r.content).toMatch(/is not a GitHub account or organisation/);
			expect(r.content).not.toMatch(/transient|try again/i);
		}
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("keeps \"try again\" for the one state that earns it (502)", async () => {
		const blip = (_p: string) =>
			({ token: () => Promise.reject(Object.assign(new Error("GitHub could not be reached just now."), { status: 502 })) }) as never;
		const r = await tool("github_workflow_runs").handler(ctx({ connectorClient: blip }), { repo: "acme/widgets" });
		expect(r.content).toMatch(/try again/i);
	});

	it("a one-part repo points at the field that IS a path, rather than at authorization", async () => {
		// "fws" reached the minter as an owner in the first place because the Lead had only a
		// display label. Naming `repo.githubRepo` here is the difference between a fixable
		// mistake and a re-authorization the owner did not need.
		const r = await tool("github_workflow_runs").handler(ctx(), { repo: "fws" });
		expect(r.success).toBe(false);
		expect(r.content).toMatch(/githubRepo/);
		expect(r.content).not.toMatch(/authoriz/i);
	});
});

describe("github connector — github_workflow_runs dispatch", () => {
	it("parses workflow runs into a compact shape and sends the auth token", async () => {
		fetchMock.mockResolvedValue(
			jsonResponse({
				workflow_runs: [
					{
						status: "completed",
						conclusion: "success",
						name: "CI",
						run_number: 42,
						head_branch: "main",
						head_sha: "abcdef1234567890",
						html_url: "https://github.com/acme/widgets/actions/runs/42",
						updated_at: "2026-01-01T00:00:00Z",
					},
				],
			}),
		);
		const r = await tool("github_workflow_runs").handler(ctx(), { repo: "acme/widgets", per_page: 3 });
		expect(r.success).toBe(true);
		const runs = JSON.parse(r.content);
		expect(runs).toHaveLength(1);
		expect(runs[0]).toMatchObject({
			status: "completed",
			conclusion: "success",
			name: "CI",
			runNumber: 42,
			branch: "main",
			sha: "abcdef1", // sliced to 7 chars
			url: "https://github.com/acme/widgets/actions/runs/42",
		});
		// per_page honored + auth header carried.
		expect(fetchMock.mock.calls[0][0]).toContain("per_page=3");
		expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toMatchObject({
			Authorization: "token gh-token-abc",
		});
	});

	it("clamps per_page into [1,20]", async () => {
		fetchMock.mockResolvedValue(jsonResponse({ workflow_runs: [] }));
		await tool("github_workflow_runs").handler(ctx(), { repo: "acme/widgets", per_page: 999 });
		expect(fetchMock.mock.calls[0][0]).toContain("per_page=20");
	});

	it("reports a non-ok GitHub status", async () => {
		fetchMock.mockResolvedValue(jsonResponse({}, false, 404));
		const r = await tool("github_workflow_runs").handler(ctx(), { repo: "acme/widgets" });
		expect(r.success).toBe(false);
		expect(r.content).toMatch(/GitHub returned 404 for acme\/widgets/);
	});
});

describe("github connector — issue reads delegate to github-issues", () => {
	it("github_list_issues passes state/labels through and serialises the result", async () => {
		listIssues.mockResolvedValue([{ number: 1, title: "Bug", state: "open", labels: ["p1"], comments: 0, updatedAt: "", url: "u" }]);
		const r = await tool("github_list_issues").handler(ctx(), { repo: "acme/widgets", state: "closed", labels: "p1,p2" });
		expect(r.success).toBe(true);
		expect(JSON.parse(r.content)[0]).toMatchObject({ number: 1, title: "Bug" });
		expect(listIssues).toHaveBeenCalledWith(
			APP_ENV,
			"u1",
			"acme/widgets",
			expect.objectContaining({ state: "closed", labels: "p1,p2", limit: 30 }),
		);
	});

	it("github_list_issues defaults an invalid state to open", async () => {
		listIssues.mockResolvedValue([]);
		await tool("github_list_issues").handler(ctx(), { repo: "acme/widgets", state: "banana" });
		expect(listIssues).toHaveBeenCalledWith(APP_ENV, "u1", "acme/widgets", expect.objectContaining({ state: "open" }));
	});

	it("github_read_issue returns the issue detail when found", async () => {
		readIssue.mockResolvedValue({ number: 7, title: "Crash", state: "open", labels: [], comments: 0, updatedAt: "", url: "u", body: "steps" });
		const r = await tool("github_read_issue").handler(ctx(), { repo: "acme/widgets", number: 7 });
		expect(r.success).toBe(true);
		expect(JSON.parse(r.content)).toMatchObject({ number: 7, title: "Crash", body: "steps" });
		expect(readIssue).toHaveBeenCalledWith(APP_ENV, "u1", "acme/widgets", 7);
	});

	it("github_read_issue requires a number WITHOUT calling readIssue", async () => {
		const r = await tool("github_read_issue").handler(ctx(), { repo: "acme/widgets" });
		expect(r.success).toBe(false);
		expect(r.content).toMatch(/number.*required/i);
		expect(readIssue).not.toHaveBeenCalled();
	});

	it("github_read_issue reports not-found when readIssue returns null", async () => {
		readIssue.mockResolvedValue(null);
		const r = await tool("github_read_issue").handler(ctx(), { repo: "acme/widgets", number: 99 });
		expect(r.success).toBe(false);
		expect(r.content).toMatch(/#99 not found in acme\/widgets/);
	});

	it("github_list_issue_comments passes pagination through and serialises the comments", async () => {
		listIssueComments.mockResolvedValue([
			{ id: 10, author: "octo", body: "please check the failing case", createdAt: "2026-08-01T00:00:00Z", updatedAt: "2026-08-01T00:00:00Z", url: "u10" },
		]);
		const r = await tool("github_list_issue_comments").handler(ctx(), { repo: "acme/widgets", number: 7, page: 2, per_page: 5 });
		expect(r.success).toBe(true);
		expect(JSON.parse(r.content)[0]).toMatchObject({ id: 10, author: "octo", body: "please check the failing case" });
		expect(listIssueComments).toHaveBeenCalledWith(APP_ENV, "u1", "acme/widgets", 7, { page: 2, perPage: 5 });
	});

	it("github_list_issue_comments requires a number WITHOUT calling GitHub", async () => {
		const r = await tool("github_list_issue_comments").handler(ctx(), { repo: "acme/widgets" });
		expect(r.success).toBe(false);
		expect(r.content).toMatch(/number.*required/i);
		expect(listIssueComments).not.toHaveBeenCalled();
	});
});

describe("github connector — github_create_issue dispatch", () => {
	it("POSTs title/body/labels and returns the new issue url", async () => {
		fetchMock.mockResolvedValue(jsonResponse({ number: 11, html_url: "https://github.com/acme/widgets/issues/11" }));
		const r = await tool("github_create_issue").handler(ctx(), {
			repo: "acme/widgets",
			title: "New bug",
			body: "it broke",
			labels: "p1, needs-triage , ",
		});
		expect(r.success).toBe(true);
		expect(r.content).toBe("Opened issue #11 — https://github.com/acme/widgets/issues/11");
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://api.github.com/repos/acme/widgets/issues");
		expect(init.method).toBe("POST");
		const sent = JSON.parse(String(init.body));
		expect(sent).toMatchObject({ title: "New bug", body: "it broke" });
		// labels split, trimmed, empties dropped.
		expect(sent.labels).toEqual(["p1", "needs-triage"]);
		expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
		expect((init.headers as Record<string, string>).Authorization).toBe("token gh-token-abc");
	});

	it("omits the labels key entirely when none are supplied", async () => {
		fetchMock.mockResolvedValue(jsonResponse({ number: 12, html_url: "u" }));
		await tool("github_create_issue").handler(ctx(), { repo: "acme/widgets", title: "No labels" });
		const sent = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
		expect(sent).not.toHaveProperty("labels");
	});

	it("requires a non-empty title WITHOUT fetching", async () => {
		const r = await tool("github_create_issue").handler(ctx(), { repo: "acme/widgets", title: "   " });
		expect(r.success).toBe(false);
		expect(r.content).toMatch(/title.*required/i);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("reports a non-ok GitHub status on create", async () => {
		fetchMock.mockResolvedValue(jsonResponse({}, false, 422));
		const r = await tool("github_create_issue").handler(ctx(), { repo: "acme/widgets", title: "x" });
		expect(r.success).toBe(false);
		expect(r.content).toMatch(/GitHub returned 422 creating the issue in acme\/widgets/);
	});

	/**
	 * #401 point 3. The conditional-request cache makes `github_list_issues` cheap; it also makes
	 * it possible for an agent to open an issue and then be shown the list from BEFORE it did — the
	 * `get_tasks`-after-`create_task` failure `agent-think.ts` documents, one layer out. The fix is
	 * one line at the write site, and this is what keeps it there.
	 */
	it("drops this user's cached issue list after opening one, so the next list is not pre-write", async () => {
		fetchMock.mockResolvedValue(jsonResponse({ number: 7, html_url: "u7" }));
		await tool("github_create_issue").handler(ctx(), { repo: "acme/widgets", title: "fresh" });
		expect(invalidateIssuesCache).toHaveBeenCalledWith(APP_ENV, "u1", "acme/widgets");
	});

	it("does NOT drop the cache when the create failed — nothing changed to invalidate", async () => {
		fetchMock.mockResolvedValue(jsonResponse({}, false, 422));
		await tool("github_create_issue").handler(ctx(), { repo: "acme/widgets", title: "x" });
		expect(invalidateIssuesCache).not.toHaveBeenCalled();
	});
});

describe("github connector — pull request reads (#401)", () => {
	it("github_list_pulls delegates with the state it was given and serialises the result", async () => {
		listPulls.mockResolvedValue([{ number: 3, title: "Fix the thing", draft: false }]);
		const r = await tool("github_list_pulls").handler(ctx(), { repo: "acme/widgets", state: "all" });
		expect(r.success).toBe(true);
		expect(listPulls).toHaveBeenCalledWith(APP_ENV, "u1", "acme/widgets", { state: "all", limit: 30 });
		expect(JSON.parse(r.content)[0]).toMatchObject({ number: 3, title: "Fix the thing" });
	});

	it("github_list_pulls falls back to open for a state it does not know", async () => {
		listPulls.mockResolvedValue([]);
		await tool("github_list_pulls").handler(ctx(), { repo: "acme/widgets", state: "merged-ish" });
		expect(listPulls).toHaveBeenCalledWith(APP_ENV, "u1", "acme/widgets", { state: "open", limit: 30 });
	});

	it("github_read_pull requires a number and never delegates without one", async () => {
		const r = await tool("github_read_pull").handler(ctx(), { repo: "acme/widgets" });
		expect(r.success).toBe(false);
		expect(r.content).toMatch(/number.*required/i);
		expect(readPull).not.toHaveBeenCalled();
	});

	it("github_read_pull reports a missing PR as a failure, not as empty content", async () => {
		readPull.mockResolvedValue(null);
		const r = await tool("github_read_pull").handler(ctx(), { repo: "acme/widgets", number: 99 });
		expect(r.success).toBe(false);
		expect(r.content).toMatch(/#99 not found/);
	});

	it("a PR read is gated by the same repo validation as everything else here", async () => {
		const r = await tool("github_list_pulls").handler(ctx(), { repo: "owner/name?per_page=100" });
		expect(r.success).toBe(false);
		expect(r.content).toMatch(/invalid repo/i);
		expect(listPulls).not.toHaveBeenCalled();
	});
});

describe("github connector — write-consent gate (runRegistryTool)", () => {
	// A DB stub where SELECT ... instance_connector_consent → row (granted) or null.
	const envConsent = (granted: boolean) =>
		({
			...(APP_ENV as object),
			DB: { prepare() { return { bind() { return { first: async () => (granted ? { ok: 1 } : null) }; } }; } },
		}) as unknown as Env;

	it("blocks github_create_issue when write consent is NOT granted (before the handler fetches)", async () => {
		const r = await runRegistryTool(
			"github_create_issue",
			{ env: envConsent(false), userId: "u1", agentId: "i1", instanceId: "i1", connectorClient: tokenClient("gh-token-abc") },
			{ repo: "acme/widgets", title: "blocked" },
		);
		expect(r.success).toBe(false);
		expect(r.content).toMatch(/github/i);
		expect(r.content).toMatch(/permitted|Connections|enable/i);
		expect(fetchMock).not.toHaveBeenCalled(); // gated before the handler runs
	});

	it("allows github_create_issue once write consent IS granted", async () => {
		fetchMock.mockResolvedValue(jsonResponse({ number: 5, html_url: "https://github.com/acme/widgets/issues/5" }));
		const r = await runRegistryTool(
			"github_create_issue",
			{ env: envConsent(true), userId: "u1", agentId: "i1", instanceId: "i1", connectorClient: tokenClient("gh-token-abc") },
			{ repo: "acme/widgets", title: "allowed" },
		);
		expect(r.success).toBe(true);
		expect(r.content).toMatch(/Opened issue #5/);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("allows a read tool (github_list_issues) with no consent row", async () => {
		listIssues.mockResolvedValue([]);
		const r = await runRegistryTool(
			"github_list_issues",
			{ env: envConsent(false), userId: "u1", agentId: "i1", instanceId: "i1", connectorClient: tokenClient("gh-token-abc") },
			{ repo: "acme/widgets" },
		);
		expect(r.success).toBe(true);
		expect(listIssues).toHaveBeenCalled();
	});
});

/**
 * The issue-mutation tools (#507).
 *
 * The connector could OPEN an issue and never touch it again — no comment, no close, no relabel,
 * no assign. Verbatim from the owner's Chess coder 2 on 2026-08-11: "I can't assign issues to you
 * via my tools (no write access to issue assignment)." True, and expensive: closing issue #128
 * with one sentence of comment consumed a Pilot run and an Engine session on his machine, because
 * `gh issue close` was the only route — a route unavailable entirely to any agent without a
 * runner, which is every Coder Lead.
 */
describe("github connector — github_comment_issue dispatch", () => {
	it("POSTs the comment and returns its url", async () => {
		fetchMock.mockResolvedValue(jsonResponse({ html_url: "https://github.com/acme/widgets/issues/128#issuecomment-1" }));
		const r = await tool("github_comment_issue").handler(ctx(), { repo: "acme/widgets", number: 128, body: "Not in scope — closing." });
		expect(r.success).toBe(true);
		expect(r.content).toBe("Commented on acme/widgets#128 — https://github.com/acme/widgets/issues/128#issuecomment-1");
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://api.github.com/repos/acme/widgets/issues/128/comments");
		expect(init.method).toBe("POST");
		expect(JSON.parse(String(init.body))).toEqual({ body: "Not in scope — closing." });
		expect((init.headers as Record<string, string>).Authorization).toBe("token gh-token-abc");
	});

	it("requires a number and a non-empty body WITHOUT fetching", async () => {
		// GitHub 422s an empty comment. Spending the request to find that out tells the agent
		// "GitHub returned 422", which sends it looking at the repo instead of at its own argument.
		for (const input of [
			{ repo: "acme/widgets", body: "hi" },
			{ repo: "acme/widgets", number: 0, body: "hi" },
			{ repo: "acme/widgets", number: 3, body: "   " },
		]) {
			const r = await tool("github_comment_issue").handler(ctx(), input);
			expect(r.success, JSON.stringify(input)).toBe(false);
		}
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("reports a non-ok GitHub status rather than claiming the comment landed", async () => {
		fetchMock.mockResolvedValue(jsonResponse({}, false, 404));
		const r = await tool("github_comment_issue").handler(ctx(), { repo: "acme/widgets", number: 9, body: "x" });
		expect(r.success).toBe(false);
		expect(r.content).toMatch(/GitHub returned 404 commenting on issue #9 in acme\/widgets/);
	});

	it("drops BOTH cached issue resources, so a read-back is not pre-write", async () => {
		fetchMock.mockResolvedValue(jsonResponse({ html_url: "u" }));
		await tool("github_comment_issue").handler(ctx(), { repo: "acme/widgets", number: 5, body: "x" });
		expect(invalidateIssueCaches).toHaveBeenCalledWith(APP_ENV, "u1", "acme/widgets");
	});

	it("does NOT drop the cache when the comment failed — nothing changed to invalidate", async () => {
		fetchMock.mockResolvedValue(jsonResponse({}, false, 403));
		await tool("github_comment_issue").handler(ctx(), { repo: "acme/widgets", number: 5, body: "x" });
		expect(invalidateIssueCaches).not.toHaveBeenCalled();
	});
});

describe("github connector — github_update_issue dispatch", () => {
	it("closes an issue and reports the state GitHub came back with", async () => {
		fetchMock.mockResolvedValue(
			jsonResponse({ state: "closed", html_url: "https://github.com/acme/widgets/issues/128", labels: [{ name: "bug" }], assignees: [] }),
		);
		const r = await tool("github_update_issue").handler(ctx(), { repo: "acme/widgets", number: 128, state: "closed" });
		expect(r.success).toBe(true);
		expect(r.content).toContain("state: closed");
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://api.github.com/repos/acme/widgets/issues/128");
		expect(init.method).toBe("PATCH");
		expect(JSON.parse(String(init.body))).toEqual({ state: "closed" });
	});

	it("assigns and relabels in ONE call — the request the owner was refused", async () => {
		fetchMock.mockResolvedValue(jsonResponse({ state: "open", html_url: "u", labels: [{ name: "high priority" }], assignees: [{ login: "serge-ivo" }] }));
		const r = await tool("github_update_issue").handler(ctx(), {
			repo: "acme/widgets",
			number: 16,
			assignees: "serge-ivo",
			labels: "high priority, , high priority",
		});
		expect(r.success).toBe(true);
		const sent = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
		// trimmed, empties dropped, de-duplicated — same handling as create's labels.
		expect(sent).toEqual({ labels: ["high priority"], assignees: ["serge-ivo"] });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("reports the RESULTING assignees, not the requested ones", async () => {
		// GitHub does not error on an assignee without push access — it accepts the request and
		// silently drops the name. Echoing the REQUEST would have the agent report an assignment
		// that does not exist, which is the one failure mode a write tool must not have.
		fetchMock.mockResolvedValue(jsonResponse({ state: "open", html_url: "u", labels: [], assignees: [] }));
		const r = await tool("github_update_issue").handler(ctx(), { repo: "acme/widgets", number: 16, assignees: "someone-with-no-access" });
		expect(r.success).toBe(true);
		expect(r.content).toContain("assignees: none");
		expect(r.content).not.toContain("someone-with-no-access");
	});

	it("omits every field that was not supplied — an update is never a silent overwrite", async () => {
		fetchMock.mockResolvedValue(jsonResponse({ state: "closed", html_url: "u", labels: [{ name: "bug" }], assignees: [{ login: "a" }] }));
		await tool("github_update_issue").handler(ctx(), { repo: "acme/widgets", number: 4, state: "closed", labels: "  ", assignees: "" });
		const sent = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
		// PATCH treats `[]` as "empty this field", so an empty string arg must NOT become `[]` —
		// otherwise a model passing `labels: ""` to mean "leave them" strips every label.
		expect(sent).toEqual({ state: "closed" });
		expect(sent).not.toHaveProperty("labels");
		expect(sent).not.toHaveProperty("assignees");
	});

	it("refuses an empty update instead of reporting a no-op as success", async () => {
		const r = await tool("github_update_issue").handler(ctx(), { repo: "acme/widgets", number: 4 });
		expect(r.success).toBe(false);
		expect(r.content).toMatch(/Nothing to update/);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("rejects a state that is not open/closed WITHOUT fetching", async () => {
		const r = await tool("github_update_issue").handler(ctx(), { repo: "acme/widgets", number: 4, state: "resolved" });
		expect(r.success).toBe(false);
		expect(r.content).toMatch(/must be "open" or "closed"/);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("requires a usable issue number WITHOUT fetching", async () => {
		for (const input of [{ repo: "acme/widgets", state: "closed" }, { repo: "acme/widgets", number: -1, state: "closed" }]) {
			expect((await tool("github_update_issue").handler(ctx(), input)).success).toBe(false);
		}
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("reports a non-ok GitHub status rather than claiming the change landed", async () => {
		fetchMock.mockResolvedValue(jsonResponse({}, false, 410));
		const r = await tool("github_update_issue").handler(ctx(), { repo: "acme/widgets", number: 4, state: "closed" });
		expect(r.success).toBe(false);
		expect(r.content).toMatch(/GitHub returned 410 updating issue #4 in acme\/widgets/);
	});

	it("drops BOTH cached issue resources after a successful update, and neither after a failure", async () => {
		// The half that is new relative to the create path: `github_read_issue` caches per issue
		// under its own resource, so closing #128 and reading #128 back would report `open`.
		fetchMock.mockResolvedValue(jsonResponse({ state: "closed", html_url: "u", labels: [], assignees: [] }));
		await tool("github_update_issue").handler(ctx(), { repo: "acme/widgets", number: 128, state: "closed" });
		expect(invalidateIssueCaches).toHaveBeenCalledWith(APP_ENV, "u1", "acme/widgets");

		invalidateIssueCaches.mockClear();
		fetchMock.mockResolvedValue(jsonResponse({}, false, 422));
		await tool("github_update_issue").handler(ctx(), { repo: "acme/widgets", number: 128, state: "closed" });
		expect(invalidateIssueCaches).not.toHaveBeenCalled();
	});

	it("refuses an unresolvable repo before it writes anything", async () => {
		const r = await tool("github_update_issue").handler(ctx({ connectorClient: tokenClient(null) }), {
			repo: "acme/widgets",
			number: 4,
			state: "closed",
		});
		expect(r.success).toBe(false);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("says out loud that labels and assignees REPLACE rather than add", async () => {
		// The one sharp edge of modelling this as GitHub models it. A model told only "labels:
		// comma-separated" will pass the ONE label it was asked to add and silently strip the rest.
		// The description is the whole mitigation, so it is asserted rather than trusted.
		const d = tool("github_update_issue").description;
		expect(d).toMatch(/REPLACE/);
		expect(d).toMatch(/github_read_issue/);
	});
});
