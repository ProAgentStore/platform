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
 * ── What this slice deliberately does NOT do, and why
 *
 * **It does not act.** `RepoPolicyMode` has no `"act"` member: it is ABSENT, not gated, so no
 * setting, prompt or objective can reach one. The two assessments on #322 both landed there for
 * the same reason — the only actuators that exist are a general coding Engine running
 * `claude --dangerously-skip-permissions` on the owner's own machine, and delegating "commit the
 * working tree" to one closes the vocabulary at the NAME of the policy and leaves it wide open at
 * the hands. An acting slice needs a fixed-argv write surface on the runner, which is a CLI
 * release, and it has to earn the promotion with a period of accurate observation first.
 *
 * **It does not schedule.** Evaluation happens at the end of a coding run, which is the moment the
 * state actually changed and the only moment a live runner is guaranteed. No second scheduler, no
 * second claim, no second retry ladder — and specifically no reuse of the delivery outbox, whose
 * `[60, 300, 900, 3600, 10800]s` ladder would replay a 09:00 observation at 12:00 against a repo
 * that has since changed. A policy that misses a tick re-observes next tick and never replays.
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
 * `observe` reports; there is no `act`. See the header — its absence is the safety property, so
 * this union must not grow one without the runner write surface that would make it honest.
 */
export type RepoPolicyMode = "off" | "observe";

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
}

export const REPO_POLICIES: readonly RepoPolicyDef[] = [
	{
		id: "repo.tree_clean",
		label: "clean working tree",
		invariant: "this checkout carries no uncommitted work between runs",
		fallback: "observe",
		cardType: "coding.uncommitted",
	},
	{
		id: "repo.on_default_branch",
		label: "on its default branch",
		invariant: "this checkout is left on its configured branch, or the trunk when it has none",
		fallback: "off",
		cardType: "coding.off_branch",
	},
];

const BY_ID = new Map<string, RepoPolicyDef>(REPO_POLICIES.map((p) => [p.id, p]));

export function repoPolicyDef(id: string): RepoPolicyDef | null {
	return BY_ID.get(id) ?? null;
}

/** What a repo has declared. A policy absent from the record falls back to its table default. */
export type DeclaredRepoPolicies = Partial<Record<RepoPolicyId, RepoPolicyMode>>;

const MODES: readonly RepoPolicyMode[] = ["off", "observe"];

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
		if (typeof v !== "string" || !MODES.includes(v as RepoPolicyMode)) {
			return { ok: false, error: `policy \`${k}\` must be one of: ${MODES.join(", ")}` };
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
	const explicit = declared?.[id];
	return explicit ?? (BY_ID.get(id)?.fallback ?? "off");
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

export interface RepoPolicyFinding {
	policy: RepoPolicyId;
	status: RepoPolicyStatus;
	cardId: string;
	/** The card to raise. Present only for `violated`. */
	card: { type: string; title: string; subtitle?: string; description: string } | null;
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
	// Whether the BRANCH fact has an owner decides where it is reported, below.
	const branchClaimed = resolveRepoPolicyMode(declared, "repo.on_default_branch") === "observe";
	return REPO_POLICIES.map((def) => {
		const cardId = repoPolicyCardId(def.id, repoId);
		const base = { policy: def.id, cardId, card: null } as const;
		if (resolveRepoPolicyMode(declared, def.id) === "off") return { ...base, status: "unclaimed" };
		if (!state) return { ...base, status: "unknown" };

		if (def.id === "repo.on_default_branch") {
			const clause = offTrunkClause(state, configuredBranch);
			if (!clause) return { ...base, status: "held" };
			const expected = (configuredBranch || "").trim() || "the trunk";
			return {
				policy: def.id,
				status: "violated",
				cardId,
				card: card(def, {
					title: `${repoLabel} is not on ${expected}`,
					subtitle: state.branch ? `on ${state.branch}` : undefined,
					sentence: `This checkout is ${clause}.`,
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
			policy: def.id,
			status: "violated",
			cardId,
			card: card(def, {
				title: `Uncommitted work in ${repoLabel}`,
				subtitle: state.branch ? `on ${state.branch}` : undefined,
				sentence,
			}),
		};
	});
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
