/**
 * #1112 — the never-started reason reaches every path that reads a repo's builds, not just the
 * `github_workflow_runs` tool and the two notifiers: the Coder's `## Deployment` line, the queue's
 * red-branch hold, and the `/deployment` + Builds routes (which return `latestHostedBuild` /
 * `listHostedBuilds` as they are).
 *
 * Driven through the real `hosted-repo.ts` → `github-actions.ts` path with GitHub's API answered from
 * the #1112 fixtures (billing annotation, ordinary failure, 403 annotations). Mocked: only the token
 * resolution — a token, and `authContext: null`, which means "do not cache".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ActionsFixture, fixtureFetch, loadActionsFixture } from "./__fixtures__/github-actions/fixture-fetch.js";
import { realSchemaD1, type RealSchemaD1, seedTenant } from "./d1-sqlite.js";
import type { Env } from "../types.js";

vi.mock("./github-cache.js", async () => {
	const actual = await vi.importActual<typeof import("./github-cache.js")>("./github-cache.js");
	return { ...actual, resolveGithubRead: async () => ({ token: "tok", authContext: null }) };
});
vi.mock("./github-app.js", async () => {
	const actual = await vi.importActual<typeof import("./github-app.js")>("./github-app.js");
	return { ...actual, githubAppConfigured: () => true };
});

const { attachStartFailures, describeStartFailure, START_FAILURE_LOOKUPS } = await import("./github-actions.js");
const { latestHostedBuild, listHostedBuilds } = await import("./hosted-repo.js");
const { deploymentPrompt } = await import("./deployment-prompt.js");
const { redDeployBlocking } = await import("./ticket-queue.js");

const REPO = "acme/interns";
const ref = { provider: "github" as const, githubRepo: REPO, repoSlug: REPO };
const BILLING_TEXT = "The job was not started because recent account payments have failed or your spending limit needs to be increased to enable additional minutes.";
const env = { DB: null } as unknown as Env;

/** GitHub as one fixture: the run list holds its run, and the jobs/annotations/log come from the fixture. */
function github(fx: ActionsFixture, runs: Array<Record<string, unknown>> = fx.run ? [fx.run] : []) {
	const inner = fixtureFetch(fx);
	const urls: string[] = [];
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input instanceof Request ? input.url : input);
		urls.push(url);
		if (/\/actions\/runs\?/.test(url)) return new Response(JSON.stringify({ workflow_runs: runs }), { status: 200, headers: { "Content-Type": "application/json" } });
		return inner.fetch(input, init);
	});
	return urls;
}
const reads = (urls: string[]) => urls.filter((u) => /\/jobs|\/annotations/.test(u)).length;

afterEach(() => vi.unstubAllGlobals());

describe("the hosted build reads carry the never-started reason (#1112)", () => {
	it("a failed run with a billing annotation: failureReason minutes_exhausted with GitHub's words — latest and list alike", async () => {
		github(loadActionsFixture("billing-annotation"));
		const latest = await latestHostedBuild(env, "u1", ref);
		expect(latest.run).toMatchObject({ conclusion: "failure", failureReason: { classification: "minutes_exhausted", verbatim: BILLING_TEXT } });
		const list = await listHostedBuilds(env, "u1", ref, { page: 1, perPage: 20 });
		expect(list?.[0].failureReason).toEqual({ classification: "minutes_exhausted", verbatim: BILLING_TEXT });
	});

	it("annotations refused with 403: not_started, flagged unreadable with the status — never guessed as billing", async () => {
		const fx = loadActionsFixture("inaccessible-annotations");
		github(fx, [{ ...loadActionsFixture("billing-annotation").run, id: 900200 }]);
		const latest = await latestHostedBuild(env, "u1", ref);
		expect(latest.run?.failureReason).toEqual({ classification: "not_started", verbatim: null, unreadable: { status: 403 } });
		expect(describeStartFailure(latest.run?.failureReason)).toMatch(/could not be read \(annotations HTTP 403 — the GitHub App may lack checks: read\)/);
	});

	it("a successful run is not looked up and carries no reason", async () => {
		const urls = github(loadActionsFixture("billing-annotation"), [{ ...loadActionsFixture("billing-annotation").run, conclusion: "success" }]);
		const latest = await latestHostedBuild(env, "u1", ref);
		expect(latest.run?.conclusion).toBe("success");
		expect(latest.run && "failureReason" in latest.run).toBe(false);
		expect(reads(urls)).toBe(0);
	});

	it("an ordinary failure (the job ran) has a null reason — a log to read, not a block", async () => {
		const fx = loadActionsFixture("ordinary-failure");
		github(fx, [{ ...loadActionsFixture("billing-annotation").run, id: 900100 }]);
		expect((await latestHostedBuild(env, "u1", ref)).run?.failureReason).toBeNull();
	});

	it("looks up at most START_FAILURE_LOOKUPS failed runs per page", async () => {
		const run = loadActionsFixture("billing-annotation").run as Record<string, unknown>;
		const urls = github(loadActionsFixture("billing-annotation"), Array.from({ length: 8 }, (_, i) => ({ ...run, id: 1000 + i })));
		const list = await listHostedBuilds(env, "u1", ref, { page: 1, perPage: 20 });
		expect(list?.filter((r) => r.failureReason).length).toBe(START_FAILURE_LOOKUPS);
		expect(list?.slice(START_FAILURE_LOOKUPS).every((r) => !("failureReason" in r))).toBe(true);
		expect(urls.filter((u) => /\/jobs/.test(u)).length).toBe(START_FAILURE_LOOKUPS);
	});

	it("a lookup that outlives its budget leaves the run un-enriched rather than reasonless", async () => {
		vi.stubGlobal("fetch", () => new Promise<Response>(() => {}));
		const raw = [loadActionsFixture("billing-annotation").run as Record<string, unknown>];
		const mapped = [{ conclusion: "failure" }];
		await attachStartFailures(REPO, "tok", raw, mapped, { budgetMs: 20 });
		expect("failureReason" in mapped[0]).toBe(false);
	});
});

describe("the Coder's Deployment line and the queue hold say why (#1112)", () => {
	const NOW = Date.parse("2026-10-15T05:00:00Z");

	it("## Deployment names minutes_exhausted with GitHub's words; a failure with no reason reads as before", async () => {
		github(loadActionsFixture("billing-annotation"));
		const block = deploymentPrompt(REPO, await latestHostedBuild(env, "u1", ref), { now: NOW });
		expect(block).toMatch(/FAILED, last updated .* Reason: minutes_exhausted: the job was never started \(Actions minutes or spending limit\) — GitHub says: "The job was not started because recent account payments have failed/);
		const plain = deploymentPrompt(REPO, { available: true, run: { status: "completed", conclusion: "failure", name: "Deploy", updatedAt: "2026-10-15T04:15:09Z" } }, { now: NOW });
		expect(plain).toMatch(/FAILED/);
		expect(plain).not.toMatch(/Reason:/);
	});

	describe("redDeployBlocking", () => {
		let d1: RealSchemaD1;
		beforeEach(() => {
			d1 = realSchemaD1();
			seedTenant(d1, { userId: "u1", instanceIds: ["inst-q"] });
			d1.exec(`UPDATE agent_instances SET config = '${JSON.stringify({ githubRepo: REPO })}' WHERE id = 'inst-q'`);
		});
		afterEach(() => d1.close());

		it("a red default branch blocked by billing says minutes_exhausted and GitHub's words", async () => {
			github(loadActionsFixture("billing-annotation"));
			const hold = await redDeployBlocking({ DB: d1.DB } as unknown as Env, "inst-q", "u1");
			expect(hold).toMatch(/^acme\/interns's default branch is red \(Deploy to R2 failure — minutes_exhausted: the job was never started .* GitHub says: "The job was not started because recent account payments/);
			expect(hold).toMatch(/the queue waits for it to go green/);
		});

		it("an ordinary red default branch reads exactly as before", async () => {
			github(loadActionsFixture("ordinary-failure"), [{ ...loadActionsFixture("billing-annotation").run, id: 900100 }]);
			const hold = await redDeployBlocking({ DB: d1.DB } as unknown as Env, "inst-q", "u1");
			expect(hold).toBe("acme/interns's default branch is red (Deploy to R2 failure) — the queue waits for it to go green before starting new work.");
		});
	});
});
