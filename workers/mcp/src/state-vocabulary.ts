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
// ── Both halves of that limit are now MEASURED rather than narrated (#600)
//
// The paragraph above was true and was doing no work: it described the blindness in prose while
// the success line went on reporting "12 claims found", a number that reads the same whether the
// surface holds twelve claims or twenty. Two arms in `state-vocabulary.test.ts` close it, and the
// design is deliberately split in two so neither compromises the other:
//
//   · DETECTION OF PRESENCE is broad. {@link enumAnnouncements} asks only "does this description
//     publish a value set", never what the members are, so it can match phrasings the extractor
//     must not. A description that announces one and yields no parsed claim now FAILS.
//   · EXTRACTION OF MEMBERS stays narrow. {@link stateEnumClaims} is unchanged, because a widened
//     extractor has to be RIGHT about what it pulls out: measured at 6 false positives in 8
//     candidates, recovering two of four members from the description it was written for.
//
// So the remedy for an unreadable announcement is to render the vocabulary readably, never to
// teach the scanner one more shape. Its first catch was `coding_session_capture` — rendered from
// a constant since #593 and INVISIBLE to the sweep the whole time, checked by generation and
// uncounted by detection at once. Fixing it moved the surface from 14 claims to 15.
//
// The announcement vocabulary was measured over all 136 descriptions, not imagined: 3 announce a
// value set, and `\bvalues are\b` was dropped as a marker because it produced 2 false positives
// and no true ones.
//
// ── The nine entries below, re-derived against the tree
//
// Each was checked entry by entry rather than assumed, and their citations are now FIELDS the
// test resolves (file exists, symbol declared, members present near it) instead of prose nothing
// read. Three were false — `lib/tool-listing.ts` was not a file, `lib/connector-consent.ts` held
// none of the four members cited to it, `lib/coding-engines.ts` declared a different four-member
// set — and an entry naming a missing file passed exactly as an accurate one did. Corrected in
// place; the old citation is kept in each `reason` so the record shows what moved.
//
//   · FOUR are one derivation away, because the cited file really does declare a closed set:
//     `board.ts:17 BoardView`, `feedback.ts:35 FeedbackStatus`, `agent-capabilities.ts:31
//     AgentRuntimeKind` (needs the parser to accept the unquoted `null` member) and
//     `agent-loop.ts:15 LoopStopReason` (a multi-line union of nine, of which the claim names
//     three — the sweep's subset rule already covers that shape).
//   · ONE cannot be backed at all and should not be: `events.ts:23` documents `source` as
//     `'chat' | 'apply' | 'coding' | 'voice' | 'tool' | …` — an OPEN field with an explicit
//     ellipsis. A closed set derived from an open one would be a new false claim.
//   · ONE is correctly labelled not a value set at all ("added|errors|seen|skipped" — field
//     names), though it is a PIPELINE run tally rather than the "ingest" one recorded until #600.
//
// What the citation check CANNOT do, stated because it is the next hole: it proves a citation
// RESOLVES, not that it is the right enum. `cancelled|done|failed` cites `LoopStopReason`, which
// contains all three — and the only description publishing that set is about runtime TASK status,
// whose vocabulary has `completed` and no `done` at all. That defect is real, is in a file this
// one does not own, and is recorded on the entry rather than silently fixed here.

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
 *
 * ── Why it LEADS with a bare chain (#600)
 *
 * It did not, and that cost it its place in the denominator. Written as `is one of:` followed
 * straight into glossed members, `stateEnumClaims` returned `[]` for it — the same blindness
 * that hid the two `health` descriptions in #588 — so the one description on this surface that
 * is genuinely rendered from a constant was NOT among the claims the sweep counted. It was
 * checked by generation and invisible to detection at the same time, which reads in the success
 * line as a surface with one fewer value set on it than it has.
 *
 * Found by the announcement sweep added in #600 rather than by reading: it was the only true
 * positive of three, over 136 descriptions. Fixed the way {@link runHealthSentence} was fixed,
 * because the two now have to answer the same guard.
 */
export function runStateSentence(): string {
	const chain = CODING_RUN_STATES.map((s) => `\`${s}\``).join("/");
	const parts = CODING_RUN_STATES.map((s) => `\`${s}\` (${RUN_STATE_GLOSS[s]})`);
	return `\`run_state\` is one of ${chain} — ${parts.join(", ")}.`;
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

/** An unbacked claim's citation — the code that emits it, in a shape a guard can resolve. */
export interface UnbackedClaim {
	/** Why the claim is not backed by a derived vocabulary. */
	reason: string;
	/**
	 * Repo-relative path of the code that emits the vocabulary, or `null` when the members are
	 * genuinely declared nowhere. `state-vocabulary.test.ts` READS this file and fails when it
	 * does not exist or does not declare the members — prose could not be checked, and three of
	 * these nine were false (#600).
	 */
	source: string | null;
	/** The declaration in {@link source}. The guard looks for the members around it. */
	symbol?: string;
}

/**
 * Enum-shaped claims found in tool descriptions that are NOT yet backed by a derived vocabulary.
 *
 * Keyed by the claim's normalised members. Backing one means finding the code that emits it and
 * adding it to {@link BACKED_VOCABULARIES} — at which point its entry here must be deleted, which
 * the guard enforces in both directions.
 *
 * ── Why the citation is a field and not a sentence (#600)
 *
 * It was a sentence, and nothing read it. Three of the nine named code that does not exist:
 * `lib/tool-listing.ts` was not a file in the tree, `lib/connector-consent.ts` contained zero
 * occurrences of any of `granted/n\a/per_call/required`, and `lib/coding-engines.ts` declares
 * `EngineAuth = auto|machine|subscription|api-key` — a different four-member set from the one
 * recorded against it. An entry pointing at a missing file passed exactly as an accurate one did.
 *
 * That is the defect this whole file was built to catch, occurring in its own metadata: a stated
 * fact nothing checks. It matters more than three stale strings because the inventory exists so a
 * future reader can decide whether a claim can NOW be backed; a false citation sends them to a
 * file that is not there, and finding nothing they conclude the claim is unbackable — the exact
 * opposite of what the record is for.
 *
 * All nine were re-derived against the tree, not just the three known bad: the base rate was
 * three false in nine, which is too poor to spot-check. Two more corrections came out of it —
 * `added|errors|seen|skipped` is a PIPELINE run tally rather than an "ingest" one, and
 * `account|default|env|platform` was mislabelled "engine auth origin" when it is a budget
 * ceiling tier, so both the file AND the noun were wrong on that entry.
 */
export const UNBACKED_CLAIMS: Record<string, UnbackedClaim> = {
	"kanban|list": {
		reason: "board view",
		source: "workers/api/src/lib/board.ts",
		symbol: "BoardView",
	},
	"browser|coding|null": {
		reason: "agent runtime kind — `null` is an unquoted member of the union",
		source: "workers/api/src/lib/agent-capabilities.ts",
		symbol: "AgentRuntimeKind",
	},
	"added|errors|seen|skipped": {
		reason:
			"FIELD NAMES of a pipeline-run tally, not a value set — backing it would invent a closed " +
			'set out of four struct members. Recorded as "an ingest tally" until #600; it is the ' +
			"pipeline run counter, and the tool that publishes it is `list_pipeline_runs`.",
		source: "workers/api/src/lib/pipeline-runs.ts",
		symbol: "RunCounts",
	},
	"dismissed|filed|open|triaged": {
		reason: "feedback status",
		source: "workers/api/src/lib/feedback.ts",
		symbol: "FeedbackStatus",
	},
	"disabled_by_owner|not_declared|ok": {
		reason:
			"tool-policy reason. Cited `lib/tool-listing.ts` until #600 — a file that has never " +
			"existed in this tree. The producer is `instance-tool-policy.ts:220`; the type is " +
			"re-exported from the leaf below.",
		source: "workers/api/src/lib/tool-refusal.ts",
		symbol: "ToolPolicyReason",
	},
	"granted|n/a|per_call|required": {
		reason:
			"write-consent state. Cited `lib/connector-consent.ts` until #600, which contains none " +
			"of the four (that file declares only `ConnectorScope = \"write\"`).",
		source: "workers/api/src/lib/instance-tool-policy.ts",
		symbol: "ToolWriteConsent",
	},
	"cancelled|done|failed": {
		reason:
			"loop stop reasons — three of a nine-member union, which the sweep's subset rule covers. " +
			"NOTE, and NOT fixed here because it is a defect in a description this file does not own: " +
			"the only description publishing this set is `instance-tools/board.ts:273`, which is about " +
			"runtime TASK status, not loop stop reasons. That vocabulary is `TaskStatus` in " +
			"`packages/browser-runner/src/types.ts:10`, where the member is `completed` and `done` does " +
			"not appear. So the citation below resolves and the description is still wrong — the limit " +
			"of a mechanical citation check, stated rather than papered over.",
		source: "workers/api/src/lib/agent-loop.ts",
		symbol: "LoopStopReason",
	},
	"apply|chat|coding|voice": {
		reason:
			"trace source, and the field is genuinely OPEN — declared `source: string` with an " +
			"explicit ellipsis in its doc comment. A closed set derived from an open one would be a " +
			"new false claim, so this entry must stay here rather than move to BACKED_VOCABULARIES.",
		source: "workers/api/src/lib/events.ts",
		symbol: "source",
	},
	"account|default|env|platform": {
		reason:
			"budget CEILING TIER — which of four sources supplied a spend limit. Recorded as " +
			'"engine auth origin — emitted by lib/coding-engines.ts" until #600, where both halves ' +
			"were wrong: that file declares `EngineAuth = auto|machine|subscription|api-key`, and no " +
			"concept of an engine auth origin exists in the tree at all. Unexported, and under " +
			"`routes/` rather than `lib/`, which is why it was hard to find and is worth naming.",
		source: "workers/api/src/routes/budget.ts",
		symbol: "CeilingTier",
	},
};

// ─────────────────────────────────────────────────────────────────────────────
// ANNOUNCEMENTS — the denominator {@link stateEnumClaims} cannot supply (#600)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Phrases that ANNOUNCE a value set, whether or not {@link stateEnumClaims} can read the members.
 *
 * Measured over the real registered surface (136 descriptions), not imagined. `\bvalues are\b`
 * was a candidate and is deliberately absent: it produced two false positives and no true ones
 * ("values are never exposed" in `keys_status`, "Values are clamped server-side" in
 * `set_budget_limits`), which is the cry-wolf rate that gets a guard deleted.
 *
 * `it has three values:` is here because it is what the two drifted `health` descriptions
 * actually said before #588 — recovered from `78bac76^` rather than guessed.
 */
const ENUM_ANNOUNCEMENTS: RegExp[] = [
	/\bis one of\b/i,
	/\bone of:/i,
	/\bone of the following\b/i,
	/\b(?:two|three|four|five|six|seven|eight|nine|ten|\d+)\s+values\b/i,
];

/**
 * Does this description publish a value set — in ANY shape?
 *
 * A different question from {@link stateEnumClaims}, and the whole point of the split. That
 * function EXTRACTS members and must be right about them; this one only asserts that a value set
 * is being published, so it can be broad where the extractor cannot.
 *
 * The failure this closes: `stateEnumClaims` returned `[]` for both drifted `health`
 * descriptions, so the claim was never one of the twelve the sweep measured and no inventory
 * entry could have recorded what the sweep never found. Counting announcements gives the sweep a
 * denominator — announced = parsed + UNPARSED — where before it had only "12 claims found", a
 * number that looked identical whether the surface held twelve claims or twenty.
 *
 * The remedy for an announcement the extractor cannot read is to RENDER the vocabulary in a
 * readable shape ({@link runHealthSentence}, {@link runStateSentence}), never to widen the
 * extractor: widening was measured at 6 false positives in 8 candidates and still recovered only
 * two of four members from the description it was written for. Generation, not detection — the
 * doctrine at the top of this file, now with a guard that says when it has been skipped.
 *
 * @returns the announcement phrases found, so a failure can quote what it matched on
 */
export function enumAnnouncements(text: string): string[] {
	return ENUM_ANNOUNCEMENTS.map((re) => text.match(re)?.[0]).filter((m): m is string => Boolean(m));
}

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
