import { describe, expect, it } from "vitest";
import {
	diffConfirm,
	findClaimSpans,
	findQuantityMentions,
	findSplitClaims,
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

describe("findSplitClaims", () => {
	it("reads all three phrasings the three files actually use", () => {
		// Not invented: these are the live sentences from platform-docs/mcp.md:321,
		// workers/mcp/README.md:129 and workers/mcp/CLAUDE.md:189 respectively. A parser
		// tested only against the phrasing someone wrote first is a parser that stops
		// measuring the moment a second file says it differently.
		const src = [
			"The server registers **135 tools**. 117 are always present. The remaining 18 are gated to",
			"**135 tool registrations.** 117 are always registered; 18 are gated to the console",
			"given connection, because 18 tools are surface-gated.",
		].join("\n");
		const { alwaysOn, gated } = findSplitClaims(src);
		expect(alwaysOn.map((c) => [c.n, c.claimed])).toEqual([
			[1, 117],
			[2, 117],
		]);
		expect(gated.map((c) => [c.n, c.claimed])).toEqual([
			[1, 18],
			[2, 18],
			[3, 18],
		]);
	});

	it("reads the exact broken line that shipped, in all three of the ways it was wrong (#575)", () => {
		const line =
			"`instance-tools/`. 114 are always registered; 18 are surface-gated (apply=4, repo=3, coding=11+3).";
		const { alwaysOn, gated, breakdowns } = findSplitClaims(line);
		expect(alwaysOn[0].claimed).toBe(114); // against a constant of 117
		expect(gated[0].claimed).toBe(18);
		// 4 + 3 + 11 + 3 — the parenthetical did not sum to the 18 beside it.
		expect(breakdowns).toEqual([
			{ n: 1, sum: 21, parts: "apply=4, repo=3, coding=11+3", line },
		]);
		// And the sum error is only catchable because the breakdown shares a line with the
		// gated claim — which is how docs-drift decides a parenthetical restates that claim
		// rather than being unrelated prose.
		expect(breakdowns[0].n).toBe(gated[0].n);
	});

	/**
	 * The failure mode the narrow regexes CANNOT see, recorded rather than argued — the
	 * same trap as `findToolCountClaims` above, and the reason docs-drift keeps a
	 * MUST_CLAIM list rather than trusting a sweep to have found everything.
	 */
	it("does NOT see 'N always-on' or a spelled numeral — which is why the caller asserts a non-empty result", () => {
		expect(findSplitClaims("117 always-on, 18 gated.").alwaysOn).toEqual([]);
		// Real line from workers/mcp/README.md:282. Correctly not a claim about the total:
		// matching spelled numerals would turn every subset sentence into a false failure.
		expect(findSplitClaims("All six are always registered — the `coding_loop_*` tools").alwaysOn).toEqual([]);
	});

	it("ignores a parenthetical that is not beside a gated claim, so unrelated prose cannot fail the build", () => {
		// The breakdown parser is deliberately shape-based and will match this; docs-drift
		// discards it because no gated claim shares the line. Asserted here so the division
		// of labour between parser and caller is pinned, not assumed.
		const { gated, breakdowns } = findSplitClaims("a config sample (retries=3, backoff=2)");
		expect(gated).toEqual([]);
		expect(breakdowns).toHaveLength(1);
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

describe("findQuantityMentions — the population the parsers above are graded against", () => {
	/**
	 * The sentence this function exists for. `findSplitClaims` and `findToolCountClaims` both
	 * return `[]` for it (asserted below, so the premise cannot rot); it was in the swept set
	 * and `pnpm docs:drift` was green with it present. A mention detector that misses it is
	 * worth nothing, which is why this is the first assertion in the block.
	 */
	const DEFECT = "   *per-connection*: 18 of the 124 registrations are gated to the console surfaces of the";

	it("sees the claim that thirteen green checks did not", () => {
		expect(findToolCountClaims(DEFECT), "premise: the total parser is blind to this").toEqual([]);
		const { alwaysOn, gated } = findSplitClaims(DEFECT);
		expect([...alwaysOn, ...gated], "premise: the split parser is blind to this").toEqual([]);

		const mentions = findQuantityMentions(DEFECT);
		expect(mentions.map((m) => [m.text, m.shape])).toEqual([
			["124 registrations", "noun"],
			["124 registrations are gated", "verb"],
		]);
	});

	it("reads the phrasings the extractors deliberately do not", () => {
		// Every one of these is a real claim about the surface that no check compares to
		// anything. That is the point: a mention is not an extraction.
		expect(findQuantityMentions("The server registers 135 MCP tools.")[0].text).toBe("135 MCP tools");
		expect(findQuantityMentions("18 of the 124 registrations")[0].text).toBe("124 registrations");
		expect(findQuantityMentions("117 tools are always registered")[0].shape).toBe("noun");
		expect(findQuantityMentions("19 are surface-gated")[0].shape).toBe("verb");
	});

	it("reads across a backticked code span, which is where a real stale count hid", () => {
		// docs/mcp-instance-runtime.md:110 — "120 `server.tool(...)` registrations", a genuinely
		// stale number. A words-only filler could not cross the code span, so the detector missed
		// it while reporting the file clean, and it was handed to this lane as already caught.
		const m = findQuantityMentions("The server currently has 120 `server.tool(...)` registrations across `workers/mcp/src`.");
		expect(m.map((x) => x.claimed)).toEqual([120]);
	});

	it("does not read `registration` as a tool registration when it is somebody else's noun", () => {
		// The only false-positive class measured over docs/, twice in one file: RFC 7591 is a
		// number beside the word "registration", and is about OAuth client registration.
		// Bare `registration` is therefore a mention only in the PLURAL.
		expect(findQuantityMentions("now RFC 7591 dynamic client registration (`lib/connectors/dcr.ts`)")).toEqual([]);
		expect(findQuantityMentions("**RFC 7591 dynamic client registration**")).toEqual([]);
		// ...and the discriminating half: the plural IS still read, or the fix would have
		// silenced the sentence this whole guard exists for.
		expect(findQuantityMentions("18 of the 124 registrations are gated")[0].claimed).toBe(124);
		// A tool-qualified singular stays readable, because the qualifier removes the ambiguity.
		expect(findQuantityMentions("1 tool registration")[0].claimed).toBe(1);
	});

	it("requires the number to QUANTIFY the subject, not merely share a line with it", () => {
		// The line-level rule was measured and rejected: 75 lines matched, 50 with no claim on
		// them. These four are the shapes that produced those false positives.
		expect(findQuantityMentions("Registry connectors (issues #84–#90): a tool framework")).toEqual([]);
		expect(findQuantityMentions('<h3 style="color:#22c55e">Tools</h3>')).toEqual([]);
		expect(findQuantityMentions("OAuth 2.1 + PKCE (S256). Tools carry scopes.")).toEqual([]);
		expect(findQuantityMentions("`GHSA-g7r4-m6w7-qqqr` — the tool is unaffected")).toEqual([]);
	});

	/**
	 * ADR 0002's obligation on a hand-rolled scanner: its own test names what it does NOT
	 * handle. Each of these IS a claim about the surface and this detector is blind to it, so
	 * a document written this way is still unguarded. Recorded as a known gap rather than
	 * left to be discovered the way `AGENTS.md:15` was.
	 */
	it("does NOT read a count that follows its subject, or one spelled out", () => {
		expect(findQuantityMentions("`/health` reports tools: 136"), "trailing count — unread").toEqual([]);
		expect(findQuantityMentions("A tool surface of 136."), "count after the noun — unread").toEqual([]);
		expect(findQuantityMentions("all one hundred and thirty-six tools"), "spelled numeral — unread").toEqual([]);
		expect(
			findQuantityMentions("136 of the newly added and separately counted registrations"),
			"more than three words between number and noun — unread",
		).toEqual([]);
	});
});

describe("findClaimSpans — what the extractors already cover, for overlap", () => {
	it("covers the mention inside a claim that is wider than it", () => {
		const line = "117 tools are always registered; 19 are gated to the console";
		const spans = findClaimSpans(line);
		// Every mention on this line must fall inside some claim span, or the shape check would
		// report a false unparsed on a sentence that IS read. This is the assertion that keeps
		// the two halves in step when either regex is edited.
		for (const m of findQuantityMentions(line)) {
			expect(
				spans.some((s) => s.start < m.end && m.start < s.end),
				`"${m.text}" is not covered by any claim span`,
			).toBe(true);
		}
	});

	it("reports nothing for a line carrying no claim", () => {
		expect(findClaimSpans("18 of the 124 registrations are gated")).toEqual([]);
	});
});
