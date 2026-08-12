import { describe, expect, it } from "vitest";
import {
	diffConfirm,
	findToolCountClaims,
	parseConfirmBullets,
	parseConfirmCallSites,
	parseConfirmProse,
	parseConfirmTable,
} from "./doc-claims.mjs";

/**
 * These parsers decide whether `pnpm docs:drift` is green, and #555 is what happens when
 * one of them is trusted without being watched fail: the live /about page said "~67 tools"
 * against a registered 135, and the check that was supposed to compare them read three
 * files and reported on "every doc claim".
 *
 * So each block below asserts BOTH directions — the disagreement is caught, AND the parser
 * still finds the thing on the shape it is meant to handle. The second half is the one that
 * matters here: a parser that quietly returns nothing is the failure this whole ticket is
 * about, and it looks exactly like agreement.
 */

describe("findToolCountClaims", () => {
	it("finds the claim and its line, in every phrasing the docs actually use", () => {
		const src = [
			"intro",
			"The server registers 135 tools; 117 are always present.",
			"**135 tool registrations** (`.tool(` in the files above)",
		].join("\n");
		expect(findToolCountClaims(src)).toEqual([
			{ n: 2, claimed: 135, line: "The server registers 135 tools; 117 are always present." },
			{
				n: 3,
				claimed: 135,
				line: "**135 tool registrations** (`.tool(` in the files above)",
			},
		]);
	});

	it("reads the /about page's stale claim — the exact string that shipped to production", () => {
		const about =
			'<p><strong>MCP Server</strong> — manage agents from Claude Code. ~67 tools across creator operations.</p>';
		expect(findToolCountClaims(about)).toEqual([
			{ n: 1, claimed: 67, line: about },
		]);
	});

	/**
	 * The failure mode the narrow regex CANNOT see, recorded rather than argued. This is
	 * why docs-drift.mjs requires each listed file to yield at least one claim: without
	 * that rule, this rewrite silently retires the check on that file.
	 */
	it("does NOT see a claim phrased 'N <word> tools' — which is why the caller asserts a non-empty result", () => {
		expect(findToolCountClaims("The server registers 135 MCP tools.")).toEqual([]);
		expect(findToolCountClaims("A tool surface of 135.")).toEqual([]);
	});

	it("ignores prose with no number attached to the word", () => {
		expect(findToolCountClaims("Call `tools/list` for the authoritative set.")).toEqual([]);
	});
});

describe("parseConfirmCallSites", () => {
	const sources = [
		{
			name: "index.ts",
			src: 'const u = await requireConfirmation(this.safety(token), "write_agent_file", confirm, "write_agent_file", input);',
		},
		{
			name: "repo.ts",
			src: 'const u = await requireConfirmation(safetyFor(token), "remove_repo", confirm, "remove_all_repos", input);',
		},
	];

	it("reads the tool name and the exact expected value, including the one exception", () => {
		const sites = parseConfirmCallSites(sources);
		expect(sites.get("write_agent_file")).toEqual({
			expected: "write_agent_file",
			at: "index.ts:1",
		});
		expect(sites.get("remove_repo")).toEqual({ expected: "remove_all_repos", at: "repo.ts:1" });
	});

	it("finds nothing when the call shape changes — the caller's floor turns that into a failure", () => {
		const renamed = [{ name: "index.ts", src: 'await needsConfirm(s, "write_agent_file", c, "x");' }];
		expect(parseConfirmCallSites(renamed).size).toBe(0);
	});
});

describe("parseConfirmBullets", () => {
	it("reads platform-docs/mcp.md's bullet form", () => {
		const src = [
			"Destructive tools require an exact `confirm` value:",
			"",
			'- `delete_supervision`: `confirm: "delete_supervision"`',
			'- `remove_repo`: `confirm: "remove_all_repos"`, and only when removing **all** indexed repos',
		].join("\n");
		expect([...parseConfirmBullets(src)]).toEqual([
			["delete_supervision", "delete_supervision"],
			["remove_repo", "remove_all_repos"],
		]);
	});

	it("does not mistake an ordinary tool bullet for a confirm declaration", () => {
		expect(parseConfirmBullets("- `list_agents`: read-only, no confirmation").size).toBe(0);
	});
});

describe("parseConfirmTable", () => {
	const table = [
		"### Agent-to-agent",
		"",
		"| Tool | Purpose | Scope | Dry | Confirm |",
		"|---|---|---|---|---|",
		"| `list_supervision` | Agents a supervisor oversees | read | | |",
		"| `delete_supervision` | Remove a link | destructive | yes | `delete_supervision` |",
		"| `remove_repo` | Remove one repo, or all | write | yes | `remove_all_repos` (only when removing all) |",
	].join("\n");

	it("reads the Confirm cell by column position and leaves unguarded rows out", () => {
		const { tools, tables } = parseConfirmTable(table);
		expect(tables).toBe(1);
		expect([...tools]).toEqual([
			["delete_supervision", "delete_supervision"],
			["remove_repo", "remove_all_repos"],
		]);
	});

	/** A column inserted before Confirm must not shift what this reads — the reason it
	 *  resolves the index from the header instead of taking the last cell. */
	it("follows the column when the table gains one", () => {
		const widened = table
			.replace("| Tool | Purpose | Scope | Dry | Confirm |", "| Tool | Purpose | Scope | Dry | Audit | Confirm |")
			.replace("|---|---|---|---|---|", "|---|---|---|---|---|---|")
			.replace("| destructive | yes | `delete_supervision` |", "| destructive | yes | yes | `delete_supervision` |")
			.replace("| write | yes | `remove_all_repos` (only when removing all) |", "| write | yes | yes | `remove_all_repos` (only when removing all) |")
			.replace("| read | | |", "| read | | | |");
		const { tools } = parseConfirmTable(widened);
		expect(tools.get("delete_supervision")).toBe("delete_supervision");
		expect(tools.get("remove_repo")).toBe("remove_all_repos");
	});

	it("reports zero tables when the header shape moves, rather than zero offenders", () => {
		const noHeader = table.replace("| Tool | Purpose | Scope | Dry | Confirm |", "| Name | Purpose | Scope | Dry | Confirmation |");
		expect(parseConfirmTable(noHeader).tables).toBe(0);
	});
});

describe("parseConfirmProse", () => {
	const known = new Set([
		"write_agent_file",
		"delete_supervision",
		"clear_instance_messages",
		"remove_repo",
	]);
	const sentence =
		'- Thirteen tools require an exact `confirm` value, compared with `===`. In twelve cases the value is the tool\'s own name: `write_agent_file`, `delete_supervision`, `clear_instance_messages`. The exception is `remove_repo`, which takes `confirm: "remove_all_repos"` and only when removing every repo.';

	it("reads the tools, binds the exception's explicit value, and reports the stated counts", () => {
		const { tools, stated, lines } = parseConfirmProse(sentence, known);
		expect(lines).toBe(1);
		expect([...tools]).toEqual([
			["write_agent_file", "write_agent_file"],
			["delete_supervision", "delete_supervision"],
			["clear_instance_messages", "clear_instance_messages"],
			["remove_repo", "remove_all_repos"],
		]);
		expect(stated.slice(0, 2)).toEqual([13, 12]);
	});

	it("reads the other file's different phrasing of the same fact", () => {
		const alt =
			'- Thirteen tools require an exact `confirm` value (compared with `===`, never fuzzy-matched). Twelve use the tool\'s own name: `write_agent_file`, `delete_supervision`, `clear_instance_messages`. `remove_repo` is the exception: `confirm: "remove_all_repos"`, and only when removing every repo.';
		const { tools, stated } = parseConfirmProse(alt, known);
		expect(tools.get("remove_repo")).toBe("remove_all_repos");
		expect(stated.slice(0, 2)).toEqual([13, 12]);
	});

	/** The defect #555 measured: `delete_supervision` absent, and the count a word behind. */
	it("surfaces the stale list that shipped — a missing tool AND the wrong stated count", () => {
		const stale =
			'- Twelve tools require an exact `confirm` value, compared with `===`. In eleven cases the value is the tool\'s own name: `write_agent_file`, `clear_instance_messages`, `remove_repo`. The exception is `remove_repo`, which takes `confirm: "remove_all_repos"`.';
		const { tools, stated } = parseConfirmProse(stale, known);
		expect(tools.has("delete_supervision")).toBe(false);
		expect(stated.slice(0, 2)).toEqual([12, 11]);
	});

	it("reports lines:0 when the sentence is gone, so its absence cannot read as agreement", () => {
		expect(parseConfirmProse("Use `dry_run: true` before uncertain changes.", known).lines).toBe(0);
		expect(
			parseConfirmProse("- Require exact `confirm` values for destructive tools.", known).lines,
		).toBe(0);
	});
});

describe("diffConfirm", () => {
	const actual = new Map([
		["write_agent_file", { expected: "write_agent_file" }],
		["delete_supervision", { expected: "delete_supervision" }],
		["remove_repo", { expected: "remove_all_repos" }],
	]);

	it("is silent when the document matches the code", () => {
		const documented = new Map([
			["write_agent_file", "write_agent_file"],
			["delete_supervision", "delete_supervision"],
			["remove_repo", "remove_all_repos"],
		]);
		expect(diffConfirm(actual, documented)).toEqual({ missing: [], phantom: [], wrong: [] });
	});

	it("names the gate a document forgot, the one it invented, and the value it got wrong", () => {
		const documented = new Map([
			["write_agent_file", "write_agent_file"],
			["remove_repo", "remove_repo"],
			["delete_everything", "delete_everything"],
		]);
		expect(diffConfirm(actual, documented)).toEqual({
			missing: ["delete_supervision"],
			phantom: ["delete_everything"],
			wrong: [{ tool: "remove_repo", documented: "remove_repo", actual: "remove_all_repos" }],
		});
	});
});
