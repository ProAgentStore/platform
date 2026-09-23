// The JSON pair of pipeline steps — `parse_json` and `stringify_json` — plus the loose parser
// behind the first. Split out of steps.ts (whose size is pinned) and spread back into STEP_TOOLS
// at the same position, so the catalogue, its order and every behaviour are unchanged.
import type { ToolDef } from "./connectors/types.js";
import { getPath } from "./connectors/http.js";
import { asArray, fail, isRecord, ok } from "./steps-shared.js";

/**
 * Parse a value that is *supposed* to be JSON but came from a language model. Handles the
 * three shapes they actually emit: clean JSON, a ```json fenced block, and JSON with a
 * sentence wrapped around it. Returns null when nothing parses (callers treat that as
 * "this record's generation failed" rather than an error). A value that is ALREADY parsed
 * (object/array) passes straight through.
 */
export function parseJsonLoose(value: unknown): unknown {
	if (value === null || value === undefined) return null;
	if (typeof value === "object") return value;
	const raw = String(value).trim();
	if (!raw) return null;
	// Strip a fenced block: ```json … ``` or ``` … ```
	const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(raw);
	const body = (fenced ? fenced[1] : raw).trim();
	const attempt = (s: string): unknown => {
		try {
			return JSON.parse(s);
		} catch {
			return undefined;
		}
	};
	const direct = attempt(body);
	if (direct !== undefined) return direct;
	// Prose around the JSON — take the outermost {…} or […] span.
	const first = body.search(/[{[]/);
	if (first === -1) return null;
	const opener = body[first];
	const closer = opener === "{" ? "}" : "]";
	const last = body.lastIndexOf(closer);
	if (last <= first) return null;
	const span = attempt(body.slice(first, last + 1));
	return span === undefined ? null : span;
}

export const JSON_STEP_TOOLS: ToolDef[] = [
	// 7c ─ parse_json — turn a model's JSON reply into real fields. `ai_generate` writes raw
	// TEXT, so a step that asks for structured output had no way to hand its fields to the
	// next step; the alternative was one LLM call per field, which costs more AND loses
	// coherence between fields that should read as one voice. Tolerates the ```json fence
	// models add. A record whose field won't parse gets `null` — best-effort, like ai_generate.
	{
		name: "parse_json",
		tier: "standard",
		scope: "read",
		mutates: false,
		untrustedOutput: false,
		description:
			"Parse a JSON string field on each record into real structured data (pure, no I/O). Reads `field` (default \"text\" — what ai_generate writes) and writes the parsed value to `as` (default: back onto `field`). Strips a ```json code fence and any prose around the JSON. A value that won't parse becomes null rather than failing the batch, and is counted in `failed`. The companion to ai_generate when you asked the model for JSON.",
		jsonSchema: {
			type: "object",
			properties: {
				items: { type: "array", description: "Records carrying a JSON string field." },
				field: { type: "string", description: 'Field holding the JSON string (default "text").' },
				as: { type: "string", description: "Field to write the parsed value to (default: overwrite `field`)." },
			},
			required: [],
		},
		handler: async (_ctx, input) => {
			const items = asArray(input.items).filter(isRecord) as Record<string, unknown>[];
			const field = typeof input.field === "string" && input.field ? input.field : "text";
			const as = typeof input.as === "string" && input.as ? input.as : field;
			let failed = 0;
			const out = items.map((item) => {
				const parsed = parseJsonLoose(getPath(item, field));
				if (parsed === null) failed++;
				return { ...item, [as]: parsed };
			});
			return ok(JSON.stringify({ items: out, count: out.length, failed }, null, 2));
		},
	},

	// 7d ─ stringify_json — safely hand structured connector output to a later text-only step.
	// A pipeline binder keeps JSON structured (correctly), while an `ai_generate` placeholder
	// renders an object as `[object Object]`. This deliberately small inverse lets a workflow
	// ask a model to choose from an MCP catalogue or critique a diagnostic report without losing
	// the actual rows that informed the decision.
	{
		name: "stringify_json",
		tier: "standard",
		scope: "read",
		mutates: false,
		untrustedOutput: false,
		description:
			"Serialize a value as JSON for a later text-only step such as ai_generate. Returns {text}; unlike direct template interpolation, objects and arrays are preserved instead of becoming [object Object].",
		jsonSchema: {
			type: "object",
			properties: {
				value: { type: ["object", "array", "string", "number", "boolean", "null"], description: "Any JSON-compatible value to serialize." },
				pretty: { type: "boolean", description: "Pretty-print with indentation (default false)." },
			},
			required: ["value"],
		},
		handler: async (_ctx, input) => {
			try {
				return ok(JSON.stringify({ text: JSON.stringify(input.value, null, input.pretty === true ? 2 : undefined) }));
			} catch {
				return fail("value is not JSON-serializable.");
			}
		},
	},
];
