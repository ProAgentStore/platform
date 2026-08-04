import { describe, expect, it } from "vitest";
import { escalationNote, escalationRoot, escalationTarget, MAX_ESCALATION_HOPS } from "./escalation.js";
import type { SupervisionEdge } from "./supervision-graph.js";

/** `a>b` reads "a supervises b". */
const g = (...pairs: string[]): SupervisionEdge[] =>
	pairs.map((p) => {
		const [supervisorInstanceId, subordinateInstanceId] = p.split(">");
		return { supervisorInstanceId, subordinateInstanceId };
	});

describe("escalationTarget — a hierarchy absorbs interrupts", () => {
	it("tells the SUPERVISOR first, not the human", () => {
		// The whole point. Three Repo Coders under one Lead must not mean three pings to the
		// same person, each missing the context the Lead has.
		expect(escalationTarget(g("lead>fas"), "fas")).toEqual({ kind: "supervisor", instanceId: "lead", hops: 1 });
	});

	it("reaches the human at the ROOT, where nobody is left to absorb it", () => {
		expect(escalationTarget(g("lead>fas"), "lead")).toEqual({ kind: "human", reason: "root" });
	});

	it("reaches the human once the hops are spent, rather than climbing forever", () => {
		const target = escalationTarget(g("a>b", "b>c"), "c", MAX_ESCALATION_HOPS);
		expect(target).toEqual({ kind: "human", reason: "hops_exhausted" });
	});

	it("counts hops so a deep chain converges on a person", () => {
		// Each climb increments; the caller threads it back in, so the ladder terminates.
		let hops = 0;
		let node = "d";
		const edges = g("a>b", "b>c", "c>d");
		const seen: string[] = [];
		for (let i = 0; i < 10; i++) {
			const t = escalationTarget(edges, node, hops);
			if (t.kind === "human") break;
			seen.push(t.instanceId);
			hops = t.hops;
			node = t.instanceId;
		}
		expect(seen).toEqual(["c", "b", "a"]);
		expect(hops).toBeLessThanOrEqual(MAX_ESCALATION_HOPS);
	});

	it("goes straight to the human for an unsupervised agent", () => {
		// Most agents have no supervisor at all; they must not silently swallow an escalation.
		expect(escalationTarget([], "solo").kind).toBe("human");
	});
});

describe("escalationRoot", () => {
	it("attributes an escalation to the top of its tree", () => {
		expect(escalationRoot(g("a>b", "b>c"), "c")).toBe("a");
	});
});

describe("escalationNote", () => {
	const note = escalationNote({
		subordinateName: "FAS platform",
		objective: "get the test suite green",
		reason: "escalated",
		detail: "needs a database password",
	});

	it("names the subordinate and what it was doing", () => {
		// A supervisor told only "something failed" can do nothing useful with that.
		expect(note).toContain("FAS platform");
		expect(note).toContain("get the test suite green");
		expect(note).toContain("needs a database password");
	});

	it("tells the supervisor what it can actually DO next", () => {
		expect(note).toContain("check_delegation");
		expect(note).toContain("delegate_goal");
	});

	it("survives a missing detail without trailing punctuation noise", () => {
		const n = escalationNote({ subordinateName: "X", objective: "o", reason: "failed", detail: "   " });
		expect(n).toContain("X stopped and needs a decision (failed).");
	});
});
