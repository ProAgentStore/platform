/** Real-schema picker coverage: GitHub pages and queue start are the only fakes. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runAutoPickup, setAutoPickup, type AutoPickupDeps } from "./auto-pickup.js";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./d1-sqlite.js";
import type { IssueSummary, IssuesPage } from "./github-issues.js";
import type { Env } from "../types.js";

let db: RealSchemaD1;
let env: Env;
const issue = (number: number, labels: string[] = []): IssueSummary => ({ number, title: `issue ${number}`, state: "open", labels, assignees: [], comments: 0, updatedAt: "", url: `u/${number}` });
const page = (n: number, issues: IssueSummary[], hasMore = false): IssuesPage => ({ page: n, issues, hasMore });
const oldExcluded = Array.from({ length: 100 }, (_, i) => issue(i + 1, ["needs-human"]));
const deps = (read: (repo: string, n: number) => Promise<IssuesPage>): AutoPickupDeps => ({ listIssuePage: read, notify: async () => undefined, postComment: async () => true, startQueued: async () => ({ drained: true, started: true, runId: "r", driver: "d" }) });

beforeEach(async () => {
	db = realSchemaD1();
	seedTenant(db, { userId: "u1", instanceIds: ["coder"] });
	db.exec("INSERT INTO coding_repos (id, instance_id, user_id, name, github_repo) VALUES ('repo', 'coder', 'u1', 'app', 'acme/app')");
	env = { DB: db.DB } as unknown as Env;
	await setAutoPickup(env, "coder", "u1", { enabled: true });
});
afterEach(() => db.close());

it("passes 100 oldest ineligible issues and starts eligible work on page two", async () => {
	const read = vi.fn(async (_repo: string, n: number) => n === 1 ? page(1, oldExcluded, true) : page(2, [issue(101)]));
	expect(await runAutoPickup(env, "coder", "u1", deps(read))).toMatchObject({ started: true, issue: 101 });
	expect(read.mock.calls.map((c) => c[1])).toEqual([1, 2]);
});

it("continues across a PR-only page and ranks/deduplicates the combined fetched issues", async () => {
	const read = vi.fn(async (_repo: string, n: number) => n === 1 ? page(1, [], true) : n === 2 ? page(2, [issue(101, ["P3"])], true) : page(3, [issue(101, ["P3"]), issue(102, ["P0"])]));
	expect(await runAutoPickup(env, "coder", "u1", deps(read))).toMatchObject({ started: true, issue: 102 });
	expect(read.mock.calls.map((c) => c[1])).toEqual([1, 2, 3]);
});

it("bounds full-page scans and reports incomplete rather than no eligible work", async () => {
	const read = vi.fn(async (_repo: string, n: number) => page(n, oldExcluded, true));
	const result = await runAutoPickup(env, "coder", "u1", deps(read));
	expect(result).toMatchObject({ started: false, reason: expect.stringMatching(/scan incomplete.*additional work may remain/) });
	expect(read.mock.calls.map((c) => c[1])).toEqual([1, 2, 3, 4, 5]);
	expect(db.sqlite.prepare("SELECT outcome FROM auto_pickup_log WHERE outcome = 'none_eligible'").all()).toEqual([]);
	expect(db.sqlite.prepare("SELECT outcome FROM auto_pickup_log WHERE outcome = 'error'").all()).toHaveLength(1);
});

it.each(["unreadable", "throws"])("a later %s page preserves eligible candidates already read", async (failure) => {
	const read = vi.fn(async (_repo: string, n: number): Promise<IssuesPage> => {
		if (n === 1) return page(1, [issue(101)], true);
		if (failure === "throws") throw new Error("GitHub unavailable");
		return { ...page(n, []), unreadable: true };
	});
	expect(await runAutoPickup(env, "coder", "u1", deps(read))).toMatchObject({ started: true, issue: 101 });
	expect(read).toHaveBeenCalledTimes(2);
	const log = db.sqlite.prepare("SELECT detail FROM auto_pickup_log WHERE outcome = 'started'").get() as { detail: string };
	expect(log.detail).toContain("issue scan incomplete");
});

it("a failed first page cannot be reported as an empty backlog", async () => {
	const read = vi.fn(async (_repo: string, n: number) => ({ ...page(n, []), unreadable: true }));
	expect(await runAutoPickup(env, "coder", "u1", deps(read))).toMatchObject({ started: false, reason: expect.stringContaining("scan incomplete") });
	expect(read).toHaveBeenCalledTimes(1);
	expect(db.sqlite.prepare("SELECT outcome FROM auto_pickup_log WHERE outcome = 'none_eligible'").all()).toEqual([]);
});
