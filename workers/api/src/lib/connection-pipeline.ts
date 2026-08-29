/**
 * Does the pipeline a connection names actually exist on the target? (#363)
 * Can the source instance statically emit the wired eventType? (#632)
 *
 * PURE — no D1, no Env. The inventory / raw pipelines config is fetched by the caller; the
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

/**
 * Does any pipeline in the source instance's definition map have a `dedupe_upsert` step with
 * a statically-known `emit` value matching `eventType`? (#632)
 *
 * `emit` is an INPUT on `dedupe_upsert` — a `PipelineInputValue` that may be a literal string,
 * a `$ref`, or a `$param`. Only a literal string can be checked statically; a `$ref`/`$param`
 * emit is resolved at run time, so we stay silent and avoid a false "this will never work" on a
 * chain that works fine.
 *
 * Returns:
 *   `null`  — cannot determine statically:
 *             (a) the source's pipelines could not be read (`raw` is `null`/`undefined`/non-map);
 *             (b) a `dedupe_upsert` step has a `$ref`/`$param` emit — could emit at run time.
 *             Both stay silent: a false "this will never work" on a working chain is worse.
 *   `true`  — at least one pipeline has a `dedupe_upsert` step whose LITERAL `emit` matches.
 *   `false` — the config is legible AND every `dedupe_upsert` emit is a literal for a DIFFERENT
 *             event, OR there are no `dedupe_upsert` steps at all (e.g. a sink-only pipeline).
 *             Triggered by: `raw === {}` (no pipelines), or all literal emits mismatch.
 *
 * @param raw     The raw `config.pipelines` value from the source instance's stored config.
 *                Pass `null` or `undefined` to signal a failed read (returns `null`).
 *                Pass `{}` (empty object) to signal "has no pipelines" (returns `false`).
 * @param eventType The `event_type` the connection is keyed on.
 */
export function sourceCanEmitEventType(raw: unknown, eventType: string): boolean | null {
	if (!eventType.trim()) return null; // no eventType to check against
	// null and undefined both mean "we could not determine the source's pipeline config" — stay
	// silent rather than warn wrongly. An empty object `{}` means "no pipelines" and IS legible.
	if (raw === null || raw === undefined) return null;
	if (typeof raw !== "object" || Array.isArray(raw)) return null; // non-map value — unreadable
	const pipelines = raw as Record<string, unknown>;
	// Walk every pipeline definition.
	for (const def of Object.values(pipelines)) {
		if (!def || typeof def !== "object" || Array.isArray(def)) continue;
		const p = def as Record<string, unknown>;
		if (!Array.isArray(p.steps)) continue;
		for (const step of p.steps) {
			if (!step || typeof step !== "object" || Array.isArray(step)) continue;
			const s = step as Record<string, unknown>;
			if (s.tool !== "dedupe_upsert") continue;
			const inputs = s.inputs;
			if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)) continue;
			const emit = (inputs as Record<string, unknown>).emit;
			if (typeof emit === "string") {
				// Literal string emit — statically legible.
				if (emit.trim() === eventType.trim()) return true; // emits this event: healthy
				// A literal for a DIFFERENT event type: continue looking.
			} else if (emit !== null && emit !== undefined) {
				// A `$ref` / `$param` / other non-literal — not statically resolvable. We cannot
				// prove the step won't emit this event at run time, so stay silent rather than
				// produce a false "this will never work" on a chain that works fine.
				return null;
			}
		}
	}
	// We read successfully but found no step that statically emits the eventType, and no step
	// with an unresolvable emit. The source is provably not capable with its current definitions.
	return false;
}

/**
 * The advisory sentence when a source instance has no pipeline that can statically emit
 * the wired `eventType`, or null when there is nothing to say (#632).
 *
 * This is the mirror of `connectionPipelineWarning` for the other end of the edge.
 *
 * Null in three cases, deliberately:
 *   • `sourceCanEmitEventType` returns null — a failed read, so we know nothing;
 *   • it returns true — the source CAN emit, so the edge is healthy;
 *   • no eventType was given — already caught by createConnection.
 */
export function connectionSourceEmitWarning(
	eventType: string,
	sourceLabel: string,
	rawPipelines: unknown,
): string | null {
	const canEmit = sourceCanEmitEventType(rawPipelines, eventType);
	if (canEmit === null || canEmit === true) return null;
	const source = sourceLabel.trim() || "the source agent";
	return (
		`Source agent ${source} has no pipeline with a \`dedupe_upsert\` step that statically emits "${eventType}", ` +
		`so this connection will never receive an event. ` +
		`Add a \`dedupe_upsert\` step with \`"emit": "${eventType}"\` to a pipeline on that agent, or check that the event type matches exactly.`
	);
}
