/**
 * Standing policies — the invariants a repo CLAIMS, evaluated where its state is already read (#322).
 *
 * The primitive, and the whole reason this file is a closed table rather than a string:
 *
 *   A GOAL makes something happen — "fix issue #36". One-shot, user-initiated, arbitrary.
 *   A POLICY keeps something true — "this repo stays on its default branch". Standing, recurring.
 *
 * A policy may only restore a declared invariant; it may never decide what to build. That property
 * is guaranteed by the vocabulary being closed HERE, at a table with no free-text member, and — in
 * this slice — by there being no actuator at all.
 *
 * ── Acting: one policy, one verb, and the other policy declined outright
 *
 * `act` is a mode, and it is a mode a policy only gets if it declares an ACTUATOR — a fixed argv on
 * the runner (`packages/browser-runner/src/coding/repo-write.ts`), never a goal handed to an Engine.
 * That distinction is the entire safety argument the observe half made: delegating "put the repo
 * right" to `claude --dangerously-skip-permissions` closes the vocabulary at the NAME of the policy
 * and leaves it wide open at the hands.
 *
 * So exactly one policy can act:
 *
 *   `repo.on_default_branch`  →  `git checkout <declared branch>`, ONLY on a clean tree. It moves a
 *                                pointer, destroys nothing, and the undo — `git checkout <the
 *                                branch you were on>` — is printed on the card. The clean-tree
 *                                precondition is not a nicety: git carries uncommitted changes
 *                                ACROSS a checkout, so acting on a dirty tree would relocate
 *                                somebody's work onto the target branch, which is #276's harm
 *                                reached from the other direction. Dirty → refuse and say so.
 *
 *   `repo.tree_clean`         →  NO actuator, and therefore `act` is REFUSED for it at the door
 *                                (`sanitizeRepoPolicies`). Not deferred — declined. An unattended
 *                                `add -A` runs over a tree that is unreviewed BY CONSTRUCTION (if
 *                                anyone had reviewed it, it would not be dirty) and sweeps in files
 *                                git was never told about. Committing to a policy branch was
 *                                considered and rejected: it still decides that unreviewed work is
 *                                now a commit, and the human who has to undo it has to find it
 *                                first. It observes, which is genuinely useful, and stops there.
 *
 * Every mode defaults exactly where the observe half left it: nothing is promoted to `act` by the
 * acting slice, on any repo. A human turns one on, per repo, per policy — and the ONLY way to do
 * that is `PUT /v1/instances/:id/coding/repos/:repoId`, which no agent tool reaches — asserted over
 * the source in `repo-policies.test.ts` ("promotion is a human action"), because a policy is the one
 * thing that acts with nobody present: an agent able to promote one converts a single prompt
 * injection into a standing capability.
 *
 * **It still does not schedule.** Evaluation happens at the end of a coding run, which is the moment the
 * state actually changed and the only moment a live runner is guaranteed. No second scheduler, no
 * second claim, no second retry ladder — and specifically no reuse of the delivery outbox, whose
 * `[60, 300, 900, 3600, 10800]s` ladder would replay a 09:00 observation at 12:00 against a repo
 * that has since changed. A policy that misses a tick re-observes next tick and never replays.
 *
 * That is also why a refused or failed remediation is NOT suppressed on the next tick. A "tick"
 * here is the end of another run — a fresh observation of a repo something has just worked in, not
 * a timer re-firing on stale state — and the attempt costs one local git call and no model spend,
 * so it draws on no budget an interactive delegation needs. Suppressing it would hide an invariant
 * that still does not hold.
 *
 * **It does not re-verify the checkout's path.** That is #440 (a transport failure stored as the
 * repo's state, plus `clone_checked_at`), and duplicating it here would put two writers on
 * `clone_status`.
 *
 * ── Unknown is not "held"
 *
 * Every observation here is conditional on a machine being reachable. An absent observation must
 * read as UNKNOWN — never as clean — so an unobserved policy leaves whatever card exists exactly
 * where it is. `repo-state.ts` already takes that care; this inherits it rather than re-deciding it.
 */
// What was OBSERVED lives one module down, and that module imports nothing (see its header): this
// one is read by `coding-store` (it parses the column) and `repo-state` reaches `coding-store`, so
// a shared shape in either of them would be a static import cycle.
import { dirtyClause, offTrunkClause, type RepoWorkingState } from "./repo-observation.js";

/** The closed vocabulary. Adding a member is a code review; there is no free-text policy. */
export type RepoPolicyId = "repo.tree_clean" | "repo.on_default_branch";

/**
 * `observe` reports; `act` also restores. `act` is only ACCEPTED for a policy that declares an
 * actuator below — for the others it is refused at the door, which is what keeps the vocabulary
 * closed at the hands rather than at the name.
 */
export type RepoPolicyMode = "off" | "observe" | "act";

/** The closed set of things an actuator may do. One member, and a second is a code review. */
export type RepoPolicyVerb = "switch_branch";

export interface RepoPolicyActuator {
	verb: RepoPolicyVerb;
	/** How the action is named to a human, before it happens and on the card afterwards. */
	label: string;
}

export interface RepoPolicyDef {
	id: RepoPolicyId;
	/** How the policy is named to a human, in the card and in the prompt. */
	label: string;
	/** The invariant in one sentence — what the repo is claiming when it turns this on. */
	invariant: string;
	/**
	 * The mode when the repo has declared nothing.
	 *
	 * `tree_clean` is `observe` because that card already ships unconditionally (#276): defaulting
	 * it off would silently retire a shipped capability. `on_default_branch` is `off` because a
	 * checkout parked on a feature branch is frequently INTENDED — #276 says so outright — and
	 * raising a `needs_human` card on every such repo the day this deploys would be a burst of
	 * noise nobody asked for. Claiming it is opt-in.
	 */
	fallback: RepoPolicyMode;
	/** Board card `type` for a violation of this policy. */
	cardType: string;
	/**
	 * The fixed-argv remediation this policy may run in `act`, or `null` — which makes `act`
	 * unacceptable for it. Null is a DECISION, not a gap: see the header on `tree_clean`.
	 */
	actuator: RepoPolicyActuator | null;
}

export const REPO_POLICIES: readonly RepoPolicyDef[] = [
	{
		id: "repo.tree_clean",
		label: "clean working tree",
		invariant: "this checkout carries no uncommitted work between runs",
		fallback: "observe",
		cardType: "coding.uncommitted",
		// Declined, not unimplemented. There is no way to clear a working tree that does not decide,
		// unattended, that somebody's unreviewed diff is now a commit — or worse, is now gone.
		actuator: null,
	},
	{
		id: "repo.on_default_branch",
		label: "on its default branch",
		invariant: "this checkout is left on its configured branch, or the trunk when it has none",
		fallback: "off",
		cardType: "coding.off_branch",
		actuator: { verb: "switch_branch", label: "switch the checkout back to its declared branch" },
	},
];

const BY_ID = new Map<string, RepoPolicyDef>(REPO_POLICIES.map((p) => [p.id, p]));

export function repoPolicyDef(id: string): RepoPolicyDef | null {
	return BY_ID.get(id) ?? null;
}

/** What a repo has declared. A policy absent from the record falls back to its table default. */
export type DeclaredRepoPolicies = Partial<Record<RepoPolicyId, RepoPolicyMode>>;

const MODES: readonly RepoPolicyMode[] = ["off", "observe", "act"];

/**
 * Validate a caller-supplied declaration.
 *
 * A whitelist over BOTH key and value, and it returns `null` — not `{}` — for input that carries
 * nothing recognisable, so a typo'd policy name cannot silently become "declared nothing" and
 * overwrite a real declaration. `parseConfig`'s lesson in `triggers.ts`: a reconstruct-from-scratch
 * whitelist drops what it does not know, so the drop has to be visible to the caller.
 */
export function sanitizeRepoPolicies(raw: unknown): { ok: true; value: DeclaredRepoPolicies } | { ok: false; error: string } {
	if (raw === null) return { ok: true, value: {} };
	if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "policies must be an object" };
	const out: DeclaredRepoPolicies = {};
	for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
		const def = BY_ID.get(k);
		if (!def) return { ok: false, error: `unknown policy \`${k}\` — known policies: ${REPO_POLICIES.map((p) => p.id).join(", ")}` };
		const modes = def.actuator ? MODES : MODES.filter((m) => m !== "act");
		if (typeof v !== "string" || !modes.includes(v as RepoPolicyMode)) {
			// A policy with no actuator says WHY rather than just listing what it takes: "act is not
			// in the list" reads as unimplemented, and this one is declined.
			const why = def.actuator
				? ""
				: ` — \`${def.id}\` has no actuator: there is no way to satisfy it that does not decide, unattended, what happens to unreviewed work`;
			return { ok: false, error: `policy \`${k}\` must be one of: ${modes.join(", ")}${why}` };
		}
		out[def.id] = v as RepoPolicyMode;
	}
	return { ok: true, value: out };
}

/** Read the stored column. Corrupt or absent JSON is "declared nothing", never a throw. */
export function parseRepoPolicies(raw: string | null | undefined): DeclaredRepoPolicies | undefined {
	if (!raw) return undefined;
	try {
		const parsed = sanitizeRepoPolicies(JSON.parse(raw));
		return parsed.ok && Object.keys(parsed.value).length ? parsed.value : undefined;
	} catch {
		return undefined;
	}
}

export function resolveRepoPolicyMode(declared: DeclaredRepoPolicies | null | undefined, id: RepoPolicyId): RepoPolicyMode {
	const def = BY_ID.get(id);
	const mode = declared?.[id] ?? def?.fallback ?? "off";
	// Belt and braces for a row written when a policy DID have an actuator that has since been
	// withdrawn: it degrades to observing rather than acting on a verb that no longer exists. The
	// sanitizer already refuses this at the door; this is the READER refusing it too.
	if (mode === "act" && !def?.actuator) return "observe";
	return mode;
}

/**
 * The board card id a policy owns for a repo.
 *
 * `repo.tree_clean` keeps the id #276 shipped (`repo-dirty-<repoId>`) rather than taking a
 * policy-shaped one. Renaming it would orphan every card open in production right now — they would
 * never close, because closing is keyed on the id — and an orphaned `needs_human` card is exactly
 * the pile the stable id was introduced to prevent.
 */
export function repoPolicyCardId(id: RepoPolicyId, repoId: string): string {
	return id === "repo.tree_clean" ? `repo-dirty-${repoId}` : `repo-branch-${repoId}`;
}

export type RepoPolicyStatus =
	/** Observed, and the invariant does not hold. */
	| "violated"
	/** Observed, and the invariant holds. */
	| "held"
	/** Not observed — the machine could not answer. Says nothing either way. */
	| "unknown"
	/** The repo does not claim this invariant. */
	| "unclaimed";

/** What the actuator should be asked to do. The ONLY thing that may reach the runner's write verb. */
export interface RepoPolicyRemediation {
	verb: RepoPolicyVerb;
	/** The branch to return to. Always explicit — never inferred, never created. */
	branch: string;
}

export interface RepoPolicyFinding {
	policy: RepoPolicyId;
	status: RepoPolicyStatus;
	cardId: string;
	/** The card to raise. Present only for `violated`. */
	card: { type: string; title: string; subtitle?: string; description: string } | null;
	/** The resolved mode this finding was judged under. `act` here is a human's per-repo decision. */
	mode: RepoPolicyMode;
	/**
	 * Present ONLY when: the repo declared `act`, the invariant is violated, and every precondition
	 * holds. Its absence on an `act` policy is never silent — `refusal` says why.
	 */
	remediation: RepoPolicyRemediation | null;
	/** Why an `act` policy is not acting on this violation. Carried onto the card. */
	refusal: string | null;
}

export interface RepoPolicyInput {
	repoId: string;
	/** The label the owner gave the repo — what the card names. */
	repoLabel: string;
	declared: DeclaredRepoPolicies | null | undefined;
	/** `null` = the checkout could not be read. Unknown, not clean. */
	state: RepoWorkingState | null;
	configuredBranch: string | null;
}

const MAX_TITLE = 200;
const MAX_DESCRIPTION = 300;

/**
 * Evaluate every policy in the registry against one observation. Pure.
 *
 * Returns a finding for EVERY policy, including the ones a repo does not claim, because the caller
 * needs to close a card left behind by a policy that has since been turned off. A feature you
 * stopped claiming should not keep a `needs_human` card open forever.
 */
export function evaluateRepoPolicies(input: RepoPolicyInput): RepoPolicyFinding[] {
	const { repoId, repoLabel, declared, state, configuredBranch } = input;
	// Whether the BRANCH fact has an OWNER decides where it is reported, below. `!== "off"` rather
	// than `=== "observe"`: acting on an invariant claims it at least as hard as watching it, and
	// reading this as unclaimed would print the branch clause on both cards.
	const branchClaimed = resolveRepoPolicyMode(declared, "repo.on_default_branch") !== "off";
	return REPO_POLICIES.map((def): RepoPolicyFinding => {
		const cardId = repoPolicyCardId(def.id, repoId);
		const mode = resolveRepoPolicyMode(declared, def.id);
		const base = { policy: def.id, cardId, card: null, mode, remediation: null, refusal: null } as const;
		if (mode === "off") return { ...base, status: "unclaimed" };
		if (!state) return { ...base, status: "unknown" };
		// A folder with no `.git` can neither satisfy nor violate a git invariant (#548). Both
		// clauses below return null for it — no branch to be off, no diff to protect — which would
		// score every policy `held`, i.e. a claim of COMPLIANCE about a repository that is not
		// there. That is precisely the false positive `unknown` exists to prevent, and it only
		// became reachable when this state stopped arriving as `null`.
		if (state.notAGitRepo) return { ...base, status: "unknown" };

		if (def.id === "repo.on_default_branch") {
			const clause = offTrunkClause(state, configuredBranch);
			if (!clause) return { ...base, status: "held" };
			const expected = (configuredBranch || "").trim() || "the trunk";
			// Decided from the observation in HAND, never from a stored verdict (#440): a repo can be
			// marked broken by a dropped WebSocket, and an actuator that trusted such a row would act
			// on a transport failure. `state` here is a fresh read or it is null, which is `unknown`
			// above and never reaches this line.
			const plan = mode === "act" ? branchRemediation(state, configuredBranch) : { remediation: null, refusal: null };
			return {
				...base,
				status: "violated",
				...plan,
				card: card(def, {
					title: `${repoLabel} is not on ${expected}`,
					subtitle: state.branch ? `on ${state.branch}` : undefined,
					sentence: `This checkout is ${clause}.${plan.refusal ? ` Not switched: ${plan.refusal}.` : ""}`,
				}),
			};
		}

		const clause = dirtyClause(state);
		if (!clause) return { ...base, status: "held" };
		// When nothing claims the branch invariant, the dirty card carries the branch fact too —
		// that is what shipped, and dropping it would lose information for the default
		// configuration. When the branch policy IS claimed it has its own card, so saying it twice
		// would be the report reading as two problems.
		const branchClause = branchClaimed ? null : offTrunkClause(state, configuredBranch);
		const sentence = `This checkout is ${[branchClause, clause].filter(Boolean).join("; ")}.`;
		return {
			...base,
			status: "violated",
			card: card(def, {
				title: `Uncommitted work in ${repoLabel}`,
				subtitle: state.branch ? `on ${state.branch}` : undefined,
				sentence,
			}),
		};
	});
}

/**
 * Will the branch policy act on THIS observation, and if not, why not? Pure.
 *
 * Two refusals, and both are the honest answer rather than a smaller action:
 *
 * - **No declared branch.** `offTrunkClause` calls a repo off-trunk when it is on neither `main` nor
 *   `master`, which is enough to REPORT but not enough to ACT: the cloud does not know which of the
 *   two this checkout has, and picking one would be inventing the target. So `act` needs the repo's
 *   branch field set. It is reported, so the fix is one edit away rather than a policy that silently
 *   never fires.
 * - **A dirty tree.** git carries uncommitted changes across a checkout, so switching here would
 *   move somebody's work onto the target branch. Refuse — never stash (repo-global, across
 *   worktrees), never commit (unreviewed by construction), never discard.
 *
 * The machine checks the same precondition again for itself (`repo-write.ts`). That is not
 * belt-and-braces for its own sake: the observation the cloud judges on is seconds old by the time
 * the write lands, and the tree can have changed in between.
 */
export function branchRemediation(
	state: RepoWorkingState,
	configuredBranch: string | null,
): { remediation: RepoPolicyRemediation | null; refusal: string | null } {
	const target = (configuredBranch || "").trim();
	if (!target) {
		return { remediation: null, refusal: "this repo declares no branch, so there is no unambiguous one to return to" };
	}
	if (state.dirty) {
		const n = state.changedFiles;
		return { remediation: null, refusal: `${n} uncommitted file${n === 1 ? "" : "s"} would be carried onto \`${target}\`` };
	}
	return { remediation: { verb: "switch_branch", branch: target }, refusal: null };
}

/**
 * Compose the card, with the attribution #322 names as its acceptance criterion: "why is there a
 * card about this?" must be answerable without reading a diff. `policy` on the payload is the
 * machine-readable half; the sentence carries the human-readable one, because the board renders
 * the description and not the payload.
 */
function card(def: RepoPolicyDef, parts: { title: string; subtitle?: string; sentence: string }) {
	const attribution = ` (standing policy \`${def.id}\`)`;
	const sentence = parts.sentence.slice(0, Math.max(0, MAX_DESCRIPTION - attribution.length));
	return {
		type: def.cardType,
		title: parts.title.slice(0, MAX_TITLE),
		subtitle: parts.subtitle,
		description: `${sentence}${attribution}`,
	};
}
