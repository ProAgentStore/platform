import { describe, expect, it } from "vitest";
import {
	MAX_LOOP_PRESETS,
	addPreset,
	canResetPresets,
	incompleteCount,
	movePreset,
	presetSourceLabel,
	presetsDirty,
	removePreset,
	saveablePresets,
	updatePreset,
	type LoopPreset,
} from "./loopPresets";

const list: LoopPreset[] = [
	{ id: "bugs", label: "Fix bugs", objective: "Find and fix all bugs." },
	{ id: "tests", label: "Add tests", objective: "Write tests." },
];

describe("addPreset", () => {
	it("appends a blank row with an id that cannot collide", () => {
		// A duplicate id edits the wrong row — the id is both the React key and the edit handle.
		const seeded: LoopPreset[] = [{ id: "preset-1", label: "a", objective: "b" }];
		expect(addPreset(seeded)[1].id).not.toBe("preset-1");
		expect(new Set(addPreset(addPreset(seeded)).map((p) => p.id)).size).toBe(3);
	});

	it("stops at the cap the server also enforces", () => {
		const full = Array.from({ length: MAX_LOOP_PRESETS }, (_, i) => ({ id: `p${i}`, label: `p${i}`, objective: "x" }));
		expect(addPreset(full)).toHaveLength(MAX_LOOP_PRESETS);
	});
});

describe("updatePreset / removePreset", () => {
	it("changes only the row addressed", () => {
		const out = updatePreset(list, "tests", { label: "Add MORE tests" });
		expect(out[0]).toEqual(list[0]);
		expect(out[1].label).toBe("Add MORE tests");
		expect(out[1].objective).toBe("Write tests.");
	});

	it("caps a pasted objective at the length the server accepts", () => {
		const out = updatePreset(list, "bugs", { objective: "x".repeat(5000) });
		expect(out[0].objective).toHaveLength(1000);
	});

	it("removes by id without disturbing the rest", () => {
		expect(removePreset(list, "bugs").map((p) => p.id)).toEqual(["tests"]);
		expect(removePreset(list, "nope")).toHaveLength(2);
	});
});

describe("movePreset", () => {
	it("swaps with the neighbour", () => {
		expect(movePreset(list, "tests", -1).map((p) => p.id)).toEqual(["tests", "bugs"]);
	});

	it("is inert at the ends rather than wrapping", () => {
		// A preset that jumps from the top of the list to the bottom reads as a bug, not a feature.
		expect(movePreset(list, "bugs", -1).map((p) => p.id)).toEqual(["bugs", "tests"]);
		expect(movePreset(list, "tests", 1).map((p) => p.id)).toEqual(["bugs", "tests"]);
	});
});

describe("saveablePresets", () => {
	it("trims, and drops a row that would be an unusable button", () => {
		const out = saveablePresets([
			{ id: "a", label: "  Ship  ", objective: "  Ship it.  " },
			{ id: "b", label: "Half", objective: "   " },
			{ id: "c", label: "", objective: "orphan objective" },
		]);
		expect(out).toEqual([{ id: "a", label: "Ship", objective: "Ship it." }]);
	});

	it("counts the half-finished rows so the UI can warn before they vanish", () => {
		expect(incompleteCount([{ id: "b", label: "Half", objective: "" }])).toBe(1);
		// A completely blank row is the "Add preset" the user changed their mind about — not a warning.
		expect(incompleteCount([{ id: "b", label: "", objective: "" }])).toBe(0);
	});
});

describe("presetsDirty", () => {
	it("is false for cosmetic-only differences", () => {
		expect(presetsDirty(list, list)).toBe(false);
		expect(presetsDirty([...list, { id: "new", label: "", objective: "" }], list)).toBe(false);
	});

	it("notices an edit, an addition, and a REORDER", () => {
		expect(presetsDirty(updatePreset(list, "bugs", { label: "Fix" }), list)).toBe(true);
		expect(presetsDirty(saveablePresets(addPreset(list)).concat({ id: "n", label: "n", objective: "o" }), list)).toBe(true);
		// Order is what the buttons render in, so moving one IS a change to save.
		expect(presetsDirty(movePreset(list, "tests", -1), list)).toBe(true);
	});
});

describe("reset + provenance", () => {
	it("only offers a reset when there is something of the user's own to reset (#232)", () => {
		expect(canResetPresets("instance")).toBe(true);
		expect(canResetPresets("agent")).toBe(false);
		expect(canResetPresets("default")).toBe(false);
	});

	it("says where the list came from, including the empty case", () => {
		expect(presetSourceLabel("instance", 2)).toContain("Your presets");
		expect(presetSourceLabel("agent", 2)).toContain("creator");
		expect(presetSourceLabel("default", 0)).toContain("no loop presets");
	});
});
