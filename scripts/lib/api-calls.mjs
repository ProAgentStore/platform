/**
 * api-calls.mjs — the pure half of `scripts/check-mcp-parity.mjs` (#610).
 *
 * Reads HTTP call sites out of TypeScript source: which API route a file calls, with which
 * method. Two consumers ask the same question of two trees — the console (`api()`/`useApi()`)
 * and the MCP worker (`authedCall()`/`apiCall()`) — and the parity check is the diff.
 *
 * Nothing here touches the filesystem. The shapes worth testing are the ones this repo's source
 * does NOT contain and must not have to (a call whose path is a variable, a nested template, a
 * path built by a ternary), which is why the parsing lives in a module with its own tests rather
 * than inside the check — the same split as `surface-lock.mjs` and `doc-claims.mjs`.
 *
 * ── Why a parser and not a regex
 *
 * The first prototype was a regex over `` `/v1/…` `` and it reported `agent_trace` as having no
 * MCP path. It has one; the call is
 * `` authedCall(`/v1/instances/${encodeURIComponent(id)}/trace${qs ? `?${qs}` : ""}`, …) `` and a
 * regex that stops at the first backtick reads the nested template as the end of the string. A
 * false gap is the worst output this check can produce — it sends someone to build a tool that
 * already exists, and the second false one gets the check deleted — so the literal reader below
 * tracks `${…}` nesting properly, including nested templates inside it.
 */

/**
 * Read the string/template literal starting at `src[i]`, collapsing every `${…}` to `{}`.
 *
 * Returns `null` when `src[i]` is not a quote, so a caller can tell "not a literal" from "an
 * empty literal" — the G1/G3 distinction, one level down.
 *
 * @param {string} src
 * @param {number} i index of the opening quote/backtick
 * @returns {{text: string, end: number} | null} `end` is the index AFTER the closing quote
 */
export function readLiteral(src, i) {
	const quote = src[i];
	if (quote !== "`" && quote !== '"' && quote !== "'") return null;
	let out = "";
	/** The raw source of each `${…}`, in order — needed to resolve a table-driven prefix. */
	const parts = [];
	let j = i + 1;
	while (j < src.length) {
		const c = src[j];
		if (c === "\\") {
			out += src[j + 1] ?? "";
			j += 2;
			continue;
		}
		if (c === quote) return { text: out, end: j + 1, parts };
		if (quote === "`" && c === "$" && src[j + 1] === "{") {
			// Walk the interpolation to its matching `}`, skipping any nested template whole —
			// this is the case the regex prototype got wrong on `agent_trace`.
			let depth = 1;
			let k = j + 2;
			while (k < src.length && depth > 0) {
				const ch = src[k];
				if (ch === "{") depth++;
				else if (ch === "}") depth--;
				else if (ch === "`" || ch === '"' || ch === "'") {
					const inner = readLiteral(src, k);
					if (inner) k = inner.end - 1;
				}
				k++;
			}
			parts.push(src.slice(j + 2, k - 1));
			out += "{}";
			j = k;
			continue;
		}
		out += c;
		j++;
	}
	return null;
}

/**
 * Expand a path whose PREFIX is an interpolation off a lookup table.
 *
 * `` `${PROVIDERS[provider].base}/instances/${id}/grants` `` is how the MCP worker serves the
 * Drive and WorkDrive grant tools from one registration, and six console capabilities looked
 * missing because of it — a sixth of the first run's gap list, all false. Rather than special-case
 * that table, take the FIELD the interpolation reads (`base`) and use every `base: "/v1/…"`
 * literal declared in the same file as a prefix. Wrong only if a file declares a same-named field
 * holding a path it never calls, which costs a missed gap rather than an invented one.
 *
 * @param {string} text normalised literal text, starting with `{}`
 * @param {string} firstPart raw source of the leading interpolation
 * @param {string} src the whole file
 * @returns {string[]}
 */
export function expandTablePrefix(text, firstPart, src) {
	const field = firstPart.trim().match(/\.([A-Za-z_$][\w$]*)\s*$/)?.[1];
	if (!field) return [];
	const suffix = text.slice(2);
	if (!suffix.startsWith("/")) return [];
	const prefixes = new Set();
	for (const m of src.matchAll(new RegExp(`\\b${field}\\s*:\\s*["'\`](/v1/[^"'\`]*)["'\`]`, "g"))) {
		prefixes.add(m[1].replace(/\/+$/, ""));
	}
	return [...prefixes].map((p) => `${p}${suffix}`);
}

/**
 * A route path in the one shape both trees compare in.
 *
 * Same normalisation `openapi-coverage.mjs` uses and for the same reason: a parameter's NAME is
 * a choice, not part of the route, so `:instanceId`, `${instanceId}` and `{id}` all become `{}`.
 * The query string is dropped — `/trace?trace_id=…` and `/trace` are one capability, and a
 * caller filtering differently is not a different route.
 *
 * The one addition is the interpolation GLUED to a segment: `` `/…/activity${qs}` `` normalises
 * to `/…/activity`, because that `{}` is a query string the template appended, not a path
 * segment. A segment that is ONLY `{}` stays a parameter.
 *
 * @param {string} path
 * @returns {string}
 */
export function normalisePath(path) {
	const bare = path.split("?")[0].split("#")[0];
	const segs = bare
		.split("/")
		.filter(Boolean)
		.map((s) => {
			const t = s.replace(/^:[\w$]+(\{[^}]*\})?$/, "{}");
			if (t === "{}") return t;
			const stripped = t.replace(/\{\}/g, "");
			return stripped || "{}";
		});
	return `/${segs.join("/")}`;
}

/** The index just past the call's closing paren, given the index of its `(`. */
function endOfCall(src, open) {
	let depth = 1;
	let i = open + 1;
	for (; i < src.length && depth > 0; i++) {
		const c = src[i];
		if (c === "(") depth++;
		else if (c === ")") depth--;
		else if (c === "`" || c === '"' || c === "'") {
			const lit = readLiteral(src, i);
			if (lit) i = lit.end - 1;
		}
	}
	return i;
}

/**
 * Every `/v1/…` literal inside the `const NAME = …;` statement that most recently precedes
 * `before` — the path a call like `authedCall(path, …)` will actually use.
 *
 * Seven call sites in the MCP worker pass a variable, and they are not an oversight to route
 * around: `instance_runtime_status` picks `/runtime/status` or `/runtime` by argument, and a
 * check that could not see through that reported the tool as missing. A binding may therefore
 * yield SEVERAL paths, and all of them count as reachable.
 *
 * @param {string} src
 * @param {string} name
 * @param {number} before
 * @returns {string[]}
 */
function resolveBinding(src, name, before) {
	const decl = new RegExp(`\\b(?:const|let|var)\\s+${name}\\s*(?::[^=]+)?=`, "g");
	let at = -1;
	for (const m of src.slice(0, before).matchAll(decl)) at = m.index + m[0].length;
	if (at === -1) return [];
	// The initialiser runs to the `;` that closes it at depth 0. A ternary of two templates is
	// the shape that matters; anything longer than a statement is not a path expression.
	let i = at;
	let depth = 0;
	const found = [];
	for (; i < src.length && i < at + 600; i++) {
		const c = src[i];
		if (c === "(" || c === "{" || c === "[") depth++;
		else if (c === ")" || c === "}" || c === "]") depth--;
		else if (c === "`" || c === '"' || c === "'") {
			const lit = readLiteral(src, i);
			if (lit) {
				if (lit.text.startsWith("/v1/")) found.push(lit.text);
				else if (lit.text.startsWith("{}/")) found.push(...expandTablePrefix(lit.text, lit.parts[0] ?? "", src));
				// Jump past the literal so a `;` inside it does not end the statement early.
				i = lit.end - 1;
			}
		} else if (c === ";" && depth <= 0) break;
	}
	return found;
}

/**
 * Every API call in a source file, as `{method, path}` pairs plus the sites that could not be read.
 *
 * `unresolved` is a first-class part of the answer, not a swallowed failure: a call whose path is
 * a member expression (`entry.flow.start`, from a table of connector flows) is a capability this
 * module cannot measure, and reporting "0 gaps" over a tree where six calls were skipped is the
 * empty-set-passes trap. The caller prints it.
 *
 * @param {string} src
 * @param {string[]} fnNames functions whose FIRST argument is the path
 * @returns {{calls: {method: string, path: string, raw: string}[], unresolved: string[]}}
 */
export function extractCalls(src, fnNames) {
	const calls = [];
	const unresolved = [];
	for (const fn of fnNames) {
		// `api<T>(`, `useApi<{a: b}>(`, `authedCall(` — the generic argument is optional and may
		// itself contain parens, so the opening paren is found by scanning rather than matched.
		const re = new RegExp(`(?<![\\w$.])${fn}\\s*(?:<[^;()]*>)?\\s*\\(`, "g");
		for (const m of src.matchAll(re)) {
			const open = m.index + m[0].length - 1;
			const stop = endOfCall(src, open);
			let k = open + 1;
			while (k < src.length && /\s/.test(src[k])) k++;
			const lit = readLiteral(src, k);
			const body = src.slice(open, stop);
			const method = (body.match(/method:\s*["'`](\w+)["'`]/)?.[1] ?? "GET").toUpperCase();
			if (lit) {
				if (lit.text.startsWith("/v1/")) calls.push({ method, path: normalisePath(lit.text), raw: lit.text });
				else if (lit.text.startsWith("{}/")) {
					for (const p of expandTablePrefix(lit.text, lit.parts[0] ?? "", src)) {
						calls.push({ method, path: normalisePath(p), raw: p });
					}
				}
				continue;
			}
			const ident = src.slice(k).match(/^([A-Za-z_$][\w$]*)\s*[,)]/)?.[1];
			const bound = ident ? resolveBinding(src, ident, open) : [];
			if (bound.length) {
				for (const p of bound) calls.push({ method, path: normalisePath(p), raw: p });
				continue;
			}
			// Not every unread site is a missed route: `api(url)` inside the api wrapper itself,
			// and any call whose first argument is not a path at all. The caller decides.
			const arg = src.slice(k, k + 40).split(/[,)\n]/)[0].trim();
			if (arg) unresolved.push(arg);
		}
	}
	return { calls, unresolved };
}
