import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../types.js";

/**
 * #903: default-branch CI/deploy health for a coding instance's repos. The rules are pure and tested
 * directly; the sweep is tested against a stateful `coding_repos` stand-in with GitHub and the
 * notifier mocked at their module boundaries, so "alerts once" and "unknown moves nothing" are
 * claims about what is STORED and SENT, not about a helper's return value.
 */

const github = vi.hoisted(() => ({
	meta: { ok: true, data: { default_branch: "main" }, stale: false } as Record<string, unknown>,
	runs: { runs: [] } as Record<string, unknown>,
	token: "tok" as string | null,
	workflows: [] as Array<{ path: string; state: string }>,
	perWorkflow: {} as Record<string, unknown[]>,
}));
const notified = vi.hoisted(() => [] as Array<{ userId: string; title: string; body: string; key?: string }>);

vi.mock("./github-cache.js", () => ({
	resolveGithubRead: vi.fn(async () => ({ token: github.token, authContext: "ctx" })),
	// The workflow LIST (#898) answers from `github.workflows`; every other read is the repo meta.
	githubConditionalJson: vi.fn(async (_env: unknown, args: { url: string }) =>
		args.url.includes("/actions/workflows?") ? { ok: true, data: { workflows: github.workflows }, stale: false } : github.meta,
	),
}));
vi.mock("./github-actions.js", () => ({
	fetchWorkflowRuns: vi.fn(async (_repo: string, _token: unknown, opts: { workflow?: string }) =>
		opts.workflow ? { runs: github.perWorkflow[opts.workflow] ?? [] } : github.runs,
	),
}));
vi.mock("../routes/push.js", () => ({
	notifyUser: vi.fn(async (_env: Env, userId: string, _type: string, title: string, body: string, _url: string, opts: { key?: string }) => {
		notified.push({ userId, title, body, key: opts.key });
	}),
}));
vi.mock("./error-log.js", () => ({ logError: vi.fn(async () => undefined) }));

const { assessCiRuns, checkRepoCi, CI_STALE_AFTER_MS, decideCiAlerts, instanceRepoCi, overallCiState } = await import("./repo-ci-health.js");
type CiRun = Parameters<typeof assessCiRuns>[0][number];

const NOW = Date.parse("2026-10-02T12:00:00Z");
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
let seq = 0;
function run(over: Partial<CiRun> = {}): CiRun {
	seq++;
	return {
		id: String(1000 + seq),
		workflowName: "CI",
		workflowPath: ".github/workflows/ci.yml",
		event: "push",
		branch: "main",
		status: "completed",
		conclusion: "success",
		sha: `sha${seq}aaaaaaa`,
		url: `https://github.com/o/r/actions/runs/${1000 + seq}`,
		createdAt: iso(10),
		...over,
	};
}
const raw = (r: CiRun) => ({
	id: Number(r.id),
	name: r.workflowName,
	path: r.workflowPath,
	event: r.event,
	head_branch: r.branch,
	status: r.status,
	conclusion: r.conclusion,
	head_sha: r.sha,
	html_url: r.url,
	created_at: r.createdAt,
});
const deployPath = ".github/workflows/deploy.yml";

describe("assessCiRuns — what counts (#903)", () => {
	it("green: every workflow's newest decisive run succeeded → passing, nothing to alert", () => {
		const w = assessCiRuns([run(), run({ workflowName: "Deploy", workflowPath: deployPath })], "main", NOW);
		expect(overallCiState(w)).toBe("passing");
		expect(w.map((x) => x.kind).sort()).toEqual(["ci", "deploy"]);
		expect(decideCiAlerts(w, {}).newlyFailing).toEqual([]);
	});

	it("red: the newest decisive run failed → failing, whatever passed before it", () => {
		const w = assessCiRuns([run({ conclusion: "failure", createdAt: iso(5) }), run({ createdAt: iso(60) })], "main", NOW);
		expect(overallCiState(w)).toBe("failing");
		expect(w[0]).toMatchObject({ state: "failing", conclusion: "failure" });
	});

	it("timed_out and startup_failure are failures too", () => {
		expect(assessCiRuns([run({ conclusion: "timed_out" })], "main", NOW)[0].state).toBe("failing");
		expect(assessCiRuns([run({ conclusion: "startup_failure" })], "main", NOW)[0].state).toBe("failing");
	});

	it("pending: a run still going is not a failure, and an undecided-only workflow is pending", () => {
		const afterGreen = assessCiRuns([run({ status: "in_progress", conclusion: null, createdAt: iso(1) }), run({ createdAt: iso(30) })], "main", NOW);
		expect(afterGreen[0]).toMatchObject({ state: "passing", running: true });
		const onlyRunning = assessCiRuns([run({ status: "queued", conclusion: null })], "main", NOW);
		expect(overallCiState(onlyRunning)).toBe("pending");
		expect(decideCiAlerts(onlyRunning, {}).newlyFailing).toEqual([]);
	});

	it("a run still going does not hide the failure before it — red is the last thing the pipeline said", () => {
		const w = assessCiRuns([run({ status: "in_progress", conclusion: null, createdAt: iso(1) }), run({ conclusion: "failure", createdAt: iso(30) })], "main", NOW);
		expect(w[0]).toMatchObject({ state: "failing", running: true });
	});

	it("cancelled, skipped, neutral and action_required are passed over — never counted as failures", () => {
		for (const conclusion of ["cancelled", "skipped", "neutral", "action_required", "stale"]) {
			const w = assessCiRuns([run({ conclusion, createdAt: iso(1) }), run({ createdAt: iso(30) })], "main", NOW);
			expect(w[0].state).toBe("passing");
			expect(assessCiRuns([run({ conclusion })], "main", NOW)).toEqual([]);
		}
	});

	it("non-default-branch, pull-request and manually triggered runs are ignored", () => {
		const w = assessCiRuns(
			[
				run({ branch: "feature/x", conclusion: "failure" }),
				run({ event: "pull_request", branch: "main", conclusion: "failure" }),
				run({ event: "workflow_dispatch", conclusion: "failure", workflowPath: ".github/workflows/nightly.yml", workflowName: "Nightly" }),
				run(),
			],
			"main",
			NOW,
		);
		expect(overallCiState(w)).toBe("passing");
		expect(w).toHaveLength(1);
	});

	it("a scheduled run on the default branch counts — the nightly job that started #903", () => {
		const w = assessCiRuns([run({ event: "schedule", conclusion: "failure", workflowName: "Nightly", workflowPath: ".github/workflows/nightly.yml" })], "main", NOW);
		expect(overallCiState(w)).toBe("failing");
	});

	it("stale: a workflow whose last decisive run is older than the horizon is dropped", () => {
		const old = new Date(NOW - CI_STALE_AFTER_MS - 60_000).toISOString();
		expect(assessCiRuns([run({ conclusion: "failure", createdAt: old })], "main", NOW)).toEqual([]);
	});

	it("respects the repo's ACTUAL default branch", () => {
		expect(overallCiState(assessCiRuns([run({ branch: "master", conclusion: "failure" })], "master", NOW))).toBe("failing");
		expect(overallCiState(assessCiRuns([run({ branch: "master", conclusion: "failure" })], "main", NOW))).toBe("none");
	});
});

describe("decideCiAlerts — one alert per red streak (#903)", () => {
	const failing = (id: string) => assessCiRuns([run({ id, conclusion: "failure" })], "main", NOW);
	const passing = () => assessCiRuns([run()], "main", NOW);

	it("a new failure alerts once; the same failing run does not alert again", () => {
		const first = decideCiAlerts(failing("1"), {});
		expect(first.newlyFailing).toHaveLength(1);
		expect(decideCiAlerts(failing("1"), first.alerted).newlyFailing).toEqual([]);
	});

	it("a NEXT red run in the same streak does not re-alert either", () => {
		const first = decideCiAlerts(failing("1"), {});
		expect(decideCiAlerts(failing("2"), first.alerted).newlyFailing).toEqual([]);
	});

	it("recovery clears the state, so the next failure is news again", () => {
		const first = decideCiAlerts(failing("1"), {});
		const green = decideCiAlerts(passing(), first.alerted);
		expect(green.alerted).toEqual({});
		expect(decideCiAlerts(failing("3"), green.alerted).newlyFailing).toHaveLength(1);
	});

	it("an undecided run keeps the alert it had — it says nothing either way", () => {
		const first = decideCiAlerts(failing("1"), {});
		const pending = assessCiRuns([run({ status: "queued", conclusion: null })], "main", NOW);
		expect(decideCiAlerts(pending, first.alerted).alerted).toEqual(first.alerted);
	});
});

/** A stateful stand-in for the two tables the sweep touches. */
function fakeEnv(rows: Array<Record<string, unknown>>, notifications: Array<{ user_id: string; dedupe_key: string }> = []) {
	return {
		DB: {
			prepare(sql: string) {
				return {
					bind(...args: unknown[]) {
						return {
							async run() {
								if (sql.startsWith("UPDATE coding_repos SET ci_health")) {
									const row = rows.find((r) => r.id === args[1]);
									if (row) {
										row.ci_health = args[0];
										if (args.length === 3) row.ci_alerted = args[2];
									}
								}
								return { meta: { changes: 1 } };
							},
							async first() {
								if (sql.includes("FROM notifications")) return notifications.some((n) => n.user_id === args[0] && n.dedupe_key === args[1]) ? { 1: 1 } : null;
								return null;
							},
							async all() {
								if (sql.includes("WHERE instance_id = ?1")) return { results: rows.filter((r) => r.instance_id === args[0] && r.user_id === args[1]) };
								return { results: rows };
							},
						};
					},
				};
			},
		},
	} as unknown as Env;
}
const repoRow = (id: string, githubRepo: string) => ({ id, instance_id: "inst1", user_id: "u1", name: githubRepo.split("/")[1], github_repo: githubRepo, ci_health: null, ci_alerted: null });
const asRow = (r: Record<string, unknown>) => r as unknown as Parameters<typeof checkRepoCi>[1];
const now = new Date(NOW);

describe("checkRepoCi — what is stored and what is sent (#903)", () => {
	beforeEach(() => {
		notified.length = 0;
		github.meta = { ok: true, data: { default_branch: "main" }, stale: false };
		github.runs = { runs: [] };
		github.token = "tok";
	});

	it("green → stored passing, no notification", async () => {
		const row = repoRow("r1", "o/app");
		github.runs = { runs: [raw(run())] };
		const health = await checkRepoCi(fakeEnv([row]), asRow(row), now);
		expect(health.state).toBe("passing");
		expect(notified).toEqual([]);
		expect(JSON.parse(row.ci_health as unknown as string).state).toBe("passing");
	});

	it("red → ONE notification; the next sweep over the same failing run sends nothing", async () => {
		const row = repoRow("r1", "o/app");
		const env = fakeEnv([row]);
		github.runs = { runs: [raw(run({ conclusion: "failure", workflowName: "CI" }))] };
		await checkRepoCi(env, asRow(row), now);
		expect(notified).toHaveLength(1);
		expect(notified[0].title).toBe("❌ CI failing on main — app");
		expect(notified[0].body).toMatch(/CI \(failure\)/);
		await checkRepoCi(env, asRow(row), now);
		expect(notified).toHaveLength(1);
	});

	it("a deploy workflow failing says Deploy", async () => {
		const row = repoRow("r1", "o/app");
		github.runs = { runs: [raw(run({ conclusion: "failure", workflowName: "Deploy API", workflowPath: deployPath }))] };
		await checkRepoCi(fakeEnv([row]), asRow(row), now);
		expect(notified[0].title).toMatch(/^❌ Deploy failing on main/);
	});

	it("recovery: failure then green clears the stored failure and the alert state", async () => {
		const row = repoRow("r1", "o/app");
		const env = fakeEnv([row]);
		github.runs = { runs: [raw(run({ conclusion: "failure" }))] };
		await checkRepoCi(env, asRow(row), now);
		github.runs = { runs: [raw(run({ createdAt: iso(1) })), raw(run({ conclusion: "failure", createdAt: iso(20) }))] };
		const health = await checkRepoCi(env, asRow(row), now);
		expect(health.state).toBe("passing");
		expect(JSON.parse(row.ci_alerted as unknown as string)).toEqual({});
	});

	it("pending → stored pending, no notification", async () => {
		const row = repoRow("r1", "o/app");
		github.runs = { runs: [raw(run({ status: "in_progress", conclusion: null }))] };
		expect((await checkRepoCi(fakeEnv([row]), asRow(row), now)).state).toBe("pending");
		expect(notified).toEqual([]);
	});

	it("a second row watching the SAME repository does not notify again (#709)", async () => {
		const a = repoRow("r1", "o/app");
		const b = repoRow("r2", "O/App");
		const notifications: Array<{ user_id: string; dedupe_key: string }> = [];
		const env = fakeEnv([a, b], notifications);
		github.runs = { runs: [raw(run({ id: "77", conclusion: "failure" }))] };
		await checkRepoCi(env, asRow(a), now);
		// What `notifyUser` would have stored for the first alert.
		const { notificationDedupeKey } = await import("./notifications.js");
		notifications.push({ user_id: "u1", dedupe_key: notificationDedupeKey("ci", notified[0].key, "", "") });
		await checkRepoCi(env, asRow(b), now);
		expect(notified).toHaveLength(1);
	});

	describe("unavailable GitHub is UNKNOWN — never healthy, never failed, no alert, no state moved", () => {
		const cases: Array<[string, () => void, RegExp]> = [
			["no token on a private repo (404)", () => { github.token = null; github.meta = { ok: false, status: 404 }; }, /not visible/],
			["rate-limited (403)", () => { github.meta = { ok: false, status: 403 }; }, /refused|rate/],
			["rate-limited on the runs read (429)", () => { github.runs = { status: 429 }; }, /rate limit/],
			["GitHub unreachable", () => { github.runs = { status: null }; }, /could not be reached/],
			["a stored page served while GitHub was down", () => { github.runs = { runs: [raw(run())], stale: true }; }, /stored copy/],
		];
		for (const [name, setup, reason] of cases) {
			it(name, async () => {
				const row = repoRow("r1", "o/app");
				const env = fakeEnv([row]);
				github.runs = { runs: [raw(run({ conclusion: "failure" }))] };
				await checkRepoCi(env, asRow(row), now); // known red first
				const alertedBefore = row.ci_alerted;
				notified.length = 0;
				setup();
				const health = await checkRepoCi(env, asRow(row), now);
				expect(health.state).toBe("unknown");
				expect(health.reason).toMatch(reason);
				expect(notified).toEqual([]);
				expect(row.ci_alerted).toBe(alertedBefore);
				// The red pipeline does not vanish behind the outage.
				expect(health.lastKnown?.state).toBe("failing");
				expect(health.lastKnown?.failing).toHaveLength(1);
			});
		}

		it("a repo never seen and unreadable is unknown with no last-known verdict, and alerts nothing", async () => {
			const row = repoRow("r1", "o/app");
			github.token = null;
			github.meta = { ok: false, status: 404 };
			const health = await checkRepoCi(fakeEnv([row]), asRow(row), now);
			expect(health).toMatchObject({ state: "unknown" });
			expect(health.lastKnown).toBeUndefined();
			expect(notified).toEqual([]);
		});
	});
});

describe("a workflow outside the newest-runs window is still read (#898)", () => {
	beforeEach(() => {
		notified.length = 0;
		github.meta = { ok: true, data: { default_branch: "main" }, stale: false };
		github.token = "tok";
	});

	it("a red, rarely-run workflow reads failing — not absent, and not passing", async () => {
		const row = repoRow("r9", "o/rare");
		// The window holds only the busy CI workflow; nightly.yml's last run is older than all of it.
		github.runs = { runs: [raw(run())] };
		github.workflows = [
			{ path: ".github/workflows/ci.yml", state: "active" },
			{ path: ".github/workflows/nightly.yml", state: "active" },
			{ path: ".github/workflows/old.yml", state: "disabled_manually" },
		];
		github.perWorkflow = { "nightly.yml": [raw(run({ workflowName: "Nightly", workflowPath: ".github/workflows/nightly.yml", event: "schedule", conclusion: "failure", createdAt: iso(60 * 24) }))] };
		const health = await checkRepoCi(fakeEnv([row]), asRow(row), now);
		expect(health.state).toBe("failing");
		expect(health.workflows.map((w) => [w.path, w.state])).toContainEqual([".github/workflows/nightly.yml", "failing"]);
		expect(notified).toHaveLength(1);
		github.workflows = [];
		github.perWorkflow = {};
	});
});

describe("instanceRepoCi — multi-repo instances (#903)", () => {
	beforeEach(() => {
		notified.length = 0;
		github.meta = { ok: true, data: { default_branch: "main" }, stale: false };
		github.token = "tok";
	});

	it("a failure in ANY repo surfaces at the top, naming the repo and workflow, beside the others", async () => {
		const green = repoRow("r1", "o/api");
		const red = repoRow("r2", "o/web");
		const env = fakeEnv([green, red]);
		github.runs = { runs: [raw(run())] };
		await checkRepoCi(env, asRow(green), now);
		github.runs = { runs: [raw(run({ conclusion: "failure", workflowName: "Web CI" }))] };
		await checkRepoCi(env, asRow(red), now);

		const ci = await instanceRepoCi(env, "inst1", "u1");
		expect(ci?.state).toBe("failing");
		expect(ci?.attention).toContain("o/web: Web CI");
		expect(ci?.attention).not.toContain("o/api");
		expect(ci?.repos.map((r) => [r.githubRepo, r.state])).toEqual([
			["o/api", "passing"],
			["o/web", "failing"],
		]);
	});

	it("a repo not checked yet reads unknown, not passing", async () => {
		const ci = await instanceRepoCi(fakeEnv([repoRow("r1", "o/api")]), "inst1", "u1");
		expect(ci?.state).toBe("unknown");
		expect(ci?.repos[0].state).toBe("unchecked");
		expect(ci?.attention).toBeUndefined();
	});

	it("an instance with no GitHub repos reports nothing at all", async () => {
		expect(await instanceRepoCi(fakeEnv([]), "inst1", "u1")).toBeNull();
	});
});
