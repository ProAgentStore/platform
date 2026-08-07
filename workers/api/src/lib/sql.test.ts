// biome-ignore-all lint/suspicious/noTemplateCurlyInString: every `${...}` in this file is a
// FIXTURE, not an interpolation that lost its backticks. findQuotedInterpolations is a detector
// for SQL built by string interpolation, so its tests must hand it source text containing the
// placeholder verbatim. Rewriting them to satisfy the rule would delete the thing under test.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findQuotedInterpolations, isValidJsonPathKey, jsonPath, sqlLiteralList } from "./sql.js";

// ── The builders ─────────────────────────────────────────────────────────────────────────────

describe("jsonPath", () => {
	it("builds the path for a key the JSON functions can address", () => {
		expect(jsonPath("behaviour")).toBe("$.behaviour");
		expect(jsonPath("_x9")).toBe("$._x9");
	});

	// Not a security boundary any more (the path is bound), but a key nobody can address later
	// is still a bug, and the shapes below are exactly the ones that used to be one.
	it("refuses a key that is not a plain identifier", () => {
		for (const bad of ["a.b", "a'b", "$.x", "a b", "", "1abc", "a[0]", "a\\b"]) {
			expect(() => jsonPath(bad), bad).toThrow(/Invalid JSON path key/);
			expect(isValidJsonPathKey(bad), bad).toBe(false);
		}
	});
});

describe("sqlLiteralList", () => {
	it("quotes and joins constants", () => {
		expect(sqlLiteralList(["ticket.question", "ticket.answer"])).toBe("'ticket.question', 'ticket.answer'");
	});

	// The whole reason the function exists rather than a `.map(v => \`'${v}'\`)` at each site:
	// the exception for a partial-index predicate must not be reachable by a value with a quote
	// in it, and "we only ever pass constants" is not enforceable by reading the call site.
	it("throws on anything a quote could escape out of", () => {
		for (const bad of ["a'b", "a b", 'a"b', "a\\b", "a;DROP", "a)"]) {
			expect(() => sqlLiteralList([bad]), bad).toThrow(/not a constant safe to inline/);
		}
		expect(() => sqlLiteralList([])).toThrow(/empty IN/);
	});
});

// ── The detector, proved on fixtures before it is pointed at the tree ─────────────────────────

describe("findQuotedInterpolations", () => {
	it("flags an interpolation inside a SQL string literal", () => {
		const hits = findQuotedInterpolations("const q = `SELECT 1 FROM t WHERE event = '${name}'`;");
		expect(hits.map((h) => h.expression)).toEqual(["name"]);
	});

	it("flags one inside a JSON path, the shape #327 was filed for", () => {
		const hits = findQuotedInterpolations("db.prepare(`UPDATE agent_instances SET config = json_set(config, '$.${key}', json(?1))`)");
		expect(hits.map((h) => h.expression)).toEqual(["key"]);
	});

	it("allows an interpolation outside quotes — a column list, a clause, a placeholder run", () => {
		expect(findQuotedInterpolations("const q = `SELECT ${COLS} FROM t WHERE id IN (${marks}) LIMIT ${n}`;")).toEqual([]);
	});

	// SQLite escapes a quote by doubling it, and closed literals are everywhere in this codebase
	// (`datetime('now')`, `status IN ('active', 'suspended')`). Reading a closed literal as an
	// open one would report every one of them and the guard would be muted in a week.
	it("does not confuse a CLOSED literal for an open one", () => {
		expect(findQuotedInterpolations("const q = `UPDATE t SET at = datetime('now') WHERE id = ?1 AND s IN ('a', 'b') AND x = ${y}`;")).toEqual([]);
		expect(findQuotedInterpolations("const q = `SELECT * FROM t WHERE a = 'it''s' AND b = ${c}`;")).toEqual([]);
	});

	// The failure mode that made the VCQA report partial: it only reads the template handed
	// directly to `.prepare(`, so an identical violation inside a callback went unreported.
	it("sees a template that is never passed straight to prepare()", () => {
		const src = "const sql = build((p) => `SELECT a FROM t WHERE id = ?${p} AND event = '${EVT}'`);";
		expect(findQuotedInterpolations(src).map((h) => h.expression)).toEqual(["EVT"]);
	});

	it("sees a SQL template nested inside another template's interpolation", () => {
		const src = "const q = `${cond ? `SELECT 1 FROM t WHERE e = '${x}'` : ''}`;";
		expect(findQuotedInterpolations(src).map((h) => h.expression)).toEqual(["x"]);
	});

	// Comments in this codebase discuss the banned shape at length — including the header of
	// `sql.ts` itself. A guard that reports its own documentation gets deleted.
	it("ignores comments, and non-SQL languages that quote the same way", () => {
		expect(findQuotedInterpolations("// bad: `SELECT 1 FROM t WHERE e = '${x}'`\nconst a = 1;")).toEqual([]);
		expect(findQuotedInterpolations("/* `UPDATE t SET a = '${x}'` */\nconst a = 1;")).toEqual([]);
		// lib/drive.ts builds Google Drive queries this way. Different language, different
		// escaping story, not this guard's subject.
		expect(findQuotedInterpolations("const q = `'${escapeDriveQuery(id)}' in parents`;")).toEqual([]);
	});

	it("reports the line and the surrounding SQL", () => {
		const src = "const a = 1;\nconst q = `SELECT 1 FROM t WHERE e = '${x}'`;\n";
		expect(findQuotedInterpolations(src)[0]).toMatchObject({ line: 2, expression: "x" });
		expect(findQuotedInterpolations(src)[0].excerpt).toContain("SELECT");
	});
});

// ── The guard ────────────────────────────────────────────────────────────────────────────────

const SRC_ROOT = new URL("../", import.meta.url).pathname; // workers/api/src

function sourceFiles(): Array<{ path: string; rel: string; src: string }> {
	const out: Array<{ path: string; rel: string; src: string }> = [];
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir)) {
			const p = join(dir, entry);
			if (statSync(p).isDirectory()) {
				walk(p);
				continue;
			}
			if (!p.endsWith(".ts") || p.endsWith(".test.ts")) continue;
			out.push({ path: p, rel: p.slice(SRC_ROOT.length), src: readFileSync(p, "utf-8") });
		}
	};
	walk(SRC_ROOT);
	return out;
}

/**
 * No SQL string in this Worker interpolates into a quoted position (#327).
 *
 * This is the one shape that turns a bug into a cross-tenant read: the interpolated text lands
 * INSIDE a SQL string literal, so a quote in it ends the literal and the rest of the value is
 * parsed as SQL — which is how a `WHERE user_id = ?` becomes a WHERE somebody else chose. Every
 * other kind of splicing here (a column list, a clause of bound-parameter predicates, a generated
 * placeholder run) puts the text where a quote is not special and can at worst produce a syntax
 * error.
 *
 * The two legitimate needs it displaced both have a door: a JSON path is BOUND (`jsonPath`), and
 * the one predicate that must be inlined for a partial index to be used goes through
 * `sqlLiteralList`, which rejects anything a quote could escape out of at module load.
 */
describe("no SQL string interpolates into a quoted position", () => {
	it("holds across workers/api/src", () => {
		const offenders: string[] = [];
		for (const f of sourceFiles()) {
			for (const hit of findQuotedInterpolations(f.src)) {
				offenders.push(`${f.rel}:${hit.line}  \${${hit.expression}}  — ${hit.excerpt}`);
			}
		}
		expect(
			offenders,
			[
				"A ${…} inside a SQL string literal is the one splice that can widen a WHERE:",
				"a quote in the value ends the literal and the rest is executed as SQL.",
				"",
				"  • a JSON path       -> bind it, via jsonPath() (json_set/json_remove take it as an argument)",
				"  • any runtime value -> bind it, ?N + .bind()",
				"  • a constant that MUST be inlined for a partial index (migration 0088) -> sqlLiteralList()",
				"",
				offenders.join("\n"),
			].join("\n"),
		).toEqual([]);
	});
});

/**
 * The instance+agent config join exists once, in one file, in two named scopes.
 *
 * It had four copies — `behaviour-store.ts` twice, `agent-think.ts`, `stats-rollup.ts` — three
 * owner-scoped and one not. That is the state in which a fifth gets written by copy-paste from
 * whichever one was open, and copying the unscoped one is a cross-tenant read with no error.
 * Centralising it only helps if the unscoped door stays enumerable, which is what the second
 * assertion is for.
 */
describe("the instance ⋈ agent config read has one home", () => {
	// Anchored on the exact PROJECTION, not on any join of the two tables. Several queries
	// legitimately join them for other things — `admin.ts` for an operator list, `supervision.ts`
	// for a team of instances, `loop-presets-store.ts` for config plus slug and category. Those
	// are different reads that have to justify themselves on their own; this pins the one that
	// had been copy-pasted four times.
	const JOIN = /SELECT i\.config AS config, a\.config AS agent_config FROM agent_instances i LEFT JOIN agents a/i;

	it("no file but instance-config.ts writes the join", () => {
		const offenders = sourceFiles()
			.filter((f) => !f.rel.endsWith("instance-config.ts") && JOIN.test(f.src.replace(/\s+/g, " ")))
			.map((f) => f.rel);
		expect(
			offenders,
			`Use readInstanceConfigPair(env, instanceId, userId) — or, only from a Durable Object, readInstanceConfigPairForDurableObject. Offenders:\n${offenders.join("\n")}`,
		).toEqual([]);
	});

	it("only agent-think.ts reads it without an owner predicate", () => {
		// The DO is addressed BY the instance id and has no session to scope to. Every other
		// caller has a userId; requiring it is what keeps tenant isolation a type obligation
		// rather than a habit.
		const callers = sourceFiles()
			.filter((f) => !f.rel.endsWith("instance-config.ts") && f.src.includes("readInstanceConfigPairForDurableObject"))
			.map((f) => f.rel);
		expect(
			callers,
			"An unscoped config read outside a Durable Object is a cross-tenant read. If a new caller has a userId in scope, it must use readInstanceConfigPair instead.",
		).toEqual(["agent-think.ts"]);
	});

	it("the owner-scoped statement actually carries the owner predicate", () => {
		// Belt to the brace above: centralising is only a win if the surviving copy is the
		// scoped one. Asserted on the source so a later edit to the SQL cannot quietly drop it.
		const src = readFileSync(join(SRC_ROOT, "lib/instance-config.ts"), "utf-8").replace(/\s+/g, " ");
		expect(src).toContain("WHERE i.id = ?1 AND i.user_id = ?2");
	});
});
