import { z } from "zod";

/**
 * JSON Schema → zod raw shape, for the subset the instance tools actually publish (#783).
 *
 * ── Why a converter exists at all
 *
 * A pinned session (`/mcp/i/<instanceId>`, see `pinned.ts`) registers an instance's OWN tools
 * under their real names, and the whole point of doing that is to publish their real field
 * names so a caller stops guessing them. The API serves each tool's input as JSON Schema
 * (`jsonSchema` on a `GET /v1/instances/:id/tools?schemas=true` row); the MCP SDK's
 * `registerTool` accepts only a zod shape or a Standard Schema. Nothing bridged the two, and
 * registering every pinned tool as `z.record(z.unknown())` would publish `{}` — exactly the
 * discovery gap #783 is about, moved one layer down.
 *
 * ── Deliberately a SUBSET, and the subset was measured
 *
 * The connectors' `params` (`workers/api/src/lib/connectors/*.ts`, 2026-09-08) use nine
 * keywords: `type`, `description`, `required`, `properties`, `items`, `enum`, `maxLength`,
 * `pattern`, `default`, over string / number / integer / boolean / array / object. That is what
 * is translated. Anything else is NOT silently flattened: an unrecognised `type` becomes
 * `z.unknown()` AND is reported in `unsupported`, so the caller (and a test) can see exactly which
 * field lost its shape rather than discovering it from a refused call.
 *
 * PURE — no SDK, no env, no network.
 */

export interface JsonSchemaLike {
	type?: string | string[];
	description?: string;
	properties?: Record<string, JsonSchemaLike>;
	required?: string[];
	items?: JsonSchemaLike;
	enum?: unknown[];
	minLength?: number;
	maxLength?: number;
	pattern?: string;
	minimum?: number;
	maximum?: number;
	default?: unknown;
}

export interface ZodShapeResult {
	shape: z.ZodRawShape;
	/** Dotted paths whose type could not be expressed and were widened to `unknown`. */
	unsupported: string[];
}

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The single JSON type of a schema, with `["string","null"]` reduced to `string` + nullable. */
function primaryType(s: JsonSchemaLike): { type: string | undefined; nullable: boolean } {
	if (Array.isArray(s.type)) {
		const nonNull = s.type.filter((t) => t !== "null");
		return { type: nonNull[0], nullable: nonNull.length < s.type.length };
	}
	return { type: s.type, nullable: false };
}

function convert(raw: unknown, path: string, unsupported: string[]): z.ZodTypeAny {
	if (!isObject(raw)) {
		unsupported.push(path);
		return z.unknown();
	}
	const s = raw as JsonSchemaLike;
	const { type, nullable } = primaryType(s);
	let out: z.ZodTypeAny;

	if (Array.isArray(s.enum) && s.enum.length > 0 && s.enum.every((e) => typeof e === "string")) {
		out = z.enum(s.enum as [string, ...string[]]);
	} else {
		switch (type) {
			case "string": {
				let str = z.string();
				if (typeof s.minLength === "number") str = str.min(s.minLength);
				if (typeof s.maxLength === "number") str = str.max(s.maxLength);
				if (typeof s.pattern === "string") {
					try {
						str = str.regex(new RegExp(s.pattern));
					} catch {
						unsupported.push(`${path}.pattern`);
					}
				}
				out = str;
				break;
			}
			case "number":
			case "integer": {
				// `coerce`, like every numeric MCP parameter in this worker (#670): a host serving a
				// stale cached schema sends "7", and a bare z.number() answers -32602 to a correct call.
				let num = z.coerce.number();
				if (type === "integer") num = num.int();
				if (typeof s.minimum === "number") num = num.min(s.minimum);
				if (typeof s.maximum === "number") num = num.max(s.maximum);
				out = num;
				break;
			}
			case "boolean":
				out = z.boolean();
				break;
			case "array":
				out = z.array(s.items === undefined ? z.unknown() : convert(s.items, `${path}[]`, unsupported));
				break;
			case "object":
				if (isObject(s.properties)) {
					out = z.object(objectShape(s, path, unsupported)).passthrough();
				} else {
					out = z.record(z.unknown());
				}
				break;
			default:
				// A schema with `properties` and no `type` is an object by every reader's convention.
				if (type === undefined && isObject(s.properties)) {
					out = z.object(objectShape(s, path, unsupported)).passthrough();
					break;
				}
				unsupported.push(path);
				out = z.unknown();
		}
	}

	if (nullable) out = out.nullable();
	if (typeof s.description === "string" && s.description) out = out.describe(s.description);
	return out;
}

function objectShape(s: JsonSchemaLike, path: string, unsupported: string[]): z.ZodRawShape {
	const required = new Set(Array.isArray(s.required) ? s.required : []);
	const shape: z.ZodRawShape = {};
	for (const [key, prop] of Object.entries(s.properties ?? {})) {
		const field = convert(prop, path ? `${path}.${key}` : key, unsupported);
		shape[key] = required.has(key) ? field : field.optional();
	}
	return shape;
}

/**
 * The top-level object schema of a tool, as a zod raw shape for `registerTool`.
 *
 * A schema that is not an object (or is absent) yields an EMPTY shape plus an `unsupported`
 * entry for the root — the tool still registers, it just advertises no fields, which is the
 * pre-#783 state and never worse than it.
 */
export function jsonSchemaToZodShape(schema: unknown): ZodShapeResult {
	const unsupported: string[] = [];
	if (!isObject(schema)) {
		if (schema !== undefined) unsupported.push("");
		return { shape: {}, unsupported };
	}
	const s = schema as JsonSchemaLike;
	const { type } = primaryType(s);
	if ((type !== undefined && type !== "object") || !isObject(s.properties)) {
		if (type !== undefined && type !== "object") unsupported.push("");
		return { shape: {}, unsupported };
	}
	return { shape: objectShape(s, "", unsupported), unsupported };
}
