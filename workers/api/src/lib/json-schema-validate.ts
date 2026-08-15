/**
 * The minimal draft-07 object-schema validator that gates `POST /v1/instances/:id/tools/:name`.
 *
 * Dependency-free on purpose (the repo has no ajv): required-fields plus basic JSON types, an
 * error string on the first violation, null when the input satisfies the schema. Unknown/extra
 * keys are allowed — the schemas here do not set `additionalProperties`, and a property with no
 * schema entry is skipped, matching the tools' permissive handlers.
 *
 * Lifted out of `routes/tools.ts` at #608, for two reasons that are the same reason: it is a pure
 * rule about a data format and it was reachable only by standing up a Hono app with a D1 double.
 * The defect that moved it had lived here unnoticed — see {@link matchesType}.
 */

import type { JsonSchema } from "./connectors/types.js";

/** "number" · `["number","null"]` → `number` / `number or null`, for the refusal message. */
export function describeType(type: string | string[]): string {
	return Array.isArray(type) ? type.join(" or ") : type;
}

/**
 * Draft-07 `type`, which is a string OR a LIST of them — a value satisfies the list if it
 * satisfies any member (#608).
 *
 * The list form was unhandled and, worse, unhandled SILENTLY: an array fell through the switch to
 * `default: return true`, so a property declared that way was accepted whatever was passed. That
 * is not a hypothetical shape — `behaviourToolSchema` emits `["number","null"]` on every one of
 * `set_behaviour`'s fields, so that a setting can be reset and not only changed. So this validator
 * did nothing at all for the tool most likely to be called with a value a model invented, and it
 * looked exactly like a validator that worked.
 *
 * Nothing could point it out: `JsonSchema.properties[].type` declared a bare `string`, so the one
 * shape the codebase actually emits did not satisfy the type meant to describe it, and the two
 * call sites papered over the disagreement with a cast and a double-`unknown`.
 */
export function matchesType(val: unknown, type: string | string[]): boolean {
	if (Array.isArray(type)) return type.some((t) => matchesType(val, t));
	switch (type) {
		case "string":
			return typeof val === "string";
		case "number":
		case "integer":
			return typeof val === "number" && Number.isFinite(val) && (type === "number" || Number.isInteger(val));
		case "boolean":
			return typeof val === "boolean";
		case "array":
			return Array.isArray(val);
		case "object":
			return typeof val === "object" && !Array.isArray(val);
		case "null":
			// Unreachable through `validateAgainstSchema`, which skips null before it gets here, but
			// stated rather than left to `default` so the list form means what draft-07 says it means.
			return val === null;
		default:
			return true; // unknown type spec → don't block
	}
}

/** Validate one tool call's input against its declared schema. */
export function validateAgainstSchema(schema: JsonSchema, input: Record<string, unknown>): string | null {
	for (const req of schema.required ?? []) {
		if (input[req] === undefined || input[req] === null) return `Missing required field: ${req}`;
	}
	for (const [key, spec] of Object.entries(schema.properties)) {
		const val = input[key];
		if (val === undefined || val === null) continue; // absent optional (or absent required already caught)
		if (!matchesType(val, spec.type)) return `Field "${key}" must be a ${describeType(spec.type)}`;
	}
	return null;
}
