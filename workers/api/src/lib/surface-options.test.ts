import { describe, expect, it } from "vitest";
import { optionsFor, parseSurfaceOptions, parseSurfaceSpec, serializeSurfaceOptions, SURFACE_DEFAULTS } from "./surface-options.js";

describe("parseSurfaceSpec — defaults must be the safe ones", () => {
	it("fills defaults for an absent spec", () => {
		expect(parseSurfaceSpec(undefined)).toEqual({ repos: "many", drive: true, copilot: true });
	});

	it("only an EXPLICIT false opts out of driving", () => {
		// Silently dropping send_to_cli/read_terminal is the #119 failure: an orchestrator that
		// could no longer send tasks and then hallucinated success. Anything ambiguous keeps them.
		expect(parseSurfaceSpec({ drive: false }).drive).toBe(false);
		for (const v of ["no", 0, null, "false", undefined]) {
			expect(parseSurfaceSpec({ drive: v }).drive).toBe(true);
		}
	});

	it("defaults an unrecognised repos value rather than trusting it", () => {
		expect(parseSurfaceSpec({ repos: "lots" }).repos).toBe("many");
		expect(parseSurfaceSpec({ repos: "single" }).repos).toBe("single");
	});

	it("survives junk without throwing", () => {
		for (const junk of [null, 42, "coding", [], true]) {
			expect(parseSurfaceSpec(junk)).toEqual(SURFACE_DEFAULTS);
		}
	});
});

describe("parseSurfaceOptions", () => {
	it("normalizes a map of specs", () => {
		expect(parseSurfaceOptions({ coding: { repos: "single", drive: false } })).toEqual({
			coding: { repos: "single", drive: false, copilot: true },
		});
	});

	it("returns an empty map for a non-object, including an array", () => {
		// An array here is a sign someone tried the other wire format; treat it as absent
		// rather than half-reading it.
		for (const bad of [undefined, null, "coding", ["coding"], 7]) {
			expect(parseSurfaceOptions(bad)).toEqual({});
		}
	});

	it("ignores blank keys", () => {
		expect(parseSurfaceOptions({ "  ": { drive: false } })).toEqual({});
	});
});

describe("optionsFor — an option must never switch a surface ON", () => {
	it("returns null when the surface is not declared, even with options present", () => {
		// Otherwise a stray option would grant a cloud-only agent a coding surface.
		expect(optionsFor({ surfaces: [], surfaceOptions: { coding: { drive: false } } }, "coding")).toBeNull();
		expect(optionsFor({ surfaces: ["repo"] }, "coding")).toBeNull();
		expect(optionsFor(null, "coding")).toBeNull();
		expect(optionsFor(undefined, "coding")).toBeNull();
	});

	it("returns defaults for a declared surface with no options — the existing Coder's case", () => {
		expect(optionsFor({ surfaces: ["coding"] }, "coding")).toEqual({ repos: "many", drive: true, copilot: true });
	});

	it("returns the declared options when both are present", () => {
		const caps = { surfaces: ["coding"], surfaceOptions: { coding: { repos: "single", drive: false } } };
		expect(optionsFor(caps, "coding")).toEqual({ repos: "single", drive: false, copilot: true });
	});

	it("does not leak one surface's options onto another", () => {
		const caps = { surfaces: ["coding", "repo"], surfaceOptions: { coding: { drive: false } } };
		expect(optionsFor(caps, "repo")?.drive).toBe(true);
	});
});

describe("serializeSurfaceOptions — do not noisify stored configs", () => {
	it("omits a surface whose options are all defaults", () => {
		expect(serializeSurfaceOptions({ coding: { repos: "many", drive: true, copilot: true } })).toEqual({});
	});

	it("writes only the fields that differ", () => {
		expect(serializeSurfaceOptions({ coding: { repos: "single", drive: true, copilot: true } })).toEqual({ coding: { repos: "single" } });
		expect(serializeSurfaceOptions({ coding: { repos: "many", drive: false, copilot: true } })).toEqual({ coding: { drive: false } });
	});

	it("round-trips a non-default spec", () => {
		const spec = { repos: "single", drive: false, copilot: false } as const;
		const wire = serializeSurfaceOptions({ coding: { ...spec } });
		expect(parseSurfaceOptions(wire).coding).toEqual(spec);
	});
});

describe("copilot — one chat per agent (#209)", () => {
	it("defaults TRUE, so the legacy hardcoded Coder is untouched by this existing", () => {
		// The whole safety property of this change: `coder` declares no surfaceOptions, so it must
		// come back with its Co-pilot intact. A default of false would silently delete a surface
		// from a shipped agent nobody asked to change.
		expect(parseSurfaceSpec({}).copilot).toBe(true);
		expect(parseSurfaceSpec(undefined).copilot).toBe(true);
		expect(optionsFor({ surfaces: ["coding"] }, "coding")?.copilot).toBe(true);
	});

	it("only an EXPLICIT false opts out", () => {
		// Same rule as `drive`. A malformed config must never remove a view the user is looking at.
		expect(parseSurfaceSpec({ copilot: false }).copilot).toBe(false);
		for (const v of [undefined, null, 0, "", "false", "no", {}]) {
			expect(parseSurfaceSpec({ copilot: v }).copilot, String(v)).toBe(true);
		}
	});

	it("a Repo Coder's declared shape resolves to a single chat", () => {
		const caps = { surfaces: ["coding"], surfaceOptions: { coding: { repos: "single", drive: false, copilot: false } } };
		expect(optionsFor(caps, "coding")).toEqual({ repos: "single", drive: false, copilot: false });
	});

	it("cannot switch a Co-pilot ON for an agent with no coding surface", () => {
		expect(optionsFor({ surfaces: ["repo"], surfaceOptions: { coding: { copilot: true } } }, "coding")).toBeNull();
	});

	it("round-trips through serialize, and stays out of a default config", () => {
		expect(serializeSurfaceOptions({ coding: { repos: "many", drive: true, copilot: false } })).toEqual({ coding: { copilot: false } });
		expect(parseSurfaceSpec(serializeSurfaceOptions({ coding: { repos: "single", drive: false, copilot: false } }).coding))
			.toEqual({ repos: "single", drive: false, copilot: false });
	});
});
