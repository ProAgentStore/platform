import { describe, expect, it } from "vitest";
import { canDelegate, delegationDenial, supervisionToolNames } from "./supervision-capability.js";
import type { AgentCapabilities } from "./agent-capabilities.js";

const caps = (over: Partial<AgentCapabilities>): AgentCapabilities =>
	({ surfaces: [], runtime: null, workflow: null, ...over }) as AgentCapabilities;

describe("supervisionToolNames — read from the registry, never copied", () => {
	it("names the supervision connector's own tools", () => {
		const names = supervisionToolNames();
		expect(names).toContain("delegate_goal");
		expect(names).toContain("list_subordinates");
		// If a fifth tool is added or one is renamed, this guard follows it automatically — a
		// hardcoded list here would keep passing while asserting nothing about the real set.
		expect(names.length).toBeGreaterThanOrEqual(4);
	});
});

describe("canDelegate — the agent-level half of supervision (#354)", () => {
	it("is true for an agent that declares a supervision tool", () => {
		expect(canDelegate(caps({ tools: ["delegate_goal"] }))).toBe(true);
	});

	// 25 of 26 instances on the reporting account. The picker offered them all and the route
	// answered 201 for every one.
	it("is false for an agent that declares tools but none of them delegate", () => {
		expect(canDelegate(caps({ tools: ["search_knowledge", "github_list_issues"] }))).toBe(false);
	});

	// A legacy agent declaring nothing falls back to the per-surface default, which contains no
	// connector tools at all — so it cannot delegate either, and saying so is the honest answer.
	it("is false for a legacy agent that declares nothing", () => {
		expect(canDelegate(caps({}))).toBe(false);
	});
});

describe("delegationDenial", () => {
	it("names the reason, because the human is present at wiring time", () => {
		const msg = delegationDenial(caps({ tools: ["search_knowledge"] }));
		expect(msg).toContain("cannot delegate");
		expect(msg).toContain("supervision tools");
	});

	it("says nothing when the agent can delegate", () => {
		expect(delegationDenial(caps({ tools: ["delegate_goal"] }))).toBeNull();
	});

	// Ownership is proven before this runs, so a null is a FAILED READ, not evidence. Refusing on
	// it would turn a transient D1 blip into "your agent cannot delegate" — the same
	// confidently-wrong answer this ticket is about, pointed the other way.
	it("allows when the capabilities could not be read at all", () => {
		expect(delegationDenial(null)).toBeNull();
		expect(delegationDenial(undefined)).toBeNull();
	});
});
