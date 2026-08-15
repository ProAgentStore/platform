/**
 * The scanner behind the status-domain guard (#570, #587, #590). Pure — no filesystem, no env.
 *
 * Kept separate from `status-domain.ts` (the declarations) and from the test (which walks the
 * tree) for the reason `source-guard.ts` states: a guard that silently matches nothing looks
 * exactly like a guard that passes, so the scanner needs its own unit tests over fixtures.
 */

/** `table.column` → the values its schema comment declares. */
export interface DeclaredColumn {
	table: string;
	column: string;
	values: string[];
	/** Where it was found, for the failure message. */
	source: string;
}

const COLUMN_LINE =
	/^\s*(\w*status)\s+TEXT\b[^,]*?,?\s*--\s*(.+)$/i;

/**
 * Value domains declared the way this schema has declared them since `0001_init.sql`: a trailing
 * comment on the column listing the values, separated by `,` or `|`, optionally quoted.
 *
 *     status TEXT NOT NULL DEFAULT 'inactive',  -- inactive, active, error
 *     status TEXT NOT NULL DEFAULT 'running',   -- 'running' | 'completed' | 'failed'
 *
 * A comment that is prose rather than a list is NOT a declaration — `-- JSON array` must not
 * become a two-value domain. The test asserts the parsed set against the table in
 * `status-domain.ts`, so a comment this misses shows up as a missing key rather than silently.
 */
export function parseDeclaredColumns(files: { name: string; sql: string }[]): DeclaredColumn[] {
	const out: DeclaredColumn[] = [];
	for (const { name, sql } of files) {
		let table = "";
		for (const rawLine of sql.split("\n")) {
			const create = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)/i.exec(rawLine);
			if (create) table = create[1];
			if (!table) continue;
			const m = COLUMN_LINE.exec(rawLine);
			if (!m) continue;
			const values = m[2]
				.split(/[,|]/)
				.map((v) => v.trim().replace(/^['"]|['"]$/g, ""))
				.filter(Boolean);
			// A list, not a sentence. Two or more single tokens, each plausibly an enum member.
			if (values.length < 2 || values.some((v) => !/^[a-z][a-z0-9_]*$/i.test(v))) continue;
			out.push({ table, column: m[1], values, source: name });
		}
	}
	return out;
}

export interface Source {
	rel: string;
	/** Comments blanked, string literals KEPT — the literals are the evidence here. */
	code: string;
}

/**
 * Blank `//` and block comments, preserving length and newlines. Deliberately NOT
 * `stripCommentsAndLiterals` from `source-guard.ts`: that blanks string literals too, and a value
 * written to a status column IS a string literal. Regex literals are left alone; a `/` inside a
 * string is handled by skipping quoted runs, which is the only case that bit `source-guard.ts`.
 */
export function stripComments(source: string): string {
	const out = source.split("");
	const blank = (from: number, to: number) => {
		for (let k = from; k < to && k < out.length; k++) if (out[k] !== "\n") out[k] = " ";
	};
	let i = 0;
	while (i < source.length) {
		const c = source[i];
		const next = source[i + 1];
		if (c === '"' || c === "'" || c === "`") {
			let j = i + 1;
			while (j < source.length && source[j] !== c) {
				if (source[j] === "\\") j++;
				j++;
			}
			i = j + 1;
			continue;
		}
		if (c === "/" && next === "/") {
			let j = i;
			while (j < source.length && source[j] !== "\n") j++;
			blank(i, j);
			i = j;
			continue;
		}
		if (c === "/" && next === "*") {
			const end = source.indexOf("*/", i + 2);
			const j = end === -1 ? source.length : end + 2;
			blank(i, j);
			i = j;
			continue;
		}
		i++;
	}
	return out.join("");
}

/**
 * Every quoted string literal in a chunk of code, at BOTH nesting levels.
 *
 * Two independent passes, not one alternation, and the difference is the whole function. SQL in
 * this codebase is a TypeScript string containing SQL string literals:
 *
 *     "UPDATE users SET subscription_status = 'active' WHERE id = ?1"
 *
 * An alternation scanning left to right consumes the outer `"…"` as one literal and never sees
 * `'active'` — so the first cut of this reported "no application writer" for nine values that are
 * written in plain sight, one regex away. Over-collecting is the safe direction: callers keep only
 * the literals that are declared values of the column they asked about.
 */
export function literalsIn(chunk: string): string[] {
	const out: string[] = [];
	for (const m of chunk.matchAll(/'([^'\\\n]*)'/g)) out.push(m[1]);
	for (const m of chunk.matchAll(/"([^"\\\n]*)"/g)) out.push(m[1]);
	return out;
}

/**
 * The text of each statement that WRITES `table` and mentions `column`.
 *
 * A "statement" here is the `prepare(...)…run()` chain: from the `prepare(` that opens it to the
 * `;` that closes it. That window is what has to be read as one thing, because the column name is
 * in the SQL and the value is very often in the `.bind(...)` several lines below it — the shape
 * `INSERT INTO agents (…, status, …) VALUES (…, 'inactive', …)` is the easy case and
 * `SET status = ?1 … .bind(status, …)` is the one that matters.
 */
export function writeStatements(code: string, table: string, column: string): string[] {
	const out: string[] = [];
	const re = new RegExp(`(?:INSERT\\s+(?:OR\\s+\\w+\\s+)?INTO|REPLACE\\s+INTO|UPDATE)\\s+${table}\\b`, "gi");
	for (const m of code.matchAll(re)) {
		const from = code.lastIndexOf("prepare(", m.index ?? 0);
		const start = from === -1 ? (m.index ?? 0) : from;
		let end = code.indexOf(";", m.index ?? 0);
		if (end === -1) end = code.length;
		const chunk = code.slice(start, end);
		if (new RegExp(`\\b${column}\\b`).test(chunk)) out.push(chunk);
	}
	return out;
}

/**
 * The name of the function a character offset sits inside, or "" at module level.
 *
 * Both spellings, because this codebase uses both and the first cut of this only knew
 * `function X` — which silently reported "no writer" for five columns whose write helper is
 * `export const upsertX = async (…) => …`. A scanner that misses a shape reports a clean result,
 * which is the failure mode this whole file exists to avoid.
 */
export function enclosingFunction(code: string, offset: number): string {
	const before = code.slice(0, offset);
	const decls = [
		...before.matchAll(/(?:export\s+)?(?:async\s+)?function\s+(\w+)/g),
		...before.matchAll(/(?:export\s+)?(?:const|let)\s+(\w+)\s*(?::[^=]+)?=\s*(?:async\s*)?\(/g),
	];
	if (!decls.length) return "";
	decls.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
	return decls[decls.length - 1][1];
}

/** The argument text of every call to `name(` in `code`. */
export function callArguments(code: string, name: string): string[] {
	const out: string[] = [];
	const re = new RegExp(`\\b${name}\\s*\\(`, "g");
	for (const m of code.matchAll(re)) {
		let depth = 1;
		let i = (m.index ?? 0) + m[0].length;
		const start = i;
		while (i < code.length && depth > 0) {
			if (code[i] === "(") depth++;
			else if (code[i] === ")") depth--;
			i++;
		}
		const args = code.slice(start, i - 1);
		// The declaration matches this pattern too. Its parameters carry type annotations; calls
		// do not. (The same discriminator `instances-runtime.test.ts` uses, for the same reason.)
		if (/\w+\??:\s*(Env|string|number|boolean)\b/.test(args)) continue;
		out.push(args);
	}
	return out;
}

/**
 * Every value application code can write to `table.column`.
 *
 * Three routes, because a status write takes three shapes in this codebase:
 *  1. an SQL or bind literal inside the write statement itself;
 *  2. the column DEFAULT, when an INSERT into the table does not name the column — the application
 *     performing that INSERT is what puts the default into a row, so the default is reachable;
 *  3. a value bound from a PARAMETER, in which case the writable set is whatever the callers of
 *     the enclosing function pass. `updateRuntimeStatus(env, id, uid, "offline", node)` is the
 *     example that matters: the literal is nowhere near the SQL.
 */
export function writableValues(
	sources: Source[],
	table: string,
	column: string,
	declared: string[],
	columnDefault: string | null,
): Set<string> {
	const found = new Set<string>();
	const parameterisedIn: { rel: string; fn: string }[] = [];
	let insertsWithoutColumn = false;

	for (const { rel, code } of sources) {
		const statements = writeStatements(code, table, column);
		for (const chunk of statements) {
			for (const lit of literalsIn(chunk)) if (declared.includes(lit)) found.add(lit);
			// Bound from a variable? Then the callers decide, not this statement.
			if (new RegExp(`\\b${column}\\s*=\\s*\\?`).test(chunk) || /VALUES\s*\(\s*\?/i.test(chunk)) {
				const at = code.indexOf(chunk);
				parameterisedIn.push({ rel, fn: enclosingFunction(code, at < 0 ? 0 : at) });
			}
		}
		// An INSERT into the table that does not name the column applies the DEFAULT.
		const inserts = new RegExp(`INSERT\\s+(?:OR\\s+\\w+\\s+)?INTO\\s+${table}\\b`, "gi");
		for (const m of code.matchAll(inserts)) {
			let end = code.indexOf(";", m.index ?? 0);
			if (end === -1) end = code.length;
			if (!new RegExp(`\\b${column}\\b`).test(code.slice(m.index ?? 0, end))) insertsWithoutColumn = true;
		}
	}

	if (insertsWithoutColumn && columnDefault && declared.includes(columnDefault)) found.add(columnDefault);

	for (const { fn } of parameterisedIn) {
		if (!fn) continue;
		for (const { code } of sources) {
			for (const args of callArguments(code, fn)) {
				for (const lit of literalsIn(args)) if (declared.includes(lit)) found.add(lit);
			}
		}
	}
	return found;
}

/** `<col> TEXT ... DEFAULT 'x'` → `x`. */
export function parseDefault(files: { sql: string }[], table: string, column: string): string | null {
	for (const { sql } of files) {
		const block = new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?["\`]?${table}\\b[\\s\\S]*?;`, "i").exec(sql);
		const body = block?.[0] ?? "";
		const m = new RegExp(`\\b${column}\\s+TEXT[^,]*?DEFAULT\\s+'([^']*)'`, "i").exec(body);
		if (m) return m[1];
	}
	return null;
}

export interface Decision {
	rel: string;
	line: number;
	text: string;
}

/** Does this file query `table` at all? `\b` matters: `agent_instances` is not `agents`. */
export function queriesTable(code: string, table: string): boolean {
	return new RegExp(`(?:FROM|JOIN|INTO|UPDATE)\\s+${table}\\b`, "i").test(code);
}

/**
 * The aliases a SQL statement binds to `table` — `FROM agents a`, `JOIN users u ON …`.
 *
 * Needed because a single statement routinely joins several tables that each have a column called
 * `status`, and `WHERE i.status = 'active'` inside a statement that also selects `FROM agents a`
 * is a decision about `agent_instances`, not about `agents`. Without this, `lib/admin.ts` alone
 * produced four confident false reports.
 */
export function aliasesFor(statement: string, table: string): string[] {
	const out: string[] = [];
	const re = new RegExp(`(?:FROM|JOIN|INTO|UPDATE)\\s+${table}\\b\\s*(?:AS\\s+)?(\\w+)?`, "gi");
	for (const m of statement.matchAll(re)) {
		const alias = m[1];
		if (alias && !/^(ON|WHERE|SET|VALUES|LEFT|INNER|JOIN|GROUP|ORDER|LIMIT|AND|OR)$/i.test(alias)) out.push(alias);
	}
	return out;
}

/** Every table an alias in this statement could refer to, as `alias → table`. */
export function aliasMap(statement: string): Map<string, string> {
	const out = new Map<string, string>();
	for (const m of statement.matchAll(/(?:FROM|JOIN|INTO|UPDATE)\s+(\w+)\s*(?:AS\s+)?(\w+)?/gi)) {
		const [, tbl, alias] = m;
		if (alias && !/^(ON|WHERE|SET|VALUES|LEFT|INNER|JOIN|GROUP|ORDER|LIMIT|AND|OR)$/i.test(alias)) out.set(alias, tbl);
	}
	return out;
}

/**
 * Every table named in a statement, aliased or not.
 *
 * `aliasMap` is not enough for the ambiguity question: the correlated subquery
 * `(SELECT COUNT(*) FROM agent_instances WHERE agent_id = a.id AND status = 'active')` inside a
 * `FROM agents a` statement names its table WITHOUT an alias, so an alias-only view saw one table,
 * called the bare `status` unambiguous, and reported two decisions about `agents` that were about
 * `agent_instances`.
 */
export function tablesIn(statement: string): string[] {
	const out = new Set<string>();
	for (const m of statement.matchAll(/(?:FROM|JOIN|INTO|UPDATE)\s+(\w+)/gi)) out.add(m[1]);
	return [...out];
}

/**
 * Places where application code takes a DECISION on a specific value of a status column: a
 * comparison, in TypeScript or in SQL. This is the thing that must never name an unwritable value
 * — reading such a value and displaying it is harmless; branching on it is a branch that can
 * never be taken for anything the application creates.
 *
 * ## Attribution to a table is the hard part, and it is deliberately conservative
 *
 * Half a dozen tables in this schema have a column literally called `status`, so matching the
 * column name alone attributes every `x.status === "error"` in the Worker to all of them at once
 * — the first cut of this reported 24 offenders, of which 2 were real. A guard with a 90% false
 * positive rate is a guard that gets an allowlist bolted to it and then gets ignored.
 *
 * So a hit only counts in a file that actually QUERIES the table. That is sound for SQL (the
 * statement names the table) and a heuristic for TypeScript (a row of `agents` is overwhelmingly
 * compared in the file that selected it). It UNDER-reports across a file boundary: a row read in
 * one module and branched on in another is missed. That is the right direction to be wrong in —
 * every offender it does report is real, so the failure is always worth reading.
 */
export function findDecisions(
	sources: Source[],
	table: string,
	column: string,
	value: string,
	/** Every table in the schema that declares a status domain — used to judge ambiguity. */
	statusTables: string[] = [],
): Decision[] {
	const out: Decision[] = [];
	const lineOf = (code: string, index: number) => code.slice(0, index).split("\n").length;
	const push = (rel: string, code: string, index: number) => {
		const line = lineOf(code, index);
		const text = code.split("\n")[line - 1]?.trim() ?? "";
		if (!out.some((d) => d.rel === rel && d.line === line)) out.push({ rel, line, text });
	};

	// ── SQL: precise, because the statement names its own tables ────────────────────────────────
	const sqlOps = new RegExp(`(?:(\\w+)\\.)?\\b${column}\\s*(?:=|!=|<>)\\s*'${value}'|(?:(\\w+)\\.)?\\b${column}\\s+IN\\s*\\([^)]*'${value}'`, "gi");
	for (const { rel, code } of sources) {
		for (const stmt of sqlStatements(code)) {
			if (!queriesTable(stmt.text, table)) continue;
			const aliases = aliasesFor(stmt.text, table);
			const others = tablesIn(stmt.text).filter((t) => t !== table);
			for (const m of stmt.text.matchAll(sqlOps)) {
				const qualifier = m[1] ?? m[2] ?? "";
				// Unqualified is this table's only if no OTHER table in the statement could own it.
				const ambiguous = !qualifier && others.length > 0;
				if (qualifier ? !aliases.includes(qualifier) : ambiguous) continue;
				push(rel, code, stmt.start + (m.index ?? 0));
			}
		}
	}

	// ── TypeScript: `row.status === "active"`, scoped to files where the table is unambiguous ────
	//
	// A row's table is not knowable from `x.status` without type resolution, and six tables here
	// have a column called `status` — so this only reports in a file that queries EXACTLY ONE
	// status-declaring table. `routes/run.ts` (agents) and `lib/runner-client.ts` (the two runtime
	// tables, which share a domain) are exactly that; `lib/admin.ts` and `agent-think.ts` are not,
	// and their SQL decisions are covered precisely above. A known, deliberate under-report: a
	// false alarm here would cost more than the miss, because the miss is still caught by the SQL
	// half wherever the decision is expressed in SQL.
	const tsOps = new RegExp(`\\.${column}\\s*[!=]==?\\s*["'\`]${value}["'\`]|["'\`]${value}["'\`]\\s*[!=]==?\\s*\\w+\\.${column}\\b`, "g");
	for (const { rel, code } of sources) {
		if (!queriesTable(code, table)) continue;
		const others = statusTables.filter((t) => t !== table && queriesTable(code, t));
		if (others.length) continue;
		for (const m of code.matchAll(tsOps)) push(rel, code, m.index ?? 0);
	}
	return out.sort((a, b) => a.rel.localeCompare(b.rel) || a.line - b.line);
}

/** Each `prepare(` … `;` window, with its start offset — one SQL statement as the reader sees it. */
export function sqlStatements(code: string): { text: string; start: number }[] {
	const out: { text: string; start: number }[] = [];
	for (const m of code.matchAll(/prepare\(/g)) {
		const start = m.index ?? 0;
		let end = code.indexOf(";", start);
		if (end === -1) end = code.length;
		out.push({ text: code.slice(start, end), start });
	}
	return out;
}
