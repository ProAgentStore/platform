/**
 * Both branches of the unsubscribe scope statement (#742).
 *
 * The difference between them IS the point of the change: the last-instance case is the only one
 * where anything beyond the instance changes, and before this it was worded identically to the
 * common case. So the two are pinned against each other, not just individually — a refactor that
 * collapsed them back into one sentence has to fail here.
 */

import { describe, expect, it } from "vitest";
import { type RosterInstance, unsubscribeScope } from "./unsubscribeScope";

const inst = (id: string, agent_id: string, name?: string, agentName?: string): RosterInstance => ({
	id,
	agent_id,
	name,
	agentName,
});

describe("unsubscribeScope — with siblings", () => {
	const roster = [
		inst("i1", "a1", "Coder Lead", "Coder"),
		inst("i2", "a1", "Coder Spare", "Coder"),
		inst("i3", "a1", "Coder Third", "Coder"),
		inst("i9", "a2", "Repo Chat"),
	];

	it("names the instance it cancels, not the agent", () => {
		const s = unsubscribeScope(roster, "i1");
		expect(s.button).toBe("Cancel this instance");
		expect(s.statement).toContain("Cancels Coder Lead only.");
		// The defect: the control used to name the agent as the thing being acted on.
		expect(s.button).not.toContain("Unsubscribe");
		expect(s.statement).not.toContain("Unsubscribe from this agent");
	});

	it("states the sibling count and that they survive", () => {
		const s = unsubscribeScope(roster, "i1");
		expect(s.siblings).toBe(2);
		expect(s.statement).toContain("Your 2 other instances of Coder keep running.");
	});

	it("does not count another agent's instances as siblings", () => {
		// i9 belongs to agent a2. Counting it would overstate what survives.
		expect(unsubscribeScope(roster, "i1").siblings).toBe(2);
		expect(unsubscribeScope(roster, "i9").siblings).toBe(0);
	});

	it("agrees in number with the singular", () => {
		const two = [inst("i1", "a1", "Coder Lead", "Coder"), inst("i2", "a1", "Coder Spare", "Coder")];
		const s = unsubscribeScope(two, "i1");
		expect(s.statement).toContain("Your 1 other instance of Coder keeps running.");
	});

	it("never claims the subscription ends", () => {
		const s = unsubscribeScope(roster, "i1");
		expect(s.endsSubscription).toBe(false);
		expect(s.statement).not.toContain("subscription");
	});

	it("falls back to the agent name when the instance has no display name", () => {
		// my/instances omits `agentName` unless a display name is set, and then `name` IS the
		// agent's name — so both halves of the sentence read the same, which is honest.
		const r = [inst("i1", "a1", "Repo Chat"), inst("i2", "a1", "Repo Chat")];
		expect(unsubscribeScope(r, "i1").statement).toBe(
			"Cancels Repo Chat only. Your 1 other instance of Repo Chat keeps running. " +
				"Nothing is deleted — chat, memory, knowledge and files stay unless you clear them above.",
		);
	});
});

describe("unsubscribeScope — the last instance", () => {
	const roster = [inst("i1", "a1", "Coder Lead", "Coder"), inst("i9", "a2", "Repo Chat")];

	it("says the subscription ends, which is the only thing beyond the instance that changes", () => {
		const s = unsubscribeScope(roster, "i1");
		expect(s.endsSubscription).toBe(true);
		expect(s.siblings).toBe(0);
		expect(s.statement).toContain("This is your only instance of Coder");
		expect(s.statement).toContain("ends your subscription to Coder too");
	});

	it("is distinguishable from the common case — the whole point of the split", () => {
		const withSiblings = unsubscribeScope(
			[inst("i1", "a1", "Coder Lead", "Coder"), inst("i2", "a1", "Coder Spare", "Coder")],
			"i1",
		);
		const lastOne = unsubscribeScope(roster, "i1");
		expect(lastOne.statement).not.toBe(withSiblings.statement);
		expect(lastOne.endsSubscription).not.toBe(withSiblings.endsSubscription);
		// Specifically: only one of them mentions the subscription at all.
		expect(lastOne.statement).toContain("subscription");
		expect(withSiblings.statement).not.toContain("subscription");
	});
});

describe("unsubscribeScope — the confirm dialog", () => {
	it("carries the panel's statement verbatim, in both branches", () => {
		const many = unsubscribeScope(
			[inst("i1", "a1", "Coder Lead", "Coder"), inst("i2", "a1", "Coder Spare", "Coder")],
			"i1",
		);
		const one = unsubscribeScope([inst("i1", "a1", "Coder Lead", "Coder")], "i1");
		// The old dialog said "Unsubscribe from this agent? Your data stays unless you clear it." —
		// a shorter restatement of the same scope error. It must now be the SAME sentence.
		expect(many.confirm).toContain(many.statement);
		expect(one.confirm).toContain(one.statement);
		expect(many.confirm.startsWith("Cancel Coder Lead?")).toBe(true);
	});
});

describe("unsubscribeScope — when the roster could not be read", () => {
	// SettingsTab's roster fetch can fail; it already accumulates that into a "could not load"
	// banner. A control that then asserted a sibling count would be inventing the number that
	// made the user trust it.
	for (const [name, roster] of [
		["null", null],
		["undefined", undefined],
		["empty", [] as RosterInstance[]],
		["missing this instance", [inst("other", "a1", "Someone Else")]],
		// A row with no agent_id: nothing to group siblings by. Reporting "only instance" here
		// would announce that the subscription ends, which is the alarming direction to be wrong in.
		["a row with no agent_id", [{ id: "i1", name: "Coder Lead" } as RosterInstance]],
	] as const) {
		it(`states no count it cannot support (${name})`, () => {
			const s = unsubscribeScope(roster, "i1");
			expect(s.siblings).toBeNull();
			expect(s.statement).toContain("Cancels this instance only");
			expect(s.statement).not.toMatch(/Your \d+ other/);
			// It must not claim the subscription ends either — it does not know.
			expect(s.endsSubscription).toBe(false);
			expect(s.statement).toContain("If it is your last one");
			expect(s.confirm).toContain(s.statement);
		});
	}
});

describe("unsubscribeScope — the data sentence survives all three branches", () => {
	it("still answers the question the old copy got right", () => {
		const cases = [
			unsubscribeScope([inst("i1", "a1", "A", "Ag"), inst("i2", "a1", "B", "Ag")], "i1"),
			unsubscribeScope([inst("i1", "a1", "A", "Ag")], "i1"),
			unsubscribeScope(null, "i1"),
		];
		for (const c of cases) {
			expect(c.statement).toContain(
				"Nothing is deleted — chat, memory, knowledge and files stay unless you clear them above.",
			);
		}
	});
});
