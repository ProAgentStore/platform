/**
 * Unit tests for `github-browse.ts` (#685).
 *
 * `listGithubRepos` and `listGithubOrgs` are pure in the sense that they take input
 * and call `gh api` — the test harness stubs `spawnSync` so no network call is made
 * and no real `gh` binary is needed.
 *
 * What is verified:
 *   - The `gh` arguments (endpoint, sort, pagination, jq projection).
 *   - Projection (`toEntry`) handles missing fields, wrong types, and GitHub's REST
 *     shape defensively.
 *   - `limit` is honoured and `hasMore` reflects whether the list was truncated.
 *   - `since` filters by `pushed_at`.
 *   - `visibility` is forwarded to the API.
 *   - Errors from `gh` (non-zero exit, missing binary, unparsable output) surface as
 *     `{ error }` rather than throwing.
 *   - Read-only: the `gh` command is ALWAYS `gh api` (never a write verb).
 */
import { spawnSync } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listGithubOrgs, listGithubRepos } from "./github-browse.js";

vi.mock("node:child_process", () => ({
	spawnSync: vi.fn(),
}));

const mockSpawn = vi.mocked(spawnSync);

/** Build a synthetic `spawnSync` return for a successful `gh api --paginate` call. */
function success(repos: object[]) {
	return {
		status: 0,
		stdout: JSON.stringify(repos),
		stderr: "",
		error: undefined,
	};
}

function fail(stderr: string, status = 1) {
	return { status, stdout: "", stderr, error: undefined };
}

function noGh() {
	return { status: null, stdout: "", stderr: "", error: Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" }) };
}

/** A minimal repo object as GitHub returns it. */
function ghRepo(overrides: Partial<{
	full_name: string;
	visibility: string;
	default_branch: string;
	pushed_at: string;
	language: string;
}> = {}) {
	return {
		full_name: "serge-ivo/my-app",
		visibility: "public",
		default_branch: "main",
		pushed_at: "2026-08-01T10:00:00Z",
		language: "TypeScript",
		...overrides,
	};
}

beforeEach(() => {
	vi.resetAllMocks();
});

describe("listGithubRepos — personal repos", () => {
	it("calls gh api for the authenticated user's repos when no owner is given", () => {
		mockSpawn.mockReturnValue(success([ghRepo()]));
		listGithubRepos({});
		expect(mockSpawn).toHaveBeenCalledOnce();
		const [cmd, args] = mockSpawn.mock.calls[0] as [string, string[]];
		expect(cmd).toBe("gh");
		// Must be a read-only API call
		expect(args[0]).toBe("api");
		expect(args[1]).toBe("--paginate");
		// Must target the user/repos endpoint
		expect(args.some((a) => String(a).includes("user/repos"))).toBe(true);
		// Must sort by pushed, descending
		expect(args.some((a) => String(a).includes("sort=pushed"))).toBe(true);
		expect(args.some((a) => String(a).includes("direction=desc"))).toBe(true);
	});

	it("calls gh api for a specific org when owner is given", () => {
		mockSpawn.mockReturnValue(success([ghRepo({ full_name: "my-org/repo-a" })]));
		listGithubRepos({ owner: "my-org" });
		const [, args] = mockSpawn.mock.calls[0] as [string, string[]];
		expect(args.some((a) => String(a).includes("orgs/my-org/repos"))).toBe(true);
	});

	it("returns repos with the expected fields", () => {
		mockSpawn.mockReturnValue(success([
			ghRepo({ full_name: "serge-ivo/alpha", visibility: "public", language: "TypeScript", pushed_at: "2026-08-10T00:00:00Z" }),
			ghRepo({ full_name: "serge-ivo/beta", visibility: "private", language: null, pushed_at: "2026-07-01T00:00:00Z" }),
		]));
		const result = listGithubRepos({ limit: 10 });
		expect(result).not.toHaveProperty("error");
		if ("error" in result) return;
		expect(result.checked).toBe(true);
		expect(result.repos).toHaveLength(2);
		expect(result.repos[0]).toMatchObject({
			owner: "serge-ivo",
			name: "alpha",
			full_name: "serge-ivo/alpha",
			visibility: "public",
			default_branch: "main",
			pushed_at: "2026-08-10T00:00:00Z",
			language: "TypeScript",
		});
		expect(result.repos[1].visibility).toBe("private");
		expect(result.repos[1].language).toBeNull();
	});

	it("honours limit and sets hasMore when the list is truncated", () => {
		const many = Array.from({ length: 80 }, (_, i) => ghRepo({ full_name: `org/repo-${i}` }));
		mockSpawn.mockReturnValue(success(many));
		const result = listGithubRepos({ limit: 25 });
		if ("error" in result) throw new Error("expected success");
		expect(result.repos).toHaveLength(25);
		expect(result.hasMore).toBe(true);
		expect(result.total).toBe(80);
	});

	it("sets hasMore=false when the list fits within limit", () => {
		mockSpawn.mockReturnValue(success([ghRepo(), ghRepo({ full_name: "org/b" })]));
		const result = listGithubRepos({ limit: 50 });
		if ("error" in result) throw new Error("expected success");
		expect(result.hasMore).toBe(false);
		expect(result.repos).toHaveLength(2);
	});

	it("applies the since filter by pushed_at", () => {
		const recent = ghRepo({ full_name: "org/new", pushed_at: "2026-08-15T00:00:00Z" });
		const old = ghRepo({ full_name: "org/old", pushed_at: "2025-01-01T00:00:00Z" });
		mockSpawn.mockReturnValue(success([recent, old]));
		const result = listGithubRepos({ since: "2026-01-01T00:00:00Z", limit: 50 });
		if ("error" in result) throw new Error("expected success");
		expect(result.repos).toHaveLength(1);
		expect(result.repos[0].name).toBe("new");
	});

	it("forwards the visibility=private filter to the API", () => {
		mockSpawn.mockReturnValue(success([]));
		listGithubRepos({ visibility: "private" });
		const [, args] = mockSpawn.mock.calls[0] as [string, string[]];
		expect(args.some((a) => String(a).includes("visibility=private"))).toBe(true);
	});

	it("defaults visibility to all", () => {
		mockSpawn.mockReturnValue(success([]));
		listGithubRepos({});
		const [, args] = mockSpawn.mock.calls[0] as [string, string[]];
		expect(args.some((a) => String(a).includes("visibility=all"))).toBe(true);
	});

	it("applies a hard cap of 200 on limit", () => {
		const many = Array.from({ length: 300 }, (_, i) => ghRepo({ full_name: `org/r${i}` }));
		mockSpawn.mockReturnValue(success(many));
		const result = listGithubRepos({ limit: 999 });
		if ("error" in result) throw new Error("expected success");
		expect(result.repos).toHaveLength(200);
	});

	it("defaults to limit=50 when not specified", () => {
		const many = Array.from({ length: 100 }, (_, i) => ghRepo({ full_name: `org/r${i}` }));
		mockSpawn.mockReturnValue(success(many));
		const result = listGithubRepos({});
		if ("error" in result) throw new Error("expected success");
		expect(result.repos).toHaveLength(50);
	});

	it("skips malformed items and carries on", () => {
		mockSpawn.mockReturnValue(success([
			null,
			{ full_name: 123 }, // no slash in full_name → filtered
			ghRepo({ full_name: "org/ok" }),
		]));
		const result = listGithubRepos({ limit: 10 });
		if ("error" in result) throw new Error("expected success");
		expect(result.repos).toHaveLength(1);
		expect(result.repos[0].name).toBe("ok");
	});

	it("returns an error when gh is not installed", () => {
		mockSpawn.mockReturnValue(noGh());
		const result = listGithubRepos({});
		expect(result).toHaveProperty("error");
		if (!("error" in result)) return;
		expect(result.error).toMatch(/not installed/i);
	});

	it("returns an error when gh exits non-zero", () => {
		mockSpawn.mockReturnValue(fail("authentication required: please run `gh auth login`"));
		const result = listGithubRepos({});
		expect(result).toHaveProperty("error");
	});

	it("returns an error when gh produces unparsable output", () => {
		mockSpawn.mockReturnValue({ status: 0, stdout: "not json at all", stderr: "", error: undefined });
		const result = listGithubRepos({});
		expect(result).toHaveProperty("error");
	});

	it("returns empty list when gh returns an empty array", () => {
		mockSpawn.mockReturnValue(success([]));
		const result = listGithubRepos({});
		if ("error" in result) throw new Error("expected success");
		expect(result.repos).toHaveLength(0);
		expect(result.hasMore).toBe(false);
		expect(result.total).toBe(0);
	});
});

describe("listGithubOrgs", () => {
	it("calls gh api for the user's orgs", () => {
		mockSpawn.mockReturnValue(success([{ login: "my-org" }]));
		listGithubOrgs();
		const [cmd, args] = mockSpawn.mock.calls[0] as [string, string[]];
		expect(cmd).toBe("gh");
		expect(args[0]).toBe("api");
		expect(args.some((a) => String(a).includes("user/orgs"))).toBe(true);
	});

	it("returns an array of org login names", () => {
		mockSpawn.mockReturnValue(success([{ login: "org-a" }, { login: "org-b" }]));
		const result = listGithubOrgs();
		expect(result).not.toHaveProperty("error");
		if ("error" in result) return;
		expect(result.orgs).toEqual(["org-a", "org-b"]);
	});

	it("returns an error when gh fails", () => {
		mockSpawn.mockReturnValue(fail("gh: Not Found (HTTP 404)"));
		const result = listGithubOrgs();
		expect(result).toHaveProperty("error");
	});

	it("returns an empty list when the user is in no orgs", () => {
		mockSpawn.mockReturnValue(success([]));
		const result = listGithubOrgs();
		if ("error" in result) throw new Error("expected success");
		expect(result.orgs).toEqual([]);
	});
});

describe("read-only invariant", () => {
	it("only ever calls `gh api` — never a write verb", () => {
		mockSpawn.mockReturnValue(success([]));
		listGithubRepos({});
		listGithubRepos({ owner: "some-org" });
		listGithubOrgs();
		for (const call of mockSpawn.mock.calls) {
			const [cmd, args] = call as [string, string[]];
			expect(cmd).toBe("gh");
			// The second arg must be "api" (the read-only subcommand). Write verbs
			// are two-word ("pr create", "issue close", etc.) — never a bare "api".
			expect(args[0]).toBe("api");
		}
	});
});
