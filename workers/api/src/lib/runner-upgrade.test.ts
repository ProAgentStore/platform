import { describe, expect, it } from "vitest";
import { cliAtLeast, runnerUpgradeClause, runnerUpgradeMessage } from "./runner-upgrade.js";
import { REPO_SEARCH_MIN_CLI } from "./connectors/repo-local.js";
import { SWITCH_BRANCH_MIN_CLI } from "./repo-policy-act.js";

/**
 * #524, measured: two machines connected, `RLs-MacBook-Air` on 0.4.49 and
 * `Sergeys-Mac-mini.local` on 0.4.45, with the instance pinned to the Mac mini. The old sentence
 * said "Run `npm i -g @proagentstore/cli` on that machine", which the owner resolved to the laptop
 * he was sitting at — the one that needed nothing.
 */
const MINI = "Sergeys-Mac-mini.local";
const AIR = "RLs-MacBook-Air";
const search = { what: "search this repository", minCli: REPO_SEARCH_MIN_CLI };

describe("runnerUpgradeMessage names the machine (#524)", () => {
	it("pinned, with no capable machine anywhere: names the node, its version, and the pin", () => {
		const msg = runnerUpgradeMessage({ ...search, node: MINI, nodeVersion: "0.4.45", pinned: true });
		expect(msg).toContain(MINI);
		expect(msg).toContain("0.4.45");
		expect(msg).toContain(REPO_SEARCH_MIN_CLI);
		// The pin is the only reason the other machine is not being used, and the failure is the
		// owner's only chance to discover it exists.
		expect(msg).toMatch(/pinned to that machine \(Settings → Runs on\)/);
		expect(msg).not.toContain(AIR);
	});

	it("pinned, with a capable machine connected: names it and offers the repin", () => {
		const msg = runnerUpgradeMessage({
			...search,
			node: MINI,
			nodeVersion: "0.4.45",
			pinned: true,
			alternative: { node: AIR, version: "0.4.51", connected: true },
		});
		expect(msg).toContain(AIR);
		expect(msg).toContain("is connected and already runs 0.4.51");
		expect(msg).toMatch(/repin this agent there/);
		// A dead end becomes a choice, and both halves of the choice are named.
		expect(msg).toContain(`upgrade \`${MINI}\``);
	});

	it("does not call a machine CONNECTED on the strength of a status column (#238)", () => {
		// `status` is never cleared on disconnect, so a laptop shut months ago still reads
		// `registered`. Offering that as "connected and ready" would be this bug one machine over.
		const msg = runnerUpgradeMessage({
			...search,
			node: MINI,
			nodeVersion: "0.4.45",
			pinned: true,
			alternative: { node: AIR, version: "0.4.51", connected: false },
		});
		expect(msg).toContain("last reported 0.4.51");
		expect(msg).not.toContain("is connected");
	});

	it("unpinned: names the machine without claiming a pin that is not set", () => {
		const msg = runnerUpgradeMessage({ ...search, node: MINI, nodeVersion: "0.4.45", pinned: false });
		expect(msg).toContain(MINI);
		expect(msg).not.toMatch(/pinned/i);
	});

	it("omits the version when the machine never reported one, rather than inventing it", () => {
		const msg = runnerUpgradeMessage({ ...search, node: MINI, nodeVersion: null, pinned: true });
		expect(msg).toContain(MINI);
		expect(msg).not.toMatch(/it has /);
	});

	it("falls back to the old sentence when no machine could be resolved", () => {
		const msg = runnerUpgradeMessage(search);
		expect(msg).toContain("This machine's runner is too old");
		expect(msg).toContain(REPO_SEARCH_MIN_CLI);
	});

	/**
	 * #517's finding, applied to a message that is now longer than the one it replaces: a long
	 * remedy gets cut before the owner sees it, so whatever survives the cut must be the machine.
	 */
	it("keeps the machine name in the FIRST clause, so a truncated form still names it", () => {
		const msg = runnerUpgradeMessage({
			...search,
			node: MINI,
			nodeVersion: "0.4.45",
			pinned: true,
			alternative: { node: AIR, version: "0.4.51", connected: true },
		});
		expect(msg.slice(0, 80)).toContain(MINI);
		expect(msg.indexOf(MINI)).toBeLessThan(msg.indexOf(REPO_SEARCH_MIN_CLI));
	});
});

describe("runnerUpgradeClause — the same rule for the switch-branch card (#524 AC4)", () => {
	it("names the machine inside a fragment a card can embed", () => {
		const clause = runnerUpgradeClause({ what: "switch branch", minCli: SWITCH_BRANCH_MIN_CLI, node: MINI });
		expect(clause).toContain(MINI);
		expect(clause).toContain(SWITCH_BRANCH_MIN_CLI);
		// A fragment, not a sentence: it is spliced into a card's own prose.
		expect(clause[0]).toBe("`");
		expect(clause.endsWith(".")).toBe(false);
	});

	it("keeps the machine-less wording when there is no node to name", () => {
		const clause = runnerUpgradeClause({ what: "switch branch", minCli: SWITCH_BRANCH_MIN_CLI });
		expect(clause).toContain("this machine's runner");
		expect(clause).toContain(SWITCH_BRANCH_MIN_CLI);
	});
});

describe("cliAtLeast — unknown is not capable", () => {
	it("compares dotted versions numerically, not as strings", () => {
		// The string comparison that would have shipped: "0.4.9" > "0.4.51" lexicographically.
		expect(cliAtLeast("0.4.51", "0.4.49")).toBe(true);
		expect(cliAtLeast("0.4.9", "0.4.49")).toBe(false);
		expect(cliAtLeast("0.4.49", "0.4.49")).toBe(true);
		expect(cliAtLeast("0.5.0", "0.4.49")).toBe(true);
		expect(cliAtLeast("1.0.0", "0.4.49")).toBe(true);
	});

	it("refuses to call an unreported version capable", () => {
		// Naming a machine as the alternative and having it turn out to be older is how a dead end
		// becomes a wild goose chase.
		expect(cliAtLeast(null, "0.4.49")).toBe(false);
		expect(cliAtLeast("", "0.4.49")).toBe(false);
		expect(cliAtLeast("unknown", "0.4.49")).toBe(false);
	});

	it("tolerates a leading v and a short version", () => {
		expect(cliAtLeast("v0.5", "0.4.49")).toBe(true);
	});
});
