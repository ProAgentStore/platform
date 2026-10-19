/**
 * What every tool does with arguments a model got slightly wrong (#1241) — at the ONE seam every call
 * passes through (`registration.ts`'s `tools/call` wrapper), so all tools behave the same with no
 * per-tool code.
 *
 *  - `normalizeArguments` runs BEFORE the SDK validates: a camelCase key the schema has in snake_case
 *    (`instanceId` → `instance_id`) is renamed, and a list given in the other form (an array where a
 *    comma string is expected, or the reverse) is converted. Each rewrite is a warning the caller is
 *    shown, never silent. A key the schema does not have is NOT dropped quietly either: zod would
 *    strip it unseen, so it is named as ignored.
 *  - `actionableInputError` replaces the SDK's bare zod message when validation still fails: it names
 *    each bad argument and why, lists every argument the tool takes with its type, and gives a
 *    corrected example call built from the schema and what the caller sent.
 *  - `closestToolNames` answers an unknown tool name with the nearest real ones.
 *
 * Pure: the schema is the zod raw shape the tool registered with; nothing here talks to the network.
 */
import { z, type ZodTypeAny } from "zod";
import { clipMarked } from "./clip-marked.js";

export type RawShape = Record<string, ZodTypeAny>;

/** `instanceId` → `instance_id`; `HTTPSUrl` → `https_url`. */
export const toSnake = (key: string): string =>
	key
		.replace(/([A-Z]{2,})s(?=$|[A-Z_])/g, (_, acronym: string) => `${acronym.charAt(0)}${acronym.slice(1).toLowerCase()}s`) // repoIDs → repoIds
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
		.replace(/-/g, "_")
		.toLowerCase();

/** The type under optional/default/nullable/effects wrappers. */
function core(t: ZodTypeAny): ZodTypeAny {
	let cur: ZodTypeAny = t;
	for (let i = 0; i < 8; i++) {
		const def = cur._def as { typeName?: string; innerType?: ZodTypeAny; schema?: ZodTypeAny };
		if ((def.typeName === "ZodOptional" || def.typeName === "ZodDefault" || def.typeName === "ZodNullable") && def.innerType) cur = def.innerType;
		else if (def.typeName === "ZodEffects" && def.schema) cur = def.schema;
		else break;
	}
	return cur;
}
const kind = (t: ZodTypeAny): string => (core(t)._def as { typeName?: string }).typeName ?? "";
const isOptional = (t: ZodTypeAny): boolean => t.isOptional();

/** A short type label for the argument table: `string`, `number`, `"a" | "b"`, `string[]`, … */
export function typeLabel(t: ZodTypeAny): string {
	const c = core(t);
	const def = c._def as { typeName?: string; values?: readonly string[]; type?: ZodTypeAny; options?: ZodTypeAny[]; value?: unknown };
	switch (def.typeName) {
		case "ZodString":
			return "string";
		case "ZodNumber":
			return "number";
		case "ZodBoolean":
			return "boolean";
		case "ZodEnum":
			return (def.values ?? []).map((v) => JSON.stringify(v)).join(" | ");
		case "ZodLiteral":
			return JSON.stringify(def.value);
		case "ZodArray":
			return `${def.type ? typeLabel(def.type) : "unknown"}[]`;
		case "ZodObject":
		case "ZodRecord":
			return "object";
		case "ZodUnion":
			return (def.options ?? []).map(typeLabel).join(" | ");
		default:
			return "value";
	}
}

/** A plausible example value for an argument, from its name and type. */
function exampleValue(name: string, t: ZodTypeAny): unknown {
	const c = core(t);
	const def = c._def as { typeName?: string; values?: readonly string[]; type?: ZodTypeAny; options?: ZodTypeAny[]; value?: unknown };
	switch (def.typeName) {
		case "ZodString":
			return name.endsWith("_id") ? `<${name}>` : name === "repo" ? "owner/name" : `<${name}>`;
		case "ZodNumber":
			return 1;
		case "ZodBoolean":
			return true;
		case "ZodEnum":
			return def.values?.[0];
		case "ZodLiteral":
			return def.value;
		case "ZodArray":
			return def.type ? [exampleValue(name, def.type)] : [];
		case "ZodUnion":
			return def.options?.[0] ? exampleValue(name, def.options[0]) : `<${name}>`;
		default:
			return {};
	}
}

export interface Normalized {
	args: Record<string, unknown>;
	warnings: string[];
}

/**
 * Rename camelCase keys to the schema's snake_case ones and convert list forms. Returns the arguments
 * to validate and a warning per rewrite or per ignored key. Arguments that are not a plain object are
 * returned untouched (the SDK reports them).
 */
export function normalizeArguments(shape: RawShape | undefined, input: unknown): Normalized {
	if (!shape || !input || typeof input !== "object" || Array.isArray(input)) return { args: input as Record<string, unknown>, warnings: [] };
	const args: Record<string, unknown> = { ...(input as Record<string, unknown>) };
	const warnings: string[] = [];
	for (const key of Object.keys(args)) {
		if (key in shape) continue;
		const snake = toSnake(key);
		if (snake !== key && snake in shape && !(snake in args)) {
			args[snake] = args[key];
			delete args[key];
			warnings.push(`\`${key}\` was read as \`${snake}\` — argument names are snake_case.`);
		}
	}
	for (const [key, value] of Object.entries(args)) {
		const t = shape[key];
		if (!t) continue;
		const k = kind(t);
		if (k === "ZodString" && Array.isArray(value) && value.every((v) => typeof v === "string" || typeof v === "number")) {
			args[key] = value.map(String).join(",");
			warnings.push(`\`${key}\` takes a comma-separated string; the list was joined as "${args[key]}".`);
		} else if (k === "ZodArray" && typeof value === "string") {
			const el = (core(t)._def as { type?: ZodTypeAny }).type;
			if (el && kind(el) === "ZodString") {
				args[key] = value.split(",").map((s) => s.trim()).filter(Boolean);
				warnings.push(`\`${key}\` takes a list; "${value}" was split on commas.`);
			}
		}
	}
	const unknown = Object.keys(args).filter((k) => !(k in shape));
	if (unknown.length) warnings.push(`Ignored ${unknown.length === 1 ? "an argument" : "arguments"} this tool does not take: ${unknown.map((k) => `\`${k}\``).join(", ")}.`);
	return { args, warnings };
}

/** One line per argument: `name (type, required) — description`. */
export function argumentTable(shape: RawShape): string[] {
	return Object.entries(shape)
		.filter(([name]) => name !== "token")
		.map(([name, t]) => {
			const desc = t.description ? ` — ${clipMarked(t.description, 160)}` : "";
			return `- \`${name}\` (${typeLabel(t)}, ${isOptional(t) ? "optional" : "required"})${desc}`;
		});
}

/** A corrected call: the arguments the caller sent that the tool takes, plus each missing required one. */
export function correctedExample(shape: RawShape, args: Record<string, unknown>, issues: z.ZodIssue[]): Record<string, unknown> {
	const bad = new Set(issues.map((i) => String(i.path[0] ?? "")));
	const out: Record<string, unknown> = {};
	for (const [name, t] of Object.entries(shape)) {
		if (name === "token") continue;
		if (name in args && !bad.has(name)) out[name] = args[name];
		else if (!isOptional(t) || bad.has(name)) out[name] = exampleValue(name, t);
	}
	return out;
}

/**
 * The SDK's validation error, made actionable. Keeps the `Input validation error` prefix (the audit
 * classifies a call by it) and adds: each bad argument and why, the full argument list, an example.
 */
export function actionableInputError(tool: string, shape: RawShape | undefined, args: unknown, sdkMessage: string): string {
	if (!shape) return sdkMessage;
	const given = args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
	const parsed = z.object(shape).safeParse(given);
	const issues = parsed.success ? [] : parsed.error.issues;
	const problems = issues.length
		? issues.map((i) => {
				const name = i.path.join(".") || "(arguments)";
				const why = i.code === "invalid_type" && (i as { received?: string }).received === "undefined" ? "is required but missing" : i.message.charAt(0).toLowerCase() + i.message.slice(1);
				return `- \`${name}\` ${why}`;
			})
		: [`- ${sdkMessage.replace(/^(MCP error -?\d+: )?Input validation error: Invalid arguments for tool \S+: /, "")}`];
	return [
		`Input validation error: Invalid arguments for tool ${tool}.`,
		"",
		"What is wrong:",
		...problems,
		"",
		`${tool} takes:`,
		...argumentTable(shape),
		"",
		`Corrected example: ${JSON.stringify(correctedExample(shape, given, issues))}`,
	].join("\n");
}

function editDistance(a: string, b: string): number {
	const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
	for (let i = 1; i <= a.length; i++) {
		let diag = prev[0];
		prev[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const tmp = prev[j];
			prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
			diag = tmp;
		}
	}
	return prev[b.length];
}

/** The nearest registered names to an unknown one: shared words first, then edit distance. */
export function closestToolNames(name: string, registered: Iterable<string>, n = 3): string[] {
	const want = toSnake(name);
	const words = new Set(want.split("_").filter((w) => w.length > 2));
	return [...registered]
		.map((t) => ({ t, shared: t.split("_").filter((w) => words.has(w)).length, d: editDistance(want, t) }))
		.sort((a, b) => b.shared - a.shared || a.d - b.d || a.t.localeCompare(b.t))
		.filter((x) => x.shared > 0 || x.d <= Math.max(3, Math.floor(want.length / 3)))
		.map((x) => x.t)
		.filter((_, i) => i < n);
}
