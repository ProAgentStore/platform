/**
 * #1714 / #1713 — the cloud half of the checkout strategy at run boundaries, over the real schema; only the runner and GitHub are faked.
 *
 * What must hold: a repository with no stored strategy sends and asks NOTHING new; an explicit `shared-direct` is admitted only onto a clean
 * checkout and the refusal names the paths; an isolated repository whose runner did not isolate is refused in words; an isolated run is
 * published (direct push, or a branch plus a pull request ONLY for `isolated-pr`) and its worktree removed only after the runner says it
 * reads back; and an older runner (every route 404s) leaves all of it a no-op.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type RealSchemaD1, realSchemaD1, seedTenant } from "./d1-sqlite.js";
import type { CodingRepo } from "./coding-types.js";
import type { RunnerConn } from "./runner-client.js";
import type { Env } from "../types.js";

const runner = vi.hoisted(() => ({ calls: [] as Array<{ path: string; body: Record<string, unknown> }>, answers: {} as Record<string, unknown> }));
vi.mock("./runner-client.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./runner-client.js")>()),
	callRunner: async (_conn: unknown, path: string, body: Record<string, unknown>) => {
		runner.calls.push({ path, body });
		const a = runner.answers[path];
		if (a === undefined || a instanceof Error) throw a ?? new Error("404 not found");
		return a;
	},
}));
const prOpen = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>>, result: { ok: true, number: 7, url: "https://github.com/o/r/pull/7", existed: false } as unknown }));
vi.mock("./github-pr-open.js", () => ({
	openRunPullRequest: async (_env: unknown, _user: string, input: Record<string, unknown>) => {
		prOpen.calls.push(input);
		return prOpen.result;
	},
}));
const { notIsolatedRefusal, publishIsolatedRun, sharedAdmissionRefusal } = await import("./isolated-run.js");

const INSTANCE = "a185b1db-c560-456d-9522-f7792bd95cca";
const conn = { runnerNode: "pink-laptop" } as unknown as RunnerConn;
let d1: RealSchemaD1;
let env: Env;
const repo = (strategy?: CodingRepo["strategy"]) => ({ id: "r1", name: "o/r", workdir: "/w/r", githubRepo: "o/r", branch: "main", strategy }) as unknown as CodingRepo;
const timeline = () => d1.DB.prepare("SELECT content FROM coding_timeline WHERE session_id = 'csess_1' ORDER BY seq").all<{ content: string }>().then((r) => (r.results ?? []).map((x) => x.content));
const paths = () => runner.calls.map((c) => c.path);

beforeEach(() => {
	d1 = realSchemaD1();
	env = { DB: d1.DB } as unknown as Env;
	seedTenant(d1, { userId: "u1", instanceIds: [INSTANCE] });
	d1.exec(`INSERT INTO coding_repos (id, instance_id, user_id, name, workdir, clone_status) VALUES ('r1', '${INSTANCE}', 'u1', 'o/r', '/w/r', 'ready')`);
	d1.exec(`INSERT INTO coding_sessions (id, instance_id, user_id, repo_id, client_type, status) VALUES ('csess_1', '${INSTANCE}', 'u1', 'r1', 'claude', 'active')`);
	runner.calls = [];
	runner.answers = {};
	prOpen.calls = [];
	prOpen.result = { ok: true, number: 7, url: "https://github.com/o/r/pull/7", existed: false };
});
afterEach(() => d1.close());

const run = (r: CodingRepo) => publishIsolatedRun(env, conn, { instanceId: INSTANCE, userId: "u1", sessionId: "csess_1", repo: r, objective: "Fix the login bug\nmore detail", runId: "run-1" });

describe("sharedAdmissionRefusal (#1714)", () => {
	it("asks nothing of a repository with no stored strategy, or an isolated one", async () => {
		expect(await sharedAdmissionRefusal(conn, repo(undefined))).toBeNull();
		expect(await sharedAdmissionRefusal(conn, repo("isolated-direct"))).toBeNull();
		expect(runner.calls).toEqual([]);
	});

	it("an explicit shared-direct repository is admitted when the checkout is clean", async () => {
		runner.answers["/coding/admit-checkout"] = { ok: true, blocking: [], blockingCount: 0 };
		expect(await sharedAdmissionRefusal(conn, repo("shared-direct"))).toBeNull();
		expect(runner.calls[0]).toMatchObject({ path: "/coding/admit-checkout", body: { repoId: "r1", workDir: "/w/r" } });
	});

	it("refuses a dirty one, naming the paths and saying nothing was touched", async () => {
		runner.answers["/coding/admit-checkout"] = { ok: false, blocking: ["src/a.ts", "new.txt"], blockingCount: 2 };
		const why = await sharedAdmissionRefusal(conn, repo("shared-direct"));
		expect(why).toContain("`src/a.ts`");
		expect(why).toContain("`new.txt`");
		expect(why).toMatch(/2 uncommitted paths are in the way/);
		expect(why).toMatch(/Nothing was stashed, reset or cleaned/);
	});

	it("an older runner (404) admits as before", async () => {
		expect(await sharedAdmissionRefusal(conn, repo("shared-direct"))).toBeNull();
	});
});

describe("notIsolatedRefusal (#1714)", () => {
	it("is silent for a repository that is not isolated, and for a runner that reported its worktree", () => {
		expect(notIsolatedRefusal(repo(undefined), {})).toBeNull();
		expect(notIsolatedRefusal(repo("shared-direct"), {})).toBeNull();
		expect(notIsolatedRefusal(repo("isolated-pr"), { checkout: { mode: "worktree", path: "/wt/x" } })).toBeNull();
	});

	it("says so when an isolated repository's runner ran shared", () => {
		const why = notIsolatedRefusal(repo("isolated-pr"), {}, "pink-laptop");
		expect(why).toMatch(/set to isolated-pr/);
		expect(why).toMatch(/pink-laptop/);
		expect(why).toMatch(/did not report an isolated worktree/);
		expect(why).toMatch(/not started/);
	});
});

describe("publishIsolatedRun (#1713)", () => {
	it("does nothing, and asks the runner nothing, for a repository with no stored strategy or shared/direct", async () => {
		expect(await run(repo(undefined))).toBeNull();
		expect(await run(repo("shared-direct"))).toBeNull();
		expect(runner.calls).toEqual([]);
	});

	it("an older runner (404) is a no-op", async () => {
		expect(await run(repo("isolated-direct"))).toBeNull();
		expect(paths()).toEqual(["/coding/worktree-publish"]);
	});

	it("a session with no worktree on the runner is a no-op", async () => {
		runner.answers["/coding/worktree-publish"] = { isolated: false };
		expect(await run(repo("isolated-pr"))).toBeNull();
		expect(prOpen.calls).toEqual([]);
	});

	it("isolated-direct: publishes, then removes the worktree, opening no pull request", async () => {
		runner.answers["/coding/worktree-publish"] = { isolated: true, ok: true, mode: "direct", target: "main", sha: "abcdef0123456789" };
		runner.answers["/coding/worktree-finish"] = { isolated: true, removed: true };
		const line = await run(repo("isolated-direct"));
		expect(line).toMatch(/Published abcdef01 to `main`/);
		expect(line).toMatch(/worktree was removed/);
		expect(paths()).toEqual(["/coding/worktree-publish", "/coding/worktree-finish"]);
		expect(runner.calls[0].body).toMatchObject({ sessionId: "csess_1", repoId: "r1", expect: "direct" });
		expect(prOpen.calls).toEqual([]);
		expect(await timeline()).toEqual([line]);
	});

	it("isolated-pr: opens the pull request from the pushed branch, then removes the worktree", async () => {
		runner.answers["/coding/worktree-publish"] = { isolated: true, ok: true, mode: "pr", target: "main", branch: "pags/run/x", sha: "abcdef0123456789" };
		runner.answers["/coding/worktree-finish"] = { isolated: true, removed: true };
		const line = await run(repo("isolated-pr"));
		expect(runner.calls[0].body).toMatchObject({ expect: "pr" });
		expect(prOpen.calls).toEqual([expect.objectContaining({ githubRepo: "o/r", head: "pags/run/x", base: "main", title: "Fix the login bug" })]);
		expect(line).toMatch(/Opened pull request #7/);
		expect(line).toMatch(/worktree was removed/);
		expect(paths()).toEqual(["/coding/worktree-publish", "/coding/worktree-finish"]);
	});

	it("isolated-pr: a pull request that could not be opened keeps the worktree and says the branch is pushed", async () => {
		runner.answers["/coding/worktree-publish"] = { isolated: true, ok: true, mode: "pr", target: "main", branch: "pags/run/x", sha: "abcdef0123456789" };
		prOpen.result = { ok: false, error: "no GitHub App installation covers o" };
		const line = await run(repo("isolated-pr"));
		expect(line).toMatch(/was pushed, but its pull request could not be opened: no GitHub App installation/);
		expect(paths()).toEqual(["/coding/worktree-publish"]);
	});

	it("a publication the runner refused (dirty, moved target, mode mismatch) keeps everything and says why", async () => {
		for (const reason of ["dirty", "target_moved", "mode_mismatch"]) {
			runner.calls = [];
			runner.answers["/coding/worktree-publish"] = { isolated: true, ok: false, reason, error: "kept" };
			const line = await run(repo("isolated-direct"));
			expect(line).toContain(`NOT published (${reason}`);
			expect(line).toMatch(/nothing was pushed and nothing was deleted/);
			expect(paths()).toEqual(["/coding/worktree-publish"]);
		}
		expect(prOpen.calls).toEqual([]);
	});

	it("a worktree the runner will not remove is kept and reported, not deleted", async () => {
		runner.answers["/coding/worktree-publish"] = { isolated: true, ok: true, mode: "direct", target: "main", sha: "abcdef0123456789" };
		runner.answers["/coding/worktree-finish"] = { isolated: true, removed: false, refused: "2 uncommitted files remain" };
		expect(await run(repo("isolated-direct"))).toMatch(/worktree was kept \(2 uncommitted files remain\)/);
	});
});
