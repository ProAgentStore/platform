/**
 * Reading a NUMBER out of a step input, honestly (issue #243).
 *
 * `Number(x) || 0` — the idiom the step library reached for — folds three different situations
 * into one value: "you didn't pass this", "you passed zero", and "what you passed isn't a
 * number". For most inputs that is harmless because `0` is a safe default. For `slice.limit`
 * it is the single most destructive outcome available: an unparseable limit kept ZERO records
 * while an ABSENT one kept them all, so a blank `$param` emptied the list mid-chain and every
 * downstream step still succeeded. The run completed, reporting nothing found.
 *
 * Step inputs are not gated by the declared `jsonSchema` (it's a hint for the model, not a
 * validator), so a blank string genuinely reaches a handler whenever a trigger/connection
 * config leaves a field empty. The fix is to stop guessing: tell absent from unreadable, and
 * let the handler fail loudly on unreadable rather than quietly pick the worst branch.
 *
 * Pure and exported so the decision is unit-testable without running a pipeline.
 */

/** What a step input said about a number: nothing, a usable value, or something unreadable. */
export type StepNumber =
	/** Not supplied — the handler's documented default applies. */
	| { kind: "absent" }
	/** A finite number (possibly 0, which is a real request). */
	| { kind: "value"; value: number }
	/** Supplied but unreadable — never silently treated as a default. */
	| { kind: "invalid"; reason: string };

/**
 * Read a numeric step input.
 *
 * Deliberately stricter than `Number(...)`, which happily maps `""`, `null`, `false` and `[]`
 * to `0`. Only `undefined`/`null` count as absent; everything else must be a finite number or
 * a string that parses to one.
 */
export function parseStepNumber(raw: unknown): StepNumber {
	if (raw === undefined || raw === null) return { kind: "absent" };
	if (typeof raw === "number") {
		return Number.isFinite(raw) ? { kind: "value", value: raw } : { kind: "invalid", reason: `${raw} is not a finite number` };
	}
	if (typeof raw === "string") {
		const t = raw.trim();
		// A blank string is the reachable case: a settings field or `config.params` entry left
		// empty. It is NOT "unset" — the caller did pass something — so it must not silently
		// take the absent-value default either; it is an authoring mistake worth reporting.
		if (!t) return { kind: "invalid", reason: "is blank" };
		const n = Number(t);
		return Number.isFinite(n) ? { kind: "value", value: n } : { kind: "invalid", reason: `"${t.slice(0, 40)}" is not a number` };
	}
	if (typeof raw === "boolean") return { kind: "invalid", reason: `${raw} is not a number` };
	return { kind: "invalid", reason: `a ${Array.isArray(raw) ? "list" : typeof raw} is not a number` };
}

/**
 * The message a step fails with when a numeric input is unreadable. Names the tool, the field,
 * why it was rejected, and what the caller should do — the reference that produced it is
 * usually a `$param` off a trigger/settings field, and "which field do I fill in" is the only
 * question the reader has.
 */
export function stepNumberError(tool: string, field: string, reason: string, fallback: string): string {
	return `${tool}: "${field}" ${reason}. Failing rather than guessing — ${fallback}. Check the $param/$ref feeding "${field}" (a settings or trigger field left blank resolves to an empty string).`;
}
