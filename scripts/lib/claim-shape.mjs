/**
 * claim-shape.mjs — the SHAPE arm of `scripts/docs-drift.mjs` (#603).
 *
 * ── What was unmeasured
 *
 * Check 6 and check 6b both compare documented numbers to `tool-count.ts`, and both report
 * how many FILES they swept. Neither reports how many CLAIMS it found, so a sentence no
 * regex matches is indistinguishable from a file with nothing to say — both contribute
 * nothing and both read as agreement.
 *
 * `workers/mcp/AGENTS.md:15` is the bill. It said
 *
 *     "18 of the 124 registrations are gated to the console surfaces of the agents…"
 *
 * against an actual 19 of 136, in the file whose entire job is to be the calling agent's
 * contract. It was in the swept set — `docFiles()` adds an `AGENTS.md` from every worker — and
 * `pnpm docs:drift` reported all thirteen checks green with the sentence present. Stepped
 * through before this was written: `findSplitClaims` and `findToolCountClaims` both return
 * `[]` for that line, and for the whole file. The cause is the PHRASING, not an exclusion.
 *
 * ── The inversion
 *
 * The other checks ask "what does this document claim, and is it right?". This one asks
 * "**does this document raise the subject in a shape nobody can read?**" — and fails if so.
 *
 *     no mention          → silent, legitimately. Contributes nothing to anything.
 *     mention → parsed    → checks 6 and 6b compare it to the constants. Unchanged.
 *     mention → UNPARSED  → FAILS HERE, naming file:line.
 *
 * That third row is the one that did not exist. It is ADR 0002's G3 — "a scanner that
 * cannot parse something reports it" — applied to prose, where until now G3 was honoured
 * only by the structured parsers (`parseTableColumn`'s `tables`, `parseConfirmProse`'s
 * `lines`).
 *
 * ── Why the fix is a shape requirement and not a wider regex
 *
 * Widening `GATED_CLAIM` until it matched AGENTS.md:15 would fix that sentence and leave
 * the class open: the next honest rewrite phrases past the wider regex too, silently, and
 * a third instance appears. Worse, a widened extractor has to be RIGHT about the members
 * it pulls out — the sibling measurement on `workers/mcp/src/state-vocabulary.ts` (#600)
 * found a widened value-set scanner produced 6 false positives in 8 candidates and still
 * recovered only two of four members from the description it was written for.
 *
 * A shape requirement has neither problem, because it never extracts anything. It only
 * asserts that a document raising the subject does so in a form some parser can check, and
 * the remedy for a failure is to write the sentence in a readable shape — not to teach the
 * guard one more phrasing. The extractors stay narrow and stay correct.
 *
 * ── ADR 0002 (a guard states what it measured)
 *
 *  - G1: the sweep has a floor, and so does the MENTION count. A detector that suddenly
 *    finds no mentions across ~40 documents has broken, and says so rather than passing.
 *  - G2: the success line states mentions = parsed + unparsed, which is the denominator
 *    checks 6 and 6b could not state. "40 swept" never distinguished the three rows above.
 *  - G3: this file IS G3 for prose claims.
 */

import { findClaimSpans, findQuantityMentions } from "./doc-claims.mjs";

/**
 * The one file exempt from BOTH the total-count check and this one, for one reason.
 *
 * `workers/mcp/CLAUDE.md` is the module-layout document: it quotes per-file registration
 * counts ("13 in `storage-tools.ts`"), deliberate historical statements ("67 of those 86
 * tools until #305") and subset rows ("+ 3 loop tools"). Every one of those is a number
 * beside the word "tools" that is CORRECTLY not a claim about the surface total, and
 * measured: they are 2 of the 3 unparsed mentions in the tree, and both are honest.
 *
 * It is exempt because it is checked HARDER, not because it is trusted — its per-file rows
 * are compared to real `.tool(` counts, its headline must contain the literal
 * "<MCP_TOOL_COUNT> tool registrations", and `SPLIT_MUST_CLAIM` requires it to state the
 * split. Shared with check 6 rather than restated there, so the exemption is ONE decision
 * that cannot come to mean two different things in two places.
 */
export const SUBSET_CLAIMS = ["workers/mcp/CLAUDE.md"];

/** The floor below which the sweep is assumed broken rather than the tree assumed clean. */
const SWEEP_FLOOR = 20;

/**
 * The floor below which the MENTION detector is assumed broken.
 *
 * DERIVED, not observed. Today's tree yields 13 non-exempt mentions, and a floor set at 13
 * would be a bound chosen to make today's number pass — the thing ADR 0002 names as the
 * wrong answer to G1. The bound is instead read off the other two checks' own must-speak
 * lists, which are already enforced: `MUST_CLAIM` obliges four files to state the total
 * (≥1 noun mention each) and `SPLIT_MUST_CLAIM` obliges two non-exempt files to state the
 * split (≥2 verb mentions each, always-on and gated). Those obligations cannot all hold
 * while this detector sees fewer than 4 + 4 = 8.
 *
 * So a reading under 8 means the detector stopped detecting, and it will be caught HERE
 * rather than showing up as a comfortable "all mentions parsed" over almost nothing —
 * which is the `parseThemeColorTokens` failure ADR 0002 was written for.
 */
const MENTION_FLOOR = 8;

/**
 * Assert that every documented mention of the MCP tool surface is in a shape a claim check
 * can read.
 *
 * @param {{files: {name: string, src: string}[]}} input `files` is docFiles() +
 *        servedHtmlFiles(), already read — the SAME sweep checks 6 and 6b use, passed in
 *        rather than recomputed, so the three cannot disagree about the trusted surface.
 * @returns {{failures: {check: string, message: string}[], notes: string[]}}
 */
export function checkClaimShape({ files }) {
	const failures = [];
	const notes = [];
	const fail = (message) => failures.push({ check: "claim-shape", message });

	if (files.length < SWEEP_FLOOR) {
		fail(
			`swept ${files.length} file(s), expected at least ${SWEEP_FLOOR}.\n` +
				"  docFiles() + servedHtmlFiles() are ~40 files together. This is a check that has\n" +
				"  stopped measuring, not a clean tree.",
		);
		return { failures, notes };
	}

	const unparsed = [];
	let mentions = 0;
	let parsed = 0;
	let exempted = 0;
	const speaking = new Set();
	for (const { name, src } of files) {
		const lines = src.split("\n");
		if (SUBSET_CLAIMS.includes(name)) {
			// Counted even though it is not checked. "1 exempt file" hides how much of the
			// population that is — it is the single densest file on this subject in the tree —
			// and an exclusion whose size is not printed is the under-count ADR 0002 forbids.
			exempted += findQuantityMentions(src).length;
			continue;
		}
		for (const m of findQuantityMentions(src)) {
			mentions++;
			speaking.add(name);
			// Overlap, not equality: a claim's match is usually wider than the mention inside
			// it ("117 tools are always registered" is one claim containing one noun mention).
			const covered = findClaimSpans(lines[m.n - 1]).some((s) => s.start < m.end && m.start < s.end);
			if (covered) parsed++;
			else unparsed.push({ name, ...m });
		}
	}

	if (mentions < MENTION_FLOOR) {
		fail(
			`found ${mentions} mention(s) of the MCP tool surface across ${files.length} file(s), ` +
				`expected at least ${MENTION_FLOOR}.\n` +
				"  Forty trusted documents describing a 136-tool server quantify it more often than\n" +
				"  that. The mention detector has stopped detecting — fix it, do not lower the floor.",
		);
		return { failures, notes };
	}

	if (unparsed.length) {
		fail(
			`${unparsed.length} mention(s) of the MCP tool surface are in a shape no claim check can ` +
				`read, out of ${mentions} mention(s) across ${files.length} file(s) swept:\n` +
				unparsed
					.map((u) => `    ${u.name}:${u.n}  "${u.text}" (${u.shape})\n      ${u.line.slice(0, 120)}`)
					.join("\n") +
				"\n  These are NOT compared to MCP_TOOL_COUNT or to the always-on/gated split by anything,\n" +
				"  and an unchecked number reads exactly like a checked one. `workers/mcp/AGENTS.md:15`\n" +
				'  carried "18 of the 124 registrations are gated" — wrong in both halves — through a\n' +
				"  fully green docs:drift for this reason.\n" +
				"  Fix by REPHRASING into a shape the checks read (\"19 tools are gated\", \"136 tool\n" +
				"  registrations\"), not by widening the extractor: a wider extractor still has to be\n" +
				"  right about what it pulls out, and the next honest rewrite phrases past it too.",
		);
	}

	if (!failures.length) {
		notes.push(
			`MCP surface claim shapes: ${mentions} mention(s) across ${speaking.size} file(s) that ` +
				`quantify the surface == ${parsed} parsed by a claim check + ${unparsed.length} unparsed, ` +
				`${files.length} swept (${SUBSET_CLAIMS.length} exempt, holding ${exempted} unchecked mention(s))`,
		);
	}
	return { failures, notes };
}
