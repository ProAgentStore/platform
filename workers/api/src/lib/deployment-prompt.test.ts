/**
 * #494 — the repo the subscriber saved in the console Deployment card, and the build beside it,
 * have to reach the agent.
 *
 * The reported exchange, verbatim:
 *
 *   owner — "I saved it into settings, I saved it as Heartfull Organization and Request Platform.
 *            Check again."
 *   agent — "I don't have the GitHub URL stored in my memory … Can you give me the repo URL or the
 *            organisation name?"
 *
 * `GET /deploy-status` on that instance in that minute returned `heartfull-online/platform` with
 * run #597 `success`. Both halves of the answer existed; neither was in the prompt.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEPLOY_LOOKUP_TIMEOUT_MS, deploymentPrompt, isValidGithubRepo } from "./deployment-prompt.js";

const NOW = Date.parse("2026-08-10T22:49:00Z");
/** The live run from the issue, as `GET /deploy-status` actually returned it. */
const RUN_597 = {
	status: "completed",
	conclusion: "success",
	name: "Discord Build Notifications",
	runNumber: 597,
	branch: "main",
	sha: "39f7069",
	url: "https://github.com/HeartFull-online/platform/actions/runs/31374292291",
	updatedAt: "2026-08-10T09:22:51Z",
};

describe("#494 — the configured repo reaches the agent", () => {
	it("states the repo the subscriber saved", () => {
		const block = deploymentPrompt("heartfull-online/platform", { available: true, run: RUN_597 }, { now: NOW });
		expect(block).toContain("## Deployment");
		expect(block).toContain("`heartfull-online/platform`");
	});

	it("forbids both wrong sources the agent actually used — asking, and memory", () => {
		// It asked twice for a value it had been given, and answered the tool call it DID make with
		// `read_memory`. Naming memory explicitly matters: the instance carries summary-derived
		// entries about GitHub (#495), so "answer from what you know" resolves to a stale fact
		// unless this line outranks it.
		const block = deploymentPrompt("heartfull-online/platform", { available: true, run: RUN_597 }, { now: NOW });
		expect(block).toContain("Never ask the subscriber for it");
		expect(block).toContain("never answer from memory");
		expect(block).toContain("out of date");
	});

	it("emits nothing at all when no repo is configured", () => {
		// The overwhelming majority of instances. A block that says "no repository is configured"
		// on every turn of every agent is noise, and invites the model to raise it unprompted.
		expect(deploymentPrompt(undefined, null, { now: NOW })).toBe("");
		expect(deploymentPrompt("", null, { now: NOW })).toBe("");
		expect(deploymentPrompt("not-a-coordinate", null, { now: NOW })).toBe("");
		expect(deploymentPrompt(42, null, { now: NOW })).toBe("");
	});
});

describe("#494 — 'was it deployed?' is answerable without the machine", () => {
	it("reports the run with its number, branch, sha and verdict", () => {
		const block = deploymentPrompt("heartfull-online/platform", { available: true, run: RUN_597 }, { now: NOW });
		expect(block).toContain("#597");
		expect(block).toContain("on main");
		expect(block).toContain("(39f7069)");
		expect(block).toContain("SUCCEEDED");
		expect(block).toContain(RUN_597.url);
	});

	it("carries the run's age, so a 13-hour-old success cannot be read as 'just now'", () => {
		// The whole reason the second answer was wrong. The run finished at 09:22 and the question
		// was asked at 22:49 — 13 hours later. Without an age, "the last run succeeded" silently
		// becomes "it is deployed", which is a different claim.
		const block = deploymentPrompt("heartfull-online/platform", { available: true, run: RUN_597 }, { now: NOW });
		expect(block).toContain("13h ago");
		expect(block).toContain("state AT THAT TIME");
		expect(block).toContain("not proof that the site is up now");
	});

	it("formats the timestamp in the owner's zone rather than handing over an ISO string", () => {
		const block = deploymentPrompt("heartfull-online/platform", { available: true, run: RUN_597 }, { now: NOW, timeZone: "Australia/Sydney" });
		expect(block).not.toContain("2026-08-10T09:22:51Z");
		expect(block).toMatch(/last updated .*2026/);
	});

	it("outranks the terminal, which is where the wrong answer came from", () => {
		const block = deploymentPrompt("heartfull-online/platform", { available: true, run: RUN_597 }, { now: NOW });
		expect(block).toContain("never answer a deploy question from scrollback");
	});

	it("reports a FAILED run as failed, not as 'finished'", () => {
		const block = deploymentPrompt("o/r", { available: true, run: { ...RUN_597, conclusion: "failure" } }, { now: NOW });
		expect(block).toContain("FAILED");
		expect(block).not.toContain("SUCCEEDED");
	});

	it("reports an in-flight run as in-flight", () => {
		const block = deploymentPrompt("o/r", { available: true, run: { ...RUN_597, status: "in_progress", conclusion: null } }, { now: NOW });
		expect(block).toContain("STILL RUNNING");
	});

	it("passes an unenumerated conclusion through verbatim instead of inventing a friendly word", () => {
		// #416's leaked-enum-token failure, inverted: flattening `action_required` to "finished"
		// would state something the run does not say.
		const block = deploymentPrompt("o/r", { available: true, run: { ...RUN_597, conclusion: "action_required" } }, { now: NOW });
		expect(block).toContain("action_required");
	});
});

describe("#494 — the three lookup outcomes stay distinct", () => {
	// "I did not look", "GitHub would not tell me" and "GitHub says there are none" are three
	// different facts. Conflating the first two is how a chat-turn timeout starts being reported as
	// a repo that cannot be reached.
	it("NOT CHECKED when the lookup was not attempted or timed out", () => {
		const block = deploymentPrompt("o/r", null, { now: NOW });
		expect(block).toContain("NOT CHECKED");
		expect(block).toContain("do not guess");
	});

	it("UNAVAILABLE when the lookup ran and GitHub would not answer", () => {
		const block = deploymentPrompt("o/r", { available: false, run: null }, { now: NOW });
		expect(block).toContain("UNAVAILABLE");
		expect(block).toContain("GitHub App may not be installed");
	});

	it("NO runs when GitHub answered and there is nothing there", () => {
		const block = deploymentPrompt("o/r", { available: true, run: null }, { now: NOW });
		expect(block).toContain("NO runs");
	});

	it("still states the repo in every one of them — the repo half needs no I/O", () => {
		// The point of the timeout falling back to `null` rather than dropping the section: the
		// question that started the incident ("which repo?") is answerable with no network at all.
		for (const build of [null, { available: false, run: null }, { available: true, run: null }]) {
			expect(deploymentPrompt("heartfull-online/platform", build, { now: NOW })).toContain("`heartfull-online/platform`");
		}
	});

	it("bounds the wait so a slow GitHub cannot hold up the reply", () => {
		expect(DEPLOY_LOOKUP_TIMEOUT_MS).toBeGreaterThan(0);
		expect(DEPLOY_LOOKUP_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
	});
});

describe("#494 — the route and the prompt share one definition of 'configured'", () => {
	it("agrees with the route on what an `owner/repo` is", () => {
		expect(isValidGithubRepo("owner/repo")).toBe(true);
		expect(isValidGithubRepo("group/sub/project")).toBe(true);
		expect(isValidGithubRepo("owner")).toBe(false);
		expect(isValidGithubRepo("owner/")).toBe(false);
		expect(isValidGithubRepo(null)).toBe(false);
	});

	it("instances-deploy.ts imports it rather than keeping a second copy", () => {
		// The duplicate is the failure mode, not the style: an agent announcing a repo the status
		// route refuses to poll (or the reverse) is #494 inverted, and it would look correct in
		// both files.
		const route = readFileSync(fileURLToPath(new URL("../routes/instances-deploy.ts", import.meta.url).href), "utf8");
		expect(route).toContain('from "../lib/deployment-prompt.js"');
		expect(route).not.toMatch(/function isValidGithubRepo/);
	});
});
