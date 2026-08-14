import { describe, expect, it } from "vitest";
import {
	checkWireSurface,
	parseAdvertisedVersion,
	parseAnnotationTable,
	parseDeclaredAnnotations,
	parseJsonStringField,
	parseOutputSchemaDecls,
	parseSpecHints,
	parseStringConstant,
	parseStructuredBullets,
} from "./wire-surface.mjs";

/**
 * These parsers decide whether `pnpm docs:drift` is green for #572/#573, and the lesson
 * doc-claims.test.mjs records applies unchanged: a parser that quietly returns nothing is
 * indistinguishable from agreement. So every block below asserts BOTH directions — the
 * disagreement is caught, AND the parser still finds the thing on the shape it handles.
 *
 * The last describe is the one ADR 0002 G4 asks for: the check is watched going RED for
 * each defect it was written for, driven over in-memory files rather than over the tree.
 */

const SPEC = JSON.stringify({
	$defs: {
		ToolAnnotations: {
			properties: {
				destructiveHint: {},
				idempotentHint: {},
				openWorldHint: {},
				readOnlyHint: {},
				title: {},
			},
		},
	},
});

const METADATA = `
/** A comment mentioning openWorldHint and a stray { brace. */
export interface ToolAnnotations {
	readOnlyHint?: boolean;
	destructiveHint?: boolean;
}

export const TOOL_OUTPUT: Record<string, z.ZodRawShape> = {
	list_agents: {
		agents: z.array(z.object({ id: z.string().optional() }).passthrough()).optional()
			.describe("Published agents. { not a brace to count }"),
		error: z.string().optional(),
	},
	my_instances: {
		instances: z.array(z.object({ id: z.string().optional() }).passthrough()).optional(),
		error: z.string().optional(),
	},
};
`;

const DOC = `
| Hint | Published | What it means here |
|---|---|---|
| \`readOnlyHint\` | declared | Only reads. |
| \`destructiveHint\` | declared | May destroy. |
| \`idempotentHint\` | omitted | No notion of it. |
| \`openWorldHint\` | omitted | No record of it. |

- \`list_agents\`: \`structuredContent: {"agents": […]}\`
- \`my_instances\`: \`structuredContent: {"instances": […]}\`
`;

describe("parseSpecHints", () => {
	it("reads the four hints out of the vendored spec and leaves `title` out", () => {
		// `title` lives in the same $defs object but is not a hint, and this server publishes
		// it at the TOOL level. Including it would demand the docs call it an omitted hint.
		expect(parseSpecHints(SPEC)).toEqual([
			"destructiveHint",
			"idempotentHint",
			"openWorldHint",
			"readOnlyHint",
		]);
	});

	it("returns nothing on a truncated or wrong-shaped schema, rather than guessing", () => {
		expect(parseSpecHints("{ not json")).toEqual([]);
		expect(parseSpecHints('{"$defs":{}}')).toEqual([]);
	});
});

describe("parseDeclaredAnnotations", () => {
	it("reads the interface fields, not the prose around them", () => {
		// The doc comment above the interface names `openWorldHint`; a grep would have
		// counted it as declared, which is the exact claim this check must not get wrong.
		expect(parseDeclaredAnnotations(METADATA)).toEqual(["destructiveHint", "readOnlyHint"]);
	});

	it("returns nothing when the interface is renamed — the caller's floor turns that into a failure", () => {
		expect(parseDeclaredAnnotations("export interface Hints { readOnlyHint?: boolean }")).toEqual([]);
	});
});

describe("parseOutputSchemaDecls", () => {
	it("reads each tool and the ONE key its payload is wrapped in", () => {
		const { tools, ambiguous } = parseOutputSchemaDecls(METADATA);
		expect([...tools]).toEqual([
			["list_agents", "agents"],
			["my_instances", "instances"],
		]);
		expect(ambiguous).toEqual([]);
	});

	it("reports a schema it cannot read as one payload key instead of picking one", () => {
		const { tools, ambiguous } = parseOutputSchemaDecls(
			"export const TOOL_OUTPUT: Record<string, z.ZodRawShape> = { t: { a: z.string(), b: z.string(), error: z.string() } };",
		);
		expect(tools.size).toBe(0);
		expect(ambiguous).toEqual(["t: 2 payload key(s) [a, b]"]);
	});

	it("finds nothing when the constant is renamed", () => {
		expect(parseOutputSchemaDecls("export const OUTPUTS = { a: { b: 1 } };").tools.size).toBe(0);
	});
});

describe("parseAnnotationTable / parseStructuredBullets", () => {
	it("reads the Published column by position and the bullets by shape", () => {
		expect([...parseAnnotationTable(DOC)]).toEqual([
			["readOnlyHint", "declared"],
			["destructiveHint", "declared"],
			["idempotentHint", "omitted"],
			["openWorldHint", "omitted"],
		]);
		expect([...parseStructuredBullets(DOC)]).toEqual([
			["list_agents", "agents"],
			["my_instances", "instances"],
		]);
	});

	it("reports nothing when the table header or the bullet shape moves", () => {
		expect(parseAnnotationTable(DOC.replace("Published", "Status")).size).toBe(0);
		expect(parseStructuredBullets(DOC.replace(/structuredContent/g, "structured")).size).toBe(0);
	});
});

describe("parseAdvertisedVersion", () => {
	it("distinguishes a value imported from one source from a value typed a second time", () => {
		expect(
			parseAdvertisedVersion('server = new McpServer({ name: "ProAgentStore", version: MCP_SERVER_VERSION }, {});'),
		).toEqual({ kind: "identifier", token: "MCP_SERVER_VERSION" });
		expect(
			parseAdvertisedVersion('server = new McpServer({ name: "ProAgentStore", version: "0.1.0" }, {});'),
		).toEqual({ kind: "literal", token: "0.1.0" });
	});

	it("returns null when the constructor is not there at all", () => {
		expect(parseAdvertisedVersion('const v = "0.1.1";')).toBeNull();
	});
});

describe("parseStringConstant / parseJsonStringField", () => {
	it("reads the constant with or without a type annotation, and the manifest field", () => {
		expect(parseStringConstant('export const MCP_SERVER_VERSION = "0.1.1";', "MCP_SERVER_VERSION")).toBe("0.1.1");
		expect(parseStringConstant('export const X: string = "1.2.3";', "X")).toBe("1.2.3");
		expect(parseStringConstant("export const X = 3;", "X")).toBeNull();
		expect(parseJsonStringField('{"name":"a","version":"0.1.1"}', "version")).toBe("0.1.1");
		expect(parseJsonStringField('{"name":"a"}', "version")).toBeNull();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// ADR 0002 G4 — the check watched failing, for each defect it exists for
// ─────────────────────────────────────────────────────────────────────────────

const FILES = {
	"workers/mcp/src/mcp-schema-2025-11-25.json": SPEC,
	"workers/mcp/src/tool-metadata.ts": METADATA,
	"platform-docs/mcp.md": DOC,
};

const run = (overrides = {}) => {
	const files = { ...FILES, ...overrides };
	return checkWireSurface({
		read: (f) => files[f],
		exists: (f) => files[f] !== undefined,
	});
};

const messages = (res) => res.failures.map((f) => f.message).join("\n");

describe("checkWireSurface", () => {
	it("is silent when the docs name every wire fact, and states its denominators", () => {
		const res = run();
		expect(res.failures).toEqual([]);
		expect(res.notes).toEqual([
			"wire surface — tool annotations: 4 hint(s) from 2 code file(s) == platform-docs/mcp.md (4)",
			"wire surface — structured results: 2 output schema(s) from 1 code file(s) == platform-docs/mcp.md (2)",
		]);
	});

	it("goes red when the documentation is deleted — not silent, which is the whole point", () => {
		const res = run({ "platform-docs/mcp.md": "# MCP\n\nNothing about the wire.\n" });
		expect(res.failures).toHaveLength(2);
		expect(messages(res)).toContain("tool annotations: platform-docs/mcp.md states nothing");
		expect(messages(res)).toContain("structured results: platform-docs/mcp.md states nothing");
		// And no ✓ line for either: a fact that failed must not also print a denominator, or
		// the tick and the finding describe the same tree.
		expect(res.notes).toEqual([]);
	});

	it("goes red when a new hint is declared and the docs still list it as omitted", () => {
		const res = run({
			"workers/mcp/src/tool-metadata.ts": METADATA.replace(
				"destructiveHint?: boolean;",
				"destructiveHint?: boolean;\n\tidempotentHint?: boolean;",
			),
		});
		expect(messages(res)).toContain('idempotentHint: says "omitted", the code defines "declared"');
	});

	it("goes red when a tool gains an output schema the docs do not mention", () => {
		const res = run({
			"workers/mcp/src/tool-metadata.ts": METADATA.replace(
				"my_instances: {",
				"usage_summary: {\n\t\ttotals: z.object({}).optional(),\n\t\terror: z.string().optional(),\n\t},\n\tmy_instances: {",
			),
		});
		expect(messages(res)).toContain("omits 1 of 3 output schema(s): usage_summary");
	});

	it("goes red when the docs claim a wrapper key the schema does not use", () => {
		const res = run({ "platform-docs/mcp.md": DOC.replace('{"instances"', '{"agents"') });
		expect(messages(res)).toContain('my_instances: says "agents", the code defines "instances"');
	});

	it("fails rather than skips when a listed path is gone, and names the fact it stopped measuring", () => {
		const files = { ...FILES };
		delete files["workers/mcp/src/tool-metadata.ts"];
		const res = checkWireSurface({ read: (f) => files[f], exists: (f) => files[f] !== undefined });
		expect(messages(res)).toContain("listed path(s) do not exist: workers/mcp/src/tool-metadata.ts");
		expect(res.notes).toEqual([]);
	});

	it("fails when the authority parser stops measuring, rather than reporting agreement", () => {
		// The failure mode ADR 0002 G1 is about: an empty input set and an empty offender
		// list print the same tick everywhere they are not separated.
		const res = run({ "workers/mcp/src/mcp-schema-2025-11-25.json": '{"$defs":{}}' });
		expect(messages(res)).toContain("read 0 hint(s)");
		expect(messages(res)).toContain("expected at least 4");
	});
});
