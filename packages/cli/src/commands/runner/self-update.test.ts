/**
 * `runner_update`'s decision on the machine (#859): when it may update, when it must wait, and when
 * it must refuse because nothing would bring it back.
 */
import { describe, expect, it } from "vitest";
import { olderThan, planRunnerUpdate, type UpdateFacts } from "./self-update.js";

const facts = (over: Partial<UpdateFacts> = {}): UpdateFacts => ({ current: "0.4.62", latest: "0.4.63", fromSource: false, supervised: true, busy: [], ...over });

describe("planRunnerUpdate (#859)", () => {
	it("updates an idle, supervised, npm-installed runner that is behind", () => {
		expect(planRunnerUpdate(facts())).toEqual({ action: "update", current: "0.4.62", latest: "0.4.63" });
	});

	it("WAITS while any engine is mid-turn — a run is paused across the restart, never cut off", () => {
		expect(planRunnerUpdate(facts({ busy: ["csess_1", "csess_2"] }))).toEqual({ action: "wait", current: "0.4.62", latest: "0.4.63", waitingFor: ["csess_1", "csess_2"] });
	});

	it("does nothing when it is already current", () => {
		expect(planRunnerUpdate(facts({ current: "0.4.63" }))).toEqual({ action: "up-to-date", current: "0.4.63" });
		expect(planRunnerUpdate(facts({ current: "0.5.0" })).action).toBe("up-to-date");
	});

	it("refuses when NOTHING would restart it — and says how to make later updates remote", () => {
		const out = planRunnerUpdate(facts({ supervised: false }));
		expect(out.action).toBe("refused");
		expect(out.action === "refused" && out.reason).toMatch(/not started by a `pags up` that can restart it.*npm i -g @proagentstore\/cli.*later updates can then be done remotely/);
	});

	it("refuses a source checkout, and a machine that cannot reach npm", () => {
		expect(planRunnerUpdate(facts({ fromSource: true }))).toMatchObject({ action: "refused", reason: expect.stringMatching(/git pull/) });
		expect(planRunnerUpdate(facts({ latest: null }))).toMatchObject({ action: "refused", reason: expect.stringMatching(/npm could not be asked/) });
	});
});

describe("olderThan", () => {
	it("compares numerically, and never calls a version it cannot read older", () => {
		expect(olderThan("0.4.9", "0.4.10")).toBe(true);
		expect(olderThan("0.4.61", "0.4.62")).toBe(true);
		expect(olderThan("0.4.62", "0.4.62")).toBe(false);
		expect(olderThan("1.0.0", "0.9.9")).toBe(false);
		expect(olderThan("dev", "0.4.62")).toBe(false);
	});
});
