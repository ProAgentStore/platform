import { describe, expect, it } from "vitest";
import { decideDeployNotification, type WatchedRun } from "./deploy-watch.js";

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
		const d = decideDeployNotification(run(), null, "acme/app");
		expect(d.notify).toBe(false);
		expect(d.seenId).toBe("run_2");
		expect(d).toMatchObject({ reason: "first-sight" });
	});

	it("notifies once the watermark exists and the run is new", () => {
		const d = decideDeployNotification(run(), "run_1", "acme/app");
		expect(d).toMatchObject({ notify: true, seenId: "run_2" });
		if (d.notify) {
			expect(d.title).toContain("Deployed");
			expect(d.title).toContain("#42");
			expect(d.url).toContain("/runs/2");
		}
	});

	it("says what happened when the build failed, not just that something happened", () => {
		const d = decideDeployNotification(run({ conclusion: "failure" }), "run_1", "acme/app");
		expect(d).toMatchObject({ notify: true });
		if (d.notify) {
			expect(d.title).toContain("failed");
			expect(d.body).toContain("acme/app");
		}
	});

	// One run, one notification — the acceptance criterion. The sweep runs every minute, so
	// without this the same finished build would notify sixty times an hour.
	it("notifies a given run exactly once", () => {
		const first = decideDeployNotification(run(), "run_1", "acme/app");
		expect(first.notify).toBe(true);
		const again = decideDeployNotification(run(), first.seenId, "acme/app");
		expect(again.notify).toBe(false);
		expect(again).toMatchObject({ reason: "already-notified" });
	});

	it("stays quiet while a run is still going, and keeps the old watermark", () => {
		for (const status of ["queued", "in_progress"]) {
			const d = decideDeployNotification(run({ status, conclusion: null }), "run_1", "acme/app");
			expect(d.notify).toBe(false);
			expect(d.seenId).toBe("run_1"); // not advanced — this run has yet to be reported
		}
	});

	it("handles a repo with no runs at all", () => {
		const d = decideDeployNotification(null, null, "acme/app");
		expect(d.notify).toBe(false);
		expect(d.seenId).toBeNull();
	});

	it("omits the run number rather than printing a broken one", () => {
		const d = decideDeployNotification(run({ runNumber: null }), "run_1", "acme/app");
		if (d.notify) expect(d.title).not.toContain("#");
	});

	// A cancelled run is not a success; the user should not be told it is live.
	it("treats anything other than success as a failure", () => {
		for (const conclusion of ["cancelled", "timed_out", "action_required", null]) {
			const d = decideDeployNotification(run({ conclusion }), "run_1", "acme/app");
			if (d.notify) expect(d.title).toContain("failed");
		}
	});
});
