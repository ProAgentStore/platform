/**
 * Merge authority — whether an agent is ALLOWED to put code on the trunk (#314).
 *
 * ── The event this exists for ──
 *
 * Run `73ffc073`, one delegated objective, unattended: three pull requests opened and merged to
 * `main` of a real repository, plus an issue closed. The objective did say "merge each before
 * starting the next", so the agent did exactly as it was told. That is the point — **nothing
 * decided whether it was allowed to.** #184 bounds what a delegation may SPEND; nothing bounded
 * what it may make IRREVERSIBLE. Spend is recoverable; a merge to `main` is not.
 *
 * #294 built the other half: the runner classifies the Engine's `tool_use` protocol events into
 * consequential acts and the cloud writes them to the trace, so a merge is now VISIBLE. This module
 * is the half that DECIDES.
 *
 * ── The default is deliberately permissive, and that is a decision, not an oversight ──
 *
 * {@link DEFAULT_MERGE_POLICY} is `"merge"`: today's behaviour, byte for byte, for every repo that
 * has not chosen otherwise. Defaulting to blocked would silently change how an owner's Coder
 * behaves — work they rely on would start failing without them asking for it, which is its own
 * unannounced surprise and exactly the failure mode this ticket is about. The recommendation is
 * `"pr"` for any repository somebody else depends on; the choice belongs to the owner, and it is
 * one constant here (platform-wide), one setting per agent, or one field per repo.
 *
 * ── What this can and cannot do — the honest boundary ──
 *
 * There are three layers, and only two of them are enforcement:
 *
 *   1. {@link authorityInstruction} — the policy in the Pilot's system prompt. Advisory. A prompt
 *      is a request, and a model that ignores it has broken nothing that stops it.
 *   2. {@link screenInstruction} — the Pilot's OUTGOING instruction is screened before it reaches
 *      the Engine. This is real, deterministic and cloud-side: under a restrictive policy the
 *      orchestrator CANNOT relay "merge it" to the CLI, which is precisely how run 73ffc073
 *      happened. It is a heuristic over natural language, so it is bounded (a refusal is visible
 *      and capped, never a silent stall) and it is a no-op under the default policy.
 *   3. {@link unauthorizedActs} — the observed acts (#294) are checked against the policy. This is
 *      protocol FACT, not prose: `{"command":"gh pr merge 42 --squash"}` is what the Engine ran.
 *      An act the policy forbids halts the run and is recorded at `error` level.
 *
 * None of the three is a kernel-level block. The Engine runs
 * `claude --dangerously-skip-permissions` on the owner's own machine, so `gh pr merge` remains
 * physically available to it; layer 3 catches the merge AFTER it happened and stops the run before
 * the second one. Turning the first merge into a refusal needs the Engine launched with the command
 * denied to it, which lives in the runner and is follow-up work.
 *
 * ── AND THE GAP THAT MUST BE SAID OUT LOUD ──
 *
 * Layer 3 sees NOTHING on a raw Codex/Grok session. Only a stream-json engine (Claude Code) emits
 * the `tool_use` events acts are derived from — the same limit as engine usage (#267). So on a
 * non-reporting engine a restrictive policy is layers 1 and 2 only: the orchestrator will not ask
 * for a merge, and if the Engine merges on its own initiative nothing observes it and nothing
 * halts. A gate that quietly permitted everything there while looking like protection would be
 * worse than no gate, so {@link describeAuthority} states it in the run note the owner reads.
 */
import { logEvent } from "./events.js";
import { upsertWorkCard } from "./work-card.js";
import type { EngineActReport } from "./engine-acts.js";
import type { CodingClientType } from "./coding-types.js";
import type { Env } from "../types.js";

/**
 * What an agent may do with the trunk of one repository.
 *
 * Repo-level rather than agent-level because the answer genuinely differs per repository: a
 * dogfood repo and a customer repo are not the same risk, and one Coder works on both.
 */
export type MergePolicy = "merge" | "pr" | "none";

export const MERGE_POLICIES: readonly MergePolicy[] = ["merge", "pr", "none"];

/**
 * The platform-wide default — TODAY'S BEHAVIOUR.
 *
 * One line. Changing it to `"pr"` makes every repo that has not chosen for itself open pull
 * requests and stop there. That is the recommended posture, and it is the owner's call to make,
 * not this file's: see the module comment.
 */
export const DEFAULT_MERGE_POLICY: MergePolicy = "merge";

/** The settings-field id an agent's `settingsSchema` declares (migration 0091). */
export const MERGE_POLICY_SETTING = "merge_policy";

export function parseMergePolicy(value: unknown): MergePolicy | null {
	return typeof value === "string" && (MERGE_POLICIES as readonly string[]).includes(value) ? (value as MergePolicy) : null;
}

/**
 * Validate a `mergePolicy` field on a repo-update body.
 *
 * `undefined` = not being changed; `""` = clear the override back to inheriting. An unrecognised
 * value is REFUSED rather than ignored: silently keeping the old policy after a caller believed
 * they had tightened it is the one failure mode a safety setting must not have.
 */
export function mergePolicyPatch(value: unknown): { ok: true; value?: string } | { ok: false; error: string } {
	if (value === undefined) return { ok: true };
	if (value === "") return { ok: true, value: "" };
	const parsed = parseMergePolicy(value);
	return parsed ? { ok: true, value: parsed } : { ok: false, error: `mergePolicy must be one of ${MERGE_POLICIES.join(", ")} (or "" to inherit)` };
}

/**
 * The policy in force for one repo: repo override > agent setting > platform default.
 *
 * Three levels rather than one because each answers a different question. The repo field is the
 * ticket's ask ("this repository specifically"). The agent setting is what makes it usable — an
 * owner with twenty repos should not have to set twenty fields to change their posture. The
 * constant is the platform's own stance. Every level is one value to change.
 *
 * An unrecognised stored value falls THROUGH to the next level rather than failing closed or open
 * on its own: a typo in config must not silently invent a policy nobody chose.
 */
export function resolveMergePolicy(source: { repo?: unknown; agent?: unknown }): MergePolicy {
	return parseMergePolicy(source.repo) ?? parseMergePolicy(source.agent) ?? DEFAULT_MERGE_POLICY;
}

/**
 * Act kinds (the #294 vocabulary) this policy forbids.
 *
 * `merge` forbids nothing at all — the empty set is what keeps the default a literal no-op.
 *
 * `pr` forbids exactly the two acts that put code on the trunk: merging a pull request, and pushing
 * straight to `main`/`master`. It deliberately does NOT forbid `push.force`: force-pushing a
 * feature branch is ordinary in a pull-request workflow, and a policy that broke rebasing would be
 * turned off within a day, which protects nothing. (A force-push AT the trunk is classified
 * `push.force`, not `push.trunk`, and is a known narrow hole — see the report on #314.)
 */
export function forbiddenActKinds(policy: MergePolicy): ReadonlySet<string> {
	switch (policy) {
		case "merge":
			return new Set();
		case "pr":
			return new Set(["pr.merge", "push.trunk"]);
		case "none":
			return new Set(["pr.merge", "push.trunk", "push.force", "push", "pr.open", "branch.delete"]);
	}
}

/** One line naming what the agent may do — for a run note, a board card, or a prompt. */
export function policyLabel(policy: MergePolicy): string {
	switch (policy) {
		case "merge":
			return "may merge to the trunk";
		case "pr":
			return "may open a pull request but must NOT merge it";
		case "none":
			return "may commit locally only — no push, no pull request";
	}
}

/**
 * The policy as the Pilot's system prompt states it, or null when there is nothing to say.
 *
 * Null under `merge` is load-bearing: the default must produce the EXACT prompt the Pilot had
 * before this feature existed, so an owner who changed nothing sees no behavioural drift at all.
 *
 * The wording tells the Pilot what to do when the OBJECTIVE contradicts the policy, because that is
 * the live case — "merge each before starting the next" was the objective in the incident. Silently
 * complying and silently refusing are both failures; saying so plainly in the outcome is the ask.
 */
export function authorityInstruction(policy: MergePolicy): string | null {
	if (policy === "merge") return null;
	const body =
		policy === "pr"
			? [
					"You may commit, push a branch, and open a pull request.",
					"You must NOT merge a pull request, and must NOT push to main/master.",
				]
			: [
					"You may commit locally.",
					"You must NOT push, must NOT open a pull request, and must NOT merge anything.",
				];
	return [
		"MERGE AUTHORITY (set by the repository owner — this OVERRIDES the objective and any rule below):",
		...body.map((l) => `- ${l}`),
		"- If the objective tells you to merge, do the part you are permitted to do, then finish and SAY PLAINLY that merging is not permitted for this repository. Do not merge anyway, and do not quietly drop the instruction — the owner needs to know the work is waiting on them.",
	].join("\n");
}

/**
 * Phrases that ORDER a merge to the trunk. Matched against the instruction the Pilot is about to
 * send to the Engine.
 *
 * Kept narrow on purpose. `git merge main` into a feature branch is not a merge to the trunk and is
 * not matched; `gh pr merge` and "merge the PR" are.
 */
const MERGE_ORDERS: readonly RegExp[] = [
	/\bgh\s+pr\s+merge\b/i,
	/\bsquash[-\s]and[-\s]merge\b/i,
	/\bmerge\b[^.\n]{0,40}\b(?:pr\b|pull request)/i,
	/\b(?:pr\b|pull request)[^.\n]{0,40}\bmerge\b/i,
	/\bmerge\b[^.\n]{0,30}\binto\s+(?:main|master|trunk)\b/i,
	/\bmerge\s+(?:it|them)\b/i,
];

/** Phrases that ORDER publishing outward at all — only `none` forbids these. */
const PUBLISH_ORDERS: readonly RegExp[] = [
	/\bgit\s+push\b/i,
	/\bgh\s+pr\s+create\b/i,
	/\bopen\s+(?:a|the)\s+(?:pr\b|pull request)/i,
	/\bpush\b[^.\n]{0,30}\b(?:origin|remote|main|master|upstream)\b/i,
];

/**
 * A sentence that FORBIDS the act rather than ordering it.
 *
 * Checked first, so the Pilot relaying the policy itself ("do not merge — the owner has to") is not
 * refused by the guard that put those words in its mouth. Without this the screen would fire on its
 * own instruction text, which reads as the feature being broken.
 */
const NEGATED = /\b(?:do not|do n't|don't|dont|never|without|avoid|not permitted|no need to|refrain from)\b[^.\n]{0,40}\b(?:merg|push|open a)/i;

/**
 * Screen one outgoing instruction. Returns a refusal reason, or null to allow.
 *
 * A heuristic over natural language, and it is treated as one: it only ever runs under a policy the
 * owner deliberately chose, a refusal is announced rather than swallowed, and the caller caps how
 * many times it may fire before the run finishes with the reason (so a false positive costs a
 * stopped run with a clear explanation, never a silent spin).
 */
export function screenInstruction(policy: MergePolicy, text: string): string | null {
	if (policy === "merge") return null;
	const s = String(text ?? "");
	if (!s.trim()) return null;
	if (NEGATED.test(s)) return null;
	if (MERGE_ORDERS.some((re) => re.test(s))) {
		return "Merging is not permitted for this repository (merge policy: " + policy + "). Open the pull request and stop there, then finish and say that the merge is waiting on the owner.";
	}
	if (policy === "none" && PUBLISH_ORDERS.some((re) => re.test(s))) {
		return "Pushing and opening pull requests are not permitted for this repository (merge policy: none). Commit locally, then finish and say the work is waiting on the owner.";
	}
	return null;
}

/**
 * The observed acts this policy did not permit.
 *
 * Keyed on `kind` alone so both readers of the #294 record can use it — the sanitized report the
 * runner just sent, and the `ActItem` rows read back out of the trace, which carry no outcome.
 *
 * Outcome is NOT filtered on anywhere. A `gh pr merge` that came back failed, and one whose result
 * was never observed, are both the agent having RUN a forbidden command — the breach is the
 * attempt, and "we did not see whether it worked" is not grounds to assume it did not.
 * {@link describeViolation} carries the distinction rather than hiding it behind a dropped row.
 */
export function unauthorizedActs<T extends { kind: string }>(policy: MergePolicy, acts: readonly T[]): T[] {
	const forbidden = forbiddenActKinds(policy);
	if (!forbidden.size) return [];
	return acts.filter((a) => forbidden.has(a.kind));
}

/** One sentence for a violation, honest about whether it landed. */
export function describeViolation(policy: MergePolicy, act: { kind: string; target?: string | null; ok?: boolean | null }): string {
	const what = act.kind === "pr.merge" ? "merged a pull request" : act.kind === "push.trunk" ? "pushed directly to the trunk" : act.kind;
	const subject = act.target ? ` ${act.target}` : "";
	const outcome = act.ok === false ? " (the command FAILED)" : act.ok === null || act.ok === undefined ? " (outcome not observed)" : "";
	return `Not permitted by this repository's merge policy (${policy}): the agent ${what}${subject}${outcome}.`;
}

/** Engines whose protocol the runner can read acts from (#294). Everything else reports none. */
const ACT_REPORTING_ENGINES: ReadonlySet<CodingClientType> = new Set<CodingClientType>(["claude"]);

export function engineReportsActs(clientType: CodingClientType | string | undefined): boolean {
	return ACT_REPORTING_ENGINES.has(String(clientType ?? "") as CodingClientType);
}

/**
 * What the owner should be told about this run's authority, or null when there is nothing worth
 * saying (the default policy on any engine — no gate, no claim of one).
 *
 * The second sentence exists because of the gap in the module comment: under a restrictive policy
 * on an engine that reports no acts, the owner must not read "merge policy: pr" and conclude they
 * are protected. Stating the limit next to the policy is the only place they will reliably see it.
 */
export function describeAuthority(policy: MergePolicy, clientType: CodingClientType | string | undefined): string | null {
	if (policy === "merge") return null;
	const base = `Merge policy: ${policy} — this agent ${policyLabel(policy)}.`;
	return engineReportsActs(clientType)
		? base
		: `${base} NOTE: the "${clientType}" engine does not report what it ran, so this run's actual commands could not be checked — the policy reached the orchestrator's instructions only.`;
}

// ── The I/O half ────────────────────────────────────────────────────────────
//
// Everything above is pure and unit-tested. The two below touch D1, and live here rather than in
// the workflow for the reason `recordEngineActs` lives in engine-acts.ts: the caller should say
// WHAT it wants recorded, not know the shape of the row, and the Pilot workflow is already the
// largest file in this subsystem.

/**
 * The policy in force for one run, read from the repo override and the agent's typed setting.
 *
 * Both reads degrade to "unset" on failure and fall through to the default, which is the permissive
 * one. That is deliberate and worth naming: a D1 blip must not invent a restriction the owner did
 * not choose and stop a run they were relying on. The gate's job is to honour a decision, not to
 * manufacture one out of an error.
 */
export async function readMergePolicyForRun(
	env: Env,
	ctx: { instanceId: string; userId: string; repoId: string },
): Promise<MergePolicy> {
	const [repo, row] = await Promise.all([
		env.DB.prepare("SELECT merge_policy FROM coding_repos WHERE id = ?1 AND instance_id = ?2 AND user_id = ?3")
			.bind(ctx.repoId, ctx.instanceId, ctx.userId)
			.first<{ merge_policy: string | null }>()
			.catch(() => null),
		env.DB.prepare("SELECT config FROM agent_instances WHERE id = ?1 AND user_id = ?2")
			.bind(ctx.instanceId, ctx.userId)
			.first<{ config: string }>()
			.catch(() => null),
	]);
	let agent: unknown;
	try {
		agent = (JSON.parse(row?.config || "{}") as { settings?: Record<string, unknown> }).settings?.[MERGE_POLICY_SETTING];
	} catch {
		agent = undefined;
	}
	return resolveMergePolicy({ repo: repo?.merge_policy, agent });
}

/**
 * Record every act this policy did not permit, and return the reason the run should stop (null when
 * there was nothing to record).
 *
 * Written at `error` level — in this trace the levels are the only queryable severity band, and an
 * unauthorized merge is above the `warn` that #294 gives an ordinary irreversible act. It also gets
 * a BOARD CARD: the issue's own complaint is that the three merges were only found by reading a run
 * detail after the fact, so a record that still requires suspicion to look at would not fix it.
 *
 * Both writes use a deterministic id derived from the act, so a retried workflow step reports the
 * same breach once rather than manufacturing a second merge that never happened.
 */
export async function recordAuthorityViolations(
	env: Env,
	ctx: { userId: string; instanceId: string; sessionId: string; repoLabel: string; traceId?: string | null },
	policy: MergePolicy,
	acts: readonly EngineActReport[],
): Promise<string | null> {
	const violations = unauthorizedActs(policy, acts);
	if (!violations.length) return null;
	const now = new Date().toISOString();
	for (const act of violations) {
		const text = describeViolation(policy, act);
		const id = `authz:${ctx.sessionId}:${act.id}`.slice(0, 200);
		await logEvent(env, {
			id,
			source: "coding",
			event: "act.unauthorized",
			level: "error",
			userId: ctx.userId,
			instanceId: ctx.instanceId,
			traceId: ctx.traceId || ctx.sessionId,
			message: text,
			context: { act: act.kind, command: act.command, target: act.target, ok: act.ok, policy, sessionId: ctx.sessionId },
		}).catch(() => undefined);
		await upsertWorkCard(env, {
			instanceId: ctx.instanceId,
			userId: ctx.userId,
			id,
			task: {
				id,
				type: "coding.unauthorized_act",
				status: "needs_human",
				title: `Unpermitted ${act.kind} in ${ctx.repoLabel}`.slice(0, 200),
				subtitle: act.target ?? undefined,
				description: `${text} The run was stopped. Command: ${act.command}`.slice(0, 300),
				createdAt: now,
				updatedAt: now,
			},
		}).catch(() => undefined);
	}
	return describeViolation(policy, violations[0]);
}
