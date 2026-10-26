/** #1150 — the owner can retry a release this machine rolled back from, and the machine reports its rollbacks. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { approvedActionsVersion, BOOTSTRAP_ENV, installPayload } from "../../bootstrap/payload.js";
import { writeInstalled } from "../../bootstrap/test-payload.js";
import { badDetails, badVersions, beginTrial, clearBad, markBad } from "../../bootstrap/trial.js";
import { planRunnerUpdate, type UpdateFacts } from "./self-update.js";
import { agentsStillMissing, applyRetryRolledBack, releaseTrial } from "./release-trial.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "pags-retry-")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

const cell = { record: () => undefined };
const trialAt = (version: string) => releaseTrial(version, cell, () => undefined, { [BOOTSTRAP_ENV]: "1" }, () => root);
const facts = (over: Partial<UpdateFacts> = {}): UpdateFacts => ({ current: "0.4.148", latest: "0.4.150", fromSource: false, restarter: "service", busy: [], rolledBack: badVersions(root), ...over }) as UpdateFacts;

it("approves an Actions payload only after its relay has registered", async () => {
	await installPayload("0.4.150", root, async (prefix, version) => void writeInstalled(prefix, version));
	beginTrial(root, "0.4.150", "0.4.148");
	expect(approvedActionsVersion(root)).toBeNull();
	trialAt("0.4.150").proven();
	expect(approvedActionsVersion(root)).toBe("0.4.150");
});

describe("the bad mark and its details (#1150)", () => {
	it("records where the stub fell back to and when, beside the reason", () => {
		markBad(root, "0.4.150", "it did not register within 5 minutes", "0.4.148", 1_000);
		expect(badVersions(root)).toEqual({ "0.4.150": "it did not register within 5 minutes" });
		expect(badDetails(root)).toEqual({ "0.4.150": { to: "0.4.148", at: 1_000 } });
	});
	it("clearBad removes that version only, and says whether there was a mark", () => {
		markBad(root, "0.4.149", "crash on start", "0.4.148", 1);
		markBad(root, "0.4.150", "crash loop", "0.4.148", 2);
		expect(clearBad(root, "0.4.150")).toBe(true);
		expect(Object.keys(badVersions(root))).toEqual(["0.4.149"]);
		expect(Object.keys(badDetails(root))).toEqual(["0.4.149"]);
		expect(clearBad(root, "0.4.150")).toBe(false);
	});
});

describe("what the machine reports (#1150)", () => {
	it("lists every rolled-back release with from, to, why and when — also after the one-shot notice is gone", () => {
		markBad(root, "0.4.150", "it did not register", "0.4.148", 5_000);
		const t = trialAt("0.4.148"); // takes (and consumes) the notice
		expect(t.rollbacks()).toEqual([{ from: "0.4.150", reason: "it did not register", to: "0.4.148", at: 5_000 }]);
		expect(trialAt("0.4.148").rollbacks()).toEqual([{ from: "0.4.150", reason: "it did not register", to: "0.4.148", at: 5_000 }]);
	});
	it("is empty after a retry clears the mark; a runner not under the stub reports what it refused too (#1147)", () => {
		markBad(root, "0.4.150", "x", "0.4.148", 1);
		expect(releaseTrial("0.4.148", cell, () => undefined, {}, () => root).rollbacks()).toEqual([{ from: "0.4.150", reason: "x", to: "0.4.148", at: 1 }]);
		const t = trialAt("0.4.148");
		expect(t.forget("0.4.150")).toBe(true);
		expect(t.rollbacks()).toEqual([]);
	});
});

describe("retrying a rolled-back release (#1150)", () => {
	it("without the request, the release stays refused — and the refusal names the way out", () => {
		markBad(root, "0.4.150", "crash on start", "0.4.148");
		const t = trialAt("0.4.148");
		const out = applyRetryRolledBack(facts(), {}, t, false);
		expect(out.retried).toBeNull();
		expect(planRunnerUpdate(out.facts)).toMatchObject({ action: "refused", retryable: true, reason: expect.stringMatching(/rolled back: crash on start.*retry_rolled_back/) });
	});
	it("with the request, the mark is cleared and the release is planned for install", () => {
		markBad(root, "0.4.150", "crash on start", "0.4.148");
		const t = trialAt("0.4.148");
		const out = applyRetryRolledBack(facts(), { retryRolledBack: true }, t, false);
		expect(out.retried).toBe("0.4.150");
		expect(planRunnerUpdate(out.facts)).toMatchObject({ action: "update", latest: "0.4.150" });
		expect(badVersions(root)).toEqual({}); // so a deferred install and the next automatic check see it gone too
	});
	it("a dry run plans as if cleared but changes nothing on disk", () => {
		markBad(root, "0.4.150", "crash on start", "0.4.148");
		const t = trialAt("0.4.148");
		const out = applyRetryRolledBack(facts(), { retryRolledBack: true }, t, true);
		expect(out.retried).toBe("0.4.150");
		expect(planRunnerUpdate(out.facts).action).toBe("update");
		expect(Object.keys(badVersions(root))).toEqual(["0.4.150"]);
	});
	it("clears only the latest release's mark, and nothing when the latest was not rolled back or the flag is not exactly true", () => {
		markBad(root, "0.4.149", "older failure", "0.4.148");
		const t = trialAt("0.4.148");
		expect(applyRetryRolledBack(facts(), { retryRolledBack: true }, t, false).retried).toBeNull();
		markBad(root, "0.4.150", "crash", "0.4.148");
		expect(applyRetryRolledBack(facts(), { retryRolledBack: "yes" }, t, false).retried).toBeNull();
		expect(applyRetryRolledBack(facts(), undefined, t, false).retried).toBeNull();
		expect(applyRetryRolledBack(facts(), { retryRolledBack: true }, t, false).retried).toBe("0.4.150");
		expect(Object.keys(badVersions(root))).toEqual(["0.4.149"]);
	});
	it("a fresh failure afterwards is marked again: the retry is on trial like any release", () => {
		markBad(root, "0.4.150", "crash", "0.4.148");
		trialAt("0.4.148").forget("0.4.150");
		markBad(root, "0.4.150", "crashed again", "0.4.148", 9);
		expect(badVersions(root)).toEqual({ "0.4.150": "crashed again" });
	});
});

describe("a release on trial is kept only once its agents are back (#1154)", () => {
	const cycle = { attachments: ["a1", "a2", "a3"] };
	it("requires nothing without an open update cycle: a manual start, a first run or a resolved cycle is proven by the first answer", () => {
		expect(agentsStillMissing(undefined, [], null)).toEqual([]);
		expect(agentsStillMissing({ ...cycle, verifiedAt: "2026-10-25T00:00:00Z" }, [], null)).toEqual([]);
	});
	it("names the agents the install was made over that are not attached and registered yet", () => {
		expect(agentsStillMissing(cycle, [], null)).toEqual(["a1", "a2", "a3"]);
		expect(agentsStillMissing(cycle, ["a1", "a3"], null)).toEqual(["a2"]);
		expect(agentsStillMissing(cycle, ["a3", "a2", "a1", "extra"], null)).toEqual([]);
	});
	it("excuses an agent the machine no longer should hold (repinned, paused, unsubscribed since the install)", () => {
		expect(agentsStillMissing(cycle, ["a1"], new Set(["a1", "a2"]))).toEqual(["a2"]);
		expect(agentsStillMissing(cycle, ["a1"], new Set(["a1"]))).toEqual([]);
		expect(agentsStillMissing(cycle, [], new Set())).toEqual([]);
	});
	it("takes any iterable of attached ids", () => {
		expect(agentsStillMissing(cycle, new Set(["a1", "a2", "a3"]), null)).toEqual([]);
	});
});
