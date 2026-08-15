/**
 * mcp-split.mjs — the always-on / surface-gated arm of `scripts/docs-drift.mjs` (#575).
 *
 * ── What was unmeasured
 *
 * `workers/mcp/src/tool-count.ts` exports THREE numbers. Check 6 compared one of them to
 * anything:
 *
 *     MCP_TOOL_COUNT     = 135   ← swept across ~40 documents, and has been since #555
 *     MCP_TOOL_ALWAYS_ON = 117   ← compared to nothing
 *     MCP_TOOL_GATED     = MCP_TOOL_COUNT - MCP_TOOL_ALWAYS_ON   ← compared to nothing
 *
 * So the split could say anything, and did. `workers/mcp/CLAUDE.md:85` carried
 *
 *     "114 are always registered; 18 are surface-gated (apply=4, repo=3, coding=11+3)"
 *
 * which is wrong three separate ways in one sentence: 114 contradicts the constant's 117;
 * 114 + 18 = 132 against the 135 stated two lines earlier in the same paragraph; and the
 * parenthetical sums to 21, not 18. `platform-docs/mcp.md` and `workers/mcp/README.md` both
 * had it right — so the file that was wrong was the one a session working INSIDE the worker
 * reads before touching the tool surface, and the public page was fine.
 *
 * Note what does NOT need its own arm. Once always-on and gated are each pinned to the
 * constants, "the split sums to the total" is true by construction — 117 + 18 = 135 is
 * arithmetic on values this check already forces. A third assertion would restate the
 * subtraction a fourth time, which is the species of duplication the whole file removes.
 *
 * ── Why this is a module and not fifty lines inside docs-drift.mjs
 *
 * It was written inline first, and `check-file-size.mjs` refused it: docs-drift.mjs crossed
 * 800 lines and the ratchet said "add a pin — or split it now, which is cheaper than it will
 * ever be again". Splitting is also what the two neighbours already do (`doc-claims.mjs`,
 * `wire-surface.mjs`), for the reason stated in both: a parser that takes STRINGS can be
 * tested against the shape that broke it, where one that reads the repo can only be tested
 * against whatever the repo happens to contain today.
 *
 * Same contract as `checkWireSurface`: the caller supplies the inputs, this returns
 * `{failures, notes}` and touches no filesystem.
 *
 * ── ADR 0002 (a guard states what it measured)
 *
 *  - G1: the sweep has a floor, and the constants must parse — a check with nothing to
 *    compare against reports that rather than passing.
 *  - G1: three files MUST produce a claim. A sentence rephrased past both regexes retires
 *    the check on that file and reads exactly like agreement, which is the failure #555
 *    shipped. `platform-docs/mcp.md` is in that list although it is CORRECT today: a file
 *    that agrees is precisely how `store/.well-known/mcp-server.json` hid from the first
 *    pass of the wire-surface check on #573.
 *  - G2: the success line names both constants, the claim count and the sweep size.
 */

import { findSplitClaims } from "./doc-claims.mjs";

/**
 * Files that MUST state the split, and are therefore the denominator's other half.
 *
 * `store/llms-full.txt` is deliberately NOT here even though it does state it: it is
 * generated from the docs, so requiring a claim from it would fail the day its generator
 * changed shape, for a reason having nothing to do with the split. It is still SWEPT, so a
 * wrong number in it is caught — required-to-state and checked-if-present are different
 * obligations and this file needs only the second.
 */
export const SPLIT_MUST_CLAIM = [
	"workers/mcp/CLAUDE.md",
	"workers/mcp/README.md",
	"platform-docs/mcp.md",
];

/** The floor below which the sweep is assumed broken rather than the tree assumed clean. */
const SWEEP_FLOOR = 20;

/**
 * Compare every documented always-on / gated / per-surface claim to the constants.
 *
 * @param {{toolCountSrc: string, files: {name: string, src: string}[]}} input
 *        `files` is docFiles() + servedHtmlFiles(), already read — the same sweep check 6
 *        uses, so the two checks cannot disagree about what the trusted surface is.
 * @returns {{failures: {check: string, message: string}[], notes: string[]}}
 */
export function checkMcpSplit({ toolCountSrc, files }) {
	const failures = [];
	const notes = [];
	const fail = (message) => failures.push({ check: "mcp-split", message });

	const constOf = (name) => {
		const m = toolCountSrc.match(new RegExp(`export const ${name} = (\\d+)`));
		return m ? Number(m[1]) : null;
	};
	const total = constOf("MCP_TOOL_COUNT");
	const alwaysOn = constOf("MCP_TOOL_ALWAYS_ON");
	if (total === null || alwaysOn === null) {
		fail(
			"workers/mcp/src/tool-count.ts no longer exports numeric MCP_TOOL_COUNT and MCP_TOOL_ALWAYS_ON.\n" +
				"  This check has nothing to compare the docs to, and is saying so rather than passing.",
		);
		return { failures, notes };
	}
	// Derived the way tool-count.ts derives MCP_TOOL_GATED, not restated. A fourth
	// hand-typed copy of this subtraction is the thing being guarded against.
	const gated = total - alwaysOn;

	if (files.length < SWEEP_FLOOR) {
		fail(
			`swept ${files.length} file(s), expected at least ${SWEEP_FLOOR}.\n` +
				"  docFiles() + servedHtmlFiles() are ~40 files together; a sweep this small has lost a\n" +
				"  directory, and would compare the split against almost nothing. This is a check that\n" +
				"  has stopped measuring, not a clean tree.",
		);
		return { failures, notes };
	}

	const bad = [];
	const stated = new Map();
	let claims = 0;
	for (const { name, src } of files) {
		const { alwaysOn: aClaims, gated: gClaims, breakdowns } = findSplitClaims(src);
		if (aClaims.length || gClaims.length) stated.set(name, aClaims.length + gClaims.length);
		claims += aClaims.length + gClaims.length;
		for (const c of aClaims) {
			if (c.claimed !== alwaysOn) bad.push({ name, ...c, expected: alwaysOn, what: "always-on" });
		}
		for (const c of gClaims) {
			if (c.claimed !== gated) bad.push({ name, ...c, expected: gated, what: "surface-gated" });
		}
		// Only a breakdown sharing a LINE with a gated claim restates that claim. An
		// unrelated `(retries=3, backoff=2)` elsewhere in the prose does not, and asserting
		// over it would manufacture a false failure — which is how a check earns deletion.
		const gatedLines = new Set(gClaims.map((c) => c.n));
		for (const b of breakdowns) {
			if (!gatedLines.has(b.n)) continue;
			claims += 1;
			if (b.sum !== gated) {
				bad.push({
					name,
					...b,
					claimed: b.sum,
					expected: gated,
					what: `per-surface breakdown (${b.parts})`,
				});
			}
		}
	}

	if (bad.length) {
		fail(
			`${bad.length} doc claim(s) disagree with the tool-count constants ` +
				`(MCP_TOOL_ALWAYS_ON ${alwaysOn}, gated ${gated} = ${total} - ${alwaysOn}), ` +
				`out of ${files.length} file(s) swept:\n` +
				bad
					.map(
						(b) =>
							`    ${b.name}:${b.n}  ${b.what} says ${b.claimed}, constant says ${b.expected}\n` +
							`      ${b.line.slice(0, 120)}`,
					)
					.join("\n"),
		);
	}

	const silent = SPLIT_MUST_CLAIM.filter((name) => !stated.get(name));
	if (silent.length) {
		fail(
			`${silent.length} file(s) are listed as stating the always-on/gated split and no longer do:\n` +
				silent.map((name) => `    ${name}`).join("\n") +
				"\n  Either the file left the swept set, or the sentence was rephrased past both regexes\n" +
				'  ("117 always-on" matches neither). A claim that stops being visible to this check is\n' +
				"  indistinguishable from one that agrees — the failure mode #555 shipped. Restore the\n" +
				"  phrasing, widen findSplitClaims, or drop the file from SPLIT_MUST_CLAIM as a decision.",
		);
	}

	if (!failures.length) {
		notes.push(
			`MCP always-on/gated split: ${alwaysOn} always-on + ${gated} gated == ${total} constant == ` +
				`${claims} claim(s) across ${stated.size} file(s) stating it, ${files.length} swept ` +
				`(${SPLIT_MUST_CLAIM.length} required to state it)`,
		);
	}
	return { failures, notes };
}
