import { describe, expect, it } from "vitest";
import { decideDeployNotification, deployDeepLink, type WatchedRun } from "./deploy-watch.js";

/** The same-origin console target every notification now carries (#338). */
const LINK = deployDeepLink("inst_1", "repo_1");

const run = (over: Partial<WatchedRun> = {}): WatchedRun => ({
	id: "run_2",
	status: "completed",
	conclusion: "success",
	runNumber: 42,
	url: "https://github.com/acme/app/actions/runs/2",
	...over,
});

describe("decideDeployNotification", () => {
	// THE dangerous case. Every repo that already exists has a completed run behind it, so a
	// watcher that notified on whatever it found first would — on the very deploy that ships
	// this — push every user a notification about a build they ran days ago.
	it("never notifies on FIRST sight; it seeds the watermark silently", () => {
		const d = decideDeployNotification(run(), null, "acme/app", LINK);
		expect(d.notify).toBe(false);
		expect(d.seenId).toBe("run_2");
		expect(d).toMatchObject({ reason: "first-sight" });
	});

	it("notifies once the watermark exists and the run is new", () => {
		const d = decideDeployNotification(run(), "run_1", "acme/app", LINK);
		expect(d).toMatchObject({ notify: true, seenId: "run_2" });
		if (d.notify) {
			expect(d.title).toContain("Deployed");
			expect(d.title).toContain("#42");
			expect(d.url).toBe(LINK);
		}
	});

	it("says what happened when the build failed, not just that something happened", () => {
		const d = decideDeployNotification(run({ conclusion: "failure" }), "run_1", "acme/app", LINK);
		expect(d).toMatchObject({ notify: true });
		if (d.notify) {
			expect(d.title).toContain("failed");
			expect(d.body).toContain("acme/app");
		}
	});

	// One run, one notification — the acceptance criterion. The sweep runs every minute, so
	// without this the same finished build would notify sixty times an hour.
	it("notifies a given run exactly once", () => {
		const first = decideDeployNotification(run(), "run_1", "acme/app", LINK);
		expect(first.notify).toBe(true);
		const again = decideDeployNotification(run(), first.seenId, "acme/app", LINK);
		expect(again.notify).toBe(false);
		expect(again).toMatchObject({ reason: "already-notified" });
	});

	it("stays quiet while a run is still going, and keeps the old watermark", () => {
		for (const status of ["queued", "in_progress"]) {
			const d = decideDeployNotification(run({ status, conclusion: null }), "run_1", "acme/app", LINK);
			expect(d.notify).toBe(false);
			expect(d.seenId).toBe("run_1"); // not advanced — this run has yet to be reported
		}
	});

	it("handles a repo with no runs at all", () => {
		const d = decideDeployNotification(null, null, "acme/app", LINK);
		expect(d.notify).toBe(false);
		expect(d.seenId).toBeNull();
	});

	it("omits the run number rather than printing a broken one", () => {
		const d = decideDeployNotification(run({ runNumber: null }), "run_1", "acme/app", LINK);
		if (d.notify) expect(d.title).not.toContain("#");
	});

	// A cancelled run is not a success; the user should not be told it is live.
	it("treats anything other than success as a failure", () => {
		for (const conclusion of ["cancelled", "timed_out", "action_required", null]) {
			const d = decideDeployNotification(run({ conclusion }), "run_1", "acme/app", LINK);
			if (d.notify) expect(d.title).toContain("failed");
		}
	});

	// #338: the click target is handed to an open tab via WindowClient.navigate(), which is
	// same-origin only. A github.com URL rejects there, the SW swallows it, and the click looks
	// broken — but ONLY when the console happens to be open, which is when it is most likely.
	it("never points a notification off-origin", () => {
		const d = decideDeployNotification(run({ conclusion: "failure" }), "run_1", "acme/app", LINK);
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
