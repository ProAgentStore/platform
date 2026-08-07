// What a subordinate is CONFIGURED to do — the standing layer, separate from any one run (#339).
//
// ── The event this exists for ──
//
// Owner, to the Coder Lead: "What are the instructions to it? Can you check them? Is it supposed
// to work through PRs or direct commits to main?" The Lead called `check_delegation`, read the
// RUN'S OBJECTIVE, and answered:
//
//     "The objective is: read each open issue, implement a fix, commit, push, open a PR, and
//      merge it — so it's working through PRs, not direct commits to main. That's the correct flow."
//
// The actual configuration said `merge_policy: "merge"` — "May merge to main". The Lead had never
// looked, because nothing it could call knew the field existed. So it answered from the one signal
// it held, and the answer was confidently wrong in the most damaging direction: it described a
// review gate ("through PRs, not direct commits") to a person asking whether one existed, while
// the same run went on to merge its own pull requests unattended.
//
// ── Two things this module insists on ──
//
// 1. An OBJECTIVE IS NOT A CONFIGURATION. The objective is text supplied for one run. It cannot
//    grant authority the configuration withholds, and repeating it back is not an answer to "what
//    is it allowed to do". {@link objectiveConflict} is the case that proves the two are different
//    things: an objective saying "merge it" under a `pr` policy is a CONTRADICTION to report, not
//    a plan to describe.
//
// 2. "INSTRUCTIONS" MEANS FOUR DIFFERENT THINGS and a supervisor must say which one it read.
//    Special Instructions (the owner's standing rules), Agent Behaviour (how it communicates),
//    typed settings (what it is configured with, including merge authority), and memory (what it
//    KNOWS — deliberately not here; that is subject matter, not permission). Answering from one
//    while the user meant another is the same failure in a smaller form.
//
// PURE — no D1, no Env. The reads live in `connectors/supervision.ts`, matching
// `subordinate-connectivity.ts` and `subordinate-observation.ts`.
//
// ── And the rule inherited from #259/#320 ──
//
// "Not available to me" beats a confident empty. A config blob that would not parse is UNKNOWN,
// not "no rules set" — a supervisor that reports the second has told the human the agent is
// unconstrained on the strength of a JSON error.
import {
	DEFAULT_MERGE_POLICY,
	MERGE_POLICY_SETTING,
	parseMergePolicy,
	policyLabel,
	resolveMergePolicy,
	screenInstruction,
	type MergePolicy,
} from "./coding-authority.js";
import { describeBehaviour, resolveBehaviour, type BehaviourValue } from "./agent-behaviour.js";
import { resolveSettingsValues, type SettingsValue } from "./instance-settings.js";
import type { SettingsField } from "./agent-capabilities.js";

/** Which layer an effective value came from. Naming it is the entire point of the module. */
export type ConfigSource = "repo" | "agent" | "default";

export interface RepoAuthority {
	/** The repo's `owner/name` when it has one, else the owner's display label. */
	repo: string;
	policy: MergePolicy;
	source: ConfigSource;
}

export interface MergeAuthority {
	/** False for an agent with no repository — there is no trunk for a policy to be about. */
	applies: boolean;
	/** The single answer to "may it merge?", or null when its repos disagree — then read `perRepo`. */
	policy: MergePolicy | null;
	source?: ConfigSource;
	/** Plain words for what `policy` permits, so the supervisor does not have to interpret an enum. */
	permits?: string;
	perRepo?: RepoAuthority[];
	note?: string;
}

export interface StandingRules {
	/** Tri-state on purpose: `false` is "the owner set none", not "we could not look". */
	set: boolean;
	text?: string;
	truncated?: boolean;
}

export interface SubordinateConfig {
	/** False when the stored config could not be read. Nothing below may then be believed. */
	available: boolean;
	note?: string;
	mergeAuthority: MergeAuthority;
	/** Console: Knowledge → "Rules & Tips". `agent_instances.config.specialInstructions`. */
	specialInstructions: StandingRules;
	/** Console: the "Behaviour" tab. How it COMMUNICATES — never what it may do. */
	behaviour: { set: boolean; fields: Array<{ id: string; label: string; value: BehaviourValue; description: string }> };
	/** Console: Settings → "Agent settings". The typed fields the creator declared. */
	settings: { set: boolean; values: Array<{ id: string; label: string; value: SettingsValue; set: boolean }> };
}

/** Standing rules longer than this are cut — a supervisor's prompt is not a document store. */
export const MAX_RULES_CHARS = 1200;

export interface SubordinateConfigInput {
	/** Raw `agent_instances.config`. `null`/`undefined` = there is none (a fresh instance). */
	config: string | null | undefined;
	/** Raw `agents.config` for the template — the creator's defaults. */
	agentConfig: string | null | undefined;
	/** The agent's declared typed settings, from `agentCapabilities(...).settingsSchema`. */
	settingsSchema?: SettingsField[];
	/**
	 * The subordinate's repos, or NULL when they were not read.
	 * `[]` means "it has none"; `null` means "we do not know" — and those get different answers.
	 */
	repos: Array<{ name?: string | null; githubRepo?: string | null; mergePolicy?: unknown }> | null;
}

const unavailable = (note: string): SubordinateConfig => ({
	available: false,
	note,
	mergeAuthority: { applies: false, policy: null, note },
	specialInstructions: { set: false },
	behaviour: { set: false, fields: [] },
	settings: { set: false, values: [] },
});

function parse(raw: string | null | undefined): Record<string, unknown> | null {
	if (raw === null || raw === undefined || raw === "") return {};
	try {
		const v = JSON.parse(raw) as unknown;
		return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

/**
 * The merge-authority picture for one subordinate.
 *
 * Three layers resolve per REPO (`resolveMergePolicy`), so an agent working on two repositories can
 * genuinely have two answers. When they differ the top-level `policy` is null rather than one of
 * them: picking either would be the same confident-wrong-answer this file exists to stop.
 */
function mergeAuthorityFor(input: SubordinateConfigInput, agentSetting: unknown): MergeAuthority {
	const declared = parseMergePolicy(agentSetting);
	const agentLevel: { policy: MergePolicy; source: ConfigSource } = declared
		? { policy: declared, source: "agent" }
		: { policy: DEFAULT_MERGE_POLICY, source: "default" };

	if (input.repos === null) {
		return {
			applies: true,
			policy: agentLevel.policy,
			source: agentLevel.source,
			permits: policyLabel(agentLevel.policy),
			note: "This is the agent-wide setting. Its repositories were not read, so a repo that overrides it would not show here.",
		};
	}
	if (!input.repos.length) {
		return {
			applies: false,
			policy: null,
			note: "This agent has no repository attached, so merge authority does not apply to it.",
		};
	}
	const perRepo: RepoAuthority[] = input.repos.map((r) => {
		const override = parseMergePolicy(r.mergePolicy);
		return {
			repo: (r.githubRepo || r.name || "(unnamed repo)").trim(),
			policy: resolveMergePolicy({ repo: r.mergePolicy, agent: agentSetting }),
			source: override ? "repo" : agentLevel.source,
		};
	});
	const distinct = [...new Set(perRepo.map((r) => r.policy))];
	if (distinct.length > 1) {
		return {
			applies: true,
			policy: null,
			perRepo,
			note: "This agent's repositories do not share one policy — answer per repository, never with a single yes or no.",
		};
	}
	return {
		applies: true,
		policy: distinct[0],
		source: perRepo.every((r) => r.source === "repo") ? "repo" : agentLevel.source,
		permits: policyLabel(distinct[0]),
		perRepo,
	};
}

/**
 * Resolve every STANDING layer of a subordinate's configuration.
 *
 * Deliberately not a single flat "instructions" string. The four layers have four different
 * owners, four different edit surfaces and four different meanings, and flattening them is how a
 * question about permission gets answered with a note about tone.
 */
export function resolveSubordinateConfig(input: SubordinateConfigInput): SubordinateConfig {
	const cfg = parse(input.config);
	const agentCfg = parse(input.agentConfig);
	if (!cfg || !agentCfg) {
		return unavailable(
			"This agent's stored configuration could not be read, so its rules and permissions are NOT AVAILABLE here. Say that rather than reporting it as unconfigured.",
		);
	}

	const rawRules = cfg.specialInstructions;
	const rulesText = typeof rawRules === "string" ? rawRules.trim() : "";
	const specialInstructions: StandingRules = rulesText
		? {
				set: true,
				text: rulesText.slice(0, MAX_RULES_CHARS),
				...(rulesText.length > MAX_RULES_CHARS ? { truncated: true } : {}),
			}
		: { set: false };

	const behaviourFields = describeBehaviour(resolveBehaviour(agentCfg.behaviour, cfg.behaviour));

	const schema = input.settingsSchema ?? [];
	const storedSettings = cfg.settings && typeof cfg.settings === "object" ? (cfg.settings as Record<string, unknown>) : {};
	const resolvedSettings = resolveSettingsValues(schema, storedSettings);
	const values = schema
		.filter((f) => f.id in resolvedSettings)
		.map((f) => ({ id: f.id, label: f.label || f.id, value: resolvedSettings[f.id], set: f.id in storedSettings }));

	return {
		available: true,
		mergeAuthority: mergeAuthorityFor(input, storedSettings[MERGE_POLICY_SETTING]),
		specialInstructions,
		behaviour: { set: behaviourFields.length > 0, fields: behaviourFields },
		settings: { set: values.some((v) => v.set), values },
	};
}

/**
 * Does this run's OBJECTIVE ask for something the standing policy forbids?
 *
 * The exact case from the ticket: the objective said "open a PR and merge it", the policy would
 * have been the thing to stop it, and the Lead reported the objective as though it were the rule.
 * Returns a sentence the supervisor should say INSTEAD of describing the objective as the plan.
 *
 * Reuses `screenInstruction` — the same matcher that screens what the Pilot sends to the Engine —
 * so "what the objective orders" means one thing across the system rather than two heuristics that
 * drift apart.
 */
export function objectiveConflict(policy: MergePolicy | null, objective: string): string | null {
	if (!policy || policy === "merge") return null;
	if (!screenInstruction(policy, objective)) return null;
	return (
		`The OBJECTIVE asks for something this agent's merge policy (${policy}) does not permit — it ${policyLabel(policy)}. ` +
		"Report that the objective EXCEEDS the policy. Do not repeat the objective as a description of what will happen, and do not read it as authority: an objective cannot grant permission the configuration withholds."
	);
}

/**
 * Stated in the PAYLOAD, not only in a tool description (the #259/#320 precedent — the description
 * is a long way away by the time the model is reading this JSON).
 *
 * It names all four meanings of "instructions" because the ticket's failure is a category error,
 * not a missing field: the Lead had an answer, it was simply an answer to a different question.
 */
export const CONFIG_LEGEND =
	"`config` is the agent's STANDING configuration — what it is allowed to do and how it is told to behave, independent of any run. A run's `objective` is a one-off ask and is NOT configuration: it cannot grant authority the configuration withholds, so never quote an objective as the answer to \"what are its instructions\" or \"what is it allowed to do\". " +
	"\"Instructions\" means four DIFFERENT things here and you must say which one you read: " +
	"`config.mergeAuthority` — may it put code on a repository's trunk (`merge` = it may merge to main itself, `pr` = it may open a pull request but must NOT merge, `none` = commit only). This is the field that answers \"does it work through PRs or commit to main\"; the objective is not. " +
	"`config.specialInstructions` — the owner's standing free-text rules (console: Knowledge → Rules & Tips). " +
	"`config.behaviour` — how it COMMUNICATES (tone, technicality, formatting). Never what it may do. " +
	"`config.settings` — the typed settings the creator declared and the owner set. " +
	"Memory is NOT in this view: it holds subject-matter knowledge, never permission — do not cite it when asked what an agent is allowed to do. " +
	"`config.available: false` means the configuration COULD NOT BE READ. Say it is not available to you; do not report it as unconfigured or unrestricted.";
