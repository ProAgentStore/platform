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
