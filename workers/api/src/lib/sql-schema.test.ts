/**
 * Every SQL statement this Worker writes out in full is PARSED against the schema the migrations
 * actually build (#438).
 *
 * ── Why this exists
 *
 * The suite mocks D1 in 59 files by matching the SQL string. Nothing anywhere executed a
 * statement, so the suite could not see a syntax error, a column that does not exist, or a
 * platform limit — and did not see three of them in one week (#423, #434, and the `users.email`
 * below). "Write more tests" was never the fix: 273 test files to 296 sources, and none of them
 * could have caught any of it.
 *
 * ── What this test does
 *
 * Extracts every complete SQL literal in `workers/api/src` and hands each to a real SQLite carrying
 * all 111 migrations, plus D1's measured five-term compound-SELECT ceiling. Roughly five hundred
 * statements, across the 117 modules that issue SQL, checked without any of them being called.
 *
 * ── What it CANNOT see
 *
 * The full list is on {@link findLiteralSqlStatements} and {@link assertD1Preparable}; the two that
 * decide how much comfort to take from a green run:
 *
 *   1. **SQL assembled at runtime is invisible here.** A `${…}` anywhere in the statement and this
 *      guard skips it — about fifty statements, and they are the risky ones (interpolated column
 *      lists, WHEREs built from arrays, `IN (${placeholders})`, per-call table names). #434 is
 *      exactly that shape. Those are covered only by DRIVING the code through `realSchemaD1()`,
 *      which `sql-execution.test.ts` does for the two modules with a defect on record. The
 *      remainder are uncovered, and the count below is printed on failure so the number is a fact
 *      rather than an impression.
 *   2. **A statement that parses can still be wrong.** #451's `WHERE agent_id = ?1` names a real
 *      column that is NULL for every row in production. Valid SQL, zero rows, forever. Parsing has
 *      no opinion on data.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertD1Preparable, migrationSchemaDb } from "./d1-sqlite.js";
import { findLiteralSqlStatements } from "./sql.js";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function sourceFiles(dir = SRC, out: { rel: string; src: string }[] = []): { rel: string; src: string }[] {
	for (const name of readdirSync(dir).sort()) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) {
			sourceFiles(p, out);
			continue;
		}
		if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
		out.push({ rel: relative(SRC, p), src: readFileSync(p, "utf8") });
	}
	return out;
}

/** Statements written with a `${…}` in them — the denominator this guard does not reach. */
function runtimeAssembledCount(): number {
	let n = 0;
	for (const f of sourceFiles()) {
		for (const m of f.src.matchAll(/`([^`\\]|\\.)*`/g)) {
			const t = m[0];
			if (!t.includes("${")) continue;
			if (/\b(SELECT|INSERT\s+INTO|UPDATE\s+\w|DELETE\s+FROM)\b/i.test(t) && /\b(FROM|WHERE|SET|VALUES)\b/i.test(t)) n++;
		}
	}
	return n;
}

describe("every literal SQL statement parses against the migration schema", () => {
	it("holds across workers/api/src", () => {
		const db = migrationSchemaDb();
		const failures: string[] = [];
		let checked = 0;
		for (const f of sourceFiles()) {
			for (const s of findLiteralSqlStatements(f.src)) {
				checked++;
				try {
					assertD1Preparable(s.sql, db);
				} catch (e) {
					// First line of the engine's complaint plus a short excerpt. The whole statement
					// would be forty lines per finding, which is how a failure message stops being read.
					const why = (e as Error).message.split("\n")[0];
					failures.push(`${f.rel}:${s.line}  ${why}\n      ${s.sql.replace(/\s+/g, " ").trim().slice(0, 160)}`);
				}
			}
		}
		// A floor, so a regression in the EXTRACTOR cannot present as a green run over nothing.
		// The number only ever grows; it is not a ratchet and does not need updating when it does.
		expect(checked, "the extractor found almost no SQL — it is broken, not the tree").toBeGreaterThan(400);
		expect(
			failures,
			[
				"A statement below does not parse against the schema `workers/api/migrations` builds.",
				"D1 would raise this on the first call and every call after it — there is no data-dependent",
				"path where it works, so no amount of exercising the happy path finds it (#423, #438).",
				"",
				`  ${checked} literal statements checked; ~${runtimeAssembledCount()} more are assembled at`,
				"  runtime and are NOT covered here — drive those through realSchemaD1() to see them.",
				"",
				failures.join("\n\n"),
			].join("\n"),
		).toEqual([]);
		db.close();
	});

	it("every migration applies to SQLite, in order", () => {
		// If this fails the sweep above is measuring nothing, so it is asserted separately rather
		// than left as a precondition inside it.
		expect(() => migrationSchemaDb().close()).not.toThrow();
	});
});

/**
 * The guard is proved on the real defects before it is trusted on the tree.
 *
 * Each fixture below is the code AS IT SHIPPED, not a paraphrase. A guard nobody has watched go
 * red is a guard nobody knows the shape of.
 */
describe("the guard goes red on the defects it was written for", () => {
	const db = migrationSchemaDb();

	it("#423 — the rollup's six-arm UNION, which D1 will not parse", () => {
		// Verbatim from stats-rollup.ts at 7852232^. Local SQLite parses 500 compound terms, so
		// this is caught by the CEILING and never by the engine — which is precisely why it was
		// invisible in every environment anyone could run it in.
		const shipped = `WITH active AS (
		     SELECT instance_id, user_id FROM ai_usage
		      WHERE instance_id IS NOT NULL AND created_at >= ?1 AND created_at < ?2
		     UNION
		     SELECT instance_id, user_id FROM agent_trigger_events
		      WHERE created_at >= ?1 AND created_at < ?2
		     UNION
		     SELECT instance_id, user_id FROM instance_runtime_tasks
		      WHERE updated_at >= ?1 AND updated_at < ?2
		     UNION
		     SELECT instance_id, user_id FROM agent_events
		      WHERE instance_id IS NOT NULL AND ts >= ?3 AND ts < ?4
		     UNION
		     SELECT instance_id, user_id FROM agent_loop_runs
		      WHERE started_at >= ?3 AND started_at < ?4
		     UNION
		     SELECT instance_id, user_id FROM pipeline_runs
		      WHERE started_at >= ?3 AND started_at < ?4
		   )
		   SELECT instance_id, user_id FROM active a
		    WHERE a.user_id IS NOT NULL
		      AND NOT EXISTS (SELECT 1 FROM agent_stats_daily s WHERE s.instance_id = a.instance_id AND s.day = ?5)
		    LIMIT ?6`;
		expect(() => db.prepare(shipped), "plain SQLite parses this happily — the ceiling is D1's").not.toThrow();
		expect(() => assertD1Preparable(shipped, db)).toThrow(/too many terms in compound SELECT: 6 > 5/);
	});

	it("a column no migration ever created", () => {
		// `external-usage.ts` shipped exactly this. It threw inside a `catch {}`, so the symptom
		// was not an error anywhere — it was `operatorUserIds` quietly returning the caller alone.
		expect(() => assertD1Preparable("SELECT id, roles, github_login, email FROM users", db)).toThrow(
			/no such column: email/,
		);
	});

	it("a table no migration ever created", () => {
		expect(() => assertD1Preparable("SELECT 1 FROM agent_statistics WHERE id = ?1", db)).toThrow(/no such table/);
	});

	it("a statement that does not parse at all", () => {
		expect(() => assertD1Preparable("SELECT id FRM users", db)).toThrow();
	});

	it("stays quiet on the statements the Worker really issues", () => {
		// The half that decides whether a finding gets fixed or suppressed: a guard that cries on
		// correct code is worse than none.
		for (const sql of [
			"SELECT id, roles, github_login FROM users WHERE id = ?1",
			"SELECT i.config AS config, a.config AS agent_config FROM agent_instances i LEFT JOIN agents a ON a.id = i.agent_id WHERE i.id = ?1 AND i.user_id = ?2",
			"SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5",
		]) {
			expect(() => assertD1Preparable(sql, db), sql).not.toThrow();
		}
	});
});

/**
 * The extractor itself, proved on the shapes that made a first cut of this unusable.
 *
 * Both of these were REAL false readings: a bare `"delete"` (a tool name) read as a statement, and
 * `stats-store.ts`'s concatenated `SELECT_CONFIGS` read as a truncated fragment naming columns of
 * a table it had not joined yet. A guard whose failures are mostly noise gets turned off.
 */
describe("findLiteralSqlStatements", () => {
	it("joins a statement split across concatenated fragments", () => {
		const src = [
			'const SELECT_CONFIGS =\n\t"SELECT i.config AS config, a.config AS agent_config FROM agent_instances i" +',
			'\t" LEFT JOIN agents a ON a.id = i.agent_id WHERE i.id = ?1 AND i.user_id = ?2";',
		].join("\n");
		const found = findLiteralSqlStatements(src);
		expect(found).toHaveLength(1);
		expect(found[0]?.sql).toContain("LEFT JOIN agents a");
		expect(() => assertD1Preparable(found[0]?.sql ?? "", migrationSchemaDb())).not.toThrow();
	});

	it("ignores a word that is only a verb", () => {
		expect(findLiteralSqlStatements('const kinds = ["delete", "insert", "update", "select"];')).toEqual([]);
	});

	it("ignores prose and regex sources that begin with a verb", () => {
		const src = [
			'const RE = "INSERT\\\\s+(?:OR\\\\s+\\\\w+\\\\s+)?INTO|REPLACE\\\\s+INTO|UPDATE";',
			'const note = "With no run id this falls through to the same picture subordinate_status gives";',
		].join("\n");
		expect(findLiteralSqlStatements(src)).toEqual([]);
	});

	it("skips a statement completed at runtime rather than guessing at it", () => {
		// biome-ignore lint/suspicious/noTemplateCurlyInString: a FIXTURE — the placeholder is the subject.
		const src = "const q = `SELECT DISTINCT instance_id FROM ${s.table} WHERE user_id IS NOT NULL`;";
		expect(findLiteralSqlStatements(src)).toEqual([]);
	});

	it("finds a plain template statement", () => {
		const found = findLiteralSqlStatements("db.prepare(`SELECT id FROM users WHERE id = ?1`)");
		expect(found.map((f) => f.sql)).toEqual(["SELECT id FROM users WHERE id = ?1"]);
		expect(found[0]?.line).toBe(1);
	});
});
