// biome-ignore-all lint/suspicious/noTemplateCurlyInString: every `${...}` here is a FIXTURE. The
// guard's subject is SQL as it is WRITTEN, and the filtered call sites reach the predicate by
// interpolating `${CHARGED_SQL}` — so its tests must hand it source text containing the
// placeholder verbatim. Same reason `sql.test.ts` carries this line.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findMoneyAggregates, findMoneyClaimViolations, stringLiterals } from "./usage-aggregates.js";

// ── The detector, proved on fixtures before it is pointed at the tree ─────────────────────────

describe("findMoneyClaimViolations", () => {
	it("flags an unfiltered sum whose name claims money — the #343 shape, verbatim", () => {
		const v = findMoneyClaimViolations(
			'db.prepare("SELECT COALESCE(SUM(cost_micros), 0) AS spend_micros FROM ai_usage WHERE user_id = ?1")',
		);
		expect(v).toHaveLength(1);
		expect(v[0].alias).toBe("spend_micros");
		expect(v[0].why).toMatch(/either filter it .* or alias it as value/);
	});

	// The blacklist form of this rule ("no alias matching /spend|cost|bill/") is satisfied by
	// calling the number `n` — which is exactly how `getOverviewStats` shipped an unfiltered sum
	// into a field named `spend30dMicros`. Naming has to be positive or it is not a ratchet.
	it("flags an unfiltered sum that declines to say what it is", () => {
		const v = findMoneyClaimViolations('db.prepare("SELECT COALESCE(SUM(cost_micros),0) AS n FROM ai_usage WHERE created_at >= ?")');
		expect(v).toHaveLength(1);
		expect(v[0].why).toMatch(/calls it "n"/);
		// And with no alias at all, which is the same evasion one keystroke shorter.
		expect(findMoneyClaimViolations('db.prepare("SELECT SUM(cost_micros) FROM ai_usage")')[0].why).toMatch(/no alias saying what it is/);
	});

	it("passes a sum that takes a position on the payer", () => {
		expect(
			findMoneyClaimViolations("db.prepare(`SELECT COALESCE(SUM(cost_micros), 0) AS total FROM ai_usage WHERE user_id = ?1 AND ${CHARGED_SQL}`)"),
		).toEqual([]);
		expect(
			findMoneyClaimViolations("db.prepare(`SELECT COALESCE(SUM(cost_micros),0) AS micros FROM ai_usage WHERE payer = 'platform'`)"),
		).toEqual([]);
	});

	it("passes a display sum that declares itself notional value", () => {
		expect(findMoneyClaimViolations('db.prepare("SELECT COALESCE(SUM(cost_micros), 0) AS value_micros FROM ai_usage")')).toEqual([]);
	});

	// The CASE form is how one statement reports both numbers, which is the shape most of the
	// fixed call sites took: the filter is inside the select-item, not in the WHERE.
	it("passes a charged subtotal filtered inside the select-item", () => {
		const src = "db.prepare(`SELECT COALESCE(SUM(CASE WHEN ${CHARGED_SQL} THEN cost_micros ELSE 0 END), 0) AS charged_micros FROM ai_usage`)";
		expect(findMoneyClaimViolations(src)).toEqual([]);
	});

	/**
	 * A sibling column's WHERE says nothing about this one.
	 *
	 * `admin.ts`'s user list puts each rollup in its own correlated subquery, so a statement-wide
	 * test for the word `payer` would let an unfiltered sum ride on the filter of the column next
	 * to it — and that list is exactly where a per-user "spend" figure gets read as a bill.
	 */
	it("judges a subquery item on its own text, not its neighbour's", () => {
		const src = [
			"const q = `SELECT u.id,",
			"  (SELECT COALESCE(SUM(x.cost_micros),0) FROM ai_usage x WHERE x.user_id = u.id) AS spend_micros,",
			"  (SELECT COALESCE(SUM(x.cost_micros),0) FROM ai_usage x WHERE x.user_id = u.id AND ${CHARGED_SQL}) AS charged_micros",
			" FROM users u`;",
		].join("\n");
		const v = findMoneyClaimViolations(src);
		expect(v.map((x) => x.alias)).toEqual(["spend_micros"]);
	});

	it("is not fooled by a name that says both", () => {
		const v = findMoneyClaimViolations('db.prepare("SELECT SUM(cost_micros) AS spend_value_micros FROM ai_usage")');
		expect(v).toHaveLength(1);
	});

	// The reason five scanners in this repo now blank comments first: every file that explains
	// this correction has to quote the wording it retired, and a guard that reports its own
	// documentation is a guard someone deletes.
	it("ignores comments, including ones quoting the banned shape", () => {
		expect(findMoneyClaimViolations('// "SELECT SUM(cost_micros) AS spend FROM ai_usage"\nconst a = 1;')).toEqual([]);
		expect(findMoneyClaimViolations('/* `SELECT SUM(cost_micros) AS spend FROM ai_usage` */\nconst a = 1;')).toEqual([]);
	});

	it("ignores a URL's // and keeps scanning the line after it", () => {
		const src = 'const u = "https://x/y";\nconst q = "SELECT SUM(cost_micros) AS spend FROM ai_usage";';
		expect(findMoneyClaimViolations(src)).toHaveLength(1);
	});

	it("has no opinion on token sums, or on rows selected without aggregation", () => {
		expect(findMoneyClaimViolations('db.prepare("SELECT SUM(input_tokens) AS tokens FROM ai_usage")')).toEqual([]);
		expect(findMoneyClaimViolations('db.prepare("SELECT cost_micros FROM ai_usage WHERE cost_micros > 0")')).toEqual([]);
	});

	it("reports the line so the failure names a place", () => {
		const src = 'const a = 1;\nconst b = 2;\nconst q = "SELECT SUM(cost_micros) AS spend FROM ai_usage";';
		expect(findMoneyAggregates(src)[0]).toMatchObject({ line: 3, alias: "spend", filtered: false });
	});
});

describe("stringLiterals", () => {
	// SQL in this Worker is written in all three quote styles — `admin.ts:452` is a double-quoted
	// one-liner, `usage.ts` uses templates. A scanner that read only templates would have missed
	// the statement that actually shipped the defect.
	it("reads all three quote styles, keeping interpolations visible", () => {
		const texts = stringLiterals("const a = 'x'; const b = \"y\"; const c = `z${q}`;").map((l) => l.text);
		expect(texts).toEqual(["x", "y", "z${q}"]);
	});

	it("does not end a template at a quote inside an interpolation", () => {
		expect(stringLiterals("const c = `a${f(`b`)}c`;")[0].text).toBe("a${f(`b`)}c");
	});
});

// ── The guard ────────────────────────────────────────────────────────────────────────────────

const SRC_ROOT = new URL("../", import.meta.url).pathname; // workers/api/src

function sourceFiles(): Array<{ rel: string; src: string }> {
	const out: Array<{ rel: string; src: string }> = [];
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir)) {
			const p = join(dir, entry);
			if (statSync(p).isDirectory()) {
				walk(p);
				continue;
			}
			// Tests are excluded because their fixtures ARE the banned shape — the file you are
			// reading would report itself, which is how a guard earns its own suppression.
			if (!p.endsWith(".ts") || p.endsWith(".test.ts")) continue;
			out.push({ rel: p.slice(SRC_ROOT.length), src: readFileSync(p, "utf-8") });
		}
	};
	walk(SRC_ROOT);
	return out;
}

/**
 * Every dollar aggregate in this Worker either filters on payer or says it is notional value.
 *
 * The ticket (#346) asked for "nothing sums `cost_micros` without filtering on `payer`". That is
 * the right rule for a number that GATES or PAYS and the wrong one for a number that DISPLAYS:
 * filtering an operator's view of consumption to charged rows would make a subscription-heavy
 * account read as near-zero activity, the mirror image of the error #343 actually was. So the
 * enforceable invariant is the one that covers both — a dollar aggregate must establish what it
 * is at the point it is created, in SQL, where the next person to write a consumer will see it.
 */
describe("every dollar aggregate over ai_usage says what it is", () => {
	it("holds across workers/api/src", () => {
		const offenders: string[] = [];
		for (const f of sourceFiles()) {
			for (const v of findMoneyClaimViolations(f.src)) {
				offenders.push(`${f.rel}:${v.line}  ${v.why}\n      ${v.item}`);
			}
		}
		expect(offenders, `\n${offenders.join("\n")}\n`).toEqual([]);
	});

	it("actually finds the aggregates it is judging — a scanner that sees nothing passes vacuously", () => {
		const found = sourceFiles().flatMap((f) => findMoneyAggregates(f.src).map((a) => `${f.rel}:${a.line}`));
		expect(found.length).toBeGreaterThanOrEqual(8);
	});
});
