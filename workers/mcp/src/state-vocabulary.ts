// A tool description may not advertise a value the code cannot emit (#593 AC2).
//
// ── The class, measured three times in one day
//
//   · `coding_session_capture` said run state was "(idle/working/offline)". `working` is not a
//     member of the runner's union and never was; `offline` was, at the time, produced only by a
//     different route. Two of three advertised values were unreachable.
//   · `list_instance_tools` named two of its four tiers (#569).
//   · `agent_trace` named levels it did not emit.
//
// One shape: prose restating an enum that lives in code, drifting from it silently. A caller
// cannot falsify it — the values look authoritative, and the only way to find out is to call the
// tool enough times to notice a value never appears, or to read the emitting source.
//
// ── Two mechanisms, because a guard alone would not have prevented it
//
// 1. GENERATION. {@link runStateSentence} RENDERS the vocabulary into the description from the
//    constant, so the sentence cannot name a value the code does not have. This is the shape
//    `list_instance_tools` already adopted for its tiers after #569 ("Rendered from TOOL_TIERS,
//    never typed out"), applied to the surface that had the same defect.
//
// 2. INVENTORY. Generation only helps the descriptions that use it. `state-vocabulary.test.ts`
//    sweeps EVERY registered tool for enum-shaped claims and requires each to be either backed by
//    a vocabulary derived from the emitting code, or recorded in {@link UNBACKED_CLAIMS} with the
//    reason it is not. That is the denominator ADR 0002 asks for: the check is over every tool
//    that publishes a value set, not over the one this ticket was about.
//
// {@link UNBACKED_CLAIMS} is a RATCHET, not an allowlist. Entries may leave it — by being backed —
// and a new claim cannot be added without a decision, because an unrecorded one fails the build.
// It is deliberately honest about what it has NOT verified: twelve of these claims are emitted by
// code this worker cannot import and several are owned by other modules, so pretending they were
// checked would be the "certifies ground it never walked" failure ADR 0002 exists for.

/**
 * The coding `runState` vocabulary.
 *
 * A COPY of `workers/api/src/lib/coding-run-state.ts`, because the MCP worker is a separate
 * deployable that cannot import from the API worker — the same rule, and the same reason, as
 * `instance-tools/shared.ts`'s `columnFor`. `state-vocabulary.test.ts` derives the original from
 * that file's source and fails when the two drift, so the copy cannot rot quietly.
 */
export const CODING_RUN_STATES = ["idle", "thinking", "responding", "ended", "offline", "unknown"] as const;

/** What each state MEANS to a caller deciding whether anything is wrong. */
const RUN_STATE_GLOSS: Record<string, string> = {
	idle: "an engine answered and is doing nothing",
	thinking: "taking a turn",
	responding: "streaming its answer",
	ended: "the session is over",
	offline: "no runner is connected, so nothing was asked",
	unknown: "the runner is connected but did not answer the probe",
};

/**
 * The enumeration, rendered — never typed out.
 *
 * Every member carries its gloss because the three states that are NOT an engine's answer are
 * exactly the ones a reader collapses into "idle" when they are unlabelled, which is the defect.
 */
export function runStateSentence(): string {
	const parts = CODING_RUN_STATES.map((s) => `\`${s}\` (${RUN_STATE_GLOSS[s]})`);
	return `\`run_state\` is one of: ${parts.join(", ")}.`;
}

/** A value set a description publishes, and where the code that emits it lives. */
export interface StateVocabulary {
	/** Repo-relative path of the emitting source, read by the guard rather than trusted. */
	source: string;
	values: readonly string[];
}

/** Vocabularies checked against the code that emits them. */
export const BACKED_VOCABULARIES: Record<string, StateVocabulary> = {
	"coding run state": {
		source: "workers/api/src/lib/coding-run-state.ts",
		values: CODING_RUN_STATES,
	},
};

/**
 * Enum-shaped claims found in tool descriptions that are NOT yet backed by a derived vocabulary.
 *
 * Keyed by the claim's normalised members, valued by why it is unbacked. Backing one means finding
 * the code that emits it and adding it to {@link BACKED_VOCABULARIES} — at which point its entry
 * here must be deleted, which the guard enforces in both directions.
 */
export const UNBACKED_CLAIMS: Record<string, string> = {
	"kanban|list": "board view — emitted by workers/api/src/lib/board.ts `BoardView`",
	"browser|coding|null": "runtime kind — emitted by workers/api/src/lib/agent-capabilities.ts",
	"added|errors|seen|skipped": "FIELD NAMES of an ingest tally, not a value set",
	"dismissed|filed|open|triaged": "feedback status — emitted by workers/api/src/lib/feedback.ts",
	"disabled_by_owner|not_declared|ok": "tool-listing reason — emitted by workers/api/src/lib/tool-listing.ts",
	"granted|n/a|per_call|required": "write-consent state — emitted by workers/api/src/lib/connector-consent.ts",
	"cancelled|done|failed": "loop stop reasons — emitted by workers/api/src/lib/agent-loop.ts",
	"apply|chat|coding|voice": "trace source — emitted by workers/api/src/lib/events.ts",
	"account|default|env|platform": "engine auth origin — emitted by workers/api/src/lib/coding-engines.ts",
};

/**
 * Every enum-shaped claim in a piece of prose, as sorted member lists.
 *
 * Two shapes, both taken from what the descriptions actually contain (measured, not imagined):
 * a parenthesised list — `(idle/working/offline)`, `(ok | not_declared | disabled_by_owner)` —
 * and a backticked chain — `` `thinking`/`responding` ``. Anything else is not detected, which is
 * why generation rather than detection is the primary mechanism above.
 */
export function stateEnumClaims(text: string): string[][] {
	const claims: string[][] = [];
	// A claim's members are IDENTIFIERS. Anything with a space in it is prose that happens to
	// contain a slash — `trace_id (one run/turn)` and `(by repo_url or owner/repo)` are the two
	// real ones on this surface — and reading those as value sets would make the guard cry wolf
	// until somebody silenced it. `n/a` is one token that contains its own separator.
	const isMember = (m: string) => /^[a-z_]+$/.test(m) || m === "n/a";
	const add = (members: string[]) => {
		const cleaned = members.map((m) => m.trim()).filter(Boolean);
		if (cleaned.length < 2 || !cleaned.every(isMember)) return;
		claims.push([...new Set(cleaned)].sort());
	};
	// `(a/b/c)` and `(a | b | c)` — bare words only, so a sentence in parentheses is not a claim.
	for (const m of text.matchAll(/\(([a-z_/][a-z_ /|]*[a-z_])\)/g)) {
		const body = m[1];
		if (!/[|/]/.test(body)) continue;
		// Tokenised rather than split on a placeholder: `n/a` is one member that contains the
		// separator, and every other member is a run of non-separator characters (which is how a
		// phrase like "one run/turn" keeps its space and is then rejected as prose).
		add(body.match(/n\/a|[^|/]+/g) ?? []);
	}
	// `` `a`/`b` `` chains.
	for (const m of text.matchAll(/`[a-z_]+`(?:\/`[a-z_]+`)+/g)) {
		add(m[0].split("/").map((s) => s.replace(/`/g, "")));
	}
	return claims;
}

/** The key {@link UNBACKED_CLAIMS} records a claim under. */
export const claimKey = (members: readonly string[]): string => [...members].sort().join("|");
