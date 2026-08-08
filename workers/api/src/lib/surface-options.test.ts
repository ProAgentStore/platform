import { describe, expect, it } from "vitest";
import {
	CONNECTOR_CONSTRAINTS,
	constraintsFor,
	enforceConstraints,
	narrowConstraintSpec,
	optionsFor,
	parseConstraintSpec,
	parseSurfaceOptions,
	parseSurfaceSpec,
	serializeSurfaceOptions,
	SURFACE_DEFAULTS,
} from "./surface-options.js";

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

// ── Capability constraints (#404) ────────────────────────────────────────────────────────────────

/** The terminal tools the gate actually sees, reduced to the two fields it reads. */
const LIST = { name: "terminal_list_targets", connector: "terminal", jsonSchema: { properties: { backend: {} } } };
const CAPTURE = { name: "terminal_capture", connector: "terminal", jsonSchema: { properties: { target: {}, backend: {}, lines: {} } } };
const NEW_TARGET = { name: "terminal_new_target", connector: "terminal", jsonSchema: { properties: { backend: {}, name: {} } } };
const UNCONSTRAINED = { name: "tmux_list_sessions", connector: "tmux", jsonSchema: { properties: { backend: {} } } };

describe("parseConstraintSpec — a CLOSED vocabulary per connector", () => {
	it("keeps a declared subset, in vocabulary order", () => {
		expect(parseConstraintSpec("terminal", { backends: ["iterm2", "tmux"] })).toEqual({ backends: ["tmux", "iterm2"] });
	});

	it("drops values that are not in the vocabulary — a creator narrows, never invents", () => {
		expect(parseConstraintSpec("terminal", { backends: ["tmux", "screen", "ssh"] })).toEqual({ backends: ["tmux"] });
		expect(parseConstraintSpec("terminal", { backends: ["screen"] })).toBeUndefined();
	});

	it("ignores a field the vocabulary does not define, and a connector with no vocabulary at all", () => {
		expect(parseConstraintSpec("terminal", { domains: ["example.com"] })).toBeUndefined();
		expect(parseConstraintSpec("github", { backends: ["tmux"] })).toBeUndefined();
		expect(parseConstraintSpec("coding", { backends: ["tmux"] })).toBeUndefined();
	});

	it("treats the WHOLE vocabulary as no constraint — 'a ceiling exists' must mean 'narrower than the platform'", () => {
		expect(parseConstraintSpec("terminal", { backends: ["tmux", "kitty", "iterm2"] })).toBeUndefined();
	});

	it("treats an empty or all-junk list as ABSENT, never as 'allow nothing'", () => {
		// Reading a typo as a total ban would brick an agent on a config nobody can see is wrong.
		for (const junk of [[], [""], [null, 7], "tmux", { tmux: true }, null]) {
			expect(parseConstraintSpec("terminal", { backends: junk }), JSON.stringify(junk)).toBeUndefined();
		}
	});

	it("normalizes case and whitespace, and collapses duplicates", () => {
		expect(parseConstraintSpec("terminal", { backends: [" TMUX ", "tmux", "Tmux"] })).toEqual({ backends: ["tmux"] });
	});
});

describe("constraints ride in surfaceOptions — one map, one validator", () => {
	it("round-trips through parse → serialize in the declared FLAT shape", () => {
		const wire = serializeSurfaceOptions(parseSurfaceOptions({ terminal: { backends: ["tmux"] } }));
		expect(wire).toEqual({ terminal: { backends: ["tmux"] } });
		expect(parseSurfaceOptions(wire).terminal?.constraints).toEqual({ backends: ["tmux"] });
	});

	it("coexists with surface options on one key without either eating the other", () => {
		const wire = serializeSurfaceOptions(parseSurfaceOptions({ coding: { drive: false }, terminal: { backends: ["kitty"] } }));
		expect(wire).toEqual({ coding: { drive: false }, terminal: { backends: ["kitty"] } });
	});

	it("writes nothing for an entry that declares nothing — the stored config is unchanged", () => {
		expect(serializeSurfaceOptions(parseSurfaceOptions({ terminal: {} }))).toEqual({});
	});
});

describe("constraintsFor — the ceiling, NOT gated on surfaces", () => {
	it("resolves a declared ceiling", () => {
		expect(constraintsFor({ surfaceOptions: { terminal: { backends: ["tmux"] } } }, "terminal")).toEqual({ backends: ["tmux"] });
	});

	it("applies even though `terminal` is a connector and not one of the agent's surfaces", () => {
		// The inertness rule INVERTS here versus `optionsFor`: an option must never switch a
		// surface on, but a constraint only ever narrows, so honouring it is the safe direction.
		const caps = { surfaces: [], surfaceOptions: { terminal: { backends: ["tmux"] } } };
		expect(optionsFor(caps, "terminal")).toBeNull();
		expect(constraintsFor(caps, "terminal")).toEqual({ backends: ["tmux"] });
	});

	it("returns undefined for a connector with no vocabulary, and for capabilities that declare nothing", () => {
		expect(constraintsFor({ surfaceOptions: { github: { backends: ["tmux"] } } }, "github")).toBeUndefined();
		expect(constraintsFor({ surfaces: ["coding"] }, "terminal")).toBeUndefined();
		expect(constraintsFor(null, "terminal")).toBeUndefined();
	});
});

describe("narrowConstraintSpec — a subscriber may narrow, and may NEVER widen", () => {
	const CEILING = { backends: ["tmux", "kitty"] };

	it("honours a narrowing within the ceiling", () => {
		expect(narrowConstraintSpec("terminal", CEILING, { backends: ["tmux"] })).toEqual({ backends: ["tmux"] });
	});

	it("REFUSES to widen: a value outside the ceiling is dropped", () => {
		// The acceptance test. The ceiling is a catalog claim (`lintAgentClaims`, #362) — if a
		// subscriber could widen it, the agent's own description would become false by config.
		expect(narrowConstraintSpec("terminal", CEILING, { backends: ["tmux", "iterm2"] })).toEqual({ backends: ["tmux"] });
	});

	it("an ENTIRELY out-of-scope request leaves the ceiling standing, not empty and not open", () => {
		expect(narrowConstraintSpec("terminal", CEILING, { backends: ["iterm2"] })).toEqual(CEILING);
		expect(narrowConstraintSpec("terminal", { backends: ["tmux"] }, { backends: ["iterm2", "kitty"] })).toEqual({ backends: ["tmux"] });
	});

	it("lets a subscriber narrow an agent that declared no ceiling of its own", () => {
		expect(narrowConstraintSpec("terminal", undefined, { backends: ["tmux"] })).toEqual({ backends: ["tmux"] });
	});

	it("passes the ceiling through untouched when the subscriber asked for nothing", () => {
		expect(narrowConstraintSpec("terminal", CEILING, undefined)).toEqual(CEILING);
		expect(narrowConstraintSpec("terminal", undefined, undefined)).toBeUndefined();
	});
});

describe("enforceConstraints — absent constraints change NOTHING", () => {
	it("returns the very same input object when no ceiling is declared", () => {
		// The invisible regression: every existing agent declares no constraints, so this path is
		// the one that must stay byte-identical. Identity, not merely deep equality.
		const input = { backend: "all", target: "iterm2:1:1:1" };
		const r = enforceConstraints(CAPTURE, undefined, input);
		expect(r.ok && r.input).toBe(input);
	});

	it("leaves a connector with no constraint vocabulary alone even if a spec is somehow passed", () => {
		const input = { backend: "iterm2" };
		const r = enforceConstraints(UNCONSTRAINED, { backends: ["tmux"] }, input);
		expect(r.ok && r.input).toBe(input);
	});

	it("leaves an empty ceiling alone", () => {
		const input = { backend: "iterm2" };
		const r = enforceConstraints(CAPTURE, { backends: [] }, input);
		expect(r.ok && r.input).toBe(input);
	});
});

describe("enforceConstraints — an out-of-scope argument is refused, naming the constraint", () => {
	const TMUX_ONLY = { backends: ["tmux"] };

	it("refuses an explicitly named backend outside the ceiling", () => {
		const r = enforceConstraints(CAPTURE, TMUX_ONLY, { target: "main", backend: "iterm2" });
		expect(r.ok).toBe(false);
		expect(!r.ok && r.refusal).toContain("`terminal.backends` (tmux)");
		expect(!r.ok && r.refusal).toMatch(/iterm2/);
	});

	it("refuses a TARGET that carries an out-of-scope backend prefix", () => {
		// Without this the ceiling is decorative: the tool is normally driven by a prefixed target
		// with no `backend` at all.
		const r = enforceConstraints(CAPTURE, TMUX_ONLY, { target: "iterm2:1:1:1" });
		expect(r.ok).toBe(false);
		expect(!r.ok && r.refusal).toContain("iterm2:1:1:1");
		expect(!r.ok && r.refusal).toContain("`terminal.backends` (tmux)");
	});

	it("allows a target prefixed with a backend that IS in the ceiling", () => {
		const r = enforceConstraints(CAPTURE, TMUX_ONLY, { target: "tmux:main" });
		expect(r.ok && r.input).toEqual({ target: "tmux:main", backend: "tmux" });
	});

	it("narrows an omitted or wildcard backend to the single permitted one", () => {
		// Refusing a DEFAULTED argument would leave a tmux-only agent unable to list its own
		// sessions without guessing; the default is `all`, which is the value being replaced.
		expect(enforceConstraints(LIST, TMUX_ONLY, {})).toEqual({ ok: true, input: { backend: "tmux" } });
		expect(enforceConstraints(LIST, TMUX_ONLY, { backend: "all" })).toEqual({ ok: true, input: { backend: "tmux" } });
		expect(enforceConstraints(LIST, TMUX_ONLY, { backend: "nonsense" })).toEqual({ ok: true, input: { backend: "tmux" } });
	});

	it("pins an UNPREFIXED target's backend, so the runner cannot resolve it against another one", () => {
		expect(enforceConstraints(CAPTURE, TMUX_ONLY, { target: "1" })).toEqual({ ok: true, input: { target: "1", backend: "tmux" } });
	});

	it("asks for an explicit value when the ceiling permits more than one, rather than guessing", () => {
		const r = enforceConstraints(LIST, { backends: ["tmux", "kitty"] }, {});
		expect(r.ok).toBe(false);
		expect(!r.ok && r.refusal).toMatch(/pass `backend` explicitly/);
		expect(!r.ok && r.refusal).toMatch(/tmux, kitty/);
		// Naming the wildcard matters: told only "pass it explicitly", a model retries the default
		// it just used, because nothing said the default was the problem.
		expect(!r.ok && r.refusal).toContain("`all` is not available");
	});

	it("lets an in-scope value through with a multi-value ceiling", () => {
		expect(enforceConstraints(LIST, { backends: ["tmux", "kitty"] }, { backend: "kitty" })).toEqual({ ok: true, input: { backend: "kitty" } });
	});

	it("does not touch a tool whose schema has no such argument", () => {
		const noArgs = { name: "x", connector: "terminal", jsonSchema: { properties: {} } };
		const input = { anything: 1 };
		expect(enforceConstraints(noArgs, TMUX_ONLY, input)).toEqual({ ok: true, input });
	});

	it("constrains create-a-target too, so a ceiling cannot be escaped by making a new window", () => {
		const r = enforceConstraints(NEW_TARGET, TMUX_ONLY, { backend: "kitty", name: "x" });
		expect(r.ok).toBe(false);
		expect(!r.ok && r.refusal).toContain("`terminal.backends` (tmux)");
	});

	it("never mutates the caller's input object", () => {
		const input = { backend: "all" };
		enforceConstraints(LIST, TMUX_ONLY, input);
		expect(input).toEqual({ backend: "all" });
	});
});

describe("the vocabulary table itself", () => {
	it("declares terminal.backends and nothing else — an extension point is reviewed, not inferred", () => {
		expect(Object.keys(CONNECTOR_CONSTRAINTS)).toEqual(["terminal"]);
		expect(Object.keys(CONNECTOR_CONSTRAINTS.terminal)).toEqual(["backends"]);
		expect(CONNECTOR_CONSTRAINTS.terminal.backends.values).toEqual(["tmux", "kitty", "iterm2"]);
	});
});
