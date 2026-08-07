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
}

export const SURFACE_DEFAULTS: SurfaceSpec = { repos: "many", drive: true, copilot: true };

/** Parse one surface's options, filling defaults. Junk yields defaults, never a broken shape. */
export function parseSurfaceSpec(raw: unknown): SurfaceSpec {
	const o = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
	return {
		repos: o.repos === "single" ? "single" : "many",
		// Only an explicit `false` opts out. An absent or malformed value keeps the drive tools,
		// because silently dropping them is the failure this default exists to prevent.
		drive: o.drive !== false,
		// Same rule as `drive`: only an explicit false opts out, so a malformed config can never
		// silently remove a surface the user is looking at.
		copilot: o.copilot !== false,
	};
}

/** Normalize the whole map. Keys are surface ids; unknown keys are harmless and inert. */
export function parseSurfaceOptions(raw: unknown): Record<string, SurfaceSpec> {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const out: Record<string, SurfaceSpec> = {};
	for (const [id, spec] of Object.entries(raw as Record<string, unknown>)) {
		const key = id.trim();
		if (key) out[key] = parseSurfaceSpec(spec);
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

/** Drop defaults so a stored config stays readable and adding this feature rewrites nothing. */
export function serializeSurfaceOptions(map: Record<string, SurfaceSpec>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [id, spec] of Object.entries(map)) {
		const o: Record<string, unknown> = {};
		if (spec.repos !== SURFACE_DEFAULTS.repos) o.repos = spec.repos;
		if (spec.drive !== SURFACE_DEFAULTS.drive) o.drive = spec.drive;
		if (spec.copilot !== SURFACE_DEFAULTS.copilot) o.copilot = spec.copilot;
		if (Object.keys(o).length) out[id] = o;
	}
	return out;
}
