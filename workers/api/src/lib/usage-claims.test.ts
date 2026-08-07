import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * What the platform is allowed to SAY about a cost figure (#347).
 *
 * The bug this guards was not in a function. It was a sentence — "the one line here that is a
 * measurement rather than an estimate" — asserted on the Usage page, restated in the ledger's
 * docstring, and written into migration 0080's comment, each one reinforcing the other two. It
 * survived review because it sounded like a caveat rather than a claim, and a circuit breaker was
 * then built on the authority it conferred (#343).
 *
 * Anthropic's docs (https://code.claude.com/docs/en/costs) say Claude Code "computes the dollar
 * figure locally from token counts priced at standard list rates … and may differ from your actual
 * bill", and that for Max/Pro subscribers "the session cost figure isn't relevant for billing
 * purposes". So `total_cost_usd` is tokens × list price — the same construction as ours.
 *
 * A grep is a blunt instrument, which is the point: the claim regenerates by being re-typed in a
 * new surface, and no reviewer catches the fourth restatement by eye.
 */

const ROOT = join(import.meta.dirname, "..", "..", "..", "..");

/** Every surface that has ever asserted, or could plausibly assert, what kind of number this is. */
const SURFACES = [
	"workers/api/src/lib/usage.ts",
	"workers/api/src/routes/usage.ts",
	"workers/api/migrations/0080_ai_usage_cost_source.sql",
	"workers/api/migrations/0092_ai_usage_payer.sql",
	"store/console/src/pages/Usage.tsx",
	"workers/mcp/src/instance-tools/account.ts",
];

/**
 * Phrases that assert a cost figure IS money.
 *
 * Deliberately narrow. "measured" appears legitimately all over this repo about latency, process
 * counts and test timings, and a guard that fired on the bare word would be turned off within a
 * week. These are the constructions that make the false claim.
 */
const FORBIDDEN: Array<[RegExp, string]> = [
	[/\bmeasurement rather than an estimate\b/i, "the original claim, verbatim"],
	[/\breal thing rather than our arithmetic\b/i, "migration 0080's version of it"],
	[/\bthe CLI knows about subscription pricing\b/i, "the load-bearing false statement — the CLI prices at list rates"],
	[/\bwhat it actually spent\b/i, "asserts the engine figure is a charge"],
	[/\bCoding engine \(measured\)\b/, "the retired column label"],
	[/\bactual spend\b/i, "no figure on this page is actual spend"],
];

/**
 * Blank comments, keeping line count, before matching.
 *
 * The guard's subject is what the product TELLS the user, and every one of these files explains
 * the correction in a comment that necessarily QUOTES the retired wording — "it said measurement
 * rather than an estimate until #347" is the sentence that stops someone reinstating it. Matching
 * raw source makes the explanation of the rule a violation of the rule, so the only way to pass
 * is to delete the reasoning, which is exactly what future readers need.
 *
 * This is the fourth scanner in this repo to hit it: `source-guard.ts` blanks comments for the
 * same reason, gitleaks flagged a comment naming the secrets it had just removed, and
 * `control-labels.ts` masked comments after its own note tripped it. Handles `--` (SQL), `//`,
 * and `/* … *\/`; string literals are left alone, since a user-facing claim lives in one.
 */
function withoutComments(src: string): string {
	return src
		.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
		.replace(/^[ \t]*(\/\/|--).*$/gm, (m) => " ".repeat(m.length));
}

describe("no usage surface claims a cost figure is measured", () => {
	for (const file of SURFACES) {
		it(`${file} states an estimate, not a measurement`, () => {
			const src = withoutComments(readFileSync(join(ROOT, file), "utf8"));
			for (const [pattern, why] of FORBIDDEN) {
				expect(pattern.test(src), `${file}: ${why}`).toBe(false);
			}
		});
	}

	it("the ledger's own docstring cites the vendor rather than asserting from memory", () => {
		// The correction has to carry its evidence, or the next reader has only two opinions to
		// choose between — which is how the wrong one won the first time.
		const src = readFileSync(join(ROOT, "workers/api/src/lib/usage.ts"), "utf8");
		expect(src).toContain("code.claude.com/docs/en/costs");
		expect(src).toMatch(/list rates|list price/i);
	});

	it("the page keeps the caveat that was already true", () => {
		// Codex and Grok report no usage at all, so their spend appears nowhere. Correcting the
		// false claim must not take the correct one with it.
		const src = readFileSync(join(ROOT, "store/console/src/pages/Usage.tsx"), "utf8");
		expect(src).toMatch(/Codex and Grok report no usage/);
	});

	it("the page points at the authoritative source per payer, as the vendor docs do", () => {
		const src = readFileSync(join(ROOT, "store/console/src/pages/Usage.tsx"), "utf8");
		expect(src).toContain("platform.claude.com/usage");
	});
});
