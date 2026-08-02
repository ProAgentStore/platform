import { describe, expect, it } from "vitest";
import { normalizeRunnerNode, relayNameForInstance, parseBoundRunnerNode, readInstanceRunnerNode } from "./runtime-nodes.js";

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

describe("parseBoundRunnerNode", () => {
	it("extracts config.runnerNode from a JSON config string", () => {
		expect(parseBoundRunnerNode(JSON.stringify({ runnerNode: "pinned-box" }))).toBe("pinned-box");
	});

	it("returns '' (auto) for empty/null/absent config or missing field", () => {
		expect(parseBoundRunnerNode(null)).toBe("");
		expect(parseBoundRunnerNode(undefined)).toBe("");
		expect(parseBoundRunnerNode("{}")).toBe("");
		expect(parseBoundRunnerNode(JSON.stringify({ other: "x" }))).toBe("");
	});

	it("returns '' on malformed JSON rather than throwing", () => {
		expect(parseBoundRunnerNode("{not json")).toBe("");
	});

	it("normalizes (trims + caps) the pinned node", () => {
		expect(parseBoundRunnerNode(JSON.stringify({ runnerNode: "  spaced  " }))).toBe("spaced");
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
