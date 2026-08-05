import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bandFor, isSet } from "./BehaviourTab";
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
