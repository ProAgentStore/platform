/**
 * The minimal draft-07 object-schema validator that gates `POST /v1/instances/:id/tools/:name`.
 *
 * Dependency-free on purpose (the repo has no ajv): required-fields, basic JSON types and unknown
 * keys, an error string on the first violation, null when the input satisfies the schema.
 *
 * An input key the schema does not declare is REFUSED, naming the key and the valid ones (#1205),
 * unless the schema sets `additionalProperties`. It used to be skipped, and the handlers ignore
 * what they do not read, so `github_list_issues {query:"…"}` (the key is `search`) returned an
 * unfiltered page with no error. The caller read it as "no matching issues" and filed a duplicate.
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

/** Words a caller reaches for in place of the key a schema declares (#1205): `query` for `search`. */
const SYNONYMS: readonly (readonly string[])[] = [["search", "query", "q", "keyword", "keywords", "term", "text", "filter"]];

const normalize = (k: string) => k.toLowerCase().replace(/[_-]/g, "");

/** The declared key `unknown` was probably meant to be, or null. */
function suggestKey(unknown: string, valid: readonly string[]): string | null {
	const same = valid.find((v) => normalize(v) === normalize(unknown));
	if (same) return same;
	const group = SYNONYMS.find((g) => g.includes(unknown.toLowerCase()));
	return group ? (valid.find((v) => group.includes(v)) ?? null) : null;
}

/** The refusal for input keys the schema does not declare, or null when there are none. */
export function unknownKeysRefusal(schema: JsonSchema, input: Record<string, unknown>): string | null {
	if (schema.additionalProperties) return null;
	const valid = Object.keys(schema.properties);
	const unknown = Object.keys(input).filter((k) => !Object.hasOwn(schema.properties, k));
	if (!unknown.length) return null;
	const named = unknown.map((k) => {
		const hint = suggestKey(k, valid);
		return hint ? `"${k}" (did you mean "${hint}"?)` : `"${k}"`;
	});
	const accepts = valid.length ? `Valid keys: ${valid.map((v) => `"${v}"`).join(", ")}.` : "This tool takes no input.";
	return `Unknown input ${unknown.length === 1 ? "key" : "keys"} ${named.join(", ")} — refused rather than silently ignored. ${accepts}`;
}

/** Validate one tool call's input against its declared schema. */
export function validateAgainstSchema(schema: JsonSchema, input: Record<string, unknown>): string | null {
	const unknown = unknownKeysRefusal(schema, input);
	if (unknown) return unknown;
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
