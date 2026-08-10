import { describe, expect, it } from "vitest";
import {
	boundTargetRefusal,
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

	/**
	 * #441: a two-of-three ceiling refused a target it explicitly permits.
	 *
	 * The four cases are the ones measured on the issue, kept together because only ONE of them
	 * changed: the bug was invisible against a single-value ceiling (narrowing to `allowed[0]` is
	 * the same answer as narrowing to the prefix), so the fix is only meaningful next to the three
	 * neighbours it must not disturb.
	 */
	describe("a prefixed target NAMES its backend, whatever the ceiling's size", () => {
		const BOTH = { backends: ["tmux", "kitty"] };

		it("single-value ceiling: `tmux:main` passes and pins `backend` — unchanged", () => {
			expect(enforceConstraints(CAPTURE, TMUX_ONLY, { target: "tmux:main" })).toEqual({ ok: true, input: { target: "tmux:main", backend: "tmux" } });
		});

		it("multi-value ceiling: `tmux:main` passes, narrowed to the backend the target named", () => {
			// Was refused with "`all` is not available to this agent — pass `backend` explicitly",
			// which is wrong twice: the caller never used the wildcard, and the value it asks for is
			// the one already sitting in `target`.
			expect(enforceConstraints(CAPTURE, BOTH, { target: "tmux:main" })).toEqual({ ok: true, input: { target: "tmux:main", backend: "tmux" } });
		});

		it("multi-value ceiling: a prefix OUTSIDE it is still refused as a backend violation", () => {
			const r = enforceConstraints(CAPTURE, BOTH, { target: "iterm2:1:1:1" });
			expect(r.ok).toBe(false);
			expect(!r.ok && r.refusal).toContain("`terminal.backends` (tmux, kitty)");
			expect(!r.ok && r.refusal).toContain("iterm2:1:1:1");
		});

		it("multi-value ceiling: an explicit `backend` with an unprefixed target still passes", () => {
			expect(enforceConstraints(CAPTURE, BOTH, { backend: "tmux", target: "main" })).toEqual({ ok: true, input: { backend: "tmux", target: "main" } });
		});

		it("still ASKS when the target names no backend and the ceiling holds more than one", () => {
			// The narrowing is only ever "the caller already said so", never a guess: an unprefixed
			// target carries no backend, so the ambiguity the refusal exists for is still there.
			const r = enforceConstraints(CAPTURE, BOTH, { target: "main" });
			expect(r.ok).toBe(false);
			expect(!r.ok && r.refusal).toMatch(/pass `backend` explicitly/);
		});
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
	it("declares terminal.backends and terminal.targets and nothing else — an extension point is reviewed, not inferred", () => {
		// `tmux` is the second connector (#447), and this list stays PINNED rather than open: the
		// gate skips its lookup entirely for a connector absent from this table, so adding a key
		// switches on a fail-closed enforcement path for every tool that connector owns. That is a
		// reviewed decision, not an inference.
		expect(Object.keys(CONNECTOR_CONSTRAINTS)).toEqual(["terminal", "tmux"]);
		// Order is asserted because enforcement walks the table in it: a target naming a backend
		// outside the ceiling must be refused as a BACKEND violation, which is the constraint that
		// actually applies, not as "not the bound target".
		expect(Object.keys(CONNECTOR_CONSTRAINTS.terminal)).toEqual(["backends", "targets"]);
		const backends = CONNECTOR_CONSTRAINTS.terminal.backends;
		expect(backends.kind === "values" && backends.values).toEqual(["tmux", "kitty", "iterm2"]);
		const targets = CONNECTOR_CONSTRAINTS.terminal.targets;
		expect(targets.kind).toBe("binding");
		// The binding governs `target` and sits inside `backends` — the two facts the enforcement
		// and the write path both read, and a rename of either silently disconnects them.
		expect(targets.kind === "binding" && targets.arg).toBe("target");
		expect(targets.kind === "binding" && targets.withinField).toBe("backends");
	});
});

/**
 * `targets: "single"` + the subscriber's bound identity (#402) — the second half of the ceiling.
 *
 * A backend ceiling answers "which backends"; it cannot answer "which ONE of them", and for a
 * named operator that is the question that matters, because a mis-addressed target is a shell
 * command on somebody's machine.
 */
describe("parseConstraintSpec — the binding field", () => {
	it("keeps `single`, and DROPS `many` because many is the platform default", () => {
		expect(parseConstraintSpec("terminal", { targets: "single" })).toEqual({ targets: "single" });
		// A stored ceiling always means "narrower than the platform" — the same rule that drops a
		// whole-vocabulary `backends` list. Storing `many` would store today's behaviour as a claim.
		expect(parseConstraintSpec("terminal", { targets: "many" })).toBeUndefined();
	});

	it("reads junk as ABSENT rather than as a ban, exactly like a value list", () => {
		for (const junk of [["single"], "", "SINGLE ", 1, null, {}]) {
			const parsed = parseConstraintSpec("terminal", { targets: junk });
			// " SINGLE " normalises; everything else is absent.
			expect(parsed, JSON.stringify(junk)).toEqual(junk === "SINGLE " ? { targets: "single" } : undefined);
		}
	});

	it("keeps a bound identity as free text — a tmux session is named by whoever made it", () => {
		expect(parseConstraintSpec("terminal", { boundTarget: "  tmux:main  " })).toEqual({ boundTarget: "tmux:main" });
		expect(parseConstraintSpec("terminal", { boundTarget: "" })).toBeUndefined();
		expect(parseConstraintSpec("terminal", { boundTarget: 7 })).toBeUndefined();
	});

	it("caps the bound identity's length — a target is a name or a coordinate, never prose", () => {
		const parsed = parseConstraintSpec("terminal", { boundTarget: "tmux:".concat("x".repeat(500)) });
		expect((parsed?.boundTarget as string).length).toBe(200);
	});

	it("round-trips both halves through parse → serialize in the flat declared shape", () => {
		const wire = serializeSurfaceOptions(parseSurfaceOptions({ terminal: { backends: ["tmux"], targets: "single", boundTarget: "tmux:main" } }));
		expect(wire).toEqual({ terminal: { backends: ["tmux"], targets: "single", boundTarget: "tmux:main" } });
	});
});

describe("narrowConstraintSpec — the binding narrows in both currencies", () => {
	it("lets a subscriber TIGHTEN a `many` agent to single", () => {
		expect(narrowConstraintSpec("terminal", undefined, { targets: "single" })).toEqual({ targets: "single" });
	});

	it("REFUSES to loosen: a subscriber cannot turn a single-target agent into a many-target one", () => {
		// `many` never survives the parser, so this is what the attempt actually looks like on the
		// wire — and the creator's `single` has to outlive it.
		expect(narrowConstraintSpec("terminal", { targets: "single" }, {})).toEqual({ targets: "single" });
		expect(narrowConstraintSpec("terminal", { targets: "single" }, { targets: "many" } as never)).toEqual({ targets: "single" });
	});

	it("takes the bound identity from the instance, which is whose choice it is", () => {
		expect(narrowConstraintSpec("terminal", { targets: "single", backends: ["tmux"] }, { boundTarget: "tmux:main" })).toEqual({
			backends: ["tmux"],
			targets: "single",
			boundTarget: "tmux:main",
		});
	});

	it("DROPS a binding that names a backend outside the ceiling — the widen attempt in its other form", () => {
		// The two halves are declared in different configs (ceiling on the agent, binding on the
		// instance), so neither parse could see both. Dropped rather than honoured: a `single`
		// agent with nothing bound refuses, and refusing is the safe direction.
		expect(narrowConstraintSpec("terminal", { targets: "single", backends: ["tmux"] }, { boundTarget: "iterm2:1:1:1" })).toEqual({
			backends: ["tmux"],
			targets: "single",
		});
	});

	it("keeps an UNPREFIXED binding, which names no backend to be outside the ceiling", () => {
		expect(narrowConstraintSpec("terminal", { backends: ["tmux"] }, { boundTarget: "main" })?.boundTarget).toBe("main");
	});

	it("lets the creator fix the binding too, and the subscriber cannot then replace it", () => {
		expect(narrowConstraintSpec("terminal", { boundTarget: "tmux:ops" }, { boundTarget: "tmux:mine" })?.boundTarget).toBe("tmux:ops");
	});
});

describe("enforceConstraints — the single-target binding", () => {
	const BOUND = { targets: "single", boundTarget: "tmux:main" };

	it("passes a call that names the bound target", () => {
		expect(enforceConstraints(CAPTURE, BOUND, { target: "tmux:main" })).toEqual({ ok: true, input: { target: "tmux:main" } });
	});

	it("accepts the same pane written the other way, and canonicalises it", () => {
		// The tools take `tmux:main` and a bare `main` + `backend` as the same pane, so refusing
		// one of them would refuse a legal call — and letting both reach the runner would address
		// one pane two ways.
		expect(enforceConstraints(CAPTURE, BOUND, { target: "main" })).toEqual({ ok: true, input: { target: "tmux:main" } });
	});

	it("REFUSES a call naming any other target, saying which constraint applied and what is bound", () => {
		const r = enforceConstraints(CAPTURE, BOUND, { target: "tmux:other" });
		expect(r.ok).toBe(false);
		expect(!r.ok && r.refusal).toContain("`terminal.targets` (single)");
		expect(!r.ok && r.refusal).toContain("tmux:main");
		expect(!r.ok && r.refusal).toContain("tmux:other");
	});

	it("refuses a different backend's pane even when the suffix matches", () => {
		// `kitty:main` and `tmux:main` are different machines' worth of different. Matching on the
		// suffix alone would silently REDIRECT the command onto the bound pane instead of refusing.
		expect(enforceConstraints(CAPTURE, BOUND, { target: "kitty:main" }).ok).toBe(false);
	});

	it("fills an OMITTED target with the bound one, so the model never has to know it", () => {
		expect(enforceConstraints(CAPTURE, BOUND, {})).toEqual({ ok: true, input: { target: "tmux:main" } });
	});

	it("REFUSES a target-taking call when `single` is declared and nothing is bound", () => {
		// The agent has no way to choose, and guessing costs a shell command on a real machine —
		// the same call the backend ceiling already makes when several are permitted and none named.
		const r = enforceConstraints(CAPTURE, { targets: "single" }, { target: "tmux:whatever" });
		expect(r.ok).toBe(false);
		expect(!r.ok && r.refusal).toContain("`terminal.targets` (single)");
		expect(!r.ok && r.refusal).toMatch(/terminal-target/);
	});

	it("still lets an unbound single-target agent LIST — that is how you discover what to bind", () => {
		expect(enforceConstraints(LIST, { targets: "single" }, {})).toEqual({ ok: true, input: {} });
		// And creating a target is not the binding's business either: "may not create a second
		// terminal" is expressible by not declaring the tool, which is what the allowlist is for.
		expect(enforceConstraints(NEW_TARGET, { targets: "single" }, { backend: "tmux" })).toEqual({ ok: true, input: { backend: "tmux" } });
	});

	it("honours a bound target under the DEFAULT cardinality — a subscriber's pin only narrows", () => {
		expect(enforceConstraints(CAPTURE, { boundTarget: "tmux:main" }, { target: "kitty:3" }).ok).toBe(false);
	});

	it("changes nothing at all when neither half is declared", () => {
		const input = { target: "iterm2:1:1:1" };
		expect(enforceConstraints(CAPTURE, { backends: undefined } as never, input)).toEqual({ ok: true, input });
	});

	it("composes with the backend ceiling, and the BACKEND is the constraint reported", () => {
		const r = enforceConstraints(CAPTURE, { backends: ["tmux"], ...BOUND }, { target: "iterm2:1:1:1" });
		expect(r.ok).toBe(false);
		expect(!r.ok && r.refusal).toContain("`terminal.backends` (tmux)");
	});
});

describe("boundTargetRefusal — what a WRITE path owes the person typing", () => {
	it("refuses a target outside the declared ceiling, naming it", () => {
		const why = boundTargetRefusal("terminal", "targets", "iterm2:1:1:1", { backends: ["tmux"] });
		expect(why).toContain("`terminal.backends` (tmux)");
		expect(why).toContain("iterm2:1:1:1");
	});

	it("accepts anything the ceiling permits, and anything at all when there is no ceiling", () => {
		expect(boundTargetRefusal("terminal", "targets", "tmux:main", { backends: ["tmux"] })).toBeNull();
		expect(boundTargetRefusal("terminal", "targets", "main", { backends: ["tmux"] })).toBeNull();
		expect(boundTargetRefusal("terminal", "targets", "iterm2:1:1:1", undefined)).toBeNull();
	});
});

/**
 * `tmux` — the second connector, and the shape a VALUE ceiling cannot express (#447).
 *
 * `parseConstraintSpec` returns `undefined` for a connector it has no vocabulary for, which is why
 * a `tmux` declaration was UNWRITABLE rather than merely unwritten: #403 moved the one published
 * Operator onto `tmux_*` tools, and this table is keyed by connector.
 */
describe("the tmux binding vocabulary (#447)", () => {
	it("parses BOTH fields — the acceptance criterion, and `undefined` before the entry existed", () => {
		expect(parseConstraintSpec("tmux", { sessions: "single", boundSession: "main" })).toEqual({
			sessions: "single",
			boundSession: "main",
		});
	});

	it("carries a binding and nothing else — no value ceiling, because the backend is tmux by construction", () => {
		expect(Object.keys(CONNECTOR_CONSTRAINTS.tmux)).toEqual(["sessions"]);
		const sessions = CONNECTOR_CONSTRAINTS.tmux.sessions;
		expect(sessions.kind).toBe("binding");
		expect(sessions.kind === "binding" && sessions.arg).toBe("session");
		expect(sessions.kind === "binding" && sessions.bindField).toBe("boundSession");
		// No `withinField`: there is no value ceiling for the binding to sit inside, so the
		// within-check and the prefix walk in `narrowConstraintSpec` correctly do nothing here.
		expect(sessions.kind === "binding" && sessions.withinField).toBeUndefined();
	});

	it("keeps `many` unstored, so a stored ceiling always means NARROWER than the platform", () => {
		expect(parseConstraintSpec("tmux", { sessions: "many" })).toBeUndefined();
		expect(parseConstraintSpec("tmux", { sessions: "single" })).toEqual({ sessions: "single" });
	});

	it("names the route a subscriber binds through, so the refusal cannot point at another resource", () => {
		// In the TABLE, not in the route module: `enforceBinding`'s "bind one first" message is
		// per-connector now, and naming `/terminal-target` to a tmux agent is worse than naming none.
		const terminal = CONNECTOR_CONSTRAINTS.terminal.targets;
		const tmux = CONNECTOR_CONSTRAINTS.tmux.sessions;
		expect(terminal.kind === "binding" && terminal.bindRoute).toBe("terminal-target");
		expect(tmux.kind === "binding" && tmux.bindRoute).toBe("tmux-session");
	});
});
