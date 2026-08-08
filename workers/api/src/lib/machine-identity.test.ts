import { describe, expect, it } from "vitest";
import { adoptableIdByName, aliasNodesFor, compareCliVersions, foldNodesByMachine, identityHint, MACHINE_ID_MIN_CLI, machineNamesFor, MAX_MACHINE_NAMES, normalizeMachineId, sanitizeMachineNames, type NodeRegistration } from "./machine-identity.js";

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

describe("adoptableIdByName (#393 — one rule, shared with the Terminals fold)", () => {
	it("gives a name the id its rows agree on, including the rows that carry none", () => {
		// One row per (instance, hostname), and a `pags up` stamps the id only on what it attached
		// this session — so the SAME hostname legitimately holds identified and NULL rows at once.
		const map = adoptableIdByName([
			row("Mac", "machine-aaaa1111", { instanceId: "i1" }),
			row("Mac", null, { instanceId: "i2" }),
		]);
		expect(map.get("Mac")).toBe("machine-aaaa1111");
	});

	it("gives a name NOTHING when two machines answer to it", () => {
		// The mirror-image failure: two laptops both called `Mac` must never be merged by their name.
		const map = adoptableIdByName([row("Mac", "machine-aaaa1111"), row("Mac", "machine-bbbb2222")]);
		expect(map.has("Mac")).toBe(false);
	});
});

describe("machineNamesFor (#393 — what 'forget this machine' operates on)", () => {
	const fleet = [
		row("RLs-MacBook-Air", "machine-aaaa1111"),
		row("RLs-MacBook-Air.local", "machine-aaaa1111"),
		row("Mac", "machine-aaaa1111"),
		row("Sergeys-Mac-mini.local", "machine-bbbb2222"),
	];

	it("resolves any one name of a laptop to ALL of its names", () => {
		// The reported account, exactly: three names, one machine. Forgetting by the name the user
		// clicked must take the other two with it, or the tile comes back minus some of its rows.
		const got = machineNamesFor("RLs-MacBook-Air.local", fleet);
		expect(got.ok).toBe(true);
		if (!got.ok) return;
		expect([...got.names].sort()).toEqual(["Mac", "RLs-MacBook-Air", "RLs-MacBook-Air.local"]);
		expect(got.machineId).toBe("machine-aaaa1111");
	});

	it("never reaches across machines", () => {
		const got = machineNamesFor("Sergeys-Mac-mini.local", fleet);
		expect(got.ok && got.names).toEqual(["Sergeys-Mac-mini.local"]);
	});

	it("an unidentified name is a machine of exactly one name", () => {
		// No proof of a rename means no second name to sweep up — the same fail-closed reading the
		// fold applies, and here it is also the safe one.
		const got = machineNamesFor("orphan", [row("orphan", null), row("other", null)]);
		expect(got.ok && got.names).toEqual(["orphan"]);
		expect(got.ok && got.machineId).toBe(null);
	});

	it("refuses a name two machines share rather than picking one", () => {
		expect(machineNamesFor("Mac", [row("Mac", "machine-aaaa1111"), row("Mac", "machine-bbbb2222")])).toEqual({ ok: false, reason: "ambiguous" });
	});

	it("refuses a name nothing has registered under", () => {
		expect(machineNamesFor("ghost", fleet)).toEqual({ ok: false, reason: "unknown" });
		expect(machineNamesFor("", fleet)).toEqual({ ok: false, reason: "unknown" });
	});
});

describe("compareCliVersions", () => {
	it("orders by numeric part, not by string", () => {
		// The whole point: "0.4.9" > "0.4.40" as strings, and that would tell a current CLI to upgrade.
		expect(compareCliVersions("0.4.35", "0.4.40")).toBe(-1);
		expect(compareCliVersions("0.4.9", "0.4.40")).toBe(-1);
		expect(compareCliVersions("0.4.43", "0.4.40")).toBe(1);
		expect(compareCliVersions("0.4.40", "0.4.40")).toBe(0);
		expect(compareCliVersions("v0.5.0", "0.4.40")).toBe(1);
	});

	it("says it cannot tell rather than guessing", () => {
		for (const bad of ["", "?", "unknown", "0", "abc"]) expect(compareCliVersions(bad, MACHINE_ID_MIN_CLI)).toBe(null);
	});
});

describe("identityHint (#393 — why nothing merged)", () => {
	it("says nothing about a machine that HAS an identity", () => {
		expect(identityHint("machine-aaaa1111", "0.4.35")).toBe(null);
	});

	it("names the version and the remedy for a CLI too old to mint one", () => {
		const hint = identityHint(null, "0.4.35");
		expect(hint).toContain("0.4.35");
		expect(hint).toContain(MACHINE_ID_MIN_CLI);
	});

	it("does NOT tell a current CLI to upgrade — that is the #379 failure repeated", () => {
		// "The one remedy the platform offers is the one thing the user has already done." A current
		// CLI with no id could not write its id file; upgrading cannot fix that.
		const hint = identityHint(null, "0.4.43");
		expect(hint).toContain("~/.config/proagentstore/");
		expect(hint).not.toContain("upgrade");
	});

	it("stays silent when the version cannot be read", () => {
		expect(identityHint(null, "?")).toBe(null);
		expect(identityHint(null, null)).toBe(null);
	});
});
