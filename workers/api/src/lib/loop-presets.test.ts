import { describe, expect, it } from "vitest";
import {
	CODING_LOOP_PRESETS,
	MAX_LOOP_PRESETS,
	MAX_PRESET_OBJECTIVE,
	defaultLoopPresets,
	resolveLoopPresets,
	sanitizeLoopPresets,
} from "./loop-presets.js";

describe("defaults follow what the loop DRIVES, not which agent it is (#234)", () => {
	it("gives a coding-driven agent the five that used to be hardcoded in CodingTab", () => {
		expect(defaultLoopPresets("coding").map((p) => p.id)).toEqual(["bugs", "quality", "security", "refactor", "tests"]);
	});

	it("gives a chat-driven agent none, rather than coding chores it cannot do", () => {
		// "Run a security audit and commit" in a language tutor's loop form is worse than an empty
		// form: it is a button that starts an autonomous run with an objective nobody meant.
		expect(defaultLoopPresets("chat")).toEqual([]);
	});

	it("every shipped default is well-formed, so the defaults cannot themselves be dropped", () => {
		expect(sanitizeLoopPresets([...CODING_LOOP_PRESETS])).toEqual([...CODING_LOOP_PRESETS]);
	});
});

describe("sanitizeLoopPresets — one bad row must not break the loop form", () => {
	it("drops entries that cannot render or cannot run", () => {
		const out = sanitizeLoopPresets([
			{ id: "ok", label: "Fine", objective: "Do the thing." },
			{ id: "nolabel", label: "   ", objective: "orphan" },
			{ id: "noobjective", label: "Button", objective: "" },
			"not an object",
			null,
		]);
		expect(out).toEqual([{ id: "ok", label: "Fine", objective: "Do the thing." }]);
	});

	it("derives an id from the label when one is missing, and never repeats one", () => {
		// Duplicate ids are React keys AND the handle an edit is matched on — a collision makes
		// editing one preset change another.
		const out = sanitizeLoopPresets([
			{ label: "Fix bugs", objective: "a" },
			{ label: "Fix bugs", objective: "b" },
			{ id: "Fix Bugs!", label: "Third", objective: "c" },
		]);
		expect(out.map((p) => p.id)).toEqual(["fix-bugs", "fix-bugs-2", "fix-bugs-2-2"]);
	});

	it("caps the count and the objective length", () => {
		const many = Array.from({ length: 40 }, (_, i) => ({ label: `p${i}`, objective: "x" }));
		expect(sanitizeLoopPresets(many)).toHaveLength(MAX_LOOP_PRESETS);
		// The loop route rejects an objective over 2000 chars — a preset that could build one would
		// be a button that always fails.
		const long = sanitizeLoopPresets([{ label: "Long", objective: "y".repeat(5000) }]);
		expect(long[0].objective).toHaveLength(MAX_PRESET_OBJECTIVE);
	});

	it("returns nothing for a non-array, including the object a hand-edited config might hold", () => {
		expect(sanitizeLoopPresets({ bugs: "Fix bugs" })).toEqual([]);
		expect(sanitizeLoopPresets(undefined)).toEqual([]);
	});
});

describe("resolveLoopPresets — creator default under subscriber override", () => {
	const template = [{ id: "ship", label: "Ship it", objective: "Ship the branch." }];
	const own = [{ id: "mine", label: "Mine", objective: "My objective." }];

	it("uses the built-in default when neither declares any", () => {
		const r = resolveLoopPresets({ driverId: "coding" });
		expect(r.source).toBe("default");
		expect(r.presets).toHaveLength(5);
	});

	it("prefers the creator's over the built-in", () => {
		const r = resolveLoopPresets({ agentConfig: { loopPresets: template }, driverId: "coding" });
		expect(r).toEqual({ presets: template, source: "agent" });
	});

	it("prefers the subscriber's over the creator's", () => {
		const r = resolveLoopPresets({
			agentConfig: { loopPresets: template },
			instanceConfig: { loopPresets: own },
			driverId: "coding",
		});
		expect(r).toEqual({ presets: own, source: "instance" });
	});

	it("REPLACES rather than merges, so a subscriber can drop one the template ships", () => {
		// Merging by id would make removal impossible: the template would silently restore the
		// preset on every read, and the setting would look like it never saved.
		const r = resolveLoopPresets({
			agentConfig: { loopPresets: [...template, { id: "mine", label: "Template mine", objective: "theirs" }] },
			instanceConfig: { loopPresets: own },
			driverId: "coding",
		});
		expect(r.presets).toEqual(own);
	});

	it("falls back rather than showing an empty form when the stored value is junk", () => {
		const r = resolveLoopPresets({ instanceConfig: { loopPresets: "corrupt" }, driverId: "coding" });
		expect(r.source).toBe("default");
		expect(r.presets).toHaveLength(5);
	});

	it("resolves independently per instance — editing one cannot affect another", () => {
		const a = resolveLoopPresets({ agentConfig: { loopPresets: template }, instanceConfig: { loopPresets: own }, driverId: "coding" });
		const b = resolveLoopPresets({ agentConfig: { loopPresets: template }, instanceConfig: {}, driverId: "coding" });
		expect(a.presets).toEqual(own);
		expect(b.presets).toEqual(template);
	});
});
