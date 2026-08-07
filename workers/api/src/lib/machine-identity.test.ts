import { describe, expect, it } from "vitest";
import { aliasNodesFor, foldNodesByMachine, MAX_MACHINE_NAMES, normalizeMachineId, sanitizeMachineNames, type NodeRegistration } from "./machine-identity.js";

const row = (node: string, machineId: string | null, extra: Partial<NodeRegistration> = {}): NodeRegistration => ({
	node,
	machineId,
	lastSeenAt: "2026-08-01 00:00:00",
	...extra,
});

describe("normalizeMachineId", () => {
	it("accepts a uuid and rejects anything that could not be one", () => {
		expect(normalizeMachineId("2f1c8a90-0e2b-4b6a-9a2b-3c4d5e6f7081")).toBe("2f1c8a90-0e2b-4b6a-9a2b-3c4d5e6f7081");
		for (const bad of ["", "short", null, undefined, 42, "has space", "a".repeat(65), "semi;colon"]) {
			expect(normalizeMachineId(bad)).toBe("");
		}
	});
});

describe("sanitizeMachineNames", () => {
	it("de-duplicates and caps — the list authorises a write, so its size is the blast radius", () => {
		expect(sanitizeMachineNames(["Mac", "Mac", " Mac ", "Mac.local"])).toEqual(["Mac", "Mac.local"]);
		expect(sanitizeMachineNames(Array.from({ length: 40 }, (_, i) => `host-${i}`))).toHaveLength(MAX_MACHINE_NAMES);
	});

	it("returns nothing for a non-array or for empty names", () => {
		expect(sanitizeMachineNames("Mac")).toEqual([]);
		expect(sanitizeMachineNames([" ", "", null])).toEqual([]);
	});
});

describe("aliasNodesFor", () => {
	// THE case (#379): one laptop, three hostnames. The pin names `RLs-MacBook-Air.local`; the
	// live socket is on `Mac`. Both rows carry the same persisted machine id, so this is not a
	// fallback to another machine — it IS the pinned machine, under the name it wears today.
	it("resolves a pin onto another name of the same machine", () => {
		const rows = [
			row("Mac", "machine-aaaa1111", { lastSeenAt: "2026-08-08 06:39:00" }),
			row("RLs-MacBook-Air.local", "machine-aaaa1111", { lastSeenAt: "2026-08-07 09:20:00" }),
		];
		expect(aliasNodesFor("RLs-MacBook-Air.local", rows)).toEqual(["Mac"]);
	});

	it("prefers the freshest name when a machine has worn several", () => {
		const rows = [
			row("old", "machine-aaaa1111", { lastSeenAt: "2026-07-16 10:00:00" }),
			row("pinned", "machine-aaaa1111", { lastSeenAt: "2026-08-07 09:20:00" }),
			row("newest", "machine-aaaa1111", { lastSeenAt: "2026-08-08 06:39:00" }),
		];
		expect(aliasNodesFor("pinned", rows)).toEqual(["newest", "old"]);
	});

	// The guarantee `getBoundRunnerConn` is built on: a pin never falls back to a DIFFERENT
	// machine. Without a recorded id there is no proof of sameness, so there is no candidate —
	// the honest answer is the same "offline" it has always been.
	it("yields NOTHING when the pinned row has no machine id", () => {
		expect(aliasNodesFor("pinned", [row("pinned", null), row("other", "machine-bbbb2222")])).toEqual([]);
	});

	it("never crosses machines — a different id is a different laptop", () => {
		expect(aliasNodesFor("pinned", [row("pinned", "machine-aaaa1111"), row("other", "machine-bbbb2222")])).toEqual([]);
	});

	it("skips a name registered only for OTHER instances — routing needs this instance's own row", () => {
		const rows = [
			row("pinned", "machine-aaaa1111", { instanceId: "inst-1" }),
			row("renamed", "machine-aaaa1111", { instanceId: "inst-2" }),
		];
		expect(aliasNodesFor("pinned", rows, "inst-1")).toEqual([]);
		// The same machine, registered for this instance too, IS reachable.
		expect(aliasNodesFor("pinned", [...rows, row("renamed", "machine-aaaa1111", { instanceId: "inst-1" })], "inst-1")).toEqual(["renamed"]);
	});

	it("returns nothing for an unpinned instance", () => {
		expect(aliasNodesFor("", [row("a", "machine-aaaa1111"), row("b", "machine-aaaa1111")])).toEqual([]);
	});
});

describe("foldNodesByMachine", () => {
	it("collapses one laptop's three hostnames into its freshest name", () => {
		const folded = foldNodesByMachine([
			row("RLs-MacBook-Air", "machine-aaaa1111", { lastSeenAt: "2026-07-16 10:00:00" }),
			row("RLs-MacBook-Air.local", "machine-aaaa1111", { lastSeenAt: "2026-08-07 09:20:00" }),
			row("Mac", "machine-aaaa1111", { lastSeenAt: "2026-08-08 06:39:00" }),
			row("Sergeys-Mac-mini.local", "machine-bbbb2222", { lastSeenAt: "2026-08-08 06:00:00" }),
		]);
		expect(folded.map((f) => f.node)).toEqual(["Mac", "Sergeys-Mac-mini.local"]);
	});

	it("leaves un-identified rows alone — without the proof they ARE separate machines", () => {
		const folded = foldNodesByMachine([row("a", null), row("b", null)]);
		expect(folded.map((f) => f.node)).toEqual(["a", "b"]);
	});
});
