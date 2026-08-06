/**
 * Source scanning for the security guards (#306) — pure, no filesystem.
 *
 * WHY A SCANNER AND NOT A REVIEW CHECKLIST. Every invariant this repo enforces at ONE
 * choke point has, at least once, been quietly bypassed by the next thing added next to
 * it: suspension was "enforced in requireUser" and had three inline-verify holes; the
 * untrusted fence was closable by a marker inside its own body; a per-connector consent
 * row covered every MCP server a user could name. In each case the mechanism was correct
 * and a new call site simply did not go through it. A reviewer cannot catch the
 * seventeenth call site by eye — that is the job this module exists to do.
 *
 * WHY STRIPPING COMMENTS IS THE WHOLE TRICK. This codebase explains itself at length, so
 * the words a naive grep looks for — `fetch(`, `verifySession`, `destructiveHint` — appear
 * far more often in prose ABOUT the rule than in code that breaks it. `lib/ssrf.ts` alone
 * names `fetch(` five times in its header comment. A guard that reports those is a guard
 * someone turns off in a week, so everything here runs over code with comments, string
 * literals and regex literals blanked out.
 *
 * Deliberately a hand-written lexer, not the TypeScript AST: these guards run inside the
 * fast unit suite over ~250 files and must not pull a compiler into it — the same call
 * `lib/import-graph.ts` makes, for the same reason.
 */

/**
 * Blank out comments, string/template literals and regex literals, PRESERVING length and
 * line breaks so a match's line number still points at the real line.
 *
 * Template literals keep their `${...}` interpolations as live code — a call written
 * inside one (`` `${await fetch(url)}` ``) is still a call, and blanking the whole literal
 * would hide it.
 *
 * Regex literals are recognised by what precedes them, which is the only way to tell `/` as
 * division from `/` as a literal without parsing. It matters here: `/https:\/\//` contains
 * what looks exactly like the start of a line comment, and mis-lexing it swallows the rest
 * of the line — including, in this codebase, real code.
 */
export function stripCommentsAndLiterals(source: string): string {
	const out = source.split("");
	const blank = (from: number, to: number) => {
		for (let k = from; k < to && k < out.length; k++) {
			if (out[k] !== "\n") out[k] = " ";
		}
	};
	// The last code character seen, used to decide whether a `/` opens a regex literal.
	let prev = "";
	let i = 0;
	while (i < source.length) {
		const c = source[i];
		const next = source[i + 1];

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
		if (c === '"' || c === "'") {
			const j = skipQuoted(source, i, c);
			blank(i + 1, j - 1);
			i = j;
			prev = c;
			continue;
		}
		if (c === "`") {
			i = blankTemplate(source, i, blank);
			prev = "`";
			continue;
		}
		if (c === "/" && opensRegex(prev)) {
			const j = skipRegex(source, i);
			// A regex spanning a newline is not a regex — it was division. Leave it alone.
			if (source.slice(i, j).includes("\n")) {
				prev = c;
				i++;
				continue;
			}
			blank(i + 1, j - 1);
			i = j;
			prev = "/";
			continue;
		}
		if (!/\s/.test(c)) prev = c;
		i++;
	}
	return out.join("");
}

/** Index just past the closing quote. */
function skipQuoted(src: string, start: number, quote: string): number {
	let i = start + 1;
	while (i < src.length) {
		if (src[i] === "\\") {
			i += 2;
			continue;
		}
		if (src[i] === quote) return i + 1;
		if (src[i] === "\n" && quote !== "`") return i; // unterminated — don't run away
		i++;
	}
	return src.length;
}

/** Blank a template literal's text but keep `${ ... }` expressions as code. Returns the index past the closing backtick. */
function blankTemplate(src: string, start: number, blank: (a: number, b: number) => void): number {
	let i = start + 1;
	let textFrom = i;
	while (i < src.length) {
		if (src[i] === "\\") {
			i += 2;
			continue;
		}
		if (src[i] === "`") {
			blank(textFrom, i);
			return i + 1;
		}
		if (src[i] === "$" && src[i + 1] === "{") {
			blank(textFrom, i);
			// Walk to the matching brace so nested templates/objects survive.
			let depth = 1;
			let j = i + 2;
			while (j < src.length && depth > 0) {
				if (src[j] === "`") {
					j = blankTemplate(src, j, blank);
					continue;
				}
				if (src[j] === '"' || src[j] === "'") {
					const e = skipQuoted(src, j, src[j]);
					blank(j + 1, e - 1);
					j = e;
					continue;
				}
				if (src[j] === "{") depth++;
				else if (src[j] === "}") depth--;
				j++;
			}
			i = j;
			textFrom = i;
			continue;
		}
		i++;
	}
	blank(textFrom, src.length);
	return src.length;
}

/** After these, a `/` starts a regex literal rather than a division. */
function opensRegex(prev: string): boolean {
	return prev === "" || "(,=:[!&|?{};+-*%~^<>".includes(prev);
}

/** Index just past the closing `/` (plus flags). */
function skipRegex(src: string, start: number): number {
	let i = start + 1;
	let inClass = false;
	while (i < src.length) {
		const c = src[i];
		if (c === "\\") {
			i += 2;
			continue;
		}
		if (c === "\n") return i;
		if (c === "[") inClass = true;
		else if (c === "]") inClass = false;
		else if (c === "/" && !inClass) {
			i++;
			while (i < src.length && /[a-z]/.test(src[i])) i++; // flags
			return i;
		}
		i++;
	}
	return src.length;
}

export interface Hit {
	/** 1-based line of the match. */
	line: number;
	/** The matched line, trimmed, for the failure message. */
	excerpt: string;
}

/** Every line of `code` matching `re`, as {line, excerpt}. Expects comment-stripped input. */
export function matchLines(code: string, re: RegExp): Hit[] {
	const flags = re.flags.includes("g") ? re.flags : `${re.flags}g`;
	const rx = new RegExp(re.source, flags);
	const hits: Hit[] = [];
	for (const m of code.matchAll(rx)) {
		const line = code.slice(0, m.index).split("\n").length;
		hits.push({ line, excerpt: (code.split("\n")[line - 1] ?? "").trim().slice(0, 140) });
	}
	return hits;
}

/**
 * Calls to a bare `name(...)` — not `obj.name(...)`, not `otherName(...)`.
 *
 * The negative lookbehind on `.` is what separates a raw global `fetch(` from the
 * `stub.fetch(` a Durable Object binding uses on every request, and `safeFetch(` from
 * `fetch(`. Without both, the SSRF guard reports the guard's own callers.
 */
export function findCalls(code: string, name: string): Hit[] {
	return matchLines(code, new RegExp(`(?<![.\\w$])${name}\\s*\\(`));
}

/** Bare mentions of an identifier (property access included) — for "this name must not appear". */
export function findIdentifier(code: string, name: string): Hit[] {
	return matchLines(code, new RegExp(`\\b${name}\\b`));
}

/**
 * Writes to a SQL table.
 *
 * `kind: "store"` narrows to the verbs that PUT a value in — INSERT / REPLACE / UPDATE —
 * and excludes DELETE. The distinction is the whole difference between a real finding and
 * noise for the credential guard: five routes touch `user_api_keys`, every one of them to
 * revoke a key, and removing a secret needs no key material. Failing them would have made
 * the guard's first real run look like five bugs and get muted.
 */
export function findTableWrites(code: string, table: string, kind: "any" | "store" = "any"): Hit[] {
	const verbs = kind === "store" ? "INSERT\\s+(?:OR\\s+\\w+\\s+)?INTO|REPLACE\\s+INTO|UPDATE" : "INSERT\\s+(?:OR\\s+\\w+\\s+)?INTO|REPLACE\\s+INTO|UPDATE|DELETE\\s+FROM";
	return matchLines(code, new RegExp(`(?:${verbs})\\s+${table}\\b`, "i"));
}

/**
 * A tool name that reads as MUTATING the system it talks to.
 *
 * Matched on the VERB, positionally — the leading word, or the word after the connector
 * prefix (`github_create_issue` → `create`). A substring test would call
 * `list_subordinates` destructive for containing "sub", and `terminal_capture` safe for
 * not containing any of these, which is right; a positional verb test is the version that
 * stays true as tools are added.
 *
 * Deliberately conservative in the other direction: `read`, `list`, `get`, `search`,
 * `capture`, `snapshot`, `status` are not here, so a genuinely read-only tool never has to
 * argue with the guard.
 */
const MUTATING_VERBS = new Set([
	"act",
	"add",
	"append",
	"apply",
	"approve",
	"call",
	"cancel",
	"clear",
	"close",
	"comment",
	"create",
	"delegate",
	"delete",
	"deploy",
	"disable",
	"drive",
	"drop",
	"edit",
	"enable",
	"end",
	"grant",
	"publish",
	"purge",
	"revoke",
	"exec",
	"execute",
	"insert",
	"invoke",
	"kill",
	"merge",
	"navigate",
	"new",
	"patch",
	"post",
	"push",
	"put",
	"remove",
	"rename",
	"reset",
	"restart",
	"run",
	"send",
	"set",
	"start",
	"stop",
	"submit",
	"update",
	"upload",
	"upsert",
	"write",
]);

/** True when the tool's NAME says it changes something on the other side. */
export function readsAsMutating(toolName: string): boolean {
	const parts = String(toolName || "").toLowerCase().split("_").filter(Boolean);
	// The verb is the first word, or the second when the first is the connector prefix
	// (`github_create_issue`, `mcp_call_tool`, `sheets_append`).
	return parts.slice(0, 2).some((p) => MUTATING_VERBS.has(p));
}
