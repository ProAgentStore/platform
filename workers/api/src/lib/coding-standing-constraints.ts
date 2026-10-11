/**
 * The owner's standing rules and latest words, reloaded before EVERY Pilot decision (#1015).
 *
 * Two defects shared one cause — the Pilot's view of what the owner wants was fixed at start:
 *
 *   - Entry-point parity. `POST …/sessions/:sid/run` read the instance's Special Instructions and the
 *     repo's rules into the goal; `POST /loop`, queue drains, delegation and continue (all through
 *     `loopDriverFor(...).start`) built the goal from the objective alone, so autonomous runs never
 *     saw the standing rules at all.
 *   - Latest constraints. A message the owner sent mid-run reached the Pilot as one round's
 *     `userHint` and was then cleared, so a later decision re-issued the original objective over an
 *     engine that had already acknowledged a narrower, newer restriction.
 *
 * So the WORKFLOW reads both, for every entry point, and refreshes them per decision: a rules edit
 * and an owner directive bind the very next decision and every one after it.
 */
import type { Env } from "../types.js";
import type { CodingGoal } from "./coding-loop.js";
import { listDirectives } from "./coding-ownership.js";
import { readSpecialInstructions } from "../routes/coding-shared.js";

/** Instance Special Instructions + the repo's own rules, joined as every other surface joins them. */
export async function readStandingInstructions(env: Env, input: { instanceId: string; userId: string; repoId: string }): Promise<string | undefined> {
	const instance = await readSpecialInstructions(env, input.instanceId, input.userId);
	const repo = await env.DB.prepare("SELECT instructions FROM coding_repos WHERE id = ?1 AND instance_id = ?2 AND user_id = ?3")
		.bind(input.repoId, input.instanceId, input.userId)
		.first<{ instructions: string | null }>();
	return [instance, repo?.instructions].filter(Boolean).join("\n\n") || undefined;
}

/**
 * Refresh `goal.standingInstructions` and `goal.ownerDirectives` in place. A failed read keeps what
 * the goal already holds — losing a rule because one D1 read failed would be the defect itself.
 */
export async function refreshGoalConstraints(
	env: Env,
	goal: CodingGoal,
	ctx: { instanceId: string; userId: string; repoId: string; sessionId: string; runStartedAt: number },
): Promise<void> {
	const standing = await readStandingInstructions(env, ctx).catch(() => null);
	if (standing !== null) goal.standingInstructions = standing;
	const directives = await listDirectives(env, { instanceId: ctx.instanceId, userId: ctx.userId, sessionId: ctx.sessionId, sinceMs: ctx.runStartedAt }).catch(() => null);
	if (directives) goal.ownerDirectives = directives.map((d) => ({ text: d.content, at: d.createdAt, delivery: d.delivery, processed: d.processedAt != null }));
}
