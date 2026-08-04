import { describe, expect, it } from "vitest";
import { capabilityBadges, identityFor, initialsOf } from "./identity";

const inst = (over: Partial<Parameters<typeof identityFor>[0]> = {}) => ({
	id: "i1",
	name: "Repo Coder",
	...over,
});

describe("identityFor — siblings must be distinguishable", () => {
	it("gives three instances of the SAME agent three different tints", () => {
		// The actual complaint: three Repo Coders, one per repo, looked identical. The tint
		// hashes the INSTANCE id, not the agent, which is what separates them.
		const fas = identityFor(inst({ id: "964594b6", name: "FAS platform" }));
		const fws = identityFor(inst({ id: "5219a03a", name: "FWS platform" }));
		const fgs = identityFor(inst({ id: "e26f69d0", name: "FGS platform" }));
		expect(new Set([fas.bg, fws.bg, fgs.bg]).size).toBe(3);
	});

	it("is STABLE — the same instance keeps its colour forever", () => {
		// A tile that changes colour between reloads is worse than no tile: it destroys the
		// recognition this module exists to create.
		expect(identityFor(inst({ id: "abc" })).bg).toBe(identityFor(inst({ id: "abc" })).bg);
	});

	it("overrides the legacy default purple that every seeded agent shares", () => {
		// #7c3aed is on nearly every agent in the catalog, which is exactly why the page looked
		// uniform. Honouring it would preserve the problem.
		expect(identityFor(inst({ icon_bg: "#7c3aed" })).bg).not.toBe("#7c3aed");
	});

	it("HONOURS a genuinely chosen colour — a creator's mark is intent, not a default", () => {
		expect(identityFor(inst({ icon_bg: "#0b0b0f" })).bg).toBe("#0b0b0f");
	});
});

describe("identityFor — the mark should say what the agent DOES", () => {
	it("uses the agent's own emoji when it has one", () => {
		expect(identityFor(inst({ icon: "🧭" })).emoji).toBe("🧭");
	});

	it("derives one from the declared surface when it does not", () => {
		expect(identityFor(inst({ capabilities: { surfaces: ["coding"] } })).emoji).toBe("⌨️");
		expect(identityFor(inst({ capabilities: { surfaces: ["repo"] } })).emoji).toBe("🔍");
		expect(identityFor(inst({ capabilities: { surfaces: ["apply"] } })).emoji).toBe("📄");
	});

	it("falls back to category before the generic robot", () => {
		expect(identityFor(inst({ category: "Sales" })).emoji).toBe("📈");
		expect(identityFor(inst({ category: "creative" })).emoji).toBe("🎨");
	});

	it("uses the robot only when nothing else is known", () => {
		expect(identityFor(inst({})).emoji).toBe("🤖");
	});
});

describe("identityFor — subtitle", () => {
	it("shows the agent behind a renamed instance", () => {
		expect(identityFor(inst({ name: "FAS platform", agentName: "Repo Coder" })).subtitle).toBe("Repo Coder");
	});

	it("stays null when the names are the same — 'Repo Coder / Repo Coder' is noise", () => {
		expect(identityFor(inst({ name: "Repo Coder", agentName: "Repo Coder" })).subtitle).toBeNull();
		expect(identityFor(inst({ name: "Repo Coder" })).subtitle).toBeNull();
	});
});

describe("initialsOf", () => {
	it("skips noise words so the letters carry meaning", () => {
		expect(initialsOf("The Daily Grind")).toBe("DG");
		expect(initialsOf("My Repo Coder")).toBe("RC");
	});

	it("handles one word and separators", () => {
		expect(initialsOf("Coder")).toBe("CO");
		expect(initialsOf("fas/platform")).toBe("FP");
	});

	it("never returns empty", () => {
		expect(initialsOf("")).toBe("AI");
		expect(initialsOf("   ")).toBe("AI");
	});
});

describe("capabilityBadges", () => {
	it("says what the instance actually does", () => {
		// Replaces a constant "subscribed" that appeared on every card and distinguished nothing.
		expect(capabilityBadges(inst({ capabilities: { surfaces: ["coding"], runtime: "coding" } }))).toEqual([
			"coding",
			"needs runner",
		]);
	});

	it("is empty for a plain cloud agent rather than inventing a label", () => {
		expect(capabilityBadges(inst({ capabilities: { surfaces: [], runtime: null } }))).toEqual([]);
	});

	it("caps the row so a busy agent cannot wrap the card", () => {
		const many = { surfaces: ["coding", "repo", "apply", "insurance"], runtime: "coding" };
		expect(capabilityBadges(inst({ capabilities: many })).length).toBeLessThanOrEqual(3);
	});
});
