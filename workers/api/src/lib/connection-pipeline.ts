/**
 * Does the pipeline a connection names actually exist on the target? (#363)
 *
 * PURE — no D1, no Env. The inventory is fetched by the caller (`pipelineNamesFor`); the
 * judgement lives here so it is testable without a database stub, matching
 * `trigger-capability.ts` (#358) and `supervision-capability.ts` (#354).
 *
 * Why it exists: `unattendedWarningsFor` loads the named pipeline off the target instance to warn
 * about the connector wiring it will need, and opened with `if (!def) return []`. So the one case
 * that most deserves a warning — a typo, a renamed pipeline, a pipeline that lives on a DIFFERENT
 * agent — was the only one that produced none. The connection was created clean and sat in the
 * Teamwork list looking healthy while every event it carried dead-lettered hours later.
 *
 * It is a WARNING, not a refusal, unlike #354 and #358. Those refuse because the missing
 * capability is a property of the agent and cannot change by itself; a pipeline can legitimately
 * be added to the target five minutes after the edge is wired, so a 400 here would block a
 * reasonable order of work. What is not reasonable is finding out from a dead letter at 3am.
 */
import type { PipelineInventory } from "./pipeline.js";

/** How many of the target's pipeline names to list before trailing off. */
const MAX_LISTED = 8;

function quoteList(names: readonly string[]): string {
	const shown = names.slice(0, MAX_LISTED).map((n) => `"${n}"`);
	const rest = names.length - shown.length;
	return rest > 0 ? `${shown.join(", ")} (+${rest} more)` : shown.join(", ");
}

/**
 * The advisory sentence for a `run_pipeline` connection, or null when there is nothing to say.
 *
 * Null in three cases, deliberately:
 *   • the inventory is null — a failed read, so we know nothing (the #354 asymmetry);
 *   • the name is in `valid` — the pipeline is there and would run;
 *   • no name was given — `executeTriggerAction` lets the event PAYLOAD supply `pipeline`, so an
 *     edge with no `config.pipeline` is under-specified rather than provably broken.
 *
 * The two things it does say are different problems with different fixes, so they are different
 * sentences: a name that is absent is usually a typo or an edge pointed at the wrong agent, while
 * a name that is present but does not validate is a broken definition on the target.
 */
export function connectionPipelineWarning(
	pipeline: string | null | undefined,
	targetLabel: string,
	inventory: PipelineInventory | null | undefined,
): string | null {
	const name = (pipeline ?? "").trim();
	if (!name || !inventory) return null;
	if (inventory.valid.includes(name)) return null;
	const target = targetLabel.trim() || "the target agent";
	if (inventory.invalid.includes(name)) {
		return `Target agent ${target} has a pipeline named "${name}", but its definition is not valid, so nothing will run it. Fix the definition on that agent — this connection will dead-letter every event until then.`;
	}
	const has = inventory.valid.length
		? `That agent's pipelines are ${quoteList(inventory.valid)}.`
		: "That agent has no pipelines at all.";
	return `Target agent ${target} has no pipeline named "${name}", so this connection will dead-letter every event it carries. ${has} Add the pipeline there, or correct the name.`;
}
