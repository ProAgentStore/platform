/** #1179: a pinned agent whose machine is down is told which machine can take it, and the one action — and nothing is repinned. */
import { describe, expect, it } from "vitest";
import { failoverField, failoverSuggestion, type FailoverNodeFact } from "./runner-failover.js";

const node = (over: Partial<FailoverNodeFact> & { node: string }): FailoverNodeFact => ({ displayName: null, machineId: null, connected: false, nodeOnline: false, ...over });
const MINI = node({ node: "mac-mini.local", machineId: "mid-mini", displayName: "Mac mini" });
const LAPTOP = node({ node: "laptop.local", machineId: "mid-laptop", displayName: "Laptop", connected: true, nodeOnline: true });
const DELL = node({ node: "dell", machineId: "mid-dell", nodeOnline: true });

describe("failoverSuggestion", () => {
	it("pinned machine down, another attached: names it and the repin action, and says nothing was changed", () => {
		const s = failoverSuggestion({ pinned: "mac-mini.local", pinnedMachineId: "mid-mini", nodes: [MINI, LAPTOP] });
		expect(s?.candidates).toEqual([{ displayName: "Laptop", machineId: "mid-laptop", node: "laptop.local", attached: true, repinTo: "Laptop" }]);
		expect(s?.message).toMatch(/pinned to mac-mini\.local, which isn't connected/);
		expect(s?.message).toMatch(/set_instance_runner_node \(runner_node "Laptop"\)/);
		expect(s?.message).toMatch(/Nothing was repinned/);
	});

	it("ranks machines already attached first, then merely-online ones, and falls back to id then hostname for the repin value", () => {
		const s = failoverSuggestion({ pinned: "mac-mini.local", nodes: [MINI, DELL, LAPTOP] });
		expect(s?.candidates.map((c) => [c.node, c.attached, c.repinTo])).toEqual([["laptop.local", true, "Laptop"], ["dell", false, "mid-dell"]]);
		expect(failoverSuggestion({ pinned: "x", nodes: [node({ node: "bare-host", nodeOnline: true })] })?.candidates[0].repinTo).toBe("bare-host");
	});

	it("never offers the pinned machine itself (by name or machine id), or an offline machine", () => {
		const aliasOfPinned = node({ node: "mac-mini-alias", machineId: "mid-mini", nodeOnline: true });
		const offline = node({ node: "off", machineId: "mid-off" });
		const s = failoverSuggestion({ pinned: "mac-mini.local", pinnedMachineId: "mid-mini", nodes: [MINI, aliasOfPinned, offline] });
		expect(s?.candidates).toEqual([]);
		expect(s?.message).toMatch(/No other machine of yours is online/);
	});

	it("a stale registration name does not hide a machine that is up under another name", () => {
		const old = node({ node: "old-name", machineId: "mid-old", nodeOnline: true, stale: { since: "2026-01-01" } });
		expect(failoverSuggestion({ pinned: "mac-mini.local", nodes: [MINI, old] })?.candidates.map((c) => c.node)).toEqual(["old-name"]);
	});

	it("is silent when nothing is wrong: unpinned, the pinned machine connected, or the pin resolving to a live alias", () => {
		expect(failoverSuggestion({ pinned: null, nodes: [LAPTOP] })).toBeNull();
		expect(failoverSuggestion({ pinned: "", nodes: [LAPTOP] })).toBeNull();
		expect(failoverSuggestion({ pinned: "laptop.local", nodes: [LAPTOP, DELL] })).toBeNull();
		expect(failoverSuggestion({ pinned: "mac-mini.local", resolvedNode: "mac-mini-alias", nodes: [MINI, LAPTOP] })).toBeNull();
	});

	it("failoverField adds the key only when there is a suggestion", () => {
		expect(failoverField({ pinned: null, nodes: [] })).toEqual({});
		expect(Object.keys(failoverField({ pinned: "mac-mini.local", nodes: [MINI, LAPTOP] }))).toEqual(["failover"]);
	});
});
