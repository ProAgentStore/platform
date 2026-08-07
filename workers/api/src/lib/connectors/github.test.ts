import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the two GitHub-App-backed helpers the list/read handlers delegate to. github.ts's
// github_list_issues / github_read_issue call listIssues / readIssue (github-issues.js),
// which internally mint an installation token and fetch api.github.com. Mocking at that
// module seam keeps those tests about github.ts's own behaviour (resolve → delegate →
// serialise) without re-testing github-issues.ts. github_workflow_runs + github_create_issue
// fetch api.github.com directly, so those go through the stubbed globalThis.fetch.
// vi.hoisted so the fns exist when the hoisted vi.mock factory runs.
const { listIssues, readIssue } = vi.hoisted(() => ({
	listIssues: vi.fn(),
	readIssue: vi.fn(),
}));
vi.mock("../github-issues.js", () => ({ listIssues, readIssue }));

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
	fetchMock = vi.fn();
	vi.stubGlobal("fetch", fetchMock);
});

describe("github connector — registration", () => {
	it("registers all 4 tools with correct scopes (workflow_runs/list_issues/read_issue read; create_issue write)", () => {
		const names = registryToolNameSet();
		for (const n of ["github_workflow_runs", "github_list_issues", "github_read_issue", "github_create_issue"]) {
			expect(names.has(n)).toBe(true);
		}
		expect(getRegistryTool("github_workflow_runs")?.scope).toBe("read");
		expect(getRegistryTool("github_list_issues")?.scope).toBe("read");
		expect(getRegistryTool("github_read_issue")?.scope).toBe("read");
		expect(getRegistryTool("github_create_issue")?.scope).toBe("write");
	});

	it("groups the 4 tools under the github connector for the catalog", () => {
		const grp = registryConnectorGroups().find((g) => g.connector === "github");
		expect(grp).toBeDefined();
		expect(grp?.tools).toEqual(
			expect.arrayContaining(["github_workflow_runs", "github_list_issues", "github_read_issue", "github_create_issue"]),
		);
		expect(grp?.tools).toHaveLength(4);
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
