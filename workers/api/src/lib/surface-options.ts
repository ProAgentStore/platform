// Options for a surface — the shape a bare surface id cannot express.
//
// `capabilities.surfaces: ["coding"]` is an on/off flag that mounts one monolithic component and
// grants one fixed tool set. That was fine when "coding agent" meant exactly one thing — the
// Coder, which owns many repos and drives them all. Coder 2 split that into a Lead plus one Repo
// Coder per repo, and the flag stopped fitting:
//
//   • a Repo Coder owns ONE repo, yet renders add-repo and a repo list it can never use
//   • a Repo Coder is DRIVEN BY its Lead, yet carries send_to_cli/read_terminal, making its chat
//     a third way to drive an engine alongside the Co-pilot and the Overseer — the overlapping
//     drive-paths #154 exists to remove
//
// Carried in a SIBLING map rather than by making `surfaces` an array of objects:
//
//   surfaces:       ["coding"]
//   surfaceOptions: { coding: { repos: "single", drive: false } }
//
// Twelve call sites already treat `surfaces` as string[] (`surfaces.includes("coding")`, the
// console's tab derivation, the sanitizer's KNOWN_SURFACES filter). Changing the element type
// would touch every one of them and the exported types, to say the same thing. This is additive:
// nothing that reads `surfaces` changes at all.
//
// An option for a surface the agent does not declare is INERT, never a way to switch a surface on.
//
// ── Capability CONSTRAINTS (#404) ───────────────────────────────────────────────────────────────
//
// The same map also carries per-CONNECTOR argument constraints — what an agent may PASS, not only
// what it may CALL. It goes here rather than in a sibling structure for the reason above: this is
// already the creator-declared, sanitised, persisted, per-key option map, and `agentCapabilities`
// + `sanitizeDeclaredCapabilities` already route every read and every write through
// `parseSurfaceOptions`/`serializeSurfaceOptions`. A second map would need both again.
//
//   surfaces:       ["tmux"]
//   surfaceOptions: { terminal: { backends: ["tmux"] } }
//
// Two things differ from a surface option and both are deliberate:
//
//   • the key is a CONNECTOR id, not a surface id. They share a namespace (`tmux` is both) and
//     that is fine — a key holds whichever fields its id has a vocabulary for, and a connector
//     with no constraint vocabulary simply has none.
//   • the INERTNESS RULE INVERTS. A surface option must never switch a surface on, so `optionsFor`
//     gates on `surfaces`. A constraint only ever NARROWS, so honouring one for a connector the
//     agent has no tool from costs nothing and refusing to honour it would be the unsafe
//     direction. `constraintsFor` therefore does NOT gate on `surfaces`.
//
// The vocabulary is CLOSED per connector (`CONNECTOR_CONSTRAINTS`): a creator picks a subset of a
// fixed value list, never a rule of their own. Enforcement is at dispatch, in `runRegistryTool`,
// beside the write-consent gate — a prompt is a request, a gate is a fact (ADR 0001, #395).

export interface SurfaceSpec {
	/** "many" (default) shows add-repo + the repo list; "single" hides both. */
	repos: "many" | "single";
	/**
	 * May this agent's CHAT drive the engine (send_to_cli / read_terminal)?
	 *
	 * Default true — the #119 invariant that stopped an orchestrator silently losing the ability
	 * to send tasks, after which it deflected or hallucinated success. A supervised Repo Coder
	 * sets false: its Lead drives it. Its Coding tab and its Pilot are unaffected, because
	 * neither goes through chat tools.
	 */
	drive: boolean;
	/**
	 * Does this agent get a SECOND conversation — the Co-pilot, scoped to one coding session?
	 *
	 * Default true, because the legacy hardcoded Coder has one and removing it there is a
	 * behaviour change nobody asked for. A configurable Repo Coder sets false.
	 *
	 * Why false is right for the new Coder: the Co-pilot exists to translate terminal output into
	 * English for a human. That made sense when the pane held a compiler. It holds Claude Code —
	 * a second model paid to summarise a model whose output is already English. Its one genuinely
	 * useful trick, grounding an answer with read_file/git_diff/list_issues, is not a brain: those
	 * are TOOLS, and `repo-local` + `github` already publish them in the registry (its own header
	 * says it hits "the same read-only, traversal-guarded, byte-capped" runner endpoints the
	 * Co-pilot uses). So the capability moves to the one chat and the second chat goes away.
	 *
	 * Every other agent on the platform — apply, repo-chat, site-builder, doc-chat, the pipelines —
	 * already has exactly one chat. Nine to two. This makes the Coder stop being the exception.
	 */
	copilot: boolean;
	/**
	 * Argument constraints for the CONNECTOR this key names (#404) — absent for a key that is only
	 * a surface, and for a connector with no constraint vocabulary. Field → the values this agent
	 * may pass; a field that is absent has no ceiling, which is today's behaviour exactly.
	 */
	constraints?: ConstraintSpec;
}

export const SURFACE_DEFAULTS: SurfaceSpec = { repos: "many", drive: true, copilot: true };

/** One connector's declared ceilings, keyed by constraint field (e.g. `{ backends: ["tmux"] }`). */
export type ConstraintSpec = Record<string, string[]>;

/** One constraint field: the argument it governs and the CLOSED set of values it draws from. */
export interface ConstraintDef {
	/** The tool-input key carrying the value this constraint governs. */
	arg: string;
	/** The closed value list. A creator may declare any non-empty PROPER subset; nothing else. */
	values: readonly string[];
	/** The value meaning "no filter" (`backend: "all"`). Only legal while nothing is declared. */
	wildcard?: string;
	/**
	 * Input keys whose value carries a constrained value as a `value:` prefix — `tmux:main`,
	 * `iterm2:1:1:1`. Without this the ceiling is bypassed by naming a prefixed target and
	 * omitting `backend`, which is how the tool is actually used.
	 */
	prefixArgs?: readonly string[];
	/** Noun for the refusal message ("terminal backend"). */
	noun: string;
}

/**
 * THE CLOSED VOCABULARY. A creator narrows within this table and can express nothing else — the
 * same discipline as steps, behaviour fields, stats sources and board actions, and for the same
 * reason: free-form rules would hand a creator a language the platform cannot reason about (#322).
 *
 * `terminal` is the first and, today, only entry. `terminal_list_targets` takes
 * `backend: "all"|"tmux"|"kitty"|"iterm2"` and defaults to `all`, so a tmux-only agent cannot be
 * expressed by withholding a tool — the tool it needs is the one that also reaches iTerm2 (#402).
 * `terminal.test.ts` asserts these values against the tools' own JSON-Schema enums, so the two
 * cannot drift.
 */
export const CONNECTOR_CONSTRAINTS: Record<string, Record<string, ConstraintDef>> = {
	terminal: {
		backends: {
			arg: "backend",
			values: ["tmux", "kitty", "iterm2"],
			wildcard: "all",
			prefixArgs: ["target"],
			noun: "terminal backend",
		},
	},
};

/**
 * Parse one connector's constraints against its closed vocabulary. Junk is dropped, never trusted.
 *
 * A list that resolves to the WHOLE vocabulary is not a constraint and is dropped, so "a ceiling
 * exists" always means "this agent is narrower than the platform" — which is what lets the
 * enforcement leave a wildcard argument alone in the unconstrained case.
 *
 * An empty or all-junk list is likewise treated as ABSENT rather than as "allow nothing": reading
 * a typo as a total ban would brick an agent on a config nobody could see was wrong.
 */
export function parseConstraintSpec(id: string, raw: unknown): ConstraintSpec | undefined {
	const vocab = CONNECTOR_CONSTRAINTS[id];
	if (!vocab) return undefined;
	const o = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
	const out: ConstraintSpec = {};
	for (const [field, def] of Object.entries(vocab)) {
		const declared = o[field];
		if (!Array.isArray(declared)) continue;
		const wanted = new Set(declared.filter((d): d is string => typeof d === "string").map((d) => d.trim().toLowerCase()));
		// Iterate the VOCABULARY, not the input: order is canonical, duplicates collapse, and an
		// unknown value cannot survive into stored config.
		const values = def.values.filter((v) => wanted.has(v));
		if (values.length && values.length < def.values.length) out[field] = [...values];
	}
	return Object.keys(out).length ? out : undefined;
}

/** Parse one surface's options, filling defaults. Junk yields defaults, never a broken shape.
 *  `id` (the map key) is what decides whether the entry can also carry connector constraints. */
export function parseSurfaceSpec(raw: unknown, id?: string): SurfaceSpec {
	const o = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
	const constraints = id ? parseConstraintSpec(id, o) : undefined;
	return {
		repos: o.repos === "single" ? "single" : "many",
		// Only an explicit `false` opts out. An absent or malformed value keeps the drive tools,
		// because silently dropping them is the failure this default exists to prevent.
		drive: o.drive !== false,
		// Same rule as `drive`: only an explicit false opts out, so a malformed config can never
		// silently remove a surface the user is looking at.
		copilot: o.copilot !== false,
		...(constraints ? { constraints } : {}),
	};
}

/** Normalize the whole map. Keys are surface OR connector ids; unknown keys are harmless and inert. */
export function parseSurfaceOptions(raw: unknown): Record<string, SurfaceSpec> {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const out: Record<string, SurfaceSpec> = {};
	for (const [id, spec] of Object.entries(raw as Record<string, unknown>)) {
		const key = id.trim();
		if (key) out[key] = parseSurfaceSpec(spec, key);
	}
	return out;
}

/**
 * Options for a surface the agent ACTUALLY declares.
 *
 * Returns null when the surface is not declared — so an option cannot switch a surface on, and a
 * cloud-only agent never reads as "coding with defaults". Declared with no options → defaults.
 */
export function optionsFor(
	capabilities: { surfaces?: readonly string[]; surfaceOptions?: unknown } | null | undefined,
	id: string,
): SurfaceSpec | null {
	if (!capabilities?.surfaces?.includes(id)) return null;
	const map = parseSurfaceOptions(capabilities.surfaceOptions);
	return map[id] ?? { ...SURFACE_DEFAULTS };
}

/**
 * A connector's declared constraints — the CEILING.
 *
 * Unlike `optionsFor` this does NOT gate on `surfaces`, and the asymmetry is the point: an option
 * must never switch a surface on, while a constraint only ever narrows. See the header.
 */
export function constraintsFor(
	capabilities: { surfaceOptions?: unknown } | null | undefined,
	connectorId: string,
): ConstraintSpec | undefined {
	if (!CONNECTOR_CONSTRAINTS[connectorId]) return undefined;
	return parseSurfaceOptions(capabilities?.surfaceOptions)[connectorId]?.constraints;
}

/**
 * The EFFECTIVE constraint: the creator's ceiling, narrowed by whatever the subscriber asked for.
 *
 * The rule the whole primitive rests on — **a subscriber may narrow, and may never widen.** The
 * ceiling is a claim the catalog makes: a "tmux Operator" is named that, and `lintAgentClaims`
 * (#362) checks a description against capabilities. If a subscriber could widen it, the
 * description would become false by configuration, which is what that lint exists to prevent.
 *
 * So a requested value outside the ceiling is DROPPED, not honoured and not an error. When that
 * leaves nothing, the ceiling stands unchanged: an entirely out-of-scope request is a widen
 * attempt, and the safe reading of one is "you asked for nothing you may have", never "you asked
 * for everything" and never "you are locked out of your own agent by a typo".
 */
export function narrowConstraintSpec(
	connectorId: string,
	ceiling: ConstraintSpec | undefined,
	requested: ConstraintSpec | undefined,
): ConstraintSpec | undefined {
	const vocab = CONNECTOR_CONSTRAINTS[connectorId];
	if (!vocab || !requested) return ceiling;
	const out: ConstraintSpec = {};
	for (const field of Object.keys(vocab)) {
		const base = ceiling?.[field];
		const want = requested[field];
		const narrowed = want?.filter((v) => !base || base.includes(v)) ?? [];
		const effective = narrowed.length ? narrowed : base;
		if (effective?.length) out[field] = [...effective];
	}
	return Object.keys(out).length ? out : undefined;
}

/** The minimum a tool must expose for the constraint gate to read it — structural, so a test
 *  can pass a literal and the gate never imports the tool registry. */
export interface ConstrainedTool {
	name: string;
	connector?: string;
	jsonSchema?: { properties?: Record<string, unknown> };
}

/** Either the (possibly narrowed) input to dispatch, or the refusal to return instead. */
export type ConstraintOutcome =
	| { ok: true; input: Record<string, unknown> }
	| { ok: false; refusal: string };

/**
 * Apply a connector's effective constraints to ONE tool call. Pure; the gate in `runRegistryTool`
 * is this function plus the lookup that feeds it.
 *
 * Three outcomes per constraint field, and the middle one is why this returns an input rather than
 * just a boolean:
 *
 *   • the call names a value → in scope, or REFUSED naming the constraint that applied;
 *   • the call names nothing (or the wildcard) → NARROWED to the single permitted value, because
 *     the default is `all` and refusing a defaulted argument would make a tmux-only agent unable
 *     to list its own sessions without guessing;
 *   • it names nothing and more than one value is permitted → refused, asking for an explicit
 *     one, since a single argument cannot carry a set.
 *
 * With no constraint declared this returns the input UNCHANGED and byte-identically — that is the
 * regression that would otherwise be invisible, and `surface-options.test.ts` asserts it.
 */
export function enforceConstraints(
	tool: ConstrainedTool,
	spec: ConstraintSpec | undefined,
	input: Record<string, unknown>,
): ConstraintOutcome {
	const vocab = tool.connector ? CONNECTOR_CONSTRAINTS[tool.connector] : undefined;
	if (!vocab || !spec) return { ok: true, input };
	const props = tool.jsonSchema?.properties ?? {};
	let out = input;
	for (const [field, def] of Object.entries(vocab)) {
		const allowed = spec[field];
		if (!allowed?.length) continue;
		const because = `\`${tool.connector}.${field}\` (${allowed.join(", ")})`;
		// A prefixed argument FIRST: `terminal_capture({target:"iterm2:1:1:1"})` reaches iTerm2
		// without ever setting `backend`, so checking only `backend` would leave the ceiling
		// decorative on every tool that takes a target.
		for (const p of def.prefixArgs ?? []) {
			if (!(p in props)) continue;
			const raw = out[p];
			if (typeof raw !== "string") continue;
			const sep = raw.indexOf(":");
			const prefix = sep > 0 ? raw.slice(0, sep).trim().toLowerCase() : "";
			// An UNPREFIXED target is not waved through: it falls to the `arg` rule below, which
			// pins `backend` to the single permitted value before the runner gets to guess.
			if (!def.values.includes(prefix) || allowed.includes(prefix)) continue;
			return {
				ok: false,
				refusal: `Refused by this agent's declared capability constraint ${because}: "${raw}" names a ${def.noun} this agent may not use.`,
			};
		}
		if (!(def.arg in props)) continue;
		const raw = String(out[def.arg] ?? "").trim().toLowerCase();
		const named = def.values.includes(raw) ? raw : "";
		if (named) {
			if (allowed.includes(named)) continue;
			return {
				ok: false,
				refusal: `Refused by this agent's declared capability constraint ${because}: "${named}" is not a ${def.noun} this agent may use.`,
			};
		}
		// Absent, junk, or the wildcard — all of which mean "whatever the platform allows", which
		// is exactly the value the ceiling exists to replace.
		if (allowed.length === 1) {
			out = { ...out, [def.arg]: allowed[0] };
			continue;
		}
		// More than one value permitted and none named: a single argument cannot carry a set, so
		// ask rather than guess. Naming the wildcard explicitly matters — the model's next move is
		// otherwise to retry the default it just used.
		const wildcard = def.wildcard ? `\`${def.wildcard}\` is not available to this agent — ` : "";
		return {
			ok: false,
			refusal: `Refused by this agent's declared capability constraint ${because}: ${wildcard}pass \`${def.arg}\` explicitly — one of ${allowed.join(", ")}.`,
		};
	}
	return { ok: true, input: out };
}

/** Drop defaults so a stored config stays readable and adding this feature rewrites nothing. */
export function serializeSurfaceOptions(map: Record<string, SurfaceSpec>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [id, spec] of Object.entries(map)) {
		const o: Record<string, unknown> = {};
		if (spec.repos !== SURFACE_DEFAULTS.repos) o.repos = spec.repos;
		if (spec.drive !== SURFACE_DEFAULTS.drive) o.drive = spec.drive;
		if (spec.copilot !== SURFACE_DEFAULTS.copilot) o.copilot = spec.copilot;
		// Constraint fields are written FLAT — `{terminal: {backends: [...]}}`, the shape a creator
		// declares and `docs/capability-constraints.md` specifies — not nested under a wrapper key
		// nobody types. They are already parsed against the closed vocabulary, so what round-trips
		// is canonical: known fields, known values, vocabulary order. Field names cannot collide
		// with `repos`/`drive`/`copilot`; `CONNECTOR_CONSTRAINTS` is a reviewed table.
		for (const [field, values] of Object.entries(spec.constraints ?? {})) o[field] = values;
		if (Object.keys(o).length) out[id] = o;
	}
	return out;
}
