import { describe, expect, it } from "vitest";
import { z } from "zod";
import { jsonSchemaToZodShape } from "./json-schema-zod.js";

/**
 * The converter is what lets a pinned session publish an instance tool's REAL field names
 * (#783). These cases are the shapes the connectors actually emit — measured across
 * `workers/api/src/lib/connectors/*.ts` — plus the two ways a schema can fail to be an object.
 */
describe("jsonSchemaToZodShape", () => {
	it("translates the github_read_issue shape: required string + number, descriptions kept", () => {
		const { shape, unsupported } = jsonSchemaToZodShape({
			type: "object",
			properties: {
				repo: { type: "string", description: 'The repository, "owner/name".' },
				number: { type: "number", description: "The issue number." },
			},
			required: ["repo", "number"],
		});
		expect(unsupported).toEqual([]);
		expect(Object.keys(shape)).toEqual(["repo", "number"]);
		const parsed = z.object(shape).safeParse({ repo: "a/b", number: 7 });
		expect(parsed.success).toBe(true);
		expect(z.object(shape).safeParse({ repo: "a/b" }).success).toBe(false);
		expect(shape.repo.description).toBe('The repository, "owner/name".');
	});

	it("makes a field optional exactly when it is not in `required`", () => {
		const { shape } = jsonSchemaToZodShape({
			type: "object",
			properties: { page: { type: "number" }, per_page: { type: "integer" } },
		});
		expect(z.object(shape).safeParse({}).success).toBe(true);
		expect(z.object(shape).safeParse({ per_page: 1.5 }).success).toBe(false);
		expect(z.object(shape).safeParse({ per_page: 2 }).success).toBe(true);
	});

	it("keeps enum, maxLength and pattern, and widens only what it cannot express", () => {
		const { shape, unsupported } = jsonSchemaToZodShape({
			type: "object",
			properties: {
				state: { type: "string", enum: ["open", "closed"] },
				title: { type: "string", maxLength: 3 },
				sha: { type: "string", pattern: "^[0-9a-f]+$" },
				labels: { type: "array", items: { type: "string" } },
				meta: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
				flag: { type: "boolean" },
				weird: { type: "tuple" },
			},
			required: ["state"],
		});
		const obj = z.object(shape);
		expect(obj.safeParse({ state: "open" }).success).toBe(true);
		expect(obj.safeParse({ state: "merged" }).success).toBe(false);
		expect(obj.safeParse({ state: "open", title: "abcd" }).success).toBe(false);
		expect(obj.safeParse({ state: "open", sha: "zz" }).success).toBe(false);
		expect(obj.safeParse({ state: "open", labels: ["a", 1] }).success).toBe(false);
		expect(obj.safeParse({ state: "open", meta: {} }).success).toBe(false);
		expect(obj.safeParse({ state: "open", meta: { key: "k", extra: 1 }, flag: true }).success).toBe(true);
		// The one field it could not shape is named, not silently flattened.
		expect(unsupported).toEqual(["weird"]);
		expect(obj.safeParse({ state: "open", weird: { anything: true } }).success).toBe(true);
	});

	it("reads `[\"string\",\"null\"]` as a nullable string, and `properties` with no `type` as an object", () => {
		const { shape, unsupported } = jsonSchemaToZodShape({
			properties: { note: { type: ["string", "null"] } },
		});
		expect(unsupported).toEqual([]);
		expect(z.object(shape).safeParse({ note: null }).success).toBe(true);
		expect(z.object(shape).safeParse({ note: 3 }).success).toBe(false);
	});

	it("yields an empty shape, and says so, for a schema that is not an object", () => {
		expect(jsonSchemaToZodShape(undefined)).toEqual({ shape: {}, unsupported: [] });
		expect(jsonSchemaToZodShape({ type: "string" })).toEqual({ shape: {}, unsupported: [""] });
		expect(jsonSchemaToZodShape("nonsense")).toEqual({ shape: {}, unsupported: [""] });
		// An object with no properties is a legal "takes nothing" tool, not an error.
		expect(jsonSchemaToZodShape({ type: "object" })).toEqual({ shape: {}, unsupported: [] });
	});
});
