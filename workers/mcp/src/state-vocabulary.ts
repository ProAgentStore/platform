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
// It is deliberately honest about what it has NOT verified: these claims are emitted by code this
// worker cannot import and several are owned by other modules, so pretending they were checked
// would be the "certifies ground it never walked" failure ADR 0002 exists for.
//
// ── The limit of the inventory, stated because #588 walked straight through it
//
// An inventory ratchet catches a claim that CHANGES. It cannot catch one that was already stale,
// nor one whose source enum gains a member somewhere this worker cannot see — and it cannot catch
// one the SCANNER NEVER FOUND. All three applied at once to `RunHealth` (see RUN_HEALTH_STATES
// below), on the same day this file landed: `ended` was added in `workers/api`, two descriptions
// went on saying "three values", and neither of them was among the twelve claims the sweep
// measured, because both wrote their members with parenthesised glosses — the shape the scanner
// does not read.
//
// The answer in each case is the mechanism above, not a better inventory: back the vocabulary
// against the emitting source, and RENDER it rather than restate it.
//
// How far that generalises to the nine entries below was MEASURED, entry by entry, rather than
// assumed — and it does not generalise evenly:
//
//   · FOUR are one derivation away, because the cited file really does declare a closed set:
//     `board.ts:17 BoardView`, `feedback.ts:35 FeedbackStatus`, `agent-capabilities.ts:31
//     AgentRuntimeKind` (needs the parser to accept the unquoted `null` member) and
//     `agent-loop.ts:15 LoopStopReason` (a multi-line union of nine, of which the claim names
//     three — the sweep's subset rule already covers that shape).
//   · ONE cannot be backed at all and should not be: `events.ts:23` documents `source` as
//     `'chat' | 'apply' | 'coding' | 'voice' | 'tool' | …` — an OPEN field with an explicit
//     ellipsis. A closed set derived from an open one would be a new false claim.
//   · THREE have a citation that does not hold, found while checking this: there is no
//     `lib/tool-listing.ts` in the tree; `lib/connector-consent.ts` contains none of
//     `granted/n\a/per_call/required` (grep count 0); and `lib/coding-engines.ts` declares
//     `EngineAuth = auto|machine|subscription|api-key`, which is a DIFFERENT four-member set from
//     the `account|default|env|platform` recorded here. The reasons are prose, so nothing enforces
//     them — an inventory entry pointing at a file that does not exist still passes. Left as
//     recorded rather than guessed at: sending an implementer to the wrong file is the cost this
//     whole mechanism exists to avoid, and correcting three citations is a separate measurement.
//   · ONE is correctly labelled not a value set at all ("added|errors|seen|skipped" — field names).

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

/**
 * The `health` verdict vocabulary — a run's liveness, as the platform itself judges it.
 *
 * A COPY of `RunHealth` in `workers/api/src/lib/work-report.ts`, for the same reason
 * {@link CODING_RUN_STATES} is a copy: separate deployable, no import. `state-vocabulary.test.ts`
 * parses the `export type RunHealth = …` union out of that file and fails when the two drift, so
 * adding a member over there turns this build red rather than leaving two descriptions describing
 * an enum that has moved.
 *
 * ── Why this one is here at all (#588)
 *
 * #593 shipped the guard above and measured its own reach honestly: 136 tools swept, 12 value-set
 * claims, 1 backed by generation, 9 inventoried as unbacked because the emitting code lives in a
 * worker this one cannot import. `RunHealth` gained a fourth member (`ended`) the SAME DAY, and
 * two descriptions kept saying "three values" — a word the payload now returns and the prose does
 * not define. So the first real vocabulary drift after the guard landed went straight through it.
 *
 * It went through TWO holes, and only one of them was the one that was labelled:
 *
 *   1. The import boundary, which was known. Closed here the way it was closed for the coding run
 *      states — a copy the test derives from the original's source.
 *   2. **The detector could not see the claim at all.** Measured: `stateEnumClaims` returns `[]`
 *      for both of the drifted descriptions. It reads `(a/b/c)` and `` `a`/`b` `` chains; these
 *      wrote `` `working` (gloss), `waiting` (gloss), `stalled` (gloss) ``, which is the shape a
 *      GOOD description uses. So the claim was never one of the twelve — it was invisible, and
 *      the inventory could not have recorded what the sweep never found.
 *
 * Widening the detector to match a glossed chain was measured and REJECTED: over the registered
 * surface it found 8 candidates of which 6 were false positives (field names in a result envelope,
 * the scope names `write`/`destructive`, a pair of tool names), and on the very description this
 * ticket is about it recovered only `waiting|working` — the long gloss between the members hid the
 * rest. A guard that cries wolf six times out of eight gets deleted, and one that finds two of
 * four members certifies the half it saw. This is the file's own doctrine holding: **generation,
 * not detection.** {@link runHealthSentence} renders the set, and the sentence LEADS with the bare
 * chain so what it publishes is also a claim the sweep can see and check against the source.
 */
export const RUN_HEALTH_STATES = ["working", "waiting", "stalled", "ended"] as const;

/**
 * What each verdict means, and — for two of them — what it deliberately does NOT claim.
 *
 * `ended`'s gloss is the fix: it is the member that did not exist, and a reader who meets it
 * unlabelled has no way to know it is a statement about a CLOSED run rather than a fifth kind of
 * trouble. `waiting`'s says "only when one is knowable" because `coding-pause.ts:146` writes no
 * resume time for a human handoff (#596) — the API legend stopped promising one, and a promise
 * this surface kept making would be the same defect relocated.
 */
const RUN_HEALTH_GLOSS: Record<string, string> = {
	working: "the orchestrator is ticking; it may legitimately be many minutes into ONE instruction",
	waiting:
		"deliberately parked — `waitNote` says what for, and gives a resume time only when one is knowable; read it, because one park is waiting for a PERSON and will not clear itself",
	stalled: "nothing has ticked; the row will say `running` forever and the workflow is probably gone",
	ended:
		"the run is CLOSED — read `status` and `stopReason` for what happened; `ended` makes NO claim that anything is running",
};

/**
 * The verdict vocabulary, rendered — never typed out.
 *
 * Two jobs in one sentence, both deliberate. The leading `` `a`/`b`/`c` `` chain is the closed set
 * a model needs first AND the shape {@link stateEnumClaims} can detect, so this claim is swept and
 * checked against `RunHealth` like any other rather than trusted because it was generated. The
 * glossed clauses follow, because an unlabelled member is what let `ended` arrive as a word no
 * reader could interpret.
 */
export function runHealthSentence(): string {
	const chain = RUN_HEALTH_STATES.map((s) => `\`${s}\``).join("/");
	const glossed = RUN_HEALTH_STATES.map((s) => `\`${s}\` (${RUN_HEALTH_GLOSS[s]})`).join("; ");
	return (
		`\`health\` is one of ${chain} — the platform's OWN verdict on the run, to be quoted rather than re-derived: ${glossed}.`
	);
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
	// #588. Two tools publish this one — `check_instance_loop` and `coding_loop_status`, which call
	// the SAME endpoint — and both restated it by hand, which is exactly how they came to disagree
	// with the payload on the day `ended` was added.
	"run health": {
		source: "workers/api/src/lib/work-report.ts",
		values: RUN_HEALTH_STATES,
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
