import { describe, expect, it } from "vitest";
import {
	depthAbove,
	depthBelow,
	MAX_DEPTH,
	MAX_SUBORDINATES,
	reachableFrom,
	rootOf,
	subordinatesOf,
	supervisorOf,
	validateEdge,
	wouldCreateCycle,
	type SupervisionEdge,
} from "./supervision-graph.js";

/** `a>b` reads "a supervises b". */
const g = (...pairs: string[]): SupervisionEdge[] =>
	pairs.map((p) => {
		const [supervisorInstanceId, subordinateInstanceId] = p.split(">");
		return { supervisorInstanceId, subordinateInstanceId };
	});

describe("reachableFrom", () => {
	it("collects everything downstream, transitively", () => {
		expect([...reachableFrom(g("a>b", "b>c", "c>d"), "a")].sort()).toEqual(["b", "c", "d"]);
	});

	it("terminates on an already-cyclic graph instead of hanging", () => {
		// Defensive: historical rows could be cyclic even though validateEdge now prevents it.
		// A hang here would be a Worker timeout, not a test failure.
		expect([...reachableFrom(g("a>b", "b>a"), "a")].sort()).toEqual(["a", "b"]);
	});

	it("is empty for a leaf", () => {
		expect(reachableFrom(g("a>b"), "b").size).toBe(0);
	});
});

describe("wouldCreateCycle", () => {
	it("catches direct self-supervision", () => {
		expect(wouldCreateCycle([], "a", "a")).toBe(true);
	});

	it("catches a two-node loop", () => {
		expect(wouldCreateCycle(g("a>b"), "b", "a")).toBe(true);
	});

	it("catches a long indirect loop", () => {
		// a>b>c>d already exists; d>a closes it. This is the case a human reviewing a wiring
		// form cannot see, which is exactly why it is validated rather than documented.
		expect(wouldCreateCycle(g("a>b", "b>c", "c>d"), "d", "a")).toBe(true);
	});

	it("allows a diamond — shared subordinate is not a cycle", () => {
		expect(wouldCreateCycle(g("a>b", "a>c"), "b", "d")).toBe(false);
	});
});

describe("depthBelow / depthAbove", () => {
	it("counts edges, so a leaf is zero", () => {
		expect(depthBelow(g("a>b"), "b")).toBe(0);
		expect(depthBelow(g("a>b", "b>c"), "a")).toBe(2);
	});

	it("takes the LONGEST branch, not the first", () => {
		expect(depthBelow(g("a>b", "a>c", "c>d", "d>e"), "a")).toBe(3);
	});

	it("measures the chain above a node", () => {
		expect(depthAbove(g("a>b", "b>c"), "c")).toBe(2);
		expect(depthAbove(g("a>b"), "a")).toBe(0);
	});
});

describe("validateEdge", () => {
	it("accepts a first edge", () => {
		expect(validateEdge([], "a", "b").ok).toBe(true);
	});

	it("rejects self-supervision", () => {
		const r = validateEdge([], "a", "a");
		expect(r.ok).toBe(false);
		expect(r.reason).toBe("self");
	});

	it("rejects a duplicate edge", () => {
		expect(validateEdge(g("a>b"), "a", "b").reason).toBe("duplicate");
	});

	it("rejects a second supervisor for the same subordinate", () => {
		// Two managers makes "who is accountable" and "whose budget paid" unanswerable, and the
		// escalation ladder has no single parent to climb to.
		expect(validateEdge(g("a>b"), "c", "b").reason).toBe("multiple_supervisors");
	});

	it("rejects a cycle with a message a human can act on", () => {
		const r = validateEdge(g("a>b", "b>c"), "c", "a");
		expect(r.reason).toBe("cycle");
		expect(r.message).toContain("loop");
	});

	it("rejects exceeding the fan-out cap", () => {
		const edges = g(...Array.from({ length: MAX_SUBORDINATES }, (_, i) => `a>s${i}`));
		expect(validateEdge(edges, "a", "extra").reason).toBe("too_many_subordinates");
	});

	it("allows the last edge up to the fan-out cap", () => {
		const edges = g(...Array.from({ length: MAX_SUBORDINATES - 1 }, (_, i) => `a>s${i}`));
		expect(validateEdge(edges, "a", "last").ok).toBe(true);
	});

	it("rejects a tower deeper than the cap", () => {
		// Chain of MAX_DEPTH edges already exists; one more exceeds it.
		const chain = Array.from({ length: MAX_DEPTH }, (_, i) => `n${i}>n${i + 1}`);
		const r = validateEdge(g(...chain), `n${MAX_DEPTH}`, "extra");
		expect(r.reason).toBe("too_deep");
	});

	it("counts depth in BOTH directions — the new edge joins two existing chains", () => {
		// a>b (b sits 1 below a) and c>d>e (c has a 2-deep chain below). Linking b>c yields
		// a>b>c>d>e = 4 edges, at the cap. Measuring only one side would have allowed 6.
		const edges = g("a>b", "c>d", "d>e");
		expect(validateEdge(edges, "b", "c").ok).toBe(true);
		const deeper = g("a>b", "c>d", "d>e", "e>f");
		expect(validateEdge(deeper, "b", "c").reason).toBe("too_deep");
	});

	it("requires both ids", () => {
		expect(validateEdge([], "", "b").ok).toBe(false);
		expect(validateEdge([], "a", "").ok).toBe(false);
	});
});

describe("subordinatesOf / supervisorOf / rootOf", () => {
	it("lists direct reports only", () => {
		expect(subordinatesOf(g("a>b", "a>c", "b>d"), "a")).toEqual(["b", "c"]);
	});

	it("finds the single parent, null at the root", () => {
		expect(supervisorOf(g("a>b"), "b")).toBe("a");
		expect(supervisorOf(g("a>b"), "a")).toBeNull();
	});

	it("climbs to the top — the node owning the budget and trace", () => {
		expect(rootOf(g("a>b", "b>c"), "c")).toBe("a");
		expect(rootOf(g("a>b"), "a")).toBe("a");
	});

	it("does not spin on cyclic historical data", () => {
		expect(["a", "b"]).toContain(rootOf(g("a>b", "b>a"), "a"));
	});
});
