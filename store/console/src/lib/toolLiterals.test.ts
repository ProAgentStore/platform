import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { TERMINAL_TOOL_FAMILIES, terminalFamilyToolNames } from "./terminalTools.js";
import { findToolLiterals, toolVocabulary } from "./toolLiterals.js";

/**
 * The ratchet #409 asks for: a hardcoded tool name the agent no longer declares must fail a test,
 * not a user's tab.
 *
 * The exposure was measured before this was written. #409 grepped for a name filling a whole
 * string literal and found a population of one — all in `TmuxTab.tsx`. Scanning for the name
 * ANYWHERE finds two more, and the difference is worth recording rather than quietly absorbing:
 * `McpConnections.tsx` keeps its tool name inside a URL path, and two files mention a tool name in
 * copy (a blocker hint, a form placeholder). None of the three is the defect — the two call sites
 * are both guarded on a live verdict, and copy calls nothing — but all three go stale on a rename,
 * which is the other half of what this file checks.
 *
 * Every other consumer of `/v1/instances/:id/tools` reads the list GENERICALLY, iterating it rather
 * than naming a row: `ToolPermissions.tsx`, `TeamworkSection.tsx`, `lib/toolPolicy.ts`,
 * `lib/teamwork.ts`. That is the robust direction and it needs no entry here.
 *
 * Pinned EXACTLY, following `control-shapes.test.ts`: a ceiling banks the ground you just took as
 * headroom.
 */

const CONSOLE_SRC = resolve(__dirname, "..");
const CODER_WEB_SRC = resolve(__dirname, "../../../../agents/coder/web/src");
const CONNECTORS = resolve(__dirname, "../../../../workers/api/src/lib/connectors");

/**
 * `store/admin` is deliberately out of scope, and it was checked rather than assumed: the operator
 * portal never calls `/v1/instances/:id/tools` at all, so it has no agent whose declaration could
 * go out from under it.
 */
const TREES = [
	["store/console", CONSOLE_SRC],
	["agents/coder/web", CODER_WEB_SRC],
] as const;

function sourceFiles(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		const p = join(dir, entry);
		if (statSync(p).isDirectory()) sourceFiles(p, out);
		// Tests name tools on purpose — a fixture asserting the refusal path has to spell one out.
		else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(p);
	}
	return out;
}

const vocabulary = toolVocabulary(
	readdirSync(CONNECTORS)
		.filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
		.map((f) => readFileSync(join(CONNECTORS, f), "utf8")),
);

/**
 * Where a tool name may be written, and WHY that occurrence is safe.
 *
 * Pinned per file AND per name. Adding a name here is the deliberate act; the reason beside it is
 * the thing a reviewer checks, because the test cannot check it.
 */
const ALLOWED: { file: string; names: string[]; because: string }[] = [
	{
		file: "store/console/src/lib/terminalTools.ts",
		names: [...terminalFamilyToolNames(TERMINAL_TOOL_FAMILIES[0]), ...terminalFamilyToolNames(TERMINAL_TOOL_FAMILIES[1])].sort(),
		because:
			"The declared table. Nothing calls a name from it until `resolveTerminalAccess` has matched it against the instance's own `GET /tools?allowed=true` — which is the fix for #409, and the reason `TmuxTab.tsx` itself now names none of them.",
	},
	{
		file: "store/console/src/components/McpConnections.tsx",
		names: ["mcp_call_tool"],
		because:
			"The dogfood smoke test (#287). Already correct before #409: the button is only offered once `/mcp/test` reports that tool callable, and the header states that reason — the pattern the Terminal tab has now been made to follow.",
	},
	{
		file: "store/console/src/lib/mcpConnections.ts",
		names: ["mcp_call_tool"],
		because:
			"COPY, not a call: `blockerHint` names the tool in the sentence it prints, and it only prints it when the server's own blocker verdict is `tool_disabled` — i.e. the name is being reported BY the policy rather than assumed ahead of it.",
	},
	{
		file: "store/console/src/pages/AgentDetail.tsx",
		names: ["github_create_issue"],
		because:
			"COPY, not a call: the placeholder in the creator's tool-allowlist input, showing the shape of a name to type. Nothing is invoked, and the field's own label says unknown names are ignored.",
	},
];

const findings = TREES.flatMap(([tree, root]) =>
	sourceFiles(root).flatMap((file) =>
		findToolLiterals(readFileSync(file, "utf8"), vocabulary).map((f) => ({
			file: `${tree}/src/${relative(root, file)}`,
			line: f.line,
			name: f.name,
		})),
	),
);

describe("the tool vocabulary this guard reads", () => {
	it("is derived from the connector definitions, and is not vacuously empty", () => {
		// A guard whose vocabulary silently went empty passes forever while checking nothing. This is
		// the assertion that makes the pin below mean something.
		expect(vocabulary.size).toBeGreaterThan(30);
		for (const anchor of ["terminal_list_targets", "tmux_list_sessions", "mcp_call_tool", "github_list_issues", "http_request", "web_search"]) {
			expect(vocabulary.has(anchor), `${anchor} missing from the derived vocabulary`).toBe(true);
		}
	});

	it("covers every tool the Terminal tab can call — a server-side rename fails HERE, not at a tab", () => {
		// The other half of #409's lesson. The tab's names are now in one table; this asserts that
		// table still describes tools the registry actually has, so a connector rename cannot ship
		// leaving the console calling a name that no longer exists.
		for (const family of TERMINAL_TOOL_FAMILIES) {
			for (const name of terminalFamilyToolNames(family)) {
				expect(vocabulary.has(name), `${name} is not a registry connector tool`).toBe(true);
			}
		}
	});

	it("does not read a tool name out of a comment, or out of an interpolated call", () => {
		const vocab = new Set(["tmux_list_sessions", "mcp_call_tool"]);
		expect(findToolLiterals(`// call tmux_list_sessions here\nconst a = 1;`, vocab)).toEqual([]);
		// A name the component resolved from the policy is the fix, not the defect. Built by
		// concatenation, as `control-shapes.test.ts` does, so this file does not itself contain a JS
		// template placeholder — biome's noTemplateCurlyInString flags one inside an ordinary string.
		expect(findToolLiterals(["callTool(`$", "{family.list}`)"].join(""), vocab)).toEqual([]);
		expect(findToolLiterals(`callTool("tmux_list_sessions")`, vocab)).toEqual([{ line: 1, name: "tmux_list_sessions" }]);
	});

	it("finds a name baked into a URL path, which is where the second call site keeps its", () => {
		// The shape `McpConnections.tsx` uses. A guard that only matched a name filling a whole string
		// would have been built around the one case it already knew about.
		const src = ["api(`/v1/instances/$", "{id}/tools/mcp_call_tool`, {})"].join("");
		expect(findToolLiterals(src, new Set(["mcp_call_tool"]))).toEqual([{ line: 1, name: "mcp_call_tool" }]);
	});
});

describe("no console surface names a tool the agent might not declare", () => {
	it("every hardcoded tool name is in a file that is allowed to hold one", () => {
		const allowedFiles = new Set(ALLOWED.map((a) => a.file));
		const strays = findings.filter((f) => !allowedFiles.has(f.file));
		expect(
			strays.map((f) => `${f.file}:${f.line}  ${f.name}`),
			"A console file names a connector tool with nothing checking the agent still declares it — which is exactly how #409 shipped.\n" +
				"Resolve the name through the instance's own GET /v1/instances/:id/tools (see lib/terminalTools.ts), or add the file to ALLOWED with the reason it is safe.",
		).toEqual([]);
	});

	it("each allowed file holds exactly the names it is pinned to", () => {
		for (const { file, names, because } of ALLOWED) {
			const found = [...new Set(findings.filter((f) => f.file === file).map((f) => f.name))].sort();
			expect(found, `${file} — pinned because: ${because}`).toEqual([...names].sort());
		}
	});

	it("THE ACCEPTANCE CRITERION: TmuxTab names no tool at all", () => {
		// #409 asked for it in as many words. The tab builds every call from the family
		// `resolveTerminalAccess` returned, so there is no name in it left to go stale.
		expect(findings.filter((f) => f.file.endsWith("tabs/TmuxTab.tsx"))).toEqual([]);
	});
});
