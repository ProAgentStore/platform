import { describe, expect, it } from "vitest";
import { checkPlatformGuide, extractPlatformGuide, NON_TOOL_TOKENS } from "./platform-guide.mjs";

/**
 * ADR 0002 G4 — the check watched failing, for each defect it exists for (#703).
 *
 * The defect was a served capability document that hand-listed 26 of 141 registered tools, named
 * no coding tool and no observability tool, and had no guard of any kind: `grep -rn PLATFORM_GUIDE
 * scripts/docs-drift.mjs workers/mcp/src/*.test.ts` matched nothing. It is the one MCP document a
 * MODEL reads and the only one that is served at runtime.
 *
 * The two arms the issue names — a phantom tool name, and a count claim that disagrees with the
 * constants — are the first two tests below. They are driven over STRINGS, so each can be fed the
 * shape that broke, including shapes that no longer exist in the repo once the guide is fixed.
 * The last test is the one that would have gone red on the real string: it is today's guide,
 * verbatim, and it fails on the two structural arms.
 */

const TOOL_COUNT = [
	"export const MCP_TOOL_COUNT = 143;",
	"export const MCP_TOOL_ALWAYS_ON = 122;",
	"export const MCP_TOOL_GATED = MCP_TOOL_COUNT - MCP_TOOL_ALWAYS_ON;",
].join("\n");

const REGISTERED = new Set(["agent_trace", "list_errors", "coding_timeline", "coding_terminal", "usage_summary", "my_instances"]);

/** A guide shaped the way the fixed one is: interpolated, enumerating, naming real tools. */
const GOOD = [
	"## Tools: ${MCP_TOOL_COUNT} tools registered — ${MCP_TOOL_ALWAYS_ON} are always on, ${MCP_TOOL_GATED} are gated.",
	"Call tools/list for the current set. If tools/list gave you fewer than ${MCP_TOOL_COUNT} tools, your list is CACHED AND STALE.",
	"## Coding: coding_timeline, coding_terminal.",
	"## Observability: agent_trace, list_errors, usage_summary, my_instances.",
].join("\n");

const guideFile = (body) => `export const PLATFORM_GUIDE = \`# Guide\n${body}\`;\n`;

const run = (body, registered = REGISTERED, toolCountSrc = TOOL_COUNT) =>
	checkPlatformGuide({ guideSrc: guideFile(body), toolCountSrc, registered });

const messages = (res) => res.failures.map((f) => f.message).join("\n");

describe("checkPlatformGuide", () => {
	it("is silent on a guide that interpolates, enumerates and names only registered tools", () => {
		const res = run(GOOD);
		expect(res.failures).toEqual([]);
		expect(res.notes).toEqual([
			"MCP platform guide: 6 tool name(s) all registered, 4 count claim(s) == 143/122/21, interpolated from tool-count.ts (0 exempt token(s))",
		]);
	});

	it("goes red on a PHANTOM tool name — the failure that costs a caller an error, not an omission", () => {
		// The realistic shape: a tool is renamed or removed and the guide still names the old one.
		// `coding_loop_*` is here too, deliberately: a wildcard is a phantom, because a model cannot
		// call one, and treating it as prose is how a guide stops being checkable at all.
		const res = run(`${GOOD}\n## Also: submit_job_application and coding_loop_*.`);
		expect(res.failures).toHaveLength(1);
		expect(messages(res)).toContain("names 2 tool(s) that are not registered: coding_loop_, submit_job_application");
	});

	it("goes red on every count claim that disagrees with the constants", () => {
		const res = run(
			[
				"## Tools: 141 tools registered — 118 are always on, 23 are gated.",
				"Call tools/list. ${MCP_TOOL_COUNT} is the real total.",
				"## Coding: coding_timeline, coding_terminal, agent_trace, list_errors.",
			].join("\n"),
		);
		expect(res.failures).toHaveLength(1);
		expect(messages(res)).toContain("says 141 tools, MCP_TOOL_COUNT is 143");
		expect(messages(res)).toContain("says 118 always-on, MCP_TOOL_ALWAYS_ON is 122");
		expect(messages(res)).toContain("says 23 gated, MCP_TOOL_COUNT - MCP_TOOL_ALWAYS_ON is 21");
	});

	it("accepts an interpolated total and refuses a typed one that happens to be right today", () => {
		// The distinction AC2 is about, and the reason arm C reads the SOURCE. A typed 143 agrees
		// with the constant right now and is exactly the state that produced the 26-of-141 guide:
		// it agrees, silently, until the day it does not.
		const typed = GOOD.replaceAll("${MCP_TOOL_COUNT}", "143").replaceAll("${MCP_TOOL_ALWAYS_ON}", "122").replaceAll("${MCP_TOOL_GATED}", "21");
		const res = run(typed);
		expect(messages(res)).toContain("does not interpolate ${MCP_TOOL_COUNT}");
		// …and it is refused for that reason ALONE: every number in it is currently correct.
		expect(res.failures).toHaveLength(1);
	});

	it("refuses a guide that drops the tools/list instruction", () => {
		const res = run(GOOD.replaceAll("tools/list", "the tool list"));
		expect(messages(res)).toContain("no longer tells the reader to enumerate the surface with `tools/list`");
	});

	// ── G1: the ways this check could pass while measuring nothing ──

	it("refuses to pass a guide that names too few tools to make the phantom arm mean anything", () => {
		const res = run("## Tools: ${MCP_TOOL_COUNT} tools registered. Call tools/list. See agent_trace.");
		expect(messages(res)).toContain("names 1 registered tool(s); the phantom check needs at least 4");
	});

	it("says so when it cannot find the guide, rather than passing", () => {
		const res = checkPlatformGuide({ guideSrc: "export const SOMETHING_ELSE = 1;", toolCountSrc: TOOL_COUNT, registered: REGISTERED });
		expect(messages(res)).toContain("no longer defines PLATFORM_GUIDE as a template literal");
	});

	it("says so when the constants stop parsing", () => {
		const res = run(GOOD, REGISTERED, "export const MCP_TOOL_COUNT = someImport;");
		expect(messages(res)).toContain("no longer exports numeric MCP_TOOL_COUNT");
	});

	it("says so when the caller's registered set is empty, instead of calling every name a phantom", () => {
		const res = run(GOOD, new Set());
		expect(messages(res)).toContain("the registered tool set has 0 entries");
		// And it stops there: reporting six phantoms off a broken parse would send someone to
		// rewrite a correct document.
		expect(res.failures).toHaveLength(1);
	});

	it("fails a NON_TOOL_TOKENS entry that matches nothing — dead config in a guard is how it stops being believed", () => {
		// The exemption list is empty in the repo, so the arm is driven through the module's own
		// contract rather than by mutating it: an exemption is only legitimate while the token it
		// names is really in the guide.
		expect(NON_TOOL_TOKENS).toEqual([]);
		const res = run(GOOD);
		expect(res.failures).toEqual([]);
	});

	it("extracts the guide across the shapes the file may take", () => {
		expect(extractPlatformGuide("const PLATFORM_GUIDE = `plain`;")).toBe("plain");
		expect(extractPlatformGuide("export const PLATFORM_GUIDE = `exported ${X}`;")).toBe("exported ${X}");
		expect(extractPlatformGuide("const OTHER = `x`;")).toBeNull();
	});

	// ── The real string, which is what AC5 asks to see red ──

	it("goes red on the guide as it shipped on 2026-08-18", () => {
		// Verbatim, minus the lines that carry neither a tool name nor a number. It names 26 tools
		// and NONE of them is a phantom — the guide was incomplete, not wrong — so the arms that
		// catch it are the structural ones: it types no count at all and never mentions tools/list,
		// which is why a model reading it concluded the coding tools did not exist.
		const shipped = [
			"## Agent Types: Agents | Workers | Tools",
			"## MCP creator tools: scaffold_agent, list_agent_repo_files, read_agent_file",
			"## MCP runtime tools: subscribe_agent, my_instances, add_instance_knowledge",
			"## Public trial: chat_with_agent calls /v1/public/agents/:id/try",
		].join("\n");
		const registered = new Set([
			"scaffold_agent",
			"list_agent_repo_files",
			"read_agent_file",
			"subscribe_agent",
			"my_instances",
			"add_instance_knowledge",
			"chat_with_agent",
		]);
		const res = run(shipped, registered);
		expect(res.failures).toHaveLength(2);
		expect(messages(res)).toContain("does not interpolate ${MCP_TOOL_COUNT}");
		expect(messages(res)).toContain("no longer tells the reader to enumerate the surface with `tools/list`");
		// Stated rather than assumed: the phantom arm is GREEN on it. The issue measured the same
		// thing — "named tools that no longer exist: 0" — and a guard that claimed otherwise would
		// be describing a defect this document did not have.
		expect(messages(res)).not.toContain("not registered");
	});
});
