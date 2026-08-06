import { describe, expect, it } from "vitest";
import { splitUsage } from "./external-usage.js";

const row = (user_id: string, agent_id: string | null, calls = 1, cost_micros = 0) => ({ user_id, agent_id, calls, cost_micros });

describe("splitUsage", () => {
	// The metric #68 is actually written in: "10 external users on ONE runtime agent".
	it("counts DISTINCT external users per agent, not calls", () => {
		const r = splitUsage(
			[
				row("ext-1", "coder", 500),
				row("ext-2", "coder", 3),
				row("op", "coder", 9000),
			],
			new Set(["op"]),
		);
		expect(r.externalUsers).toBe(2);
		expect(r.byAgent.find((a) => a.agentId === "coder")?.externalUsers).toBe(2);
	});

	// The classification that makes the whole thing work. Every seeded catalog agent is owned by
	// one account, so an owner-based rule would count a genuine subscriber's use of `coder` as
	// operator usage and read zero forever.
	it("classifies by WHO CALLED, never by who owns the agent", () => {
		const r = splitUsage([row("ext-1", "coder", 10)], new Set(["operator-who-owns-coder"]));
		expect(r.externalUsers).toBe(1);
		expect(r.totals.calls).toBe(10);
	});

	it("reports operator activity alongside, so the comparison is visible not implied", () => {
		const r = splitUsage([row("op", "coder", 700, 17_000_000), row("ext", "coder", 5, 100)], new Set(["op"]));
		expect(r.operator).toEqual({ users: 1, calls: 700, costMicros: 17_000_000 });
		expect(r.totals).toEqual({ calls: 5, costMicros: 100 });
	});

	// The failure mode this exists to prevent: reporting a falsely encouraging number. With no
	// identifiable operator EVERY row looks external, so the counts are meaningless, not zero.
	it("flags operatorUnknown rather than reporting everyone as external", () => {
		const r = splitUsage([row("a", "coder"), row("b", "coder")], new Set());
		expect(r.operatorUnknown).toBe(true);
		expect(r.externalUsers).toBe(2); // the raw number is still there, but it is not trustworthy
	});

	it("does not flag unknown when an operator exists but simply has no usage", () => {
		const r = splitUsage([row("ext", "coder")], new Set(["op"]));
		expect(r.operatorUnknown).toBe(false);
		expect(r.operator.calls).toBe(0);
	});

	// Attributable-to-nothing is still usage; dropping it would understate the very number the
	// bet turns on. Today ~830 calls in the live ledger have no agent id.
	it("keeps unattributed rows under an explicit bucket instead of dropping them", () => {
		const r = splitUsage([row("ext", null, 833, 8_470_000)], new Set(["op"]));
		expect(r.totals.calls).toBe(833);
		expect(r.byAgent[0]).toMatchObject({ agentId: "(unattributed)", externalUsers: 1, calls: 833 });
	});

	it("sorts agents by external users first — that is the question being asked", () => {
		const r = splitUsage(
			[row("e1", "quiet"), row("e1", "busy"), row("e2", "busy"), row("e3", "busy")],
			new Set(["op"]),
		);
		expect(r.byAgent[0].agentId).toBe("busy");
		expect(r.byAgent[0].externalUsers).toBe(3);
	});

	it("is empty and honest when there is no usage at all", () => {
		const r = splitUsage([], new Set(["op"]));
		expect(r).toMatchObject({ externalUsers: 0, byAgent: [], totals: { calls: 0, costMicros: 0 }, operatorUnknown: false });
	});
});
