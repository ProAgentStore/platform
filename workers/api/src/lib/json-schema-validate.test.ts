import { describe, expect, it } from "vitest";
import { describeType, matchesType, validateAgainstSchema } from "./json-schema-validate.js";
import { behaviourToolSchema } from "./agent-behaviour.js";
import { SELF_WRITABLE_FIELDS } from "./agent-behaviour.js";

describe("draft-07's type LIST, which this codebase emits and the validator ignored (#608)", () => {
	it("accepts a value matching ANY member of the list", () => {
		expect(matchesType(70, ["number", "null"])).toBe(true);
		expect(matchesType(null, ["number", "null"])).toBe(true);
		expect(matchesType("plain", ["string", "null"])).toBe(true);
	});

	it("REFUSES a value matching none of them — the case that silently passed", () => {
		// An array fell through the switch to `default: return true`, so a property declared with
		// the list form was accepted whatever was passed. `JsonSchema.properties[].type` declared a
		// bare `string`, so no compiler could report it.
		expect(matchesType("banana", ["number", "null"])).toBe(false);
		expect(matchesType({}, ["string", "null"])).toBe(false);
		expect(matchesType(3, ["string", "boolean"])).toBe(false);
	});

	it("still decides the scalar form exactly as it did", () => {
		expect(matchesType("x", "string")).toBe(true);
		expect(matchesType(1.5, "integer")).toBe(false);
		expect(matchesType(2, "integer")).toBe(true);
		expect(matchesType([], "array")).toBe(true);
		expect(matchesType([], "object")).toBe(false);
		// An unknown type spec must not block: the schemas are passed to the model verbatim and may
		// carry draft-07 keywords this validator does not model.
		expect(matchesType("anything", "date-time")).toBe(true);
	});

	it("names both members in the refusal, so the reader can see what was allowed", () => {
		expect(describeType(["number", "null"])).toBe("number or null");
		expect(describeType("string")).toBe("string");
	});
});

describe("validateAgainstSchema against the REAL set_behaviour schema", () => {
	// Not a hand-written fixture: the shape that made this bug matter is the one the platform
	// actually generates, and a paraphrase of it would stop measuring the defect the moment the
	// generator changed.
	const schema = behaviourToolSchema(SELF_WRITABLE_FIELDS);

	it("refuses a wrongly-typed field", () => {
		expect(validateAgainstSchema(schema, { technicality: "banana" })).toMatch(/"technicality" must be a number or null/);
	});

	it("accepts the value and the null that resets it", () => {
		expect(validateAgainstSchema(schema, { technicality: 70 })).toBeNull();
		expect(validateAgainstSchema(schema, { technicality: null })).toBeNull();
	});

	it("every property really does declare the list form, which is why this mattered", () => {
		// If `behaviourToolSchema` ever stops emitting `["…","null"]`, the validator above is being
		// exercised on a shape the platform no longer produces and this file has gone decorative.
		const types = Object.values(schema.properties).map((p) => p.type);
		expect(types.length).toBeGreaterThan(0);
		for (const t of types) expect(Array.isArray(t) && t.includes("null")).toBe(true);
	});

	it("still catches a missing required field", () => {
		const required = { type: "object" as const, properties: { repo: { type: "string" } }, required: ["repo"] };
		expect(validateAgainstSchema(required, {})).toBe("Missing required field: repo");
		expect(validateAgainstSchema(required, { repo: "owner/name" })).toBeNull();
	});
});
