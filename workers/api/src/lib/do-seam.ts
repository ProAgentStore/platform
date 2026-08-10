/**
 * Reading the AgentDO's own dispatch table — the DO half of the route → DO seam (#438).
 *
 * ── What this is for
 *
 * #428 was a paging feature broken at three layers at once, and the middle one was a route
 * that rebuilt the DO query string from scratch and silently dropped `before`. Nothing could
 * see it: the route's own test asserted the route's response, the DO's asserted the DO's, and
 * the parameter died in the gap between them. `routes/do-seam.contract.test.ts` closes that gap
 * by DRIVING each route against a recording DO stub and comparing what arrives with what the DO
 * actually honours. This module answers the second half of that question.
 *
 * ── Why the DO half is read and not driven
 *
 * `agent-do.ts` extends `DurableObject` from `cloudflare:workers`, which does not resolve under
 * vitest (`relay-do.test.ts` says the same thing about `RelayDO` and re-implements its logic
 * rather than import it). So the object cannot be instantiated in the unit suite, and a
 * re-implementation would be a paraphrase asserting itself. What CAN be done honestly is to read
 * the dispatch table the object really runs: for a concrete path and method, walk the same
 * `if (path === …)` chain the DO walks, find the handler it lands on, and collect the
 * `url.searchParams.get("…")` calls in that handler's body.
 *
 * That is a scan, with a scan's limits, and they are stated where they bite:
 *
 *   • It sees a parameter the handler READS, not one it HONOURS. A handler that reads `before`
 *     and ignores it is invisible here — and that is exactly what the DO did before #428.
 *     This module cannot catch that, and the contract test's header says so rather than
 *     implying a reach it does not have.
 *   • It follows ONE hop: the arm's handler. A parameter read by something that handler calls
 *     is not attributed. `assertDispatchTableParsed` fails loudly if the table stops parsing,
 *     so this degrades into a red build rather than a quiet zero.
 *
 * Comments and string literals are blanked before any structural decision (via
 * `source-guard.ts`, for the reason its header gives: this codebase writes far more prose about
 * a call than code that makes it), while the literal VALUES — the paths, the parameter names —
 * are read from the raw text at the same offsets.
 */
import { stripCommentsAndLiterals } from "./source-guard.js";

/** A source file with its literal text and a length-preserving comment/literal-blanked twin. */
export interface LexedSource {
	/** Path relative to workers/api/src, for failure messages. */
	rel: string;
	raw: string;
	code: string;
}

export function lex(rel: string, raw: string): LexedSource {
	return { rel, raw, code: stripCommentsAndLiterals(raw) };
}

/** One arm of the DO's dispatch chain: a path test, a method test, and where it goes. */
export interface DoRouteArm {
	/** 1-based line of the `if (path …)` in the file it was read from. */
	line: number;
	/** The condition as written, for failure messages. */
	condition: string;
	/** The HTTP method the arm requires, or null when it tests none. */
	method: string | null;
	/**
	 * The handler the arm dispatches to, as written (`this.handleGetMessages`,
	 * `storageRoutes.listFiles`, `getKnowledge`), or null for an arm that answers inline.
	 */
	handler: string | null;
	/** Does this arm claim the given DO path? */
	matches(path: string): boolean;
}

/** Names that appear first on a return line without being the handler. */
const NOT_A_HANDLER = new Set(["json", "decodeURIComponent", "encodeURIComponent", "String", "Number", "await"]);

/**
 * Every `if (path …) return …` arm of the DO's dispatch chain, in source order — which is
 * dispatch order, and the reason `matches` must be tried in sequence rather than as a set.
 */
export function parseDoRouteTable(src: LexedSource): DoRouteArm[] {
	const arms: DoRouteArm[] = [];
	// The condition is single-line in every arm; the greedy `[^\n]*` therefore ends at the last
	// `)` on that line, which is the one that closes the `if`. The mandatory newline is what stops
	// it from ending early inside `path.startsWith("/x")`.
	//
	// The line AFTER the condition is captured whatever it is — not only a `return`. An arm that
	// opens a block and answers inline (`/system-message`) still has to appear in this table: an
	// arm that goes missing reads downstream as "the DO takes no parameters here", which is a
	// guard grading itself green.
	const armRe = /\bif \((path[^\n]*)\)\s*\{?[ \t]*\r?\n[ \t]*([^\n]*)/g;
	for (const m of src.raw.matchAll(armRe)) {
		const at = m.index ?? 0;
		// A match whose text is entirely blank in the lexed twin came from a comment.
		if (!src.code.slice(at, at + m[0].length).trim()) continue;
		const condition = m[1];
		arms.push({
			line: src.raw.slice(0, at).split("\n").length,
			condition,
			method: /request\.method === "([A-Z]+)"/.exec(condition)?.[1] ?? null,
			handler: m[2].startsWith("return ") ? handlerOf(m[2]) : null,
			matches: pathMatcher(condition, `${src.rel}:${condition}`),
		});
	}
	return arms;
}

/** The handler named by a `return …` line, or null when the arm answers inline. */
function handlerOf(returnLine: string): string | null {
	// `withEngine` is a wrapper — the handler is the call INSIDE it.
	const wrapped = /([A-Za-z_]\w*)\.([A-Za-z_]\w*)\(/.exec(returnLine.replace(/this\.withEngine\(/, ""));
	if (wrapped && wrapped[1] !== "this") return `${wrapped[1]}.${wrapped[2]}`;
	const method = /this\.([A-Za-z_]\w*)\(/.exec(returnLine);
	if (method && method[1] !== "withEngine") return `this.${method[1]}`;
	for (const call of returnLine.matchAll(/(?:^|[\s(=>])([A-Za-z_]\w*)\(/g)) {
		if (!NOT_A_HANDLER.has(call[1])) return call[1];
	}
	return null;
}

/** Turn an arm's condition into the predicate the DO applies to `url.pathname`. */
function pathMatcher(condition: string, where: string): (path: string) => boolean {
	const tests: Array<(p: string) => boolean> = [];
	for (const m of condition.matchAll(/path === "([^"]*)"/g)) {
		const value = m[1];
		tests.push((p) => p === value);
	}
	for (const m of condition.matchAll(/path\.startsWith\("([^"]*)"\)/g)) {
		const value = m[1];
		tests.push((p) => p.startsWith(value));
	}
	for (const m of condition.matchAll(/path\.match\(/g)) {
		const re = readRegexLiteral(condition, (m.index ?? 0) + m[0].length);
		if (!re) throw new Error(`do-seam: could not read the regex in ${where}`);
		tests.push((p) => re.test(p));
	}
	if (!tests.length) {
		// Loud, not silent: an arm shape this parser cannot read would otherwise present as "the
		// DO honours nothing here", which is the guard quietly grading itself green.
		throw new Error(`do-seam: unreadable path condition in ${where} — teach pathMatcher this shape`);
	}
	return (p) => tests.every((t) => t(p));
}

/**
 * Read a regex literal starting at `start`, honouring `\` escapes and `[...]` classes — the
 * class matters, because every path regex in the table contains `[^/]+` and a naive scan for
 * the closing `/` stops inside it.
 */
function readRegexLiteral(text: string, start: number): RegExp | null {
	if (text[start] !== "/") return null;
	let i = start + 1;
	let inClass = false;
	while (i < text.length) {
		const c = text[i];
		if (c === "\\") {
			i += 2;
			continue;
		}
		if (c === "[") inClass = true;
		else if (c === "]") inClass = false;
		else if (c === "/" && !inClass) {
			const flags = /^[a-z]*/.exec(text.slice(i + 1))?.[0] ?? "";
			return new RegExp(text.slice(start + 1, i), flags);
		}
		i++;
	}
	return null;
}

/** The first arm that claims `method path`, in dispatch order — the one the DO would run. */
export function armFor(arms: DoRouteArm[], method: string, path: string): DoRouteArm | null {
	return arms.find((a) => (a.method === null || a.method === method) && a.matches(path)) ?? null;
}

/** The half-open span of a named function or class method's body, in `src`. */
export function findHandlerSpan(src: LexedSource, name: string): { from: number; to: number } | null {
	const decl = new RegExp(
		`(?:export\\s+(?:async\\s+)?function|private\\s+(?:async\\s+)?|public\\s+(?:async\\s+)?|async)\\s+${name}\\s*\\(`,
	);
	const m = decl.exec(src.code);
	if (!m) return null;
	// Brace-match over the lexed twin, where a `{` inside a string or comment no longer exists.
	// A template literal's `${…}` survives as code, and so does its closing brace, so it balances.
	const open = src.code.indexOf("{", (m.index ?? 0) + m[0].length);
	if (open === -1) return null;
	let depth = 0;
	for (let i = open; i < src.code.length; i++) {
		if (src.code[i] === "{") depth++;
		else if (src.code[i] === "}" && --depth === 0) return { from: open, to: i + 1 };
	}
	return null;
}

/** The query parameters read inside a span, in first-read order, de-duplicated. */
export function queryParamsIn(src: LexedSource, span: { from: number; to: number }): string[] {
	const names: string[] = [];
	const code = src.code.slice(span.from, span.to);
	for (const m of code.matchAll(/searchParams\.get\(/g)) {
		// The name lives in the raw text at the same offset — the lexed twin blanked it.
		const at = span.from + (m.index ?? 0) + m[0].length;
		const name = /^\s*"([^"]+)"/.exec(src.raw.slice(at, at + 64))?.[1];
		if (name && !names.includes(name)) names.push(name);
	}
	return names;
}

/**
 * The query parameters the DO reads for `method path` — resolved through the dispatch table and
 * the handler it lands on.
 *
 * Throws rather than returning `[]` when the path is unrouted or the handler cannot be found:
 * an empty answer and "I could not look" must not be the same value, which is the mistake that
 * makes a guard pass for the wrong reason.
 */
export function doQueryParams(sources: LexedSource[], table: LexedSource, method: string, path: string): string[] {
	const arm = armFor(parseDoRouteTable(table), method, path);
	if (!arm) throw new Error(`do-seam: the DO has no arm for ${method} ${path}`);
	if (!arm.handler) return [];
	const bare = arm.handler.replace(/^.*\./, "");
	for (const src of sources) {
		const span = findHandlerSpan(src, bare);
		if (span) return queryParamsIn(src, span);
	}
	throw new Error(`do-seam: ${method} ${path} dispatches to ${arm.handler}, which is in none of the scanned files`);
}
