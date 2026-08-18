/**
 * platform-guide.mjs — the guard over `PLATFORM_GUIDE`, the one MCP document a MODEL reads
 * and the only one nothing compared to anything (#703).
 *
 * ── What was unmeasured, and why it is the document that matters most
 *
 * `docs-drift.mjs` is thorough about every MCP doc a DEVELOPER reads. `workers/mcp/README.md`'s
 * tool table must match the registered set exactly, both directions. `MCP_TOOL_COUNT` must equal
 * the real registration count. Every "N tools" claim in `platform-docs/mcp.md`,
 * `store/llms-full.txt` and the README must equal it. The per-surface gated table must add up.
 *
 *     $ grep -rn "PLATFORM_GUIDE" scripts/docs-drift.mjs workers/mcp/src/*.test.ts
 *     (no matches)
 *
 * `PLATFORM_GUIDE` is the string the always-on `platform_guide` tool RETURNS — the answer a model
 * gets when it asks what this platform can do. Measured on 2026-08-18 it hand-listed 26 of 141
 * registered tools and named no coding tool and no observability tool at all, so a model asking
 * "can I see inside a running loop?" got a document in which the answer was no. It is also the
 * only one of these documents that is SERVED at runtime, and the only one that can reach a client
 * whose `tools/list` is cached from before a deploy — `platform_guide` has been on the surface
 * since long before any current cache was taken.
 *
 * It is excluded from the surface fingerprint, correctly: `server-version.ts:56-58` excludes even
 * a tool's description, and this is a tool's return VALUE, further out still. So nothing failed
 * when it went stale — the same argument `tool-count.ts` makes about the `/health` count that read
 * 41 while 124 were registered.
 *
 * ── What this checks, and the one thing it deliberately does NOT
 *
 *   A. every tool name in the guide is REGISTERED — catches a phantom, which is the failure that
 *      costs a caller an error rather than an omission.
 *   B. every count claim in the guide equals the constants — catches the number rotting.
 *   C. the guide INTERPOLATES those numbers rather than typing them, and tells the reader to
 *      enumerate with `tools/list`. Structural anchors, not golden prose: a check that pinned the
 *      wording would fail on every honest edit, which is the rule `wire-surface.mjs` states.
 *
 * NOT "the guide must name every registered tool". A guide that lists 143 tools is not a guide, it
 * is the README with the table removed — and the README's table is already held to the registered
 * set exactly, both directions. The hand-list is the part that rots, and (C) is what removes the
 * need for one.
 *
 * ── Why every snake_case token must be a tool
 *
 * Arm A needs a rule for deciding which words in a document are tool names, and an ALLOWLIST of
 * "words that look like tools but are not" is the hand-maintained restatement this whole cluster
 * of checks exists to delete. So the rule is the strict one: in THIS document, a snake_case token
 * IS a tool name, wildcards included — a model cannot call `coding_loop_*`, so naming one is a
 * defect rather than a shorthand. It makes the guide's vocabulary checkable without a second
 * inventory. {@link NON_TOOL_TOKENS} is the escape hatch, empty today, and an entry in it that
 * matches nothing FAILS as dead config, the rule `KNOWN_GAPS`, `PINS` and `UNBACKED_CLAIMS` all
 * carry.
 *
 * ── ADR 0002 (a guard states what it measured)
 *
 *  - G1: the guide must be found, the constants must parse, and the guide must name at least
 *    {@link MIN_TOOLS_NAMED} registered tools. Arm A over a document naming no tools passes by
 *    vacuity, which is exactly how a check comes to certify ground it never walked.
 *  - G2: the success note names the tools found, the claims compared and the constants.
 *
 * Same contract as `mcp-split.mjs` and `wire-surface.mjs`: strings in, `{failures, notes}` out,
 * no filesystem — so the tests can feed it the shape that broke it rather than whatever the repo
 * happens to contain today.
 */

import { findSplitClaims, findToolCountClaims } from "./doc-claims.mjs";

/**
 * Tokens that are snake_case and are NOT tool names. Empty, and that is a decision: the guide is
 * ours to write, and every snake_case word in it today is a tool. An entry here is a claim that
 * some non-tool identifier must appear in the guide, so it is checked like every other claim —
 * one that matches nothing fails rather than sitting there.
 * @type {string[]}
 */
export const NON_TOOL_TOKENS = [];

/** Below this, arm A is passing because the guide names nothing, not because it is correct. */
const MIN_TOOLS_NAMED = 4;

/**
 * A tool name as this document writes them — `agent_trace`, `coding_session_capture`.
 *
 * The trailing segment is `[a-z0-9]*`, allowing EMPTY, and that is not sloppiness: `\b` cannot
 * fire between `coding_loop` and the `_` of `coding_loop_*`, so a stricter pattern matched a
 * wildcard as nothing at all and let it through as prose. It now yields `coding_loop_`, which is
 * not a registered name and is correctly reported — a model cannot call a wildcard.
 */
const SNAKE_TOKEN = /\b[a-z][a-z0-9]*(?:_[a-z0-9]*)+/g;

/**
 * Pull the guide out of `workers/mcp/src/platform-guide.ts`.
 *
 * The template literal carries `${…}` interpolations and no backticks of its own, so the
 * terminator is unambiguous. Returned as SOURCE — arm C is about what the source says, and
 * rendering first would erase the distinction between an interpolated number and a typed one,
 * which is the entire point of AC2.
 *
 * @param {string} guideSrc
 * @returns {string | null}
 */
export function extractPlatformGuide(guideSrc) {
	const m = guideSrc.match(/(?:export )?const PLATFORM_GUIDE = `([\s\S]*?)`;/);
	return m ? m[1] : null;
}

/** `export const NAME = 123` out of `tool-count.ts`. @param {string} src @param {string} name */
function constOf(src, name) {
	const m = src.match(new RegExp(`export const ${name} = (\\d+)`));
	return m ? Number(m[1]) : null;
}

/**
 * Compare `PLATFORM_GUIDE` to the surface it describes.
 *
 * @param {{guideSrc: string, toolCountSrc: string, registered: Set<string>}} input
 * @returns {{failures: {check: string, message: string}[], notes: string[]}}
 */
export function checkPlatformGuide({ guideSrc, toolCountSrc, registered }) {
	/** @type {{check: string, message: string}[]} */
	const failures = [];
	/** @type {string[]} */
	const notes = [];
	const fail = (message) => failures.push({ check: "mcp-guide", message });

	const guide = extractPlatformGuide(guideSrc);
	if (guide === null) {
		fail(
			"workers/mcp/src/platform-guide.ts no longer defines PLATFORM_GUIDE as a template literal.\n" +
				"  That string is what the always-on `platform_guide` tool returns — the capability\n" +
				"  document a model reads. If it moved, point this check at where it went; a check that\n" +
				"  cannot find its subject must say so rather than pass.",
		);
		return { failures, notes };
	}

	const total = constOf(toolCountSrc, "MCP_TOOL_COUNT");
	const alwaysOn = constOf(toolCountSrc, "MCP_TOOL_ALWAYS_ON");
	if (total === null || alwaysOn === null) {
		fail("workers/mcp/src/tool-count.ts no longer exports numeric MCP_TOOL_COUNT / MCP_TOOL_ALWAYS_ON.");
		return { failures, notes };
	}
	const gated = total - alwaysOn;
	if (registered.size < MIN_TOOLS_NAMED) {
		fail(`the registered tool set has ${registered.size} entries; the caller's parse of workers/mcp/src is broken.`);
		return { failures, notes };
	}

	// ── C. interpolated, and pointing at the authoritative enumeration ──
	//
	// Checked on the SOURCE, before rendering. A typed literal that happens to be right today is
	// the state this check exists to end: it agrees, silently, until the day it does not.
	if (!guide.includes("${MCP_TOOL_COUNT}")) {
		fail(
			"PLATFORM_GUIDE does not interpolate ${MCP_TOOL_COUNT}.\n" +
				"  A typed number in this string is a number nothing moves when a tool is added — the\n" +
				"  defect that left it describing 26 of 141 tools. Interpolate from tool-count.ts.",
		);
	}
	if (!guide.includes("tools/list")) {
		fail(
			"PLATFORM_GUIDE no longer tells the reader to enumerate the surface with `tools/list`.\n" +
				"  That instruction is what replaces the hand-list this check refuses to maintain, and it\n" +
				"  is the only sentence in the system that reaches a model THROUGH a stale tool cache.",
		);
	}

	// Render the interpolations the guide is allowed to use, so arms A and B measure the string a
	// model actually receives rather than its source form.
	const rendered = guide
		.replaceAll("${MCP_TOOL_COUNT}", String(total))
		.replaceAll("${MCP_TOOL_ALWAYS_ON}", String(alwaysOn))
		.replaceAll("${MCP_TOOL_GATED}", String(gated));

	// ── A. no phantom tool names ──
	const tokens = [...new Set(rendered.match(SNAKE_TOKEN) ?? [])];
	const exempt = new Set(NON_TOOL_TOKENS);
	const named = tokens.filter((t) => registered.has(t));
	const phantom = tokens.filter((t) => !registered.has(t) && !exempt.has(t));
	if (phantom.length) {
		fail(
			`PLATFORM_GUIDE names ${phantom.length} tool(s) that are not registered: ${phantom.sort().join(", ")}.\n` +
				"  A model reads this document and calls what it names, so a phantom costs a failed call\n" +
				"  rather than a missing capability. If one of these is not a tool name, it does not belong\n" +
				"  in snake_case here — or add it to NON_TOOL_TOKENS as a decision.",
		);
	}
	const deadExemptions = NON_TOOL_TOKENS.filter((t) => !tokens.includes(t));
	if (deadExemptions.length) {
		fail(
			`NON_TOOL_TOKENS lists ${deadExemptions.length} token(s) that do not appear in PLATFORM_GUIDE: ${deadExemptions.join(", ")}.\n` +
				"  Dead config in a guard is how the guard stops being believed.",
		);
	}
	if (named.length < MIN_TOOLS_NAMED) {
		fail(
			`PLATFORM_GUIDE names ${named.length} registered tool(s); the phantom check needs at least ${MIN_TOOLS_NAMED} to mean anything.\n` +
				"  A capability document that names no capability passes arm A by vacuity, which is worse\n" +
				"  than the drift it replaced: it reads exactly like a clean tree.",
		);
	}

	// ── B. the numbers agree with the constants ──
	const bad = [];
	for (const c of findToolCountClaims(rendered)) {
		if (c.claimed !== total) bad.push(`line ${c.n}: says ${c.claimed} tools, MCP_TOOL_COUNT is ${total} — ${c.line.slice(0, 100)}`);
	}
	const split = findSplitClaims(rendered);
	for (const c of split.alwaysOn) {
		if (c.claimed !== alwaysOn) bad.push(`line ${c.n}: says ${c.claimed} always-on, MCP_TOOL_ALWAYS_ON is ${alwaysOn} — ${c.line.slice(0, 100)}`);
	}
	for (const c of split.gated) {
		if (c.claimed !== gated) bad.push(`line ${c.n}: says ${c.claimed} gated, MCP_TOOL_COUNT - MCP_TOOL_ALWAYS_ON is ${gated} — ${c.line.slice(0, 100)}`);
	}
	if (bad.length) {
		fail(`PLATFORM_GUIDE makes ${bad.length} count claim(s) that disagree with tool-count.ts:\n${bad.map((b) => `    ${b}`).join("\n")}`);
	}

	if (!failures.length) {
		notes.push(
			`MCP platform guide: ${named.length} tool name(s) all registered, ` +
				`${findToolCountClaims(rendered).length + split.alwaysOn.length + split.gated.length} count claim(s) == ` +
				`${total}/${alwaysOn}/${gated}, interpolated from tool-count.ts (${NON_TOOL_TOKENS.length} exempt token(s))`,
		);
	}
	return { failures, notes };
}
