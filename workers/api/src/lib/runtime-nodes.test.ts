import { describe, expect, it } from "vitest";
import { normalizeRunnerNode, relayNameForInstance, parseRunnerPin, pinnedNodeName, readInstanceRunnerNode } from "./runtime-nodes.js";

describe("normalizeRunnerNode", () => {
	it("trims whitespace and coerces nullish to empty string", () => {
		expect(normalizeRunnerNode("  laptop  ")).toBe("laptop");
		expect(normalizeRunnerNode(null)).toBe("");
		expect(normalizeRunnerNode(undefined)).toBe("");
		expect(normalizeRunnerNode("")).toBe("");
	});

	it("stringifies truthy non-string input then trims", () => {
		expect(normalizeRunnerNode(12345)).toBe("12345");
		// falsy values short-circuit `value || ""` to the empty string
		expect(normalizeRunnerNode(false)).toBe("");
		expect(normalizeRunnerNode(0)).toBe("");
	});

	it("caps the node name at 120 chars", () => {
		const long = "n".repeat(200);
		expect(normalizeRunnerNode(long)).toHaveLength(120);
	});
});

describe("relayNameForInstance", () => {
	it("returns the bare instance id when no node is given (legacy default)", () => {
		expect(relayNameForInstance("inst-1")).toBe("inst-1");
		expect(relayNameForInstance("inst-1", null)).toBe("inst-1");
		expect(relayNameForInstance("inst-1", "   ")).toBe("inst-1");
	});

	it("keys per (instance, node) when a node is supplied", () => {
		expect(relayNameForInstance("inst-1", "node-A")).toBe("inst-1:node:node-A");
		expect(relayNameForInstance("inst-1", "  node-B  ")).toBe("inst-1:node:node-B");
	});

	it("produces distinct relay names for two machines on the same instance", () => {
		const a = relayNameForInstance("inst-1", "macbook");
		const b = relayNameForInstance("inst-1", "workstation");
		expect(a).not.toBe(b);
		expect(a).toContain("inst-1:node:");
	});
});

describe("parseRunnerPin (#1250)", () => {
	const MID = "3901c9c4-004f-435e-bfc5-0b87b7ac5173";
	it("reads a machine-id pin, and a pre-#1250 hostname pin only while no id is pinned", () => {
		expect(parseRunnerPin(JSON.stringify({ runnerMachineId: MID }))).toEqual({ machineId: MID, legacyNode: "" });
		expect(parseRunnerPin(JSON.stringify({ runnerNode: "  pinned-box  " }))).toEqual({ machineId: "", legacyNode: "pinned-box" });
		// The id wins: a leftover hostname beside it is not the pin.
		expect(parseRunnerPin(JSON.stringify({ runnerMachineId: MID, runnerNode: "Mac.modem" }))).toEqual({ machineId: MID, legacyNode: "" });
	});

	it("reads empty, absent, malformed and invalid ids as automatic", () => {
		for (const raw of [null, undefined, "{}", JSON.stringify({ other: "x" }), "{not json", JSON.stringify({ runnerMachineId: "x'; DROP" })]) {
			expect(parseRunnerPin(raw)).toEqual({ machineId: "", legacyNode: "" });
		}
	});
});

describe("pinnedNodeName — a machine pin follows the machine's hostname (#1250)", () => {
	const MID = "3901c9c4-004f-435e-bfc5-0b87b7ac5173";
	const pin = { machineId: MID, legacyNode: "" };
	it("resolves to the hostname of the machine's freshest registration — a hostname change keeps the pin", () => {
		const rows = [
			{ runner_node: "RLs-MacBook-Air.local", machine_id: MID, last_seen_at: "2026-10-19 10:00:00" },
			{ runner_node: "Mac.modem", machine_id: MID, last_seen_at: "2026-10-20 00:40:00" },
			{ runner_node: "Macmini", machine_id: "other-machine-0001", last_seen_at: "2026-10-20 00:50:00" },
		];
		expect(pinnedNodeName(pin, rows)).toBe("Mac.modem");
		// macOS renames it again: a fresher row under the SAME id moves the pin with it.
		expect(pinnedNodeName(pin, [...rows, { runner_node: "Mac", machine_id: MID, last_seen_at: "2026-10-20 01:00:00" }])).toBe("Mac");
	});

	it("a pinned machine with no registration left reads as its id — offline, never automatic", () => {
		expect(pinnedNodeName(pin, [])).toBe(MID);
	});

	it("a legacy hostname pin resolves to itself", () => {
		expect(pinnedNodeName({ machineId: "", legacyNode: "Macmini" }, [])).toBe("Macmini");
	});
});

function envReturning(config: string | null) {
	return {
		DB: {
			prepare() {
				return { bind() { return { async first() { return config === undefined ? null : { config }; } }; } };
			},
		},
	} as unknown as { DB: D1Database };
}

describe("readInstanceRunnerNode", () => {
	it("reads + parses the pinned node from the instance config row", async () => {
		const env = envReturning(JSON.stringify({ runnerNode: "desktop-1" }));
		expect(await readInstanceRunnerNode(env, "inst-1", "user-1")).toBe("desktop-1");
	});

	it("returns '' when the instance row is missing (no config)", async () => {
		const env = { DB: { prepare() { return { bind() { return { async first() { return null; } }; } }; } } } as unknown as { DB: D1Database };
		expect(await readInstanceRunnerNode(env, "nope", "user-1")).toBe("");
	});

	it("returns '' when the config has no runnerNode", async () => {
		const env = envReturning("{}");
		expect(await readInstanceRunnerNode(env, "inst-1", "user-1")).toBe("");
	});
});
