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
 * `workers/mcp/README.md`'s table form. Reads the column POSITION out of each header row
 * rather than assuming the last cell, so adding a column to the table cannot silently
 * shift what this reads.
 *
 * @param {string} src
 * @returns {{tools: Map<string, string>, tables: number}} `tables` is the denominator: zero
 *   means the header shape moved and this parser is measuring nothing.
 */
export function parseConfirmTable(src) {
	const cells = (line) =>
		line
			.replace(/^\s*\|/, "")
			.replace(/\|\s*$/, "")
			.split("|")
			.map((c) => c.trim());

	const out = new Map();
	let confirmAt = -1;
	let toolAt = -1;
	let tables = 0;
	for (const line of src.split("\n")) {
		if (!/^\s*\|/.test(line)) {
			confirmAt = -1;
			continue;
		}
		const row = cells(line);
		const header = row.findIndex((c) => c.toLowerCase() === "confirm");
		if (header !== -1) {
			confirmAt = header;
			toolAt = row.findIndex((c) => c.toLowerCase() === "tool");
			tables++;
			continue;
		}
		if (confirmAt === -1 || toolAt === -1) continue;
		const tool = row[toolAt]?.match(/^`([a-z0-9_]+)`$/)?.[1];
		if (!tool) continue;
		const value = row[confirmAt]?.match(/`([a-z0-9_]+)`/)?.[1];
		if (value) out.set(tool, value);
	}
	return { tools: out, tables };
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
