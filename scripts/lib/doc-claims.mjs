/**
 * doc-claims.mjs — the parsers behind `scripts/docs-drift.mjs`'s numeric and list claims,
 * split out so they can be unit-tested against strings instead of against the repo (#555).
 *
 * ── Why these are pure functions with their own tests
 *
 * `docs-drift.mjs` shipped a check whose success line read "135 registered == constant ==
 * every doc claim" while `claimFiles` was a hand-written list of three paths. The public
 * /about page said "~67 tools" against a live `/health` of 135 — a prospective user reading
 * the product as less than half its size, past a guard whose entire job was that comparison.
 *
 * The lesson is not "add a fourth path". A guard that greps prose has TWO failure modes and
 * the repo had only ever defended one of them:
 *
 *   1. the claim is present and wrong  — caught, loudly, and always was
 *   2. the claim is absent, or phrased past the regex — NOT caught, and indistinguishable
 *      from a clean tree
 *
 * (2) is the one that bites. `\b(\d+)\s+tools?\b` does not match "135 MCP tools", so an
 * honest rewrite of a sentence silently retires the check on that file. So every function
 * here reports what it FOUND and what it COULD NOT PARSE, and the caller asserts both —
 * see #559 (proposed ADR 0002, rules G1/G3) and `scripts/check-design-tokens.mjs:97-101`,
 * which refuses to pass when it parses fewer than 10 colour tokens for exactly this reason.
 *
 * Nothing here reads the filesystem: the caller supplies file contents, so the tests can
 * feed each parser the shape that broke it.
 */

/**
 * "N tools" / "N tool registrations" — the shape every doc uses for the MCP total.
 *
 * DELIBERATELY not widened to "N <word> tools" ("135 MCP tools", "86 instance tools"): a
 * blanket match would fire on the legitimate SUBSET counts in `workers/mcp/CLAUDE.md`
 * ("67 of those 86 tools until #305" is a historical statement, and the per-file rows have
 * their own check). The cost of the narrow regex is failure mode (2) above, which is why
 * the caller must also assert that each file it expects a claim from actually produced one.
 */
const TOOL_COUNT_CLAIM = /\b(\d+)\s+tools?\b|\b(\d+)\s+tool registrations?\b/g;

/**
 * Every "N tools" claim in a document.
 * @param {string} src
 * @returns {{n: number, claimed: number, line: string}[]} one entry per match, 1-based line
 */
export function findToolCountClaims(src) {
	const out = [];
	src.split("\n").forEach((line, i) => {
		for (const m of line.matchAll(TOOL_COUNT_CLAIM)) {
			out.push({ n: i + 1, claimed: Number(m[1] ?? m[2]), line: line.trim() });
		}
	});
	return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// The always-on / surface-gated SPLIT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The split claims — "117 are always present", "18 are surface-gated" (#575).
 *
 * `MCP_TOOL_COUNT` was the only number check 6 compared to anything. `MCP_TOOL_ALWAYS_ON`
 * and `MCP_TOOL_GATED` are exported on the next two lines of the same file and were
 * compared to nothing, so the split could say anything — and did. `workers/mcp/CLAUDE.md`
 * carried "114 are always registered; 18 are surface-gated (apply=4, repo=3, coding=11+3)",
 * which is wrong three separate ways at once: 114 contradicts the constant's 117, 114+18
 * misses the 135 stated two lines above it, and the parenthetical sums to 21 rather than
 * 18. That is the doc a session working INSIDE the worker reads, while the public page got
 * it right.
 *
 * Three phrasings are in use across the three files that state this, so the regexes cover
 * all of them rather than the one that happened to be written first:
 *
 *     platform-docs/mcp.md   "117 are always present. The remaining 18 are gated to …"
 *     workers/mcp/README.md  "117 are always registered; 18 are gated to the console"
 *     workers/mcp/CLAUDE.md  "117 are always registered; 18 are surface-gated (…)"
 *
 * A NUMBER is required in front. `README.md`'s "All six are always registered" is prose
 * about a subset and is correctly not a claim about the total — matching spelled numerals
 * would turn every such sentence into a false failure, which is how a check gets deleted.
 *
 * The caller must still assert that each file it expects a claim from produced one: the
 * silent failure mode here is a rephrasing that slips past both regexes, which reads
 * exactly like agreement. See `findToolCountClaims` above for the same trap.
 */
const ALWAYS_ON_CLAIM = /\b(\d+)\s+(?:tools?\s+)?are\s+always\s+(?:present|registered|on)\b/g;
const GATED_CLAIM = /\b(\d+)\s+(?:tools?\s+)?are\s+(?:surface-)?gated\b/g;

/**
 * A per-surface breakdown in parentheses — `(apply=4, repo=3, coding=11)`.
 *
 * Parsed because it is the third of #575's three errors and the one no other check could
 * see: `platform-docs/mcp.md`'s gated TABLE is already compared to the constants, but a
 * prose parenthetical restating the same split was compared to nothing.
 *
 * `coding=11+3` is accepted as a shape and summed to 14, deliberately — it is what the
 * broken line actually said, and a parser that threw on it would report "no breakdown
 * found" for the one line the check exists to catch.
 */
const BREAKDOWN_CLAIM = /\(\s*([a-z][\w-]*\s*=\s*\d+(?:\s*\+\s*\d+)*(?:\s*,\s*[a-z][\w-]*\s*=\s*\d+(?:\s*\+\s*\d+)*)*)\s*\)/g;

/**
 * Every always-on / gated / per-surface-breakdown claim in a document.
 *
 * @param {string} src
 * @returns {{alwaysOn: {n: number, claimed: number, line: string}[],
 *            gated: {n: number, claimed: number, line: string}[],
 *            breakdowns: {n: number, sum: number, parts: string, line: string}[]}}
 */
export function findSplitClaims(src) {
	const alwaysOn = [];
	const gated = [];
	const breakdowns = [];
	src.split("\n").forEach((line, i) => {
		const at = { n: i + 1, line: line.trim() };
		for (const m of line.matchAll(ALWAYS_ON_CLAIM)) alwaysOn.push({ ...at, claimed: Number(m[1]) });
		for (const m of line.matchAll(GATED_CLAIM)) gated.push({ ...at, claimed: Number(m[1]) });
		for (const m of line.matchAll(BREAKDOWN_CLAIM)) {
			const sum = [...m[1].matchAll(/\d+/g)].reduce((a, d) => a + Number(d[0]), 0);
			breakdowns.push({ ...at, sum, parts: m[1] });
		}
	});
	return { alwaysOn, gated, breakdowns };
}

// ─────────────────────────────────────────────────────────────────────────────
// The confirm-gated tool table
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `requireConfirmation(safety, "tool_name", confirm, "expected_value", …)` — the ONLY thing
 * that makes a tool confirm-gated. Three documents transcribe this list by hand; before
 * #555 nothing compared any of them to the code, and two of the three were a year out of
 * date in the same way (missing `delete_supervision`).
 *
 * @param {{name: string, src: string}[]} sources — MCP worker sources, minus safety.ts/tests
 * @returns {Map<string, {expected: string, at: string}>}
 */
export function parseConfirmCallSites(sources) {
	const found = new Map();
	for (const { name, src } of sources) {
		src.split("\n").forEach((line, i) => {
			for (const m of line.matchAll(
				/requireConfirmation\(\s*[^,]+,\s*"([a-z0-9_]+)"\s*,\s*[^,]+,\s*"([a-z0-9_]+)"/g,
			)) {
				found.set(m[1], { expected: m[2], at: `${name}:${i + 1}` });
			}
		});
	}
	return found;
}

/**
 * `platform-docs/mcp.md`'s bullet form: ``- `tool`: `confirm: "value"` ``.
 * @param {string} src
 * @returns {Map<string, string>} tool → expected confirm value
 */
export function parseConfirmBullets(src) {
	const out = new Map();
	for (const m of src.matchAll(/^-\s+`([a-z0-9_]+)`:\s*`confirm:\s*"([a-z0-9_]+)"`/gm)) {
		out.set(m[1], m[2]);
	}
	return out;
}

/**
 * Read one column of a Markdown table, keyed by another. Reads the column POSITION out of
 * each header row rather than assuming the last cell, so adding a column to the table
 * cannot silently shift what this reads.
 *
 * Both cells are matched by an explicit pattern rather than by taking the raw text: a
 * decorative cell (`—`, "n/a", a sentence) must produce NO entry, not an entry whose value
 * is punctuation — that would arrive at the caller as a phantom claim and blame the docs
 * for the parser's guess.
 *
 * @param {string} src
 * @param {{key: string, value: string, keyPattern?: RegExp, valuePattern?: RegExp}} spec
 *   `key`/`value` are header names, compared case-insensitively.
 * @returns {{rows: Map<string, string>, tables: number}} `tables` is the denominator: zero
 *   means the header shape moved and this parser is measuring nothing.
 */
export function parseTableColumn(src, spec) {
	const keyPattern = spec.keyPattern ?? /^`([a-z0-9_]+)`$/;
	const valuePattern = spec.valuePattern ?? /`([a-z0-9_]+)`/;
	const cells = (line) =>
		line
			.replace(/^\s*\|/, "")
			.replace(/\|\s*$/, "")
			.split("|")
			.map((c) => c.trim());

	const out = new Map();
	let valueAt = -1;
	let keyAt = -1;
	let tables = 0;
	for (const line of src.split("\n")) {
		if (!/^\s*\|/.test(line)) {
			valueAt = -1;
			continue;
		}
		const row = cells(line);
		const header = row.findIndex((c) => c.toLowerCase() === spec.value.toLowerCase());
		if (header !== -1) {
			valueAt = header;
			keyAt = row.findIndex((c) => c.toLowerCase() === spec.key.toLowerCase());
			tables++;
			continue;
		}
		if (valueAt === -1 || keyAt === -1) continue;
		const key = row[keyAt]?.match(keyPattern)?.[1];
		if (!key) continue;
		const value = row[valueAt]?.match(valuePattern)?.[1];
		if (value) out.set(key, value);
	}
	return { rows: out, tables };
}

/**
 * `workers/mcp/README.md`'s table form: the Confirm column of its tool tables.
 *
 * @param {string} src
 * @returns {{tools: Map<string, string>, tables: number}}
 */
export function parseConfirmTable(src) {
	const { rows, tables } = parseTableColumn(src, { key: "tool", value: "confirm" });
	return { tools: rows, tables };
}

const NUMBER_WORDS = [
	"zero",
	"one",
	"two",
	"three",
	"four",
	"five",
	"six",
	"seven",
	"eight",
	"nine",
	"ten",
	"eleven",
	"twelve",
	"thirteen",
	"fourteen",
	"fifteen",
	"sixteen",
	"seventeen",
	"eighteen",
	"nineteen",
	"twenty",
];

/**
 * The two `store/llms*.txt` files state the same list as one prose sentence. Prose cannot
 * be parsed by shape, so this finds the sentence by CONTENT — a line that mentions
 * `confirm` and names at least three tools the code actually gates — and then reports what
 * it read. A rewrite that drops the list produces `lines: 0`, which the caller treats as a
 * failure rather than as agreement.
 *
 * The counts are written as WORDS ("Thirteen tools require…"), not digits, and that is
 * load-bearing in two directions: it keeps the sentence out of `TOOL_COUNT_CLAIM`'s way
 * (which would otherwise demand that "13 tools" equal the MCP total), and it means this
 * parser and that one cannot fight over the same characters.
 *
 * @param {string} src
 * @param {Set<string>} knownTools — the confirm-gated tools per the code
 * @returns {{tools: Map<string, string>, stated: number[], lines: number}}
 */
export function parseConfirmProse(src, knownTools) {
	const tools = new Map();
	const stated = [];
	let lines = 0;

	for (const line of src.split("\n")) {
		if (!line.includes("`confirm`") && !line.includes("`confirm:")) continue;
		const spans = [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
		const named = spans.filter((s) => knownTools.has(s));
		if (named.length < 3) continue;
		lines++;

		// Walk the backtick spans in order. A bare identifier names a tool (defaulting to
		// the own-name convention); a `confirm: "x"` span binds an explicit value to the
		// tool most recently named, which is how every one of these sentences reads.
		let last = null;
		for (const span of spans) {
			const explicit = span.match(/^confirm:\s*"([a-z0-9_]+)"$/);
			if (explicit) {
				if (last) tools.set(last, explicit[1]);
				continue;
			}
			if (!/^[a-z0-9_]+$/.test(span) || span === "confirm") continue;
			last = span;
			if (!tools.has(span)) tools.set(span, span);
		}

		for (const m of line.matchAll(/\b([a-z]+)\b/gi)) {
			const idx = NUMBER_WORDS.indexOf(m[1].toLowerCase());
			if (idx > 0) stated.push(idx);
		}
	}
	return { tools, stated, lines };
}

/**
 * Compare a documented confirm list with the call sites.
 * @param {Map<string, {expected: string}>} actual
 * @param {Map<string, string>} documented
 */
export function diffConfirm(actual, documented) {
	const missing = [...actual.keys()].filter((t) => !documented.has(t)).sort();
	const phantom = [...documented.keys()].filter((t) => !actual.has(t)).sort();
	const wrong = [...documented.entries()]
		.filter(([t, v]) => actual.has(t) && actual.get(t).expected !== v)
		.map(([t, v]) => ({ tool: t, documented: v, actual: actual.get(t).expected }))
		.sort((a, b) => a.tool.localeCompare(b.tool));
	return { missing, phantom, wrong };
}
