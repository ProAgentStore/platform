import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	closeIssueForCommit,
	repoDirectPushes,
	COMMIT_CLOSE_MAX_CLOSURES_PER_REPO,
	COMMIT_CLOSE_MAX_UNORDERED_AGE_MS,
	type CommitScanState,
	decideCommitScan,
	parseClosingRefs,
	runCommitCloseWatch,
	type ScannedCommit,
} from "./commit-close-watch.js";
import { logError } from "./error-log.js";
import { installationTokenForOwner } from "./github-app.js";
import { githubConditionalJson } from "./github-cache.js";
import { readIssue } from "./github-issues.js";
import type { Env } from "../types.js";

vi.mock("./github-app.js", () => ({ installationTokenForOwner: vi.fn() }));
vi.mock("./github-cache.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./github-cache.js")>()),
	githubConditionalJson: vi.fn(),
	githubAuthContext: vi.fn(async () => "app:1"),
	invalidateGithubCache: vi.fn(async () => undefined),
}));
vi.mock("./github-issues.js", () => ({
	readIssue: vi.fn(),
	invalidateIssueCaches: vi.fn(async () => undefined),
}));
vi.mock("./error-log.js", () => ({ logError: vi.fn(async () => undefined) }));

const NOW = Date.parse("2026-09-19T12:00:00Z");

const commit = (over: Partial<ScannedCommit> = {}): ScannedCommit => ({
	sha: "aaaa111bbbb222",
	message: "chore: something (closes #7)",
	committedAt: "2026-09-19T11:00:00Z",
	...over,
});

const state = (lastSha: string | null, over: Partial<CommitScanState> = {}): CommitScanState => ({
	lastSha,
	lastAt: null,
	now: NOW,
	...over,
});

describe("parseClosingRefs", () => {
	// The five commits traced on #816 before this feature was built. They are the reason the
	// grammar is what it is, and they are the regression that matters most: two of them MUST NOT
	// match, and GitHub itself recorded them as `referenced` rather than `closed`.
	describe("the real commits from #816's verification", () => {
		it("matches a keyword in the subject — chess-academy e9d065c2, which GitHub closed", () => {
			expect(parseClosingRefs("chore: add MCP auth guard audit script (closes #151)")).toEqual([{ repo: null, number: 151 }]);
		});

		it("matches a keyword in the BODY when the subject has only a bare ref — 603527c0", () => {
			const msg = [
				"fix: replace postCredentialAuth raw fetch with SDK auth methods (#141)",
				"",
				"Remove the bespoke postCredentialAuth helper that bypassed the SDK.",
				"",
				"Closes #141",
			].join("\n");
			// Subject-only scanning would have missed a close GitHub really performed.
			expect(parseClosingRefs(msg)).toEqual([{ repo: null, number: 141 }]);
		});

		it("matches this repo's b47cf05e", () => {
			expect(parseClosingRefs("fix(gmail): gmail_send stops pointing the model at a tool that does not exist (closes #808)")).toEqual([
				{ repo: null, number: 808 },
			]);
		});

		it("does NOT match a bare ref behind a conventional-commit type — 47e9e2b8", () => {
			// `fix:` is a commit TYPE, not a closing keyword. GitHub recorded `referenced`.
			expect(parseClosingRefs("fix: clock-guard hotfix — remove opponent-clock equality check from record_game_move WHERE clause (#124)")).toEqual(
				[],
			);
		});

		it("does NOT match a bare ref inside a conventional-commit scope — e81a1179", () => {
			expect(parseClosingRefs("feat(#125): make silent move-save failures loud — banner, coach indicator, telemetry")).toEqual([]);
		});
	});

	it("accepts every documented keyword, in any case", () => {
		for (const kw of ["close", "closes", "closed", "fix", "fixes", "fixed", "resolve", "resolves", "resolved"]) {
			expect(parseClosingRefs(`${kw} #12`), kw).toEqual([{ repo: null, number: 12 }]);
			expect(parseClosingRefs(`${kw.toUpperCase()} #12`), kw).toEqual([{ repo: null, number: 12 }]);
		}
	});

	it("accepts an optional colon after the keyword", () => {
		expect(parseClosingRefs("Fixes: #99")).toEqual([{ repo: null, number: 99 }]);
	});

	it("accepts the GH- and owner/repo# reference forms", () => {
		expect(parseClosingRefs("fixes GH-42")).toEqual([{ repo: null, number: 42 }]);
		expect(parseClosingRefs("resolves Acme/Widget#8")).toEqual([{ repo: "acme/widget", number: 8 }]);
	});

	it("does not match a keyword that is only part of a longer word", () => {
		expect(parseClosingRefs("prefixes #12")).toEqual([]);
		expect(parseClosingRefs("postfix #12")).toEqual([]);
		expect(parseClosingRefs("unclosed #12")).toEqual([]);
	});

	it("does not match a bare reference, however it is punctuated", () => {
		expect(parseClosingRefs("see #12, and also (#13) plus [#14]")).toEqual([]);
		expect(parseClosingRefs("refs #12")).toEqual([]);
	});

	it("requires whitespace between the keyword and the reference", () => {
		expect(parseClosingRefs("closes#12")).toEqual([]);
	});

	it("collects several references and deduplicates them", () => {
		expect(parseClosingRefs("closes #1, fixes #2, resolves #1")).toEqual([
			{ repo: null, number: 1 },
			{ repo: null, number: 2 },
		]);
	});

	it("mirrors GitHub's prose behaviour rather than second-guessing it", () => {
		// Documented, inherited and deliberate: GitHub closes on this, so the mirror does too.
		expect(parseClosingRefs("this does not close #99's second half")).toEqual([{ repo: null, number: 99 }]);
	});

	it("survives an empty or absent message without throwing", () => {
		expect(parseClosingRefs("")).toEqual([]);
		expect(parseClosingRefs(undefined as unknown as string)).toEqual([]);
	});

	it("does not leak regex state between calls", () => {
		// A shared global regex would skip every other call. Same input, same answer, twice.
		expect(parseClosingRefs("closes #5")).toEqual([{ repo: null, number: 5 }]);
		expect(parseClosingRefs("closes #5")).toEqual([{ repo: null, number: 5 }]);
	});
});

describe("decideCommitScan", () => {
	it("scans NOTHING on first sight, and seeds the watermark", () => {
		const d = decideCommitScan([commit({ sha: "new1" })], state(null));
		expect(d.scan).toBe(false);
		expect(d.seenSha).toBe("new1");
		if (!d.scan) expect(d.reason).toBe("first-sight");
	});

	it("does nothing when the newest commit is the one already scanned", () => {
		const d = decideCommitScan([commit({ sha: "seen" })], state("seen"));
		expect(d.scan).toBe(false);
		if (!d.scan) expect(d.reason).toBe("already-scanned");
	});

	it("returns only the commits above the watermark, oldest first", () => {
		const page = [
			commit({ sha: "c3", committedAt: "2026-09-19T11:30:00Z" }),
			commit({ sha: "c2", committedAt: "2026-09-19T11:20:00Z" }),
			commit({ sha: "c1", committedAt: "2026-09-19T11:10:00Z" }),
		];
		const d = decideCommitScan(page, state("c1", { lastAt: "2026-09-19T11:10:00Z" }));
		expect(d.scan).toBe(true);
		if (d.scan) {
			expect(d.commits.map((c) => c.sha)).toEqual(["c2", "c3"]);
			expect(d.seenSha).toBe("c3");
			expect(d.gap).toBe(false);
		}
	});

	it("flags a gap when the watermark has fallen off the page, and still scans", () => {
		const page = [commit({ sha: "c9", committedAt: "2026-09-19T11:50:00Z" })];
		const d = decideCommitScan(page, state("long-gone", { lastAt: "2026-09-19T10:00:00Z" }));
		expect(d.scan).toBe(true);
		if (d.scan) expect(d.gap).toBe(true);
	});

	it("handles an empty page", () => {
		const d = decideCommitScan([], state("c1"));
		expect(d.scan).toBe(false);
		if (!d.scan) expect(d.reason).toBe("no-commits");
	});

	it("ignores entries with no sha", () => {
		const d = decideCommitScan([commit({ sha: "" })], state("c1"));
		expect(d.scan).toBe(false);
		if (!d.scan) expect(d.reason).toBe("no-commits");
	});

	describe("never goes backwards", () => {
		it("refuses a page whose newest commit predates the one already scanned, and holds BOTH halves", () => {
			const d = decideCommitScan(
				[commit({ sha: "old", committedAt: "2026-09-19T09:00:00Z" })],
				state("current", { lastAt: "2026-09-19T11:00:00Z" }),
			);
			expect(d.scan).toBe(false);
			if (!d.scan) {
				expect(d.reason).toBe("stale-page");
				// Rolling the watermark back is what turns one bad read into a permanent loop.
				expect(d.seenSha).toBe("current");
				expect(d.seenAt).toBe("2026-09-19T11:00:00Z");
			}
		});

		it("treats an unknown order as allow-then-record, not as a block", () => {
			const d = decideCommitScan([commit({ sha: "c2", committedAt: "2026-09-19T11:59:00Z" })], state("c1", { lastAt: null }));
			expect(d.scan).toBe(true);
		});

		it("declines an ancient commit while the order is still unknown", () => {
			const old = new Date(NOW - COMMIT_CLOSE_MAX_UNORDERED_AGE_MS - 60_000).toISOString();
			const d = decideCommitScan([commit({ sha: "c2", committedAt: old })], state("c1", { lastAt: null }));
			expect(d.scan).toBe(false);
			if (!d.scan) expect(d.reason).toBe("stale-page");
		});

		it("still scans a late page when the order IS known — being behind is not being stale", () => {
			const late = new Date(NOW - COMMIT_CLOSE_MAX_UNORDERED_AGE_MS - 60_000).toISOString();
			const d = decideCommitScan([commit({ sha: "c2", committedAt: late })], state("c1", { lastAt: "2026-09-01T00:00:00Z" }));
			expect(d.scan).toBe(true);
		});

		it("keeps the recorded instant when a commit carries no usable date", () => {
			const d = decideCommitScan([commit({ sha: "c2", committedAt: "" })], state("c1", { lastAt: "2026-09-19T11:00:00Z" }));
			expect(d.seenAt).toBe("2026-09-19T11:00:00Z");
		});
	});
});

describe("closeIssueForCommit", () => {
	const env = {} as Env;
	const base = { userId: "u1", githubRepo: "acme/app", token: "tok", sha: "abc1234def" };

	beforeEach(() => {
		vi.clearAllMocks();
		vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
	});

	it("closes an OPEN issue and records why on the issue itself", async () => {
		vi.mocked(readIssue).mockResolvedValue({ number: 7, state: "open" } as never);
		const out = await closeIssueForCommit(env, { ...base, ref: { repo: null, number: 7 } });
		expect(out).toBe("closed");

		const calls = vi.mocked(fetch).mock.calls;
		const patch = calls.find((c) => (c[1] as RequestInit)?.method === "PATCH");
		expect(patch?.[0]).toBe("https://api.github.com/repos/acme/app/issues/7");
		expect(JSON.parse(String((patch?.[1] as RequestInit).body))).toEqual({ state: "closed", state_reason: "completed" });
		// The audit trail. Without it the timeline shows a close by an app and no reason.
		const comment = calls.find((c) => String(c[0]).endsWith("/comments"));
		expect(String((comment?.[1] as RequestInit).body)).toContain("abc1234");
	});

	it("SKIPS an issue GitHub has already closed — the expected path, and never a write", async () => {
		// This is what the sweep will actually see almost every time: GitHub's native auto-close
		// fires on a direct push to the default branch, so the issue is closed before we look.
		vi.mocked(readIssue).mockResolvedValue({ number: 7, state: "closed" } as never);
		expect(await closeIssueForCommit(env, { ...base, ref: { repo: null, number: 7 } })).toBe("already-closed");
		expect(fetch).not.toHaveBeenCalled();
	});

	it("never sends state:open — a closed issue is never reopened", async () => {
		vi.mocked(readIssue).mockResolvedValue({ number: 7, state: "closed" } as never);
		await closeIssueForCommit(env, { ...base, ref: { repo: null, number: 7 } });
		for (const call of vi.mocked(fetch).mock.calls) {
			expect(String((call[1] as RequestInit)?.body ?? "")).not.toContain('"open"');
		}
	});

	it("leaves a pull request or a missing number alone", async () => {
		vi.mocked(readIssue).mockResolvedValue(null);
		expect(await closeIssueForCommit(env, { ...base, ref: { repo: null, number: 7 } })).toBe("not-an-issue");
		expect(fetch).not.toHaveBeenCalled();
	});

	it("does not reach into another repository", async () => {
		expect(await closeIssueForCommit(env, { ...base, ref: { repo: "other/repo", number: 7 } })).toBe("cross-repo");
		expect(readIssue).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
	});

	it("acts on a same-repo reference written in the cross-repo form", async () => {
		vi.mocked(readIssue).mockResolvedValue({ number: 7, state: "open" } as never);
		expect(await closeIssueForCommit(env, { ...base, ref: { repo: "acme/app", number: 7 } })).toBe("closed");
	});

	it("reports a refused PATCH instead of claiming the close", async () => {
		vi.mocked(readIssue).mockResolvedValue({ number: 7, state: "open" } as never);
		vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 403 })));
		expect(await closeIssueForCommit(env, { ...base, ref: { repo: null, number: 7 } })).toBe("failed");
		expect(logError).toHaveBeenCalled();
	});

	it("still reports the close when only the explanatory comment fails", async () => {
		vi.mocked(readIssue).mockResolvedValue({ number: 7, state: "open" } as never);
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_u: string, init?: RequestInit) =>
				init?.method === "PATCH" ? new Response("{}", { status: 200 }) : Promise.reject(new Error("network")),
			),
		);
		expect(await closeIssueForCommit(env, { ...base, ref: { repo: null, number: 7 } })).toBe("closed");
	});
});

describe("runCommitCloseWatch", () => {
	const rows: Record<string, unknown>[] = [];
	const bound: unknown[][] = [];
	const statements: string[] = [];

	const env = {
		DB: {
			prepare: (sql: string) => {
				statements.push(sql);
				return {
					bind: (...args: unknown[]) => {
						bound.push(args);
						return {
							all: async () => ({ results: sql.includes("SELECT") ? rows : [] }),
							run: async () => ({}),
						};
					},
				};
			},
		},
	} as unknown as Env;

	beforeEach(() => {
		vi.clearAllMocks();
		rows.length = 0;
		bound.length = 0;
		statements.length = 0;
		vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
		vi.mocked(installationTokenForOwner).mockResolvedValue("tok");
	});

	const row = (over: Record<string, unknown> = {}) => ({
		id: "r1",
		instance_id: "i1",
		user_id: "u1",
		github_repo: "acme/app",
		// '' + no instance setting resolves to the platform default, `merge` — today's behaviour.
		merge_policy: "",
		instance_config: null,
		last_scanned_commit_sha: "old",
		last_scanned_commit_at: "2026-09-19T10:00:00Z",
		...over,
	});

	const page = (commits: Array<{ sha: string; message: string; date?: string }>) =>
		vi.mocked(githubConditionalJson).mockResolvedValue({
			ok: true,
			fromCache: false,
			stale: false,
			data: commits.map((c) => ({ sha: c.sha, commit: { message: c.message, committer: { date: c.date ?? "2026-09-19T11:00:00Z" } } })),
		} as never);

	it("closes the issue a new commit names", async () => {
		rows.push(row());
		page([{ sha: "new", message: "fix: thing (closes #7)" }, { sha: "old", message: "earlier" }]);
		vi.mocked(readIssue).mockResolvedValue({ number: 7, state: "open" } as never);

		await runCommitCloseWatch(env);
		const patch = vi.mocked(fetch).mock.calls.find((c) => (c[1] as RequestInit)?.method === "PATCH");
		expect(patch?.[0]).toBe("https://api.github.com/repos/acme/app/issues/7");
	});

	it("reads the repo's DEFAULT branch — no `sha` parameter is sent", async () => {
		rows.push(row());
		page([{ sha: "new", message: "nothing to close" }]);
		await runCommitCloseWatch(env);
		const args = vi.mocked(githubConditionalJson).mock.calls[0][1];
		expect(args.url).toContain("/repos/acme/app/commits?");
		expect(args.url).not.toContain("sha=");
	});

	it("closes nothing on first sight, and seeds the watermark", async () => {
		rows.push(row({ last_scanned_commit_sha: null, last_scanned_commit_at: null }));
		page([{ sha: "new", message: "fix: old history (closes #7)" }]);
		await runCommitCloseWatch(env);
		expect(fetch).not.toHaveBeenCalled();
		expect(bound.some((b) => b[0] === "new")).toBe(true);
	});

	it("does not spend GitHub's budget when it has no token to close anything with", async () => {
		rows.push(row());
		vi.mocked(installationTokenForOwner).mockResolvedValue(null);
		await runCommitCloseWatch(env);
		expect(githubConditionalJson).not.toHaveBeenCalled();
		expect(logError).toHaveBeenCalled();
	});

	it("refuses a stored page served because GitHub was unreachable", async () => {
		rows.push(row());
		vi.mocked(githubConditionalJson).mockResolvedValue({
			ok: true,
			fromCache: true,
			stale: true,
			data: [{ sha: "new", commit: { message: "closes #7", committer: { date: "2026-09-19T11:00:00Z" } } }],
		} as never);
		await runCommitCloseWatch(env);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("stops at the per-sweep closure ceiling, and still advances the watermark", async () => {
		rows.push(row());
		const many = Array.from({ length: COMMIT_CLOSE_MAX_CLOSURES_PER_REPO + 3 }, (_, i) => ({
			sha: `c${i}`,
			message: `fix: thing (closes #${i + 1})`,
			date: `2026-09-19T11:${String(10 + i).padStart(2, "0")}:00Z`,
		}));
		page(many);
		vi.mocked(readIssue).mockResolvedValue({ number: 1, state: "open" } as never);

		await runCommitCloseWatch(env);
		const patches = vi.mocked(fetch).mock.calls.filter((c) => (c[1] as RequestInit)?.method === "PATCH");
		expect(patches).toHaveLength(COMMIT_CLOSE_MAX_CLOSURES_PER_REPO);
		// A ceiling a retry defeats is not a ceiling: the watermark must move anyway.
		expect(bound.some((b) => b[0] === "c0")).toBe(true);
	});

	it("does not touch GitHub at all for a `pr` repo, and still rotates", async () => {
		rows.push(row({ merge_policy: "pr" }));
		await runCommitCloseWatch(env);
		expect(installationTokenForOwner).not.toHaveBeenCalled();
		expect(githubConditionalJson).not.toHaveBeenCalled();
		// The rotation key moves; the watermark does not, so a later switch to `merge` seeds silently.
		expect(statements.some((q) => q.includes("last_commit_scan_at = datetime('now')") && !q.includes("last_scanned_commit_sha"))).toBe(true);
	});

	it("does not touch GitHub at all for a `none` repo", async () => {
		rows.push(row({ merge_policy: "none" }));
		await runCommitCloseWatch(env);
		expect(githubConditionalJson).not.toHaveBeenCalled();
	});

	it("skips a repo whose AGENT chose pr, with no repo override", async () => {
		rows.push(row({ merge_policy: "", instance_config: JSON.stringify({ settings: { merge_policy: "pr" } }) }));
		await runCommitCloseWatch(env);
		expect(githubConditionalJson).not.toHaveBeenCalled();
	});

	it("still sweeps a `merge` repo sitting beside a skipped one", async () => {
		rows.push(row({ id: "r1", github_repo: "acme/skipme", merge_policy: "pr" }), row({ id: "r2", github_repo: "acme/app" }));
		page([{ sha: "new", message: "fix: thing (closes #7)" }]);
		vi.mocked(readIssue).mockResolvedValue({ number: 7, state: "open" } as never);
		await runCommitCloseWatch(env);
		expect(githubConditionalJson).toHaveBeenCalledTimes(1);
		expect(vi.mocked(githubConditionalJson).mock.calls[0][1].repo).toBe("acme/app");
	});

	it("survives a repo that throws, and keeps sweeping the rest", async () => {
		rows.push(row({ id: "r1", github_repo: "acme/one" }), row({ id: "r2", github_repo: "acme/two" }));
		vi.mocked(githubConditionalJson)
			.mockRejectedValueOnce(new Error("boom"))
			.mockResolvedValue({ ok: true, fromCache: false, stale: false, data: [] } as never);
		await runCommitCloseWatch(env);
		expect(githubConditionalJson).toHaveBeenCalledTimes(2);
		expect(logError).toHaveBeenCalled();
	});

	it("reports a pre-migration database as a warning rather than dying silently", async () => {
		const broken = {
			DB: {
				prepare: () => ({
					bind: () => ({
						all: async () => {
							throw new Error("no such column: last_scanned_commit_sha");
						},
					}),
				}),
			},
		} as unknown as Env;
		await runCommitCloseWatch(broken);
		expect(vi.mocked(logError).mock.calls[0][1]).toMatchObject({ level: "warn" });
	});
});

describe("repoDirectPushes — merge authority gate (#817)", () => {
	const cfg = (policy: string) => JSON.stringify({ settings: { merge_policy: policy } });

	it("runs under the platform default, so #816's behaviour is unchanged where nothing was chosen", () => {
		expect(repoDirectPushes({ merge_policy: "", instance_config: null })).toBe(true);
		expect(repoDirectPushes({})).toBe(true);
	});

	it("runs on an explicit `merge` repo", () => {
		expect(repoDirectPushes({ merge_policy: "merge", instance_config: null })).toBe(true);
	});

	it("skips `pr` — GitHub's merged-PR auto-close already covers it", () => {
		expect(repoDirectPushes({ merge_policy: "pr", instance_config: null })).toBe(false);
	});

	it("skips `none` — nothing is ever pushed to a shared branch", () => {
		expect(repoDirectPushes({ merge_policy: "none", instance_config: null })).toBe(false);
	});

	it("falls back to the agent setting when the repo does not override", () => {
		expect(repoDirectPushes({ merge_policy: "", instance_config: cfg("pr") })).toBe(false);
		expect(repoDirectPushes({ merge_policy: "", instance_config: cfg("none") })).toBe(false);
		expect(repoDirectPushes({ merge_policy: "", instance_config: cfg("merge") })).toBe(true);
	});

	it("lets the repo override the agent, in BOTH directions", () => {
		// "unless a repo sets its own" — the precedence #817 asks for, and it has to cut both ways
		// or a repo could only ever be more restrictive than its agent.
		expect(repoDirectPushes({ merge_policy: "merge", instance_config: cfg("pr") })).toBe(true);
		expect(repoDirectPushes({ merge_policy: "pr", instance_config: cfg("merge") })).toBe(false);
	});

	it("treats an unrecognised value as unset rather than inventing a policy", () => {
		expect(repoDirectPushes({ merge_policy: "MERGE_ALL_THE_THINGS", instance_config: cfg("pr") })).toBe(false);
		expect(repoDirectPushes({ merge_policy: "nonsense", instance_config: null })).toBe(true);
	});

	it("treats a malformed instance config as unset, not as a restriction", () => {
		// Failing closed here would switch the feature off for an owner who chose `merge`, with no
		// error anywhere — the silent-nothing-happens failure this codebase keeps paying for.
		expect(repoDirectPushes({ merge_policy: "", instance_config: "{not json" })).toBe(true);
	});
});
