import { describe, expect, it } from "vitest";
import { deriveFleetStatus, type FleetFacts, fleetOrder, isNeedsHumanLabel, tallyIssues } from "./fleet-snapshot.js";

const issue = (number: number, labels: string[] = []) => ({ number, title: `issue ${number}`, state: "open", labels, comments: 0, updatedAt: "", url: `u/${number}` });
const facts = (over: Partial<FleetFacts> = {}): FleetFacts => ({ health: "idle", waitingReason: null, queueDepth: 0, decisions: 0, ownerSecrets: 0, issues: null, ...over });

describe("isNeedsHumanLabel", () => {
	it("reads the labels that mean a person must do it", () => {
		for (const l of ["needs-human", "needs human", "Needs_Human", "blocked", "blocked-on-serge", "human-only"]) expect(isNeedsHumanLabel(l), l).toBe(true);
		for (const l of ["bug", "investigation", "unblocked", "enhancement"]) expect(isNeedsHumanLabel(l), l).toBe(false);
	});
});

describe("tallyIssues", () => {
	it("splits actionable from needs-human, keeps a few next issues, and never reads an unread repo as empty", () => {
		const t = tallyIssues([
			{ repo: "a/one", issues: [issue(1), issue(2, ["needs-human"]), issue(3), issue(4), issue(5)], hasMore: true, unreadable: false },
			{ repo: "a/two", issues: [], hasMore: false, unreadable: true },
		]);
		expect(t).toMatchObject({ open: 5, openMore: true, actionable: 4, needsHuman: 1, readable: false, unreadRepos: ["a/two"] });
		expect(t.next.map((n) => n.number)).toEqual([1, 3, 4]);
	});
});

describe("deriveFleetStatus (#961)", () => {
	const repo = (actionable: number, needsHuman = 0, readable = true) => ({ repos: ["a/r"], readable, unreadRepos: readable ? [] : ["a/r"], open: actionable + needsHuman, openMore: false, actionable, needsHuman, next: [] });

	it("an answerable ask beats everything — even a working run", () => {
		expect(deriveFleetStatus(facts({ decisions: 2, health: "working" }))).toMatchObject({ status: "decision_blocked", reason: expect.stringContaining("answer_instance_mcp_input_request") });
	});

	it("a run parked on a person or on sign-in is HARD-blocked — #960: a coding needs_input cannot be answered from chat", () => {
		expect(deriveFleetStatus(facts({ health: "waiting", waitingReason: "human" }))).toMatchObject({ status: "hard_blocked", reason: expect.stringContaining("#960") });
		expect(deriveFleetStatus(facts({ health: "waiting", waitingReason: "engine_auth" })).status).toBe("hard_blocked");
		expect(deriveFleetStatus(facts({ health: "stalled" })).status).toBe("hard_blocked");
		expect(deriveFleetStatus(facts({ ownerSecrets: 1 })).status).toBe("hard_blocked");
	});

	it("a usage-limit park resumes on its own, so it is working — as is a queued objective", () => {
		expect(deriveFleetStatus(facts({ health: "waiting", waitingReason: "engine_limit" })).status).toBe("working");
		expect(deriveFleetStatus(facts({ health: "working" })).status).toBe("working");
		expect(deriveFleetStatus(facts({ queueDepth: 1 })).status).toBe("working");
	});

	it("idle: work available, only human work, nothing, no repo, or unreadable", () => {
		expect(deriveFleetStatus(facts({ issues: repo(3, 1) })).status).toBe("idle_needs_work");
		expect(deriveFleetStatus(facts({ issues: repo(0, 2) })).status).toBe("hard_blocked");
		expect(deriveFleetStatus(facts({ issues: repo(0) })).status).toBe("idle");
		expect(deriveFleetStatus(facts()).status).toBe("idle");
		expect(deriveFleetStatus(facts({ issues: repo(0, 0, false) }))).toMatchObject({ status: "unknown", reason: expect.stringContaining("could not be read") });
	});

	it("orders most-needs-attention first", () => {
		const sorted = (["idle", "working", "decision_blocked", "hard_blocked", "unknown", "idle_needs_work"] as const).slice().sort(fleetOrder);
		expect(sorted).toEqual(["decision_blocked", "idle_needs_work", "hard_blocked", "working", "unknown", "idle"]);
	});
});
