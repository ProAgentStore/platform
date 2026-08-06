// Loop presets (#234) — the named objectives offered wherever a loop can start.
//
// Five of these ("Fix bugs", "Quality check", "Security audit", "Refactor", "Add tests") lived in a
// `useState` inside the Coder's CodingTab and were handed to exactly one child, the Co-pilot view.
// Two things followed from that. A configurable Repo Coder declares `copilot:false`, so its Coding
// tab renders the terminal alone and the presets were simply invisible — starting a loop meant
// retyping the objective every time. And because they were literals in a component, they could not
// be edited, extended, or differ between a frontend repo and an API repo.
//
// So they become config, resolved the way behaviour is (#223): creator template default under the
// subscriber's override. Pure here, D1 in `loop-presets-store.ts`, for the usual reason — the
// rules that decide what a user sees are worth testing without a database.

/** One shortcut button in a loop form. */
export interface LoopPreset {
	/** Stable slug — the React key, and what an edit is matched on. */
	id: string;
	/** The button text. */
	label: string;
	/** What gets put in the objective box when it is pressed. */
	objective: string;
}

/** Where the presets a caller is looking at came from — the console needs this to decide whether
 *  "Reset" is even meaningful (#232: never offer to reset to a value nobody set). */
export type LoopPresetSource = "instance" | "agent" | "default";

export const MAX_LOOP_PRESETS = 12;
export const MAX_PRESET_LABEL = 60;
/** The loop route rejects an objective over 2000 chars; a preset must not be able to build one. */
export const MAX_PRESET_OBJECTIVE = 1000;

/**
 * The five that shipped hardcoded in the Coder. Kept VERBATIM: an instance that never touches its
 * presets has to see exactly what it saw before, or this is a regression dressed as a feature.
 */
export const CODING_LOOP_PRESETS: readonly LoopPreset[] = [
	{ id: "bugs", label: "Fix bugs", objective: "Find and fix all bugs. Run tests after each fix. Commit when all pass." },
	{
		id: "quality",
		label: "Quality check",
		objective:
			"Run a full code quality audit: type check, lint, find code smells, dead code, and fix issues found. Commit improvements.",
	},
	{
		id: "security",
		label: "Security audit",
		objective:
			"Audit the codebase for security vulnerabilities: injection, auth gaps, secrets exposure, SSRF, XSS. Fix critical issues and report.",
	},
	{
		id: "refactor",
		label: "Refactor",
		objective: "Identify large or complex files. Break them into smaller, well-named modules. Keep all tests passing.",
	},
	{
		id: "tests",
		label: "Add tests",
		objective: "Find untested code paths. Write tests for the most critical functions. Aim for meaningful coverage, not 100%.",
	},
];

/**
 * The built-in defaults for an agent nobody has configured, keyed on WHAT THE LOOP DRIVES
 * (`loopDriverFor(caps).id`) rather than a slug — every coding agent gets them, hardcoded Coder and
 * declarative Repo Coder alike, and a new one gets them by declaring `workflow: CODING_SESSION`.
 *
 * A chat-driven agent gets NONE, deliberately. "Run a security audit and commit" is nonsense in a
 * language tutor's loop form, and inventing generic objectives ("do your job") would put a button
 * on screen that no agent is better at than the sentence the user was going to type anyway. An
 * empty list renders exactly today's plain textarea; a creator who has real objectives in mind
 * ships them on the agent, and a subscriber can always add their own.
 */
export function defaultLoopPresets(driverId: string): readonly LoopPreset[] {
	return driverId === "coding" ? CODING_LOOP_PRESETS : [];
}

/**
 * Coerce anything — a hand-edited config, a PUT body — into presets that can be rendered and run.
 *
 * Dropping a malformed entry rather than rejecting the whole list matters here: these are stored in
 * a shared JSON blob, and one bad row must not make the loop form unusable.
 */
export function sanitizeLoopPresets(raw: unknown): LoopPreset[] {
	if (!Array.isArray(raw)) return [];
	const seen = new Set<string>();
	const out: LoopPreset[] = [];
	for (const entry of raw.slice(0, MAX_LOOP_PRESETS)) {
		if (!entry || typeof entry !== "object") continue;
		const e = entry as Record<string, unknown>;
		const label = String(e.label ?? "").trim().slice(0, MAX_PRESET_LABEL);
		const objective = String(e.objective ?? "").trim().slice(0, MAX_PRESET_OBJECTIVE);
		// Both are load-bearing: a preset with no label is an unclickable button, one with no
		// objective is a button that starts a loop with nothing to do.
		if (!label || !objective) continue;
		let id = slug(String(e.id ?? "")) || slug(label) || "preset";
		while (seen.has(id)) id = `${id}-2`;
		seen.add(id);
		out.push({ id, label, objective });
	}
	return out;
}

function slug(s: string): string {
	return s.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

/**
 * What this instance should show: the subscriber's own list if they have one, else the creator's,
 * else the built-in default for the loop driver.
 *
 * Note this is a REPLACE, not a merge — the same rule the console's editor implies. Merging by id
 * would make "remove this preset" impossible on an agent whose template ships it: the removal would
 * be silently undone by the template on every read, which is precisely the kind of setting that
 * "doesn't stick" for no visible reason. An empty stored array therefore means "I have configured
 * zero presets"… which is indistinguishable from unset once written, so the store DELETES the key
 * to clear an override rather than writing `[]`.
 */
export function resolveLoopPresets(opts: {
	agentConfig?: unknown;
	instanceConfig?: unknown;
	driverId: string;
}): { presets: LoopPreset[]; source: LoopPresetSource } {
	const own = sanitizeLoopPresets(pick(opts.instanceConfig));
	if (own.length) return { presets: own, source: "instance" };
	const template = sanitizeLoopPresets(pick(opts.agentConfig));
	if (template.length) return { presets: template, source: "agent" };
	return { presets: [...defaultLoopPresets(opts.driverId)], source: "default" };
}

function pick(config: unknown): unknown {
	if (!config || typeof config !== "object") return undefined;
	return (config as Record<string, unknown>).loopPresets;
}
