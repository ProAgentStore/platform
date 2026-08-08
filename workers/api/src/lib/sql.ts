/**
 * The few places SQL in this Worker is not a plain literal (#327), and the guard that keeps the
 * list short.
 *
 * ── What the invariant actually is
 *
 * Tenant isolation here is not "we escape carefully". It is: every `:id`/`:instanceId` route is
 * `user_id`/`owner_id`-scoped and every runtime value is a bound parameter, so there is no path
 * by which one tenant's input can alter another tenant's WHERE. That property is destroyed by
 * exactly ONE shape — text spliced into a SQL string literal:
 *
 *     `… WHERE event = '${name}'`        ← a quote inside `name` ends the literal; the rest is SQL
 *     `… json_set(config, '$.${key}', …)`
 *
 * Everything else people call "dynamic SQL" here (a column list, a clause built from constants, a
 * generated placeholder run) cannot do that: the interpolated text sits where a quote is not
 * special, so the worst a bug produces is a syntax error, not a widened scope. The rule this
 * module enforces is therefore narrow on purpose — ban the one shape that is unambiguous, and say
 * plainly that the rest still needs a reader.
 *
 * ── Why a guard and not a review note
 *
 * The VCQA scan that opened #327 found the quoted `ACT_EVENT` at `instance-work.ts:297` and NOT
 * the identical one twenty lines above it, because that one is inside a callback and the scanner
 * only reads the template handed directly to a `prepare` call. A rule enforced by whichever lines
 * a shallow scanner happens to reach is not enforced. {@link findQuotedInterpolations} reads every
 * SQL template in the tree, wherever it is written.
 *
 * (Written as "a `prepare` call" rather than with its parenthesis for a reason worth recording:
 * the scanner matches that token in COMMENTS too, so this paragraph — prose about the rule —
 * reported itself as a finding. That is the same failure `source-guard.ts` was built to avoid,
 * observed live.)
 *
 * ── The inverse lexing problem, again
 *
 * `source-guard.ts` (#306) blanks comments AND string literals before matching, because the
 * identifiers its guards look for appear more often in prose about the rule than in code breaking
 * it. That lexer is useless here: SQL *is* string literals, so blanking them blanks the subject.
 * `prompt-claims.ts` (#315) needed the same inversion and keeps literal text while blanking code.
 * This module needs a third position — keep the literal text AND keep the interpolations, because
 * the violation is precisely the boundary between the two — so it walks templates itself, skipping
 * comments and ordinary quoted strings (which cannot contain an interpolation) and recursing into
 * interpolation bodies so a nested template is not missed.
 */

/** A `${…}` sitting inside a SQL string literal, with enough context to act on. */
export interface QuotedInterpolation {
	/** 1-based line in the file. */
	line: number;
	/** The interpolated expression as written, e.g. `key` or `ACT_EVENT`. */
	expression: string;
	/** The SQL around it, trimmed, for the failure message. */
	excerpt: string;
}

/**
 * Does this template read as SQL? A statement verb AND a clause keyword — both, deliberately.
 *
 * The verb alone is an English word. `apply-loop.ts` describes a browser action as
 * `select "${a.text}" in "${a.name}"`, which is a sentence for a human and matched a verb-only
 * test perfectly; `lib/drive.ts` builds Google Drive queries with the same quoting and is a
 * different language with a different escaping story. Requiring a clause keyword as well costs
 * nothing real — a statement with no FROM/WHERE/SET/VALUES has nowhere to put an interpolation
 * that matters — and keeps the guard out of arguments about files it has no opinion on.
 */
const SQL_VERB = /(?:\bSELECT\b|\bINSERT\s+(?:OR\s+\w+\s+)?INTO\b|\bUPDATE\s+\w|\bDELETE\s+FROM\b|\bREPLACE\s+INTO\b|\bCREATE\s+TABLE\b)/i;
const SQL_CLAUSE = /\b(?:FROM|WHERE|SET|VALUES|INTO|JOIN|GROUP\s+BY|ORDER\s+BY)\b/i;
const readsAsSql = (text: string) => SQL_VERB.test(text) && SQL_CLAUSE.test(text);

/**
 * Stands in for an interpolation while quote state is walked over a template's static text.
 *
 * A NUL rather than any printable placeholder: SQL text contains every printable character, so
 * anything visible would be indistinguishable from the query's own content.
 */
const INTERP_MARK = "\u0000";

interface Template {
	/** Static text with each interpolation replaced by {@link INTERP_MARK}. */
	text: string;
	/** Absolute source index and source text of each interpolation, in order. */
	interps: Array<{ index: number; expression: string; bodyFrom: number; bodyTo: number }>;
	/** Index just past the closing backtick. */
	end: number;
}

/** Read one template literal starting at the backtick at `start`. */
function readTemplate(src: string, start: number): Template {
	let text = "";
	const interps: Template["interps"] = [];
	let i = start + 1;
	while (i < src.length) {
		if (src[i] === "\\") {
			text += src.slice(i, i + 2);
			i += 2;
			continue;
		}
		if (src[i] === "`") return { text, interps, end: i + 1 };
		if (src[i] === "$" && src[i + 1] === "{") {
			const open = i;
			const bodyFrom = i + 2;
			// Walk to the matching brace, stepping over nested templates and strings so a `}`
			// inside one does not close the interpolation early.
			let depth = 1;
			let j = bodyFrom;
			while (j < src.length && depth > 0) {
				const c = src[j];
				if (c === "`") {
					j = readTemplate(src, j).end;
					continue;
				}
				if (c === '"' || c === "'") {
					j = skipQuoted(src, j, c);
					continue;
				}
				if (c === "{") depth++;
				else if (c === "}") depth--;
				j++;
			}
			const bodyTo = j - 1;
			interps.push({ index: open, expression: src.slice(bodyFrom, bodyTo).trim(), bodyFrom, bodyTo });
			text += INTERP_MARK;
			i = j;
			continue;
		}
		text += src[i];
		i++;
	}
	return { text, interps, end: src.length };
}

/** Index just past the closing quote of an ordinary string literal. */
function skipQuoted(src: string, start: number, quote: string): number {
	let i = start + 1;
	while (i < src.length) {
		if (src[i] === "\\") {
			i += 2;
			continue;
		}
		if (src[i] === quote) return i + 1;
		if (src[i] === "\n") return i; // unterminated — don't run away
		i++;
	}
	return src.length;
}

/**
 * The ordinals of the interpolations that land inside a SQL string literal.
 *
 * Doubled quotes — SQLite's own escape, `''` — are dropped before counting, so a CLOSED literal
 * containing one does not read as leaving a literal open. An odd number of quotes before a mark
 * means the mark is inside one.
 */
function marksInsideQuotes(text: string): number[] {
	const flat = text.replace(/''/g, "").replace(/""/g, "");
	const out: number[] = [];
	let quotes = 0;
	let ordinal = 0;
	for (const c of flat) {
		if (c === "'" || c === '"') {
			quotes++;
		} else if (c === INTERP_MARK) {
			if (quotes % 2 === 1) out.push(ordinal);
			ordinal++;
		}
	}
	return out;
}

/**
 * Every interpolation written inside a SQL string literal in `source`.
 *
 * WHAT IT CANNOT SEE, stated so nobody reads its silence as coverage:
 *
 *   • SQL assembled outside a template literal — concatenated constants, clauses pushed onto an
 *     array, a helper returning a fragment. Those are legitimate and common here (`error-log.ts`,
 *     `events.ts`, `admin.ts` each build a WHERE out of bound-parameter clauses), and telling a
 *     safe one from an unsafe one needs a reader, not a regex.
 *   • Whether an interpolation OUTSIDE quotes is safe. An unclamped `LIMIT ${n}` is a
 *     denial-of-service, not an injection, and this guard has no opinion on it.
 *   • Whether a query is correctly tenant-scoped. That is a property of the WHERE clause —
 *     checked for the config join by `instance-config.test.ts`, and by review elsewhere.
 *   • Anything outside `workers/api/src`, and anything a template's own runtime values hold.
 */
export function findQuotedInterpolations(source: string): QuotedInterpolation[] {
	const hits: QuotedInterpolation[] = [];
	const lines = source.split("\n");
	const lineOf = (idx: number) => source.slice(0, idx).split("\n").length;

	const scan = (from: number, to: number) => {
		let i = from;
		while (i < to) {
			const c = source[i];
			const next = source[i + 1];
			if (c === "/" && next === "/") {
				while (i < to && source[i] !== "\n") i++;
				continue;
			}
			if (c === "/" && next === "*") {
				const end = source.indexOf("*/", i + 2);
				i = end === -1 ? to : end + 2;
				continue;
			}
			if (c === '"' || c === "'") {
				i = skipQuoted(source, i, c);
				continue;
			}
			if (c === "`") {
				const tpl = readTemplate(source, i);
				if (readsAsSql(tpl.text)) {
					for (const ordinal of marksInsideQuotes(tpl.text)) {
						const it = tpl.interps[ordinal];
						if (!it) continue;
						const line = lineOf(it.index);
						hits.push({ line, expression: it.expression, excerpt: (lines[line - 1] ?? "").trim().slice(0, 160) });
					}
				}
				// A nested template inside an interpolation can be SQL of its own.
				for (const it of tpl.interps) scan(it.bodyFrom, it.bodyTo);
				i = tpl.end;
				continue;
			}
			i++;
		}
	};

	scan(0, source.length);
	return hits;
}

// ── The compound-SELECT ceiling ──────────────────────────────────────────────────────────────

/**
 * How many SELECTs D1 will join with UNION in one statement.
 *
 * MEASURED, not read off a doc page (#423). Against the production `pags` database on 2026-08-08,
 * `SELECT 1 UNION … ` executes at five terms and raises
 * `D1_ERROR: too many terms in compound SELECT: SQLITE_ERROR` at six — with or without `ALL`, and
 * whether or not each term is wrapped as `SELECT * FROM (…)`. SQLite's compile-time default for
 * `SQLITE_MAX_COMPOUND_SELECT` is 500; D1 sets it to 5, which is why nobody expected this.
 *
 * It is a PARSE failure. A statement over the ceiling never executes even once, so it cannot be
 * caught by "it worked in staging" — it worked nowhere. #423 shipped a six-arm UNION that failed
 * on every cron tick for 29 hours and produced 97% of the error log.
 */
export const D1_MAX_COMPOUND_TERMS = 5;

/** A SQL literal that joins more SELECTs with UNION than D1 will parse. */
export interface CompoundSelectOverrun {
	/** 1-based line of the string that holds the statement. */
	line: number;
	/** `UNION` keywords counted — the compound term count is one more. */
	unions: number;
	excerpt: string;
}

/**
 * SQL literals in `source` that exceed D1's compound-SELECT ceiling.
 *
 * WHAT IT CANNOT SEE, stated so nobody reads its silence as coverage:
 *
 *   • A union assembled at RUNTIME — `parts.join("\nUNION ALL\n")`, one branch per element of a
 *     list. The literal holds one `UNION`; the ceiling is crossed by the sixth element. A static
 *     scan cannot decide it; it needs a cap at the point of construction. Do not add a
 *     branch-per-item union without one. The one live instance of the shape,
 *     `instance-work.ts` (`unionAllChunks`), now has that cap — it chunks at
 *     {@link D1_MAX_COMPOUND_TERMS} and emits `ceil(n / 5)` statements (#434). What changed is
 *     that file, not this guard: the shape is still invisible from here, so a NEW one would be
 *     just as unseen.
 *   • SQL concatenated from several literals.
 *   • A literal holding more than one statement, where the count is the sum rather than any one
 *     statement's. Conservative in the safe direction: it can only over-report.
 */
export function findCompoundSelectOverruns(source: string, maxTerms = D1_MAX_COMPOUND_TERMS): CompoundSelectOverrun[] {
	const hits: CompoundSelectOverrun[] = [];
	const lines = source.split("\n");
	const lineOf = (idx: number) => source.slice(0, idx).split("\n").length;

	const consider = (text: string, at: number) => {
		if (!readsAsSql(text)) return;
		const unions = compoundSelectTerms(text) - 1;
		if (unions + 1 <= maxTerms) return;
		const line = lineOf(at);
		hits.push({ line, unions, excerpt: (lines[line - 1] ?? "").trim().slice(0, 160) });
	};

	const scan = (from: number, to: number) => {
		let i = from;
		while (i < to) {
			const c = source[i];
			const next = source[i + 1];
			if (c === "/" && next === "/") {
				while (i < to && source[i] !== "\n") i++;
				continue;
			}
			if (c === "/" && next === "*") {
				const end = source.indexOf("*/", i + 2);
				i = end === -1 ? to : end + 2;
				continue;
			}
			if (c === '"' || c === "'") {
				const end = skipQuoted(source, i, c);
				consider(source.slice(i + 1, Math.max(i + 1, end - 1)), i);
				i = end;
				continue;
			}
			if (c === "`") {
				const tpl = readTemplate(source, i);
				consider(tpl.text, i);
				for (const it of tpl.interps) scan(it.bodyFrom, it.bodyTo);
				i = tpl.end;
				continue;
			}
			i++;
		}
	};

	scan(0, source.length);
	return hits;
}

/**
 * Compound terms in one statement — the number D1 compares against its ceiling.
 *
 * `UNION` keywords plus one. Shared with the runtime double in `d1-sqlite.ts` so the static scan
 * and the executing harness cannot disagree about what "six terms" means: local SQLite parses 500
 * of them happily, so the ceiling is only ever enforced by this count, never by the engine.
 *
 * Counts every `UNION` in the text, including ones inside a subquery, where SQLite would apply the
 * ceiling per compound rather than to the sum. Conservative in the safe direction: it can only
 * over-report, and no query here nests one.
 */
export function compoundSelectTerms(sql: string): number {
	return (sql.match(/\bUNION\b/gi)?.length ?? 0) + 1;
}

// ── Every statement a static reader can resolve ──────────────────────────────────────────────

/** One SQL statement written out in full in a source file. */
export interface LiteralSqlStatement {
	/** 1-based line where the statement's first literal begins. */
	line: number;
	/** The statement text, with adjacent `"a" + "b"` fragments already joined. */
	sql: string;
}

/**
 * Every complete SQL statement in `source` that is written as a literal, in a form a test can
 * hand straight to a real SQLite parser.
 *
 * The point of returning these is that PARSING a statement checks things no string match can:
 * that it is syntactically valid at all, and that every table and column it names exists in the
 * schema the migrations actually build. `external-usage.ts` selected a `users.email` that has
 * never existed in any migration; it threw on every call, inside a `catch {}`, and read as
 * "nobody is an admin" for as long as it shipped.
 *
 * Adjacent string concatenation is joined (`"SELECT …" + " LEFT JOIN …"`, the shape
 * `stats-store.ts` and `loop-presets-store.ts` use) because a fragment is not a statement and
 * would otherwise report a false failure — the reading that made a first version of this guard
 * unusable.
 *
 * WHAT IT CANNOT SEE, stated so nobody reads its silence as coverage:
 *
 *   • SQL assembled at RUNTIME — any statement with a `${…}` in it. That is ~50 statements here
 *     and includes the highest-risk shapes: an interpolated column list, a WHERE built from
 *     clauses pushed onto an array, an `IN (${placeholders})`, a table name chosen per call.
 *     Those need the statement the code actually issues, which only running it produces —
 *     `realSchemaD1()` in `d1-sqlite.ts` is for exactly that, and a module is only covered once
 *     some test drives it through one.
 *   • A statement built by joining fragments held in variables or returned by a helper.
 *   • Anything outside the file handed in.
 *   • Whether a statement that parses returns the RIGHT ROWS. #451 shipped a `WHERE agent_id = ?1`
 *     against a column that is always NULL: perfectly valid SQL, zero rows, forever. Parsing has
 *     no opinion on data, and this guard must never be described as if it did.
 */
export function findLiteralSqlStatements(source: string): LiteralSqlStatement[] {
	const hits: LiteralSqlStatement[] = [];
	const lineOf = (idx: number) => source.slice(0, idx).split("\n").length;
	const skipWs = (at: number) => {
		let j = at;
		while (j < source.length && /\s/.test(source[j] as string)) j++;
		return j;
	};
	const backTo = (at: number) => {
		let j = at - 1;
		while (j >= 0 && /\s/.test(source[j] as string)) j--;
		return source[j];
	};
	/** Is this literal the CONTINUATION of an expression — `… + "SELECT …"`? Then it is a fragment. */
	const isContinuation = (at: number) => backTo(at) === "+";
	/**
	 * An element of an array literal. Every array of SQL in this Worker is a statement being
	 * ASSEMBLED — `["UPDATE agents SET", sets.join(", "), "WHERE id = ?1"].join(" ")` — so the
	 * element on its own is a fragment. An array of whole statements would be skipped too; that
	 * costs coverage, never a false red, which is the only direction this guard may be wrong in.
	 */
	const isArrayElement = (at: number, end: number) => {
		const before = backTo(at);
		const after = source[skipWs(end)];
		return (before === "[" || before === ",") && (after === "," || after === "]");
	};

	/** Join `"…" + "…" + …` runs so a statement split for line length is read as one. */
	const readConcatenation = (start: number, quote: string): { text: string; end: number; partial: boolean } => {
		let text = "";
		let i = start;
		let q = quote;
		for (;;) {
			const end = skipQuoted(source, i, q);
			text += unescapeJs(source.slice(i + 1, Math.max(i + 1, end - 1)));
			const plus = skipWs(end);
			if (source[plus] !== "+") return { text, end, partial: false };
			const nextLit = skipWs(plus + 1);
			const c = source[nextLit];
			// `"UPDATE agents SET " + sets.join(", ")` — the rest of the statement is a value, so
			// what is written here is a fragment and reporting it as a statement is noise.
			if (c !== '"' && c !== "'") return { text, end, partial: true };
			i = nextLit;
			q = c;
		}
	};

	const scan = (from: number, to: number) => {
		let i = from;
		while (i < to) {
			const c = source[i];
			const next = source[i + 1];
			if (c === "/" && next === "/") {
				while (i < to && source[i] !== "\n") i++;
				continue;
			}
			if (c === "/" && next === "*") {
				const end = source.indexOf("*/", i + 2);
				i = end === -1 ? to : end + 2;
				continue;
			}
			if (c === '"' || c === "'") {
				const run = readConcatenation(i, c);
				if (!run.partial && !isContinuation(i) && !isArrayElement(i, run.end) && isWholeStatement(run.text)) {
					hits.push({ line: lineOf(i), sql: run.text });
				}
				i = run.end;
				continue;
			}
			if (c === "`") {
				const tpl = readTemplate(source, i);
				// An interpolation means the statement is only complete at runtime. Skipped, and
				// said so above rather than guessed at with a placeholder.
				if (!tpl.interps.length && !isContinuation(i) && !isArrayElement(i, tpl.end) && isWholeStatement(tpl.text)) {
					hits.push({ line: lineOf(i), sql: tpl.text });
				}
				for (const it of tpl.interps) scan(it.bodyFrom, it.bodyTo);
				i = tpl.end;
				continue;
			}
			i++;
		}
	};

	scan(0, source.length);
	return hits;
}

/**
 * Where a statement STARTS, which is the difference between a query and a sentence about one.
 *
 * `readsAsSql` asks whether SQL keywords appear anywhere in the text, which is the right question
 * for "could an interpolation here widen a WHERE" and the wrong one for "is this a statement I can
 * hand to a parser". Prompt prose passes it easily — `apply-loop.ts` writes *"always pass the
 * element's exact ref from the snapshot to type/select/check/click/upload"*, which contains both a
 * verb and a clause keyword and is not SQL.
 *
 * It also contains the blast radius of a mis-lexed file. This scanner has no notion of a regex
 * literal, so `description.replace(/"/g, "'")` inside an interpolation leaves it a quote out of
 * step and the next backtick reads as an opener — one real occurrence, in `mcp-tool-catalog.ts`.
 * The runaway capture that produces begins mid-expression, so requiring a leading verb discards it
 * instead of reporting a source file as a broken query.
 */
function isWholeStatement(text: string): boolean {
	return STATEMENT_START.test(text) && readsAsSql(text);
}

const STATEMENT_START =
	/^\s*\(?\s*(?:SELECT\s|INSERT\s+(?:OR\s+\w+\s+)?INTO\s|UPDATE\s+[A-Za-z_"]|DELETE\s+FROM\s|REPLACE\s+INTO\s|WITH\s+[A-Za-z_]\w*\s+AS\s*\(|CREATE\s+TABLE\s)/i;

/** Undo the JS escapes a quoted literal carries, so SQLite sees the string the engine would. */
function unescapeJs(text: string): string {
	return text.replace(/\\(.)/g, (_m, c: string) => (c === "n" ? "\n" : c === "t" ? "\t" : c));
}

// ── The two sanctioned builders ──────────────────────────────────────────────────────────────

/** A JSON object key that can be spelled as `$.key` without quoting or escaping. */
const JSON_PATH_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isValidJsonPathKey(key: string): boolean {
	return JSON_PATH_KEY_RE.test(key);
}

/**
 * The SQLite JSON path for one top-level key — as a BOUND VALUE, never as SQL text.
 *
 * `json_set`/`json_remove` take the path as an ordinary function argument, so it binds like any
 * other value: `json_set(config, ?1, json(?2))`. Verified against SQLite, including that a bound
 * object or array still lands as an object or array (the subtype trap migration 0071 documents).
 *
 * That is the difference between two very different safety stories. Spliced as text, a quote in
 * the key ends the literal and the remainder executes — the regex above is then the only thing
 * between a caller and arbitrary SQL. Bound, a hostile key is inert: SQLite reads
 * `$.x', '$.y', json('1'))--` as a bizarre KEY NAME inside the document and nothing of it reaches
 * the parser. The validation stays anyway, because writing a key nobody can address later is
 * still a bug — it is just no longer a security boundary.
 */
export function jsonPath(key: string): string {
	if (!isValidJsonPathKey(key)) throw new Error(`Invalid JSON path key: ${key}`);
	return `$.${key}`;
}

/** A value safe to inline as a SQL string literal: no quote, no backslash, no whitespace. */
const SAFE_LITERAL_RE = /^[A-Za-z0-9._-]+$/;

/**
 * A comma-separated list of quoted SQL literals, for the ONE case where binding is wrong.
 *
 * SQLite only uses a PARTIAL index when it can prove the query's WHERE implies the index's, and it
 * does that by matching the predicate at PREPARE time. With `type IN (?3, ?4)` the values are
 * unknown then, so the index is skipped: `EXPLAIN QUERY PLAN` goes from `SEARCH … USING INDEX` to
 * `SCAN`, measured, and the query still returns the right answer, so nothing else would catch it.
 * `board.ts` inlines migration 0088's two ticket event types for exactly that reason.
 *
 * So the inlining is deliberate — but "deliberate" is not a property source code carries. This
 * function is where it becomes one: the values must be compile-time constants matching
 * {@link SAFE_LITERAL_RE}, and it throws at module load if they are not, failing every test at
 * once rather than shipping. Anything that is not a constant belongs in `.bind()`.
 */
export function sqlLiteralList(values: readonly string[]): string {
	if (!values.length) throw new Error("sqlLiteralList: refusing to build an empty IN () list");
	for (const v of values) {
		if (!SAFE_LITERAL_RE.test(v)) throw new Error(`sqlLiteralList: not a constant safe to inline: ${JSON.stringify(v)}`);
	}
	return values.map((v) => `'${v}'`).join(", ");
}
