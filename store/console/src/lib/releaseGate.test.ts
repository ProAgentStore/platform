/**
 * #1347 — the gate editor's rules and the panel's readiness verdict, as behaviour.
 * The invariant throughout: nothing reads as "ready" unless every condition is positively met, and an
 * unreadable or missing fact (runner version, runner node, a channel) counts against it, never for it.
 */
import { describe, expect, it } from "vitest";
import type { InstanceReleaseNotesResponse } from "./types";
import {
	chooseDeploy, clearPatch, compareVersions, draftChanged, draftFromSaved, draftIsValid, draftProblems, emptyRow, MIN_GATED_RUNNER, modeCopy, readiness, readRunner,
	rowForServerError, runnerWarning, savePatch, slackChannelsBotMissing, testSentText, type GateRow, type RunnerReading,
} from "./releaseGate";

const CHESS = [
	{ path: ".github/workflows/ci.yml", role: "check" as const },
	{ path: ".github/workflows/e2e-full.yml", role: "check" as const },
	{ path: ".github/workflows/deploy.yml", role: "production_deploy" as const, jobName: "deploy", stepName: "Upload to R2" },
];
const rows = (over: Partial<GateRow> = {}, at = 2): GateRow[] => draftFromSaved(CHESS).map((r, i) => (i === at ? { ...r, ...over } : r));

const view = (over: Partial<InstanceReleaseNotesResponse> & { channels?: InstanceReleaseNotesResponse["effective"]["channels"] } = {}): InstanceReleaseNotesResponse => ({
	settings: { requiredWorkflows: CHESS },
	account: null,
	effective: {
		enabled: true, enabledFrom: "platform", channelsFrom: "all", missing: [],
		channels: over.channels ?? [{ provider: "slack", grantId: "g1", channelId: "C1", name: "#release-notes", selected: true }],
	},
	gate: { state: "ready" },
	...("gate" in over ? { gate: over.gate } : {}),
} as InstanceReleaseNotesResponse);
const okRunner: RunnerReading = { node: "mac", connected: true, version: MIN_GATED_RUNNER };

describe("the draft", () => {
	it("starts from what is saved, including the deploy job and step", () => {
		expect(draftFromSaved(CHESS)[2]).toEqual({ path: ".github/workflows/deploy.yml", role: "production_deploy", jobName: "deploy", stepName: "Upload to R2" });
	});
	it("a new gate starts with a check and a deploy row, both empty", () => {
		expect(draftFromSaved(undefined)).toEqual([emptyRow("check"), emptyRow("production_deploy")]);
	});
	it("the ChessClubs configuration is valid as saved, and unchanged until edited", () => {
		expect(draftIsValid(rows())).toBe(true);
		expect(draftChanged(rows(), CHESS)).toBe(false);
		expect(draftChanged(rows({ stepName: "Upload" }), CHESS)).toBe(true);
	});
	it("fail-closed: a missing, blank or padded deploy selector is refused on the deploy row, not elsewhere", () => {
		for (const over of [{ jobName: "" }, { stepName: "   " }, { jobName: " deploy" }, { stepName: "x".repeat(201) }] as const) {
			const p = draftProblems(rows(over));
			expect(draftIsValid(rows(over)), JSON.stringify(over)).toBe(false);
			expect(Object.keys(p.rows)).toEqual(["2"]);
		}
	});
	it("fail-closed: a bad path, a repeated path, the wrong count and no deploy are refused", () => {
		expect(draftProblems(rows({ path: "ci.yml" }, 0)).rows[0]).toMatch(/exact path/);
		expect(draftProblems(rows({ path: ".github/workflows/ci.yml" }, 1)).rows[1]).toMatch(/already listed/);
		expect(draftProblems(rows().slice(0, 1)).form).toMatch(/2–10/);
		expect(draftProblems(Array.from({ length: 11 }, (_, i) => ({ ...emptyRow(), path: `.github/workflows/w${i}.yml` }))).form).toMatch(/2–10/);
		expect(draftProblems(rows().map((r) => ({ ...r, role: "check" as const }))).form).toMatch(/exactly one/);
	});
	it("moving the deploy role drops the old deploy row's selectors, so a check never carries them", () => {
		const moved = chooseDeploy(rows(), 0);
		expect(moved.map((r) => r.role)).toEqual(["production_deploy", "check", "check"]);
		expect(moved[2]).toMatchObject({ jobName: "", stepName: "" });
		expect(savePatch(moved.map((r, i) => (i === 0 ? { ...r, jobName: "j", stepName: "s" } : r))).requiredWorkflows[1]).toEqual({ path: ".github/workflows/e2e-full.yml", role: "check" });
	});
});

describe("what a save and a clear send", () => {
	it("a save carries requiredWorkflows and nothing else, so enabled and channels cannot be overwritten", () => {
		const patch = savePatch(rows());
		expect(Object.keys(patch)).toEqual(["requiredWorkflows"]);
		expect(patch.requiredWorkflows).toEqual(CHESS);
	});
	it("trims the path but sends the selectors exactly as typed", () => {
		expect(savePatch(rows({ path: " .github/workflows/deploy.yml " })).requiredWorkflows[2].path).toBe(".github/workflows/deploy.yml");
	});
	it("clearing the gate is the route's null, again for that field alone", () => {
		expect(clearPatch()).toEqual({ requiredWorkflows: null });
	});
	it("a server refusal is shown beside the row it is about, or for the whole gate when it is not about one", () => {
		expect(rowForServerError("The production_deploy workflow needs an exact, non-empty jobName (…)", rows())).toBe(2);
		expect(rowForServerError("requiredWorkflows cannot repeat a workflow path", rows({ path: ".github/workflows/ci.yml" }, 1))).toBe(1);
		expect(rowForServerError("requiredWorkflows must contain 2–10 workflow files", rows())).toBeNull();
		expect(rowForServerError("jobName missing", rows().map((r) => ({ ...r, role: "check" as const })))).toBeNull();
	});
});

describe("the delivery mode", () => {
	it("no gate is the status note, and says it does not verify a deploy", () => {
		const c = modeCopy({ state: "none" });
		expect(c).toMatchObject({ mode: "status", title: "Status note after a trunk-changing run" });
		expect(c.body).toMatch(/does not prove the change was deployed/);
	});
	it("a complete gate is the verified note, and says a missing proof holds it", () => {
		const c = modeCopy({ state: "ready" });
		expect(c.title).toBe("Verified production note");
		expect(c.body).toMatch(/held rather than posted/);
	});
	it("an old gate is setup-needed and shows the server's migration message, not the verified claim", () => {
		const c = modeCopy({ state: "configuration_required", message: "Set jobName and stepName" });
		expect(c).toMatchObject({ mode: "setup_needed", body: "Set jobName and stepName" });
		expect(c.title).not.toBe("Verified production note");
	});
});

describe("versions", () => {
	it("compares x.y.z numerically, not as text", () => {
		expect(compareVersions("0.4.180", "0.4.179")).toBeGreaterThan(0);
		expect(compareVersions("0.4.179", "0.4.179")).toBe(0);
		expect(compareVersions("0.4.9", "0.4.179")).toBeLessThan(0);
		expect(compareVersions("0.10.0", "0.4.179")).toBeGreaterThan(0);
		expect(compareVersions("v0.4.179", "0.4.179")).toBe(0);
	});
	it("a version that is not plain x.y.z is not comparable, never assumed new", () => {
		for (const v of ["", "dev", "0.4", "0.4.179-beta", "latest"]) expect(compareVersions(v, "0.4.179"), v).toBeNull();
	});
});

describe("the runner reading", () => {
	const machines = [{ node: "mac", aka: ["old-mac"], connected: true, runnerVersion: "0.4.180" }];
	it("joins the pinned node to the machine list for its version, also under a retired name", () => {
		expect(readRunner({ runnerNode: "mac" }, machines)).toEqual({ node: "mac", connected: true, version: "0.4.180" });
		expect(readRunner({ runnerNode: "old-mac" }, machines)).toMatchObject({ node: "old-mac", version: "0.4.180" });
	});
	it("falls back to the resolved node when nothing is pinned, and to nothing when neither read names one", () => {
		expect(readRunner({ runnerNode: null, resolvedNode: "mac" }, machines).version).toBe("0.4.180");
		expect(readRunner({ runnerNode: null }, machines)).toEqual({ node: null, connected: null, version: null });
		expect(readRunner(null, machines).node).toBeNull();
	});
	it("a failed machine read leaves the version unknown rather than inventing one", () => {
		expect(readRunner({ runnerNode: "mac" }, null)).toEqual({ node: "mac", connected: null, version: null });
	});
	it("a socket seen by the agent's own read counts as connected", () => {
		expect(readRunner({ runnerNode: "mac", nodesDetail: [{ node: "mac", connected: true }] }, [{ node: "mac", connected: false, runnerVersion: "0.4.179" }]).connected).toBe(true);
	});
});

describe("the runner warning", () => {
	it("0.4.179 and newer, connected, is fine", () => {
		expect(runnerWarning(okRunner)).toBeNull();
		expect(runnerWarning({ ...okRunner, version: "0.5.0" })).toBeNull();
	});
	it("an older runner gets an update warning that says why the SHA cannot be recovered", () => {
		const w = runnerWarning({ ...okRunner, version: "0.4.178" });
		expect(w).toMatch(/0\.4\.178/);
		expect(w).toMatch(/pags update/);
		expect(w).toMatch(/branch head/);
	});
	it("fail-closed: offline, unpinned, unreported and uncomparable runners all warn", () => {
		expect(runnerWarning({ ...okRunner, connected: false })).toMatch(/offline/);
		expect(runnerWarning({ ...okRunner, connected: null })).toMatch(/not reporting/);
		expect(runnerWarning({ node: null, connected: null, version: null })).toMatch(/No runner is pinned/);
		expect(runnerWarning({ ...okRunner, version: null })).toMatch(/does not report its version/);
		expect(runnerWarning({ ...okRunner, version: "dev" })).toMatch(/cannot be compared/);
	});
});

describe("readiness", () => {
	const ids = (v: InstanceReleaseNotesResponse, runner = okRunner, botMissing: string[] = []) => readiness({ view: v, botMissing, runner }).items.map((i) => i.id);
	it("a selected channel, a complete gate and a current runner is ready, with no warnings", () => {
		expect(readiness({ view: view(), botMissing: [], runner: okRunner })).toEqual({ ready: true, items: [] });
	});
	it("no channel granted is not ready", () => {
		expect(ids(view({ channels: [] }))).toEqual(["no_channel"]);
	});
	it("channels granted but none selected is not ready, and is not reported as 'no channel'", () => {
		expect(ids(view({ channels: [{ provider: "slack", grantId: "g1", channelId: "C1", name: "#a", selected: false }] }))).toEqual(["none_selected"]);
	});
	it("a Slack channel the bot has not joined is not ready, and names it", () => {
		const r = readiness({ view: view(), botMissing: ["#release-notes"], runner: okRunner });
		expect(r.ready).toBe(false);
		expect(r.items[0].text).toContain("#release-notes");
	});
	it("no gate is not ready, and the runner is not asked about (status notes need no SHA)", () => {
		const v = view({ gate: { state: "none" } });
		expect(ids(v, { node: null, connected: null, version: null })).toEqual(["no_gate"]);
	});
	it("an old gate is not ready", () => {
		expect(ids(view({ gate: { state: "configuration_required", message: "m" } }))).toEqual(["gate_setup"]);
	});
	it("an old runner is not ready even with everything else right", () => {
		expect(ids(view(), { ...okRunner, version: "0.4.100" })).toEqual(["runner"]);
	});
	it("turned off is not ready", () => {
		const v = view();
		v.effective.enabled = false;
		expect(ids(v)).toEqual(["off"]);
	});
	it("every problem is reported at once", () => {
		expect(ids(view({ channels: [], gate: { state: "configuration_required" } }), { node: null, connected: null, version: null })).toEqual(["no_channel", "gate_setup", "runner"]);
	});
});

describe("Slack channels the bot has not joined", () => {
	const channels = [
		{ provider: "slack" as const, grantId: "g1", channelId: "C1", name: "#a", selected: true },
		{ provider: "slack" as const, grantId: "g2", channelId: "C2", name: "#b", selected: false },
		{ provider: "discord" as const, grantId: "g3", channelId: "C1", name: "#c", selected: true },
	];
	it("flags only a selected Slack grant whose channel the list says the bot is not in", () => {
		const listed = [{ id: "C1", isMember: false }, { id: "C2", isMember: false }];
		expect(slackChannelsBotMissing(channels, listed)).toEqual(["#a"]);
	});
	it("says nothing when the list was not read, or the bot is a member", () => {
		expect(slackChannelsBotMissing(channels, null)).toEqual([]);
		expect(slackChannelsBotMissing(channels, [{ id: "C1", isMember: true }])).toEqual([]);
	});
});

describe("the test-send message", () => {
	it("is labelled TEST, says it skips the checks, and carries the permalink when there is one", () => {
		const t = testSentText({ provider: "slack", name: "#release-notes" }, "https://acme.slack.com/archives/C1/p1");
		expect(t).toMatch(/^TEST note sent to Slack #release-notes/);
		expect(t).toMatch(/skips the workflow checks/);
		expect(t).toContain("https://acme.slack.com/archives/C1/p1");
		expect(testSentText({ provider: "discord", name: "#x" })).not.toContain("Message:");
	});
});
