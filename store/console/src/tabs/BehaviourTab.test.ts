import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bandFor, fieldState, isSet, sameValue } from "./BehaviourTab";
import { SURFACES, visibleSurfaces } from "../lib/surfaces";

const FIELD = {
	id: "technicality",
	group: "style",
	label: "Technicality",
	type: "scale" as const,
	default: 50,
	selfWritable: true,
	bands: [
		{ max: 24, label: "Plain language", prompt: "plain" },
		{ max: 74, label: "Domain", prompt: "domain" },
		{ max: 100, label: "Senior engineer", prompt: "senior" },
	],
};

describe("bandFor — the slider selects an instruction, not a number", () => {
	it("picks by inclusive upper bound", () => {
		expect(bandFor(FIELD, 0)?.label).toBe("Plain language");
		expect(bandFor(FIELD, 24)?.label).toBe("Plain language");
		expect(bandFor(FIELD, 25)?.label).toBe("Domain");
		expect(bandFor(FIELD, 100)?.label).toBe("Senior engineer");
	});

	it("falls back to the top band rather than rendering nothing", () => {
		// A value above every bound (a stale stored value, a schema edit) must still describe
		// itself. An undefined band would render an empty explanation under a live slider.
		expect(bandFor(FIELD, 500)?.label).toBe("Senior engineer");
	});

	it("returns undefined only when the field genuinely has no bands", () => {
		expect(bandFor({ ...FIELD, bands: undefined }, 50)).toBeUndefined();
	});
});

describe("isSet — configured vs sitting at the default", () => {
	it("distinguishes an explicit falsy value from an absent one", () => {
		// The bug this guards: `behaviour[id] ?? default` reads `emoji: false` as unset, so the UI
		// shows "default" for a choice the user deliberately made and hides the reset control.
		expect(isSet({ emoji: false }, "emoji")).toBe(true);
		expect(isSet({ technicality: 0 }, "technicality")).toBe(true);
		expect(isSet({}, "emoji")).toBe(false);
	});
});

describe("fieldState — whose value is this? (#232)", () => {
	// GET returns the RESOLVED behaviour, so "present" says nothing about who set it. Reading
	// presence as "the subscriber configured it" put a reset link on every creator default:
	// clicking it cleared an override that was never there and the row came back unchanged.
	const template = { technicality: 80, forbidden: ["emoji", "slang"] };

	it("calls a field nobody set a platform default", () => {
		expect(fieldState({}, template, "warmth")).toBe("default");
		expect(fieldState({ technicality: 80 }, template, "warmth")).toBe("default");
	});

	it("calls a resolved value that equals the creator's an agent default — no reset offered", () => {
		expect(fieldState({ technicality: 80 }, template, "technicality")).toBe("template");
		expect(fieldState({ forbidden: ["emoji", "slang"] }, template, "forbidden")).toBe("template");
	});

	it("calls a differing value an override — reset clears back to the agent default", () => {
		expect(fieldState({ technicality: 10 }, template, "technicality")).toBe("override");
		expect(fieldState({ forbidden: ["emoji"] }, template, "forbidden")).toBe("override");
		// Nothing from the creator at all: any set value is the subscriber's.
		expect(fieldState({ emoji: false }, {}, "emoji")).toBe("override");
	});

	it("treats an explicit falsy override as set, like isSet does", () => {
		expect(fieldState({ emoji: false }, { emoji: true }, "emoji")).toBe("override");
		expect(fieldState({ emoji: false }, { emoji: false }, "emoji")).toBe("template");
		expect(fieldState({ technicality: 0 }, {}, "technicality")).toBe("override");
	});

	it("compares list values by contents, not identity", () => {
		expect(sameValue(["a", "b"], ["a", "b"])).toBe(true);
		expect(sameValue(["a", "b"], ["b", "a"])).toBe(false);
		expect(sameValue(["a"], "a")).toBe(false);
		expect(sameValue(undefined, undefined)).toBe(true);
	});
});

describe("the Behaviour surface", () => {
	it("is available to every agent, not gated to a slug or a surface", () => {
		// Character is universal. Gating it would recreate the class of bug where an agent shows
		// the wrong tabs because nobody asked what it declared.
		for (const caps of [
			{ surfaces: [] },
			{ surfaces: ["coding"] },
			{ surfaces: ["repo"] },
			{ surfaces: ["apply"], tools: ["submit_job_application"] },
		]) {
			expect(visibleSurfaces(caps).map((s) => s.id), JSON.stringify(caps)).toContain("behaviour");
		}
	});

	it("does not claim the page header", () => {
		expect(SURFACES.find((s) => s.id === "behaviour")?.ownsHeader).toBeFalsy();
	});
});

describe("the field table is not restated in the console", () => {
	it("holds no band prose of its own — it renders what the server sent", () => {
		// The whole point of serving the schema. If copy is duplicated here it will drift from the
		// prompt, and the UI will describe a setting that does something else.
		const src = readFileSync(join(__dirname, "BehaviourTab.tsx"), "utf8")
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/^\s*\/\/.*$/gm, "");
		for (const phrase of ["senior-engineer", "Avoid jargon", "no slang", "Lead with the answer"]) {
			expect(src, phrase).not.toContain(phrase);
		}
	});
});

describe("saving is one request, not one per field", () => {
	const SRC = readFileSync(join(__dirname, "BehaviourTab.tsx"), "utf8");
	const CODE = SRC.replace(/\{?\/\*[\s\S]*?\*\/\}?/g, "").replace(/^\s*\/\/.*$/gm, "");

	it("sends a whole patch, because the server read-modify-writes one config blob", () => {
		// "Reset group" looped `save(f.id, null)` over five fields. Each PUT reads the same
		// pre-patch config and the last write wins, so it cleared exactly one field at random.
		expect(CODE).toContain("JSON.stringify({ behaviour: patch })");
		expect(CODE).not.toMatch(/save\(\s*f\.id\s*,/);
		expect(CODE).not.toMatch(/behaviour:\s*\{\s*\[id\]:\s*value\s*\}/);
	});

	it("resets a group in a single call", () => {
		expect(CODE).toContain("Object.fromEntries(overrides.map((f) => [f.id, null]))");
	});

	it("tracks several in-flight ids rather than one", () => {
		expect(CODE).toContain("saving.includes(f.id)");
	});
});

describe("controls reflect a save that has landed", () => {
	const SRC = readFileSync(join(__dirname, "BehaviourTab.tsx"), "utf8");
	const CODE = SRC.replace(/\{?\/\*[\s\S]*?\*\/\}?/g, "").replace(/^\s*\/\/.*$/gm, "");

	it("remounts the uncontrolled inputs when the saved value changes", () => {
		// defaultValue means React never updates them from props: after "reset" the box still
		// showed the old text, so the reset looked broken. Three inputs use defaultValue.
		expect((CODE.match(/key=\{inputKey\}/g) || []).length).toBe(3);
		expect((CODE.match(/defaultValue=/g) || []).length).toBe(3);
	});

	it("commits a slider drag released outside the control", () => {
		// onMouseUp only fires on the element. Release the mouse off it and the shown value was
		// never saved AND `dragging` stayed set, pinning the slider to a phantom value.
		expect(CODE).toContain("onBlur={commit}");
		expect(CODE).toContain("onPointerUp={commit}");
	});
});
