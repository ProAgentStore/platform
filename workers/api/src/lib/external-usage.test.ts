import { describe, expect, it } from "vitest";
import { splitUsage } from "./external-usage.js";

/** `charged_micros` defaults to the full value — the old fixture's world, where every row is money. */
const row = (user_id: string, agent_id: string | null, calls = 1, value_micros = 0, charged_micros = value_micros) => ({
	user_id,
	agent_id,
	calls,
	value_micros,
	charged_micros,
});

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
		expect(r.operator).toEqual({ users: 1, calls: 700, valueMicros: 17_000_000, chargedMicros: 17_000_000 });
		expect(r.totals).toEqual({ calls: 5, valueMicros: 100, chargedMicros: 100 });
	});

	/**
	 * Value and charge are carried separately, because #57 turns one of them into a payout.
	 *
	 * A coding engine running on the owner's Claude subscription accrues large notional value and
	 * no charge. Reporting the value alone under a money-shaped name is how a creator gets paid,
	 * or a tenant billed, for dollars nobody was charged — the #343 error pointed outward.
	 */
	it("keeps notional value and actual charge apart", () => {
		const r = splitUsage(
			[
				row("ext-1", "coder", 10, 48_760_000, 0), // a subscription engine session: value, no charge
				row("ext-2", "coder", 4, 1_000_000, 1_000_000), // BYOK: value IS the charge
			],
			new Set(["op"]),
		);
		expect(r.totals).toEqual({ calls: 14, valueMicros: 49_760_000, chargedMicros: 1_000_000 });
		expect(r.byAgent[0]).toMatchObject({ agentId: "coder", valueMicros: 49_760_000, chargedMicros: 1_000_000 });
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
		expect(r).toMatchObject({ externalUsers: 0, byAgent: [], totals: { calls: 0, valueMicros: 0, chargedMicros: 0 }, operatorUnknown: false });
	});
});

// ── The caller is an operator by construction ────────────────────────────────
//
// Found by running this against the live platform: `operatorUnknown` came back true and the
// operator's own 2782 calls were counted as external. `isAdmin` accepts three signals and one
// of them — the role baked into the session token — is only observable for the person holding
// it. It cannot be queried for other users, so a deployment whose operator has the role only in
// their token identified nobody at all.
describe("the calling admin counts as an operator", () => {
	it("does not report the caller's own usage as external", () => {
		const rows = [row("caller", "coder", 2782, 40_920_000)];
		// What happened live: caller absent from the operator set.
		const before = splitUsage(rows, new Set());
		expect(before).toMatchObject({ externalUsers: 1, operatorUnknown: true });
		// With requireAdmin's caller included, the same data reads correctly.
		const after = splitUsage(rows, new Set(["caller"]));
		expect(after).toMatchObject({ externalUsers: 0, operatorUnknown: false });
		expect(after.operator.calls).toBe(2782);
	});

	it("still finds a genuine external user alongside the caller", () => {
		const r = splitUsage([row("caller", "coder", 900), row("someone-else", "coder", 4)], new Set(["caller"]));
		expect(r.externalUsers).toBe(1);
		expect(r.byAgent[0]).toMatchObject({ agentId: "coder", externalUsers: 1, calls: 4 });
	});
});
