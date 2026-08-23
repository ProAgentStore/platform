import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	decideDeployNotification,
	DEPLOY_MAX_UNORDERED_AGE_MS,
	deployDeepLink,
	deployEventKey,
	type DeployWatchState,
	isDeployWorkflow,
	runDeployWatch,
	type WatchedRun,
} from "./deploy-watch.js";
import { logError } from "./error-log.js";
import { fetchWorkflowRuns } from "./github-actions.js";
import { resolveGithubRead } from "./github-cache.js";
import { notifyUser } from "../routes/push.js";
import type { Env } from "../types.js";

// The sweep's collaborators, stubbed so the tests below are about the WRITE it performs. Both
// GitHub modules keep their real exports (`mapWorkflowRun` does the raw-run mapping the sweep
// depends on, and stubbing it would test the double instead of the code).
vi.mock("./github-actions.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./github-actions.js")>()),
	fetchWorkflowRuns: vi.fn(),
}));
vi.mock("./github-cache.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./github-cache.js")>()),
	resolveGithubRead: vi.fn(),
}));
vi.mock("../routes/push.js", () => ({ notifyUser: vi.fn(async () => undefined) }));
vi.mock("./error-log.js", () => ({ logError: vi.fn(async () => undefined) }));

/** The same-origin console target every notification now carries (#338). */
const LINK = deployDeepLink("inst_1", "repo_1");

const run = (over: Partial<WatchedRun> = {}): WatchedRun => ({
	id: "run_2",
	status: "completed",
	conclusion: "success",
	runNumber: 42,
	url: "https://github.com/acme/app/actions/runs/2",
	sha: "abc1234def5678",
	workflowName: "Deploy API Worker",
	workflowPath: ".github/workflows/deploy-api.yml",
	updatedAt: "2026-08-07T10:00:00Z",
	...over,
});

/** A watermark in the current format, so a test can start from "we have spoken before". */
const seen = (sha: string) => `sha:${sha}`;

/** Five minutes after the fixture run finished — a sweep behaving normally. */
const NOW = Date.parse("2026-08-07T10:05:00Z");

/**
 * The watcher's stored state. `lastDeployAt` defaults to `null`, which is both the shape of every
 * row written before #708 and the state the guards below were originally written against — so the
 * pre-existing expectations are still testing what they were testing.
 */
const state = (lastNotified: string | null, over: Partial<DeployWatchState> = {}): DeployWatchState => ({
	lastNotified,
	lastDeployAt: null,
	now: NOW,
	...over,
});

describe("isDeployWorkflow", () => {
	// The root error in #359: a green `ci.yml` produced "✅ Deployed #412 — PAGS is live".
	// Nothing was deployed and nothing went live; typecheck passed.
	it("does not call CI a deploy", () => {
		expect(isDeployWorkflow("CI", ".github/workflows/ci.yml")).toBe(false);
		expect(isDeployWorkflow("Publish npm", ".github/workflows/publish-npm.yml")).toBe(false);
		expect(isDeployWorkflow("Publish MCP registry", ".github/workflows/publish-mcp-registry.yml")).toBe(false);
	});

	it("recognises the deploy workflows this platform actually ships", () => {
		expect(isDeployWorkflow("Deploy API Worker", ".github/workflows/deploy-api.yml")).toBe(true);
		expect(isDeployWorkflow("", ".github/workflows/deploy.yml")).toBe(true); // scaffolded agent repos
		expect(isDeployWorkflow("Deploy TestFlight", ".github/workflows/deploy-testflight.yml")).toBe(true);
	});
});

describe("decideDeployNotification", () => {
	// THE dangerous case. Every repo that already exists has a completed run behind it, so a
	// watcher that notified on whatever it found first would — on the very deploy that ships
	// this — push every user a notification about a build they ran days ago.
	it("never notifies on FIRST sight; it seeds the watermark silently", () => {
		const d = decideDeployNotification([run()], state(null), "acme/app", LINK);
		expect(d.notify).toBe(false);
		expect(d.seenId).toBe(seen("abc1234def5678"));
		expect(d).toMatchObject({ reason: "first-sight" });
	});

	// The upgrade path. A watermark written before #359 is a RUN ID, which can never equal a
	// commit sha — without this it would read as "new" and announce a deploy that already went.
	it("treats a pre-#359 run-id watermark as first sight", () => {
		const d = decideDeployNotification([run()], state("17253884012"), "acme/app", LINK);
		expect(d).toMatchObject({ notify: false, reason: "first-sight", seenId: seen("abc1234def5678") });
	});

	// The reported symptom: one push, two to four notifications. Several workflows for ONE
	// commit is one deploy with several parts.
	it("collapses every deploy workflow of one commit into a single notification", () => {
		const runs = [
			run({ id: "1", workflowName: "Deploy API Worker", workflowPath: ".github/workflows/deploy-api.yml" }),
			run({ id: "2", workflowName: "Deploy Host Worker", workflowPath: ".github/workflows/deploy-host.yml" }),
			run({ id: "3", workflowName: "CI", workflowPath: ".github/workflows/ci.yml" }),
		];
		const d = decideDeployNotification(runs, state(seen("older")), "acme/app", LINK);
		expect(d.notify).toBe(true);
		if (d.notify) {
			expect(d.body).toContain("Deploy API Worker");
			expect(d.body).toContain("Deploy Host Worker");
			// CI is not a deploy and must not be named as one.
			expect(d.body).not.toContain("CI");
			expect(d.seenId).toBe(seen("abc1234def5678"));
		}
		// ...and the second sweep, a minute later with the same runs, says nothing.
		const again = decideDeployNotification(runs, state(d.seenId, { lastDeployAt: d.seenAt }), "acme/app", LINK);
		expect(again).toMatchObject({ notify: false, reason: "already-notified" });
	});

	// A CI-only repo gets SILENCE, not a lie. That is the deliberate trade: the watcher speaks
	// only for a workflow that puts something live.
	it("says nothing when no completed run is a deploy", () => {
		const d = decideDeployNotification(
			[run({ workflowName: "CI", workflowPath: ".github/workflows/ci.yml" })],
			state(seen("older")),
			"acme/app",
			LINK,
		);
		expect(d).toMatchObject({ notify: false, reason: "no-run" });
	});

	// Concurrency groups cancel a superseded run routinely, so pushing twice in quick
	// succession used to raise "❌ Build failed — cancelled" for a build that merely lost a race.
	it("is silent about a cancelled run, and does not burn the watermark on it", () => {
		for (const conclusion of ["cancelled", "skipped", "neutral", "stale", null]) {
			const d = decideDeployNotification([run({ conclusion })], state(seen("older")), "acme/app", LINK);
			expect(d).toMatchObject({ notify: false, reason: "still-running" });
			expect(d.seenId).toBe(seen("older")); // the commit can still be reported when a real run lands
		}
	});

	it("says what happened when the deploy failed, and names the workflow that failed", () => {
		const runs = [
			run({ id: "1", conclusion: "failure", workflowName: "Deploy API Worker" }),
			run({ id: "2", conclusion: "success", workflowName: "Deploy Host Worker" }),
		];
		const d = decideDeployNotification(runs, state(seen("older")), "acme/app", LINK);
		expect(d.notify).toBe(true);
		if (d.notify) {
			expect(d.title).toContain("failed");
			expect(d.body).toContain("Deploy API Worker");
			expect(d.body).not.toContain("Deploy Host Worker"); // it succeeded — do not blame it
		}
	});

	// #359's third wrongness: `#412` from CI and `#88` from Deploy API arrive for the same
	// commit, so the number carries no meaning across notifications. The short sha does.
	it("identifies the deploy by commit, not by a per-workflow run number", () => {
		const d = decideDeployNotification([run()], state(seen("older")), "acme/app", LINK);
		if (d.notify) {
			expect(d.title).toContain("abc1234");
			expect(d.title).not.toContain("#42");
		}
	});

	it("reports the NEWEST commit when several are on the page", () => {
		const runs = [
			run({ id: "old", sha: "1111111", updatedAt: "2026-08-07T09:00:00Z" }),
			run({ id: "new", sha: "2222222", updatedAt: "2026-08-07T11:00:00Z" }),
		];
		const d = decideDeployNotification(runs, state(seen("older")), "acme/app", LINK);
		expect(d.seenId).toBe(seen("2222222"));
		if (d.notify) expect(d.body).not.toContain("1111111");
	});

	it("stays quiet while a deploy is still going, and keeps the old watermark", () => {
		for (const status of ["queued", "in_progress"]) {
			const d = decideDeployNotification([run({ status, conclusion: null })], state(seen("older")), "acme/app", LINK);
			expect(d.notify).toBe(false);
			expect(d.seenId).toBe(seen("older")); // not advanced — this deploy has yet to be reported
		}
	});

	it("handles a repo with no runs at all", () => {
		const d = decideDeployNotification([], state(null), "acme/app", LINK);
		expect(d.notify).toBe(false);
		expect(d.seenId).toBeNull();
	});

	// #708. Everything above is about an event's IDENTITY — which run counts, which workflow
	// counts, which key means "the same thing". These are about its ORDER, which is the layer
	// four previous fixes never had a word for.
	describe("never goes backwards (#708)", () => {
		// The whole defect in one assertion. `updated_at` older than the recorded deploy means the
		// page is a snapshot from before we last spoke — GitHub serves one about 1 request in 290.
		it("refuses a page whose newest deploy run predates the deploy already reported", () => {
			const d = decideDeployNotification(
				[run({ sha: "0ldc0mm1t", updatedAt: "2026-07-25T07:29:36Z" })],
				state(seen("abc1234def5678"), { lastDeployAt: "2026-08-07T10:00:00Z" }),
				"acme/app",
				LINK,
			);
			expect(d).toMatchObject({ notify: false, reason: "stale-page" });
			// BOTH halves must hold. Refusing to speak while still writing the older commit back
			// would leave the roll-back — and therefore the second buzz — exactly where it was.
			expect(d.seenId).toBe(seen("abc1234def5678"));
			expect(d.seenAt).toBe("2026-08-07T10:00:00Z");
		});

		// The observed shape: 82 rows in 52h for a repo nobody pushed to, as two commits
		// alternating 41 times. One stale read, then the true page, must be ONE event — and here,
		// because the true page names the commit already announced, zero.
		it("costs nothing when a stale sweep is followed by a correct one", () => {
			const good = run({ sha: "34bda95", updatedAt: "2026-08-07T10:00:00Z" });
			const stale = run({ sha: "4c86d53", updatedAt: "2026-07-31T06:12:10Z" });

			// Sweep 1: the real deploy, announced once.
			const first = decideDeployNotification(
				[good],
				state(seen("earlier"), { lastDeployAt: "2026-08-06T00:00:00Z" }),
				"acme/app",
				LINK,
			);
			expect(first.notify).toBe(true);

			// Sweep 2: GitHub answers with a three-week-old snapshot.
			const bad = decideDeployNotification(
				[stale],
				state(first.seenId, { lastDeployAt: first.seenAt }),
				"acme/app",
				LINK,
			);
			expect(bad).toMatchObject({ notify: false, reason: "stale-page" });

			// Sweep 3: the true page again. Pre-#708 this fired, because the watermark had been
			// rolled back to `4c86d53` and `34bda95` was "news" all over again.
			const third = decideDeployNotification(
				[good],
				state(bad.seenId, { lastDeployAt: bad.seenAt }),
				"acme/app",
				LINK,
			);
			expect(third).toMatchObject({ notify: false, reason: "already-notified" });
		});

		// The regression the fix could most easily cause. A deploy NEWER than the recorded one is
		// news however late the sweep is — the exact order test is what makes it safe to say that,
		// and it is why the age floor below is not consulted once the order is known.
		it("still announces a real deploy when the sweep has fallen hours behind", () => {
			const d = decideDeployNotification(
				[run({ sha: "feed1234", updatedAt: "2026-08-07T10:00:00Z" })],
				state(seen("abc1234def5678"), {
					lastDeployAt: "2026-08-07T09:00:00Z",
					now: Date.parse("2026-08-08T10:00:00Z"), // swept a full day later
				}),
				"acme/app",
				LINK,
			);
			expect(d.notify).toBe(true);
			expect(d.seenAt).toBe("2026-08-07T10:00:00Z");
		});

		// NULL `last_deploy_at` is every existing row on the morning this ships. It has to mean
		// "allow, then record": read as a floor it would silence every watched repo's next deploy
		// exactly once, which is the same class of bug being fixed.
		it("treats an unknown order as allow-then-record, not as a block", () => {
			const d = decideDeployNotification(
				[run({ sha: "feed1234" })],
				state(seen("abc1234def5678"), { lastDeployAt: null }),
				"acme/app",
				LINK,
			);
			expect(d.notify).toBe(true);
			expect(d.seenAt).toBe("2026-08-07T10:00:00Z");
		});

		// ...and the age floor is what covers that one unordered window. A weeks-old run is not
		// news whatever the watermark says: a deploy notification answers "is it green yet?", and
		// one arriving six hours late has no reader.
		it("declines an ancient run while the order is still unknown", () => {
			const d = decideDeployNotification(
				[run({ sha: "0ldc0mm1t", updatedAt: "2026-07-25T07:29:36Z" })],
				state(seen("abc1234def5678"), { lastDeployAt: null }),
				"acme/app",
				LINK,
			);
			expect(d).toMatchObject({ notify: false, reason: "stale-page" });
			expect(d.seenId).toBe(seen("abc1234def5678"));
			expect(d.seenAt).toBeNull();
		});

		it("puts the floor at six hours, and speaks for anything inside it", () => {
			const inside = NOW - DEPLOY_MAX_UNORDERED_AGE_MS + 60_000;
			const outside = NOW - DEPLOY_MAX_UNORDERED_AGE_MS - 60_000;
			const decide = (at: number) =>
				decideDeployNotification(
					[run({ sha: "feed1234", updatedAt: new Date(at).toISOString() })],
					state(seen("abc1234def5678"), { lastDeployAt: null }),
					"acme/app",
					LINK,
				);
			expect(decide(inside).notify).toBe(true);
			expect(decide(outside)).toMatchObject({ notify: false, reason: "stale-page" });
		});

		// The ONLY path by which an idle repo's NULL ever becomes a value — it sits on
		// `already-notified` every minute and never reaches the notify branch. Without this the
		// guard would stay dormant for precisely the repos that flapped most.
		it("records the order on already-notified, so an idle repo arms itself", () => {
			const d = decideDeployNotification([run()], state(seen("abc1234def5678")), "acme/app", LINK);
			expect(d).toMatchObject({ notify: false, reason: "already-notified" });
			expect(d.seenAt).toBe("2026-08-07T10:00:00Z");
		});

		// A run with no parseable timestamp must not erase a known one — that would hand the next
		// sweep an unknown order and reopen the window this closes.
		it("keeps the recorded instant when a run carries no usable timestamp", () => {
			const d = decideDeployNotification(
				[run({ sha: "feed1234", updatedAt: "" })],
				state(seen("abc1234def5678"), { lastDeployAt: "2026-08-07T09:00:00Z" }),
				"acme/app",
				LINK,
			);
			expect(d.notify).toBe(true);
			expect(d.seenAt).toBe("2026-08-07T09:00:00Z");
		});

		// First sight still says nothing, and now also records where it started from.
		it("seeds both halves of the watermark on first sight", () => {
			const d = decideDeployNotification([run()], state(null), "acme/app", LINK);
			expect(d).toMatchObject({ notify: false, reason: "first-sight" });
			expect(d.seenAt).toBe("2026-08-07T10:00:00Z");
		});

		// A quiet sweep must leave the recorded order alone as surely as it leaves the sha alone.
		it("holds both halves when there is nothing to report", () => {
			for (const runs of [[], [run({ status: "in_progress", conclusion: null })]]) {
				const d = decideDeployNotification(
					runs,
					state(seen("abc1234def5678"), { lastDeployAt: "2026-08-07T09:00:00Z" }),
					"acme/app",
					LINK,
				);
				expect(d.seenId).toBe(seen("abc1234def5678"));
				expect(d.seenAt).toBe("2026-08-07T09:00:00Z");
			}
		});
	});

	// #338: the click target is handed to an open tab via WindowClient.navigate(), which is
	// same-origin only. A github.com URL rejects there, the SW swallows it, and the click looks
	// broken — but ONLY when the console happens to be open, which is when it is most likely.
	it("never points a notification off-origin", () => {
		const d = decideDeployNotification([run({ conclusion: "failure" })], state(seen("older")), "acme/app", LINK);
		if (d.notify) {
			expect(d.url.startsWith("/")).toBe(true);
			expect(d.url).not.toContain("github.com");
		}
	});
});

describe("deployDeepLink", () => {
	it("addresses the repo's Builds view — a target that exists before the build does", () => {
		expect(deployDeepLink("inst_1", "repo_1")).toBe("/console/instances/inst_1/coding?builds=repo_1");
	});

	it("escapes the repo id rather than splicing it into the query", () => {
		expect(deployDeepLink("inst_1", "a&b=c")).toBe("/console/instances/inst_1/coding?builds=a%26b%3Dc");
	});
});

/**
 * The sweep itself (#708).
 *
 * The decision above is pure and exhaustively tested, but the defect was only half in the
 * decision: the sweep wrote whatever the decision computed back to `coding_repos`
 * UNCONDITIONALLY, which is what made a stale read's roll-back durable. So these assert the
 * WRITE, not the verdict — the thing a reader of `runDeployWatch` cannot check by eye.
 */
describe("runDeployWatch persists a watermark that only moves forward (#708)", () => {
	const raw = (over: Record<string, unknown> = {}) => ({
		id: 900,
		run_number: 12,
		status: "completed",
		conclusion: "success",
		name: "Deploy API Worker",
		path: ".github/workflows/deploy-api.yml",
		head_sha: "abc1234def5678",
		html_url: "https://github.com/acme/app/actions/runs/900",
		updated_at: "2026-08-07T10:00:00Z",
		...over,
	});

	const REPO = {
		id: "repo_1",
		instance_id: "inst_1",
		user_id: "alice",
		name: "acme/app",
		github_repo: "acme/app",
		last_deploy_run_id: "sha:abc1234def5678",
		last_deploy_at: "2026-08-07T10:00:00Z",
	};

	/** A D1 double that records every statement, so a test can assert what was WRITTEN. */
	function sweepEnv(repos: Array<Record<string, unknown>> = [REPO]) {
		const statements: Array<{ sql: string; args: unknown[] }> = [];
		const DB = {
			prepare(sql: string) {
				return {
					bind(...args: unknown[]) {
						statements.push({ sql, args });
						return {
							all: async () => ({ results: sql.includes("SELECT") ? repos : [] }),
							run: async () => ({ meta: { changes: 1 } }),
							first: async () => null,
						};
					},
				};
			},
		};
		const writes = () => statements.filter((s) => s.sql.includes("UPDATE coding_repos"));
		return { env: { DB } as unknown as Env, writes };
	}

	beforeEach(() => {
		vi.mocked(notifyUser).mockClear();
		vi.mocked(logError).mockClear();
		vi.mocked(resolveGithubRead).mockResolvedValue({ token: "tok", authContext: null } as never);
	});

	/**
	 * #745 — the whole-sweep SELECT was wrapped in a bare `catch` that returned with no log row, so
	 * a schema skew or a real D1 failure made the watcher do nothing every minute and look exactly
	 * like a healthy quiet period. An audit of #708 already paid for this: it read
	 * `/v1/admin/errors?source=deploy-watch` → count 0 over 27 hours and could not tell "no stale
	 * page arrived" from "the sweep never got past line 422".
	 */
	describe("a sweep that cannot read is reported, not silent (#745)", () => {
		/** A D1 whose batch SELECT throws; everything else behaves. */
		const brokenSelect = (message: string) =>
			({
				prepare: (sql: string) => ({
					bind: () => ({
						all: async () => {
							if (sql.includes("SELECT")) throw new Error(message);
							return { results: [] };
						},
						run: async () => ({ meta: { changes: 1 } }),
						first: async () => null,
					}),
				}),
			}) as unknown as Env["DB"];

		it("writes exactly one error row when the batch SELECT fails, and still returns", async () => {
			const env = { DB: brokenSelect("D1_ERROR: network") } as unknown as Env;
			await expect(runDeployWatch(env)).resolves.toBeUndefined();
			expect(logError).toHaveBeenCalledTimes(1);
			const e = vi.mocked(logError).mock.calls[0][1];
			expect(e.source).toBe("deploy-watch");
			expect(e.level).toBe("error");
			expect(e.message).toContain("NO repo was checked this tick");
			expect(e.message).toContain("D1_ERROR: network");
		});

		it("still returns quietly-ish on a not-yet-migrated table, but says so at warn", async () => {
			const env = { DB: brokenSelect("no such table: coding_repos") } as unknown as Env;
			await expect(runDeployWatch(env)).resolves.toBeUndefined();
			expect(logError).toHaveBeenCalledTimes(1);
			const e = vi.mocked(logError).mock.calls[0][1];
			expect(e.level).toBe("warn");
			expect(e.message).toContain("not migrated yet");
		});

		it("keeps the PER-REPO catch as an isolation boundary — one bad repo, the rest still swept", async () => {
			const { env, writes } = sweepEnv([{ ...REPO, id: "repo_bad" }, { ...REPO, id: "repo_ok", github_repo: "acme/other" }]);
			vi.mocked(fetchWorkflowRuns)
				.mockRejectedValueOnce(new Error("github 502"))
				.mockResolvedValue({ runs: [raw({ head_sha: "newsha000000", updated_at: "2026-08-07T12:00:00Z" })], stale: false });

			await runDeployWatch(env);

			// The second repo was still checked and still wrote its watermark.
			expect(writes().some((w) => w.args.includes("repo_ok"))).toBe(true);
			// …and the failure is countable now instead of invisible.
			expect(logError).toHaveBeenCalledTimes(1);
			const e = vi.mocked(logError).mock.calls[0][1];
			expect(e.message).toContain("github 502");
			expect(e.level).toBe("warn");
		});
	});

	it("declines a page the cache served because GitHub was unreachable, and writes no watermark", async () => {
		const { env, writes } = sweepEnv();
		vi.mocked(fetchWorkflowRuns).mockResolvedValue({
			runs: [raw({ head_sha: "0ldc0mm1t", updated_at: "2026-07-25T07:29:36Z" })],
			stale: true,
		});

		await runDeployWatch(env);

		expect(notifyUser).not.toHaveBeenCalled();
		// The rotation key still moves — a declined repo must not pin the batch to itself — but
		// neither half of the watermark is touched.
		expect(writes()).toHaveLength(1);
		expect(writes()[0].sql).not.toContain("last_deploy_run_id");
		expect(writes()[0].sql).toContain("last_deploy_checked_at");
		expect(logError).toHaveBeenCalledTimes(1);
	});

	// The main event. Pre-#708 this UPDATE rolled `last_deploy_run_id` back to the old commit,
	// which is what made the next correct sweep fire again — one bad read, two buzzes, forever.
	it("declines a page older than the deploy already reported, and does NOT roll the watermark back", async () => {
		const { env, writes } = sweepEnv();
		vi.mocked(fetchWorkflowRuns).mockResolvedValue({
			runs: [raw({ head_sha: "0ldc0mm1t", updated_at: "2026-07-25T07:29:36Z" })],
		});

		await runDeployWatch(env);

		expect(notifyUser).not.toHaveBeenCalled();
		expect(writes()).toHaveLength(1);
		expect(writes()[0].sql).not.toContain("last_deploy_run_id");
		expect(writes()[0].args).toEqual(["repo_1"]);
		expect(logError).toHaveBeenCalledTimes(1);
	});

	it("advances BOTH halves together on a real deploy", async () => {
		const { env, writes } = sweepEnv();
		vi.mocked(fetchWorkflowRuns).mockResolvedValue({
			runs: [raw({ head_sha: "feed1234beef", updated_at: "2026-08-07T11:00:00Z" })],
		});

		await runDeployWatch(env);

		expect(notifyUser).toHaveBeenCalledTimes(1);
		expect(writes()).toHaveLength(1);
		// An id without its instant is exactly the watcher that could not tell forward from
		// backward, so the two columns are written by one statement or not at all.
		expect(writes()[0].args).toEqual(["sha:feed1234beef", "2026-08-07T11:00:00Z", "repo_1"]);
	});

	// An idle repo never reaches the notify branch, so this is the only path by which a row
	// written before the migration acquires an order at all.
	it("records the order on a quiet sweep, so a NULL row arms itself without a backfill", async () => {
		const { env, writes } = sweepEnv([{ ...REPO, last_deploy_at: null }]);
		vi.mocked(fetchWorkflowRuns).mockResolvedValue({ runs: [raw()] });

		await runDeployWatch(env);

		expect(notifyUser).not.toHaveBeenCalled();
		expect(writes()[0].args).toEqual(["sha:abc1234def5678", "2026-08-07T10:00:00Z", "repo_1"]);
	});
});

/**
 * The fan-out (#709) — the second, independent multiplier on the same 198 rows.
 *
 * A repo is attached PER WORKSPACE, so the owner has four `coding_repos` rows pointing at
 * `ProAgentStore/platform`. The sweep is per row, which is right; the EVENT KEY carried the row
 * id, which meant the #361 floor saw four unrelated events and one push buzzed four times in 39
 * seconds. 32 real deploys → 66 distinct (row, commit) events = 2.1×.
 */
describe("one deploy is one event, however many workspaces watch it (#709)", () => {
	it("keys the event on the repository, never on the coding_repos row", () => {
		const key = deployEventKey("ProAgentStore/platform", "sha:b91d340");
		expect(key).toBe("deploy:proagentstore/platform:sha:b91d340");
		expect(key).not.toContain("repo_");
	});

	// Two rows can spell one repository differently — GitHub is case-insensitive about
	// `owner/name`, and a key that is not is a key that does not collapse.
	it("normalises case, so two spellings of one repository are one event", () => {
		expect(deployEventKey("ProAgentStore/Platform", "sha:b91d340")).toBe(
			deployEventKey("proagentstore/platform", "sha:b91d340"),
		);
	});

	// ...and two genuinely different repositories that happen to deploy the same commit — a fork,
	// a mirror — stay two events, because the repository IS in the key.
	it("keeps two repositories apart even on an identical commit", () => {
		expect(deployEventKey("acme/app", "sha:b91d340")).not.toBe(deployEventKey("acme/app-fork", "sha:b91d340"));
	});
});

describe("runDeployWatch collapses a deploy across workspaces (#709)", () => {
	const raw = {
		id: 900,
		run_number: 12,
		status: "completed",
		conclusion: "success",
		name: "Deploy API Worker",
		path: ".github/workflows/deploy-api.yml",
		head_sha: "b91d340feed12",
		html_url: "https://github.com/acme/app/actions/runs/900",
		updated_at: "2026-08-07T11:00:00Z",
	};

	/** Four workspaces on ONE repository, spelled two ways — the owner's measured shape. */
	const rows = [
		{ id: "repo_f60491cd", instance_id: "inst_a", user_id: "alice", name: "pags/platform", github_repo: "ProAgentStore/platform", last_deploy_run_id: "sha:old", last_deploy_at: "2026-08-07T09:00:00Z" },
		{ id: "repo_2b2657fb", instance_id: "inst_a", user_id: "alice", name: "ProAgentStore/platform", github_repo: "proagentstore/platform", last_deploy_run_id: "sha:old", last_deploy_at: "2026-08-07T09:00:00Z" },
		{ id: "repo_fed4078a", instance_id: "inst_b", user_id: "alice", name: "pags/platform", github_repo: "ProAgentStore/platform", last_deploy_run_id: "sha:old", last_deploy_at: "2026-08-07T09:00:00Z" },
		{ id: "repo_1aa2c3f5", instance_id: "inst_c", user_id: "alice", name: "pags/platform", github_repo: "ProAgentStore/platform", last_deploy_run_id: "sha:old", last_deploy_at: "2026-08-07T09:00:00Z" },
	];

	it("hands the floor ONE event key for four workspaces, while each keeps its own deep link", async () => {
		const DB = {
			prepare(sql: string) {
				return {
					bind: () => ({
						all: async () => ({ results: sql.includes("SELECT") ? rows : [] }),
						run: async () => ({ meta: { changes: 1 } }),
						first: async () => null,
					}),
				};
			},
		};
		vi.mocked(notifyUser).mockClear();
		vi.mocked(resolveGithubRead).mockResolvedValue({ token: "tok", authContext: null } as never);
		vi.mocked(fetchWorkflowRuns).mockResolvedValue({ runs: [raw] });

		await runDeployWatch({ DB } as unknown as Env);

		const calls = vi.mocked(notifyUser).mock.calls;
		expect(calls).toHaveLength(4);
		// The floor (#361) collapses on the event key, and it can only do that if all four agree.
		const keys = new Set(calls.map((c) => (c[6] as { key?: string })?.key));
		expect(keys.size).toBe(1);
		expect([...keys][0]).toBe("deploy:proagentstore/platform:sha:b91d340feed12");
		// Four ROWS are still written, each pointing at its own workspace — the bell list is a log
		// and #338's deep link is per workspace. Only the interruption collapses.
		expect(new Set(calls.map((c) => c[5]))).toEqual(
			new Set([
				"/console/instances/inst_a/coding?builds=repo_f60491cd",
				"/console/instances/inst_a/coding?builds=repo_2b2657fb",
				"/console/instances/inst_b/coding?builds=repo_fed4078a",
				"/console/instances/inst_c/coding?builds=repo_1aa2c3f5",
			]),
		);
	});
});
