import { describe, expect, it } from "vitest";
import { decideDeployNotification, deployDeepLink, isDeployWorkflow, type WatchedRun } from "./deploy-watch.js";

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
		const d = decideDeployNotification([run()], null, "acme/app", LINK);
		expect(d.notify).toBe(false);
		expect(d.seenId).toBe(seen("abc1234def5678"));
		expect(d).toMatchObject({ reason: "first-sight" });
	});

	// The upgrade path. A watermark written before #359 is a RUN ID, which can never equal a
	// commit sha — without this it would read as "new" and announce a deploy that already went.
	it("treats a pre-#359 run-id watermark as first sight", () => {
		const d = decideDeployNotification([run()], "17253884012", "acme/app", LINK);
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
		const d = decideDeployNotification(runs, seen("older"), "acme/app", LINK);
		expect(d.notify).toBe(true);
		if (d.notify) {
			expect(d.body).toContain("Deploy API Worker");
			expect(d.body).toContain("Deploy Host Worker");
			// CI is not a deploy and must not be named as one.
			expect(d.body).not.toContain("CI");
			expect(d.seenId).toBe(seen("abc1234def5678"));
		}
		// ...and the second sweep, a minute later with the same runs, says nothing.
		const again = decideDeployNotification(runs, d.seenId, "acme/app", LINK);
		expect(again).toMatchObject({ notify: false, reason: "already-notified" });
	});

	// A CI-only repo gets SILENCE, not a lie. That is the deliberate trade: the watcher speaks
	// only for a workflow that puts something live.
	it("says nothing when no completed run is a deploy", () => {
		const d = decideDeployNotification(
			[run({ workflowName: "CI", workflowPath: ".github/workflows/ci.yml" })],
			seen("older"),
			"acme/app",
			LINK,
		);
		expect(d).toMatchObject({ notify: false, reason: "no-run" });
	});

	// Concurrency groups cancel a superseded run routinely, so pushing twice in quick
	// succession used to raise "❌ Build failed — cancelled" for a build that merely lost a race.
	it("is silent about a cancelled run, and does not burn the watermark on it", () => {
		for (const conclusion of ["cancelled", "skipped", "neutral", "stale", null]) {
			const d = decideDeployNotification([run({ conclusion })], seen("older"), "acme/app", LINK);
			expect(d).toMatchObject({ notify: false, reason: "still-running" });
			expect(d.seenId).toBe(seen("older")); // the commit can still be reported when a real run lands
		}
	});

	it("says what happened when the deploy failed, and names the workflow that failed", () => {
		const runs = [
			run({ id: "1", conclusion: "failure", workflowName: "Deploy API Worker" }),
			run({ id: "2", conclusion: "success", workflowName: "Deploy Host Worker" }),
		];
		const d = decideDeployNotification(runs, seen("older"), "acme/app", LINK);
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
		const d = decideDeployNotification([run()], seen("older"), "acme/app", LINK);
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
		const d = decideDeployNotification(runs, seen("older"), "acme/app", LINK);
		expect(d.seenId).toBe(seen("2222222"));
		if (d.notify) expect(d.body).not.toContain("1111111");
	});

	it("stays quiet while a deploy is still going, and keeps the old watermark", () => {
		for (const status of ["queued", "in_progress"]) {
			const d = decideDeployNotification([run({ status, conclusion: null })], seen("older"), "acme/app", LINK);
			expect(d.notify).toBe(false);
			expect(d.seenId).toBe(seen("older")); // not advanced — this deploy has yet to be reported
		}
	});

	it("handles a repo with no runs at all", () => {
		const d = decideDeployNotification([], null, "acme/app", LINK);
		expect(d.notify).toBe(false);
		expect(d.seenId).toBeNull();
	});

	// #338: the click target is handed to an open tab via WindowClient.navigate(), which is
	// same-origin only. A github.com URL rejects there, the SW swallows it, and the click looks
	// broken — but ONLY when the console happens to be open, which is when it is most likely.
	it("never points a notification off-origin", () => {
		const d = decideDeployNotification([run({ conclusion: "failure" })], seen("older"), "acme/app", LINK);
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
