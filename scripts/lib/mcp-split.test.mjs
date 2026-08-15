import { describe, expect, it } from "vitest";
import { checkMcpSplit, SPLIT_MUST_CLAIM } from "./mcp-split.mjs";

/**
 * ADR 0002 G4 — the check watched failing, for each defect it exists for.
 *
 * #575's defect was three arithmetic errors in one sentence of `workers/mcp/CLAUDE.md`,
 * surviving indefinitely because `MCP_TOOL_ALWAYS_ON` and `MCP_TOOL_GATED` were exported
 * beside a constant that WAS checked and were compared to nothing themselves.
 *
 * Everything below is driven over in-memory files, so each arm can be fed the exact shape
 * that broke — including the shapes that no longer exist in the repo once the text is fixed,
 * which is the whole reason these parsers take strings.
 */

const TOOL_COUNT = [
	"export const MCP_TOOL_COUNT = 135;",
	"export const MCP_TOOL_ALWAYS_ON = 117;",
	"export const MCP_TOOL_GATED = MCP_TOOL_COUNT - MCP_TOOL_ALWAYS_ON;",
].join("\n");

/** The three required files, each stating the split the way it really does, plus filler to
 *  clear the sweep floor — the floor is part of the check and must be satisfied honestly. */
const baseFiles = (overrides = {}) => {
	const files = {
		"workers/mcp/CLAUDE.md": "117 are always registered; 18 are surface-gated (apply=4, repo=3, coding=11).",
		"workers/mcp/README.md": "**135 tool registrations.** 117 are always registered; 18 are gated to the console",
		"platform-docs/mcp.md": "The server registers **135 tools**. 117 are always present. The remaining 18 are gated to",
		...overrides,
	};
	for (let i = 0; i < 20; i++) files[`platform-docs/filler-${i}.md`] = "prose with no split claim";
	return Object.entries(files).map(([name, src]) => ({ name, src }));
};

const run = (overrides, toolCountSrc = TOOL_COUNT) =>
	checkMcpSplit({ toolCountSrc, files: baseFiles(overrides) });

const messages = (res) => res.failures.map((f) => f.message).join("\n");

describe("checkMcpSplit", () => {
	it("is silent when every claim agrees, and states its denominator", () => {
		const res = run();
		expect(res.failures).toEqual([]);
		// 7 = three always-on + three gated + CLAUDE.md's per-surface breakdown, which is a
		// checked claim in its own right because it shares a line with a gated claim.
		expect(res.notes).toEqual([
			"MCP always-on/gated split: 117 always-on + 18 gated == 135 constant == 7 claim(s) across 3 file(s) stating it, 23 swept (3 required to state it)",
		]);
	});

	it("goes red on the exact sentence that shipped, naming both of its checkable errors (#575)", () => {
		const res = run({
			"workers/mcp/CLAUDE.md":
				"`instance-tools/`. 114 are always registered; 18 are surface-gated (apply=4, repo=3, coding=11+3).",
		});
		expect(res.failures).toHaveLength(1);
		expect(messages(res)).toContain("always-on says 114, constant says 117");
		expect(messages(res)).toContain("per-surface breakdown (apply=4, repo=3, coding=11+3) says 21, constant says 18");
		// The third error — 114 + 18 missing the 135 two lines above — needs no arm of its
		// own: it cannot survive both of the above being pinned to the constants.
	});

	it("catches a wrong gated count, in each of the three phrasings the docs use", () => {
		for (const [file, line] of [
			["workers/mcp/CLAUDE.md", "117 are always registered; 21 are surface-gated"],
			["workers/mcp/README.md", "117 are always registered; 21 are gated to the console"],
			["platform-docs/mcp.md", "117 are always present. The remaining 21 are gated to"],
		]) {
			const res = run({ [file]: line });
			expect(messages(res), file).toContain("surface-gated says 21, constant says 18");
		}
	});

	it("fails when a required file stops stating the split, rather than reading it as agreement", () => {
		// The #555 failure mode, which is the one that is invisible: not a wrong number, but
		// a rewrite that slips past the regex. "117 always-on" matches neither pattern.
		const res = run({ "platform-docs/mcp.md": "The server has 117 always-on and 18 gated tools." });
		expect(messages(res)).toContain("1 file(s) are listed as stating the always-on/gated split and no longer do");
		expect(messages(res)).toContain("platform-docs/mcp.md");
	});

	it("keeps a CORRECT file in the required set — agreeing today is not a reason to stop looking", () => {
		// platform-docs/mcp.md was right the whole time #575 was wrong. Dropping it because
		// it agrees is exactly how store/.well-known/mcp-server.json hid from the first pass
		// of the wire-surface check on #573.
		expect(SPLIT_MUST_CLAIM).toContain("platform-docs/mcp.md");
		const res = run({ "platform-docs/mcp.md": "117 are always present. The remaining 99 are gated to" });
		expect(messages(res)).toContain("platform-docs/mcp.md");
		expect(messages(res)).toContain("says 99, constant says 18");
	});

	it("checks a file that is swept but not required, without demanding it speak", () => {
		// store/llms-full.txt states the split today but is not REQUIRED to, so it is
		// checked-if-present. (This comment said "and is generated" until #604. It is not:
		// README.md:330 lists it as hand-edited source and no generator exists — see the
		// corrected note in mcp-split.mjs.) Both halves asserted: a wrong number in it fails…
		const bad = run({ "store/llms-full.txt": "117 are always present. The remaining 4 are gated to" });
		expect(messages(bad)).toContain("store/llms-full.txt");
		// …and its silence does not.
		expect(run({ "store/llms-full.txt": "nothing about the split here" }).failures).toEqual([]);
	});

	it("ignores a parenthetical that does not share a line with a gated claim", () => {
		const res = run({ "platform-docs/filler-0.md": "a config sample (retries=3, backoff=2)" });
		expect(res.failures).toEqual([]);
	});

	// ── G1: the input set and the authority, asserted rather than assumed ────────

	it("fails rather than passes when the constants cannot be read", () => {
		const res = run({}, "export const SOMETHING_ELSE = 1;");
		expect(messages(res)).toContain("no longer exports numeric MCP_TOOL_COUNT and MCP_TOOL_ALWAYS_ON");
		expect(res.notes).toEqual([]);
	});

	it("fails rather than passes when the sweep collapses", () => {
		// An empty offender list over three files is indistinguishable from a clean tree,
		// which is the whole of ADR 0002 G1.
		const res = checkMcpSplit({
			toolCountSrc: TOOL_COUNT,
			files: [{ name: "platform-docs/mcp.md", src: "117 are always present. The remaining 18 are gated to" }],
		});
		expect(messages(res)).toContain("swept 1 file(s), expected at least 20");
		expect(res.notes).toEqual([]);
	});
});
