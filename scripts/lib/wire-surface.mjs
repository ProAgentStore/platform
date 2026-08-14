/**
 * wire-surface.mjs — the "wire surface" arm of `scripts/docs-drift.mjs` (#572, #573).
 *
 * ── The asymmetry this closes
 *
 * `docs-drift.mjs` passed on all four of #561's commits, CORRECTLY. Every check it carries
 * compares a documented number or name to the code defining it, and none of the things it
 * measures moved: still 135 tools, still the same `confirm` values. Meanwhile the four
 * commits changed what a connecting client RECEIVES — `readOnlyHint` and `destructiveHint`
 * on every tool, an `outputSchema` on two of them, a server `instructions` string — and the
 * docs described none of it.
 *
 * So a CAPABILITY could reach the wire with no documentation obligation attached, while a
 * `confirm` value could not. Both are the same class of failure: a host or an agent makes a
 * decision from a signal the docs do not explain, or explain wrongly. The `confirm` check
 * exists because a doc naming the wrong confirm string breaks a caller; an annotation the
 * docs never mention breaks the same caller one level up.
 *
 * ── One design, not two checks
 *
 * #572 (annotations, output schemas) and #573 (the advertised version) are the same shape,
 * so they are one mechanism with three entries rather than two near-identical blocks:
 *
 *     a WIRE FACT = something a client receives
 *                 + the ONE piece of code that defines it   (the authority)
 *                 + optionally, the line that puts it on the wire   (the binding)
 *                 + every place that restates it            (docs, manifests)
 *
 * Adding the fourth wire fact is a table entry. That is the whole reason this is a table.
 *
 * ── ADR 0002 (a guard states what it measured), applied
 *
 *   - G1: every authority declares a FLOOR with a reason. A parser that finds nothing has
 *     stopped measuring, and this reports that rather than reporting agreement.
 *   - G1: a restatement that yields no claim is a FAILURE, never a skip — the deletion of a
 *     documented paragraph must not read like a clean tree.
 *   - a listed path that does not exist is a failure, never a skip.
 *   - G2: every fact prints its own denominator — how many tokens, from how many code
 *     files, restated how many times in which file.
 *   - G3: a cell or block the parser cannot read produces no entry AND no silent pass,
 *     because the floor and the non-empty rule sit underneath it.
 *
 * There is deliberately NO prose snapshot here, for the reason `docs-drift.mjs`'s header
 * gives: a golden file fails on every honest edit and is deleted within a month. Each fact
 * below compares a NAME or a VALUE.
 *
 * Nothing here reads the filesystem: the caller supplies `read`/`exists`, so the tests can
 * feed each parser the shape that broke it.
 */

import { diffConfirm, parseTableColumn } from "./doc-claims.mjs";

// ─────────────────────────────────────────────────────────────────────────────
// Parsers — pure, one per shape
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Strip JS/TS string literals and comments so a brace scanner cannot be thrown by a `{`
 * inside a description string. Deliberately CRUDE and named as such: it replaces string
 * bodies with spaces of the same length, which is all a depth counter needs, and it does
 * NOT handle regex literals or `${…}` interpolation as code. See ADR 0002's note on the
 * eight source-strippers in this repo — this is the fourth fidelity, and stating it is the
 * obligation that comes with rolling another one.
 * @param {string} src
 */
function blankStringsAndComments(src) {
	let out = "";
	for (let i = 0; i < src.length; i++) {
		const c = src[i];
		if (c === "/" && src[i + 1] === "/") {
			while (i < src.length && src[i] !== "\n") i++;
			out += "\n";
			continue;
		}
		if (c === "/" && src[i + 1] === "*") {
			const end = src.indexOf("*/", i + 2);
			const stop = end === -1 ? src.length : end + 2;
			out += src.slice(i, stop).replace(/[^\n]/g, " ");
			i = stop - 1;
			continue;
		}
		if (c === '"' || c === "'" || c === "`") {
			out += " ";
			i++;
			while (i < src.length && src[i] !== c) {
				if (src[i] === "\\") i++;
				out += src[i] === "\n" ? "\n" : " ";
				i++;
			}
			out += " ";
			continue;
		}
		out += c;
	}
	return out;
}

/**
 * The MCP hint vocabulary, read out of the SPEC schema vendored beside the worker rather
 * than written down here. `$defs/ToolAnnotations` also carries `title`, which is not a hint
 * and which this server publishes at the TOOL level (where Anthropic's directory bar asks
 * for it), so the set is the `*Hint` fields.
 *
 * @param {string} json — the vendored `mcp-schema-<revision>.json`
 * @returns {string[]} sorted
 */
export function parseSpecHints(json) {
	let doc;
	try {
		doc = JSON.parse(json);
	} catch {
		return [];
	}
	const props = doc?.$defs?.ToolAnnotations?.properties;
	if (!props || typeof props !== "object") return [];
	return Object.keys(props)
		.filter((k) => k.endsWith("Hint"))
		.sort();
}

/**
 * The hints this server can state, read out of `ToolAnnotations` in `tool-metadata.ts`.
 * That interface is the authority rather than `annotationsFor`'s bodies because `tsc` makes
 * it one: a field the interface does not carry cannot be returned, and `conformance.test.ts`
 * asserts the wire object equals `annotationsFor(name)` for all 135 tools.
 *
 * @param {string} src
 * @returns {string[]} sorted
 */
export function parseDeclaredAnnotations(src) {
	const block = blankStringsAndComments(src).match(
		/export interface ToolAnnotations\s*\{([\s\S]*?)\}/,
	);
	if (!block) return [];
	return [...block[1].matchAll(/^\s*([A-Za-z0-9_]+)\??\s*:/gm)].map((m) => m[1]).sort();
}

/**
 * `export const TOOL_OUTPUT: Record<string, z.ZodRawShape> = { … }` — which tools declare an
 * output schema, and the KEY their payload is wrapped in. The wrapper is the consumer-visible
 * half: `my_instances` answered a bare array before #561 and answers `{"instances":[…]}` now.
 *
 * Every schema also declares `error` (the refusal path the registration pipeline fills in),
 * so that key is excluded from the payload name — and a tool whose schema declares anything
 * other than exactly one payload key is reported rather than guessed at (G3).
 *
 * @param {string} src
 * @returns {{tools: Map<string, string>, ambiguous: string[]}}
 */
export function parseOutputSchemaDecls(src) {
	const code = blankStringsAndComments(src);
	const start = code.search(/export const TOOL_OUTPUT\b[^=]*=\s*\{/);
	if (start === -1) return { tools: new Map(), ambiguous: [] };
	let i = code.indexOf("{", start);

	const fields = new Map(); // tool -> payload keys at its own depth
	let tool = null;
	let depth = 0;
	let ident = "";
	for (; i < code.length; i++) {
		const c = code[i];
		if (/[A-Za-z0-9_$]/.test(c)) {
			ident += c;
			continue;
		}
		if (c === ":") {
			if (ident && depth === 1) {
				tool = ident;
				if (!fields.has(tool)) fields.set(tool, []);
			} else if (ident && depth === 2 && tool) {
				fields.get(tool).push(ident);
			}
		}
		if (c === "{" || c === "(" || c === "[") depth++;
		if (c === "}" || c === ")" || c === "]") depth--;
		ident = "";
		if (depth === 0) break;
	}

	const tools = new Map();
	const ambiguous = [];
	for (const [name, keys] of fields) {
		const payload = keys.filter((k) => k !== "error");
		if (payload.length === 1) tools.set(name, payload[0]);
		else ambiguous.push(`${name}: ${payload.length} payload key(s) [${payload.join(", ")}]`);
	}
	return { tools, ambiguous };
}

/**
 * `platform-docs/mcp.md`'s structured-result bullets, the same shape as its `confirm`
 * bullets one section above:
 *
 *     - `my_instances`: `structuredContent: {"instances": […]}`
 *
 * @param {string} src
 * @returns {Map<string, string>} tool → the payload key it is documented to wrap
 */
export function parseStructuredBullets(src) {
	const out = new Map();
	for (const m of src.matchAll(
		/^-\s+`([a-z0-9_]+)`:\s*`structuredContent:\s*\{\s*"([A-Za-z0-9_]+)"/gm,
	)) {
		out.set(m[1], m[2]);
	}
	return out;
}

/**
 * `platform-docs/mcp.md`'s hint table — which hints the server publishes and which it
 * deliberately does not. Reads the `Published` column by POSITION.
 * @param {string} src
 * @returns {Map<string, string>} hint → `declared` | `omitted`
 */
export function parseAnnotationTable(src) {
	const { rows } = parseTableColumn(src, {
		key: "hint",
		value: "published",
		keyPattern: /^`([A-Za-z0-9_]+)`$/,
		valuePattern: /\b(declared|omitted)\b/,
	});
	return rows;
}

/**
 * `export const NAME = "value"` — the shape `tool-count.ts` established for a fact the docs
 * and the code both have to agree on.
 * @param {string} src
 * @param {string} name
 * @returns {string | null}
 */
export function parseStringConstant(src, name) {
	const m = src.match(new RegExp(`export const ${name}\\s*(?::[^=]+)?=\\s*"([^"]+)"`));
	return m ? m[1] : null;
}

/**
 * What `new McpServer({ name, version })` puts on the wire, and HOW it is written: a bare
 * identifier means the value is imported from one source, a quoted string means it was typed
 * a second time. #573 is what the second one costs — `index.ts` said `0.1.0` and `server.json`
 * said `0.1.1`, and neither had moved since June.
 *
 * @param {string} src
 * @returns {{kind: "identifier" | "literal", token: string} | null}
 */
export function parseAdvertisedVersion(src) {
	const ctor = src.match(/new McpServer\(\s*\{([^}]*)\}/);
	if (!ctor) return null;
	const m = ctor[1].match(/version\s*:\s*(?:"([^"]*)"|([A-Za-z_$][\w$]*))/);
	if (!m) return null;
	return m[1] !== undefined
		? { kind: "literal", token: m[1] }
		: { kind: "identifier", token: m[2] };
}

/**
 * A top-level string field of a JSON manifest, read as TEXT rather than by parsing — the
 * failure this reports is a wrong value, and a manifest that will not parse is a different
 * (and louder) problem that `mcp-publisher` owns.
 * @param {string} src
 * @param {string} field
 * @returns {string | null}
 */
export function parseJsonStringField(src, field) {
	const m = src.match(new RegExp(`"${field}"\\s*:\\s*"([^"]*)"`));
	return m ? m[1] : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// The facts
// ─────────────────────────────────────────────────────────────────────────────

const TOOL_METADATA = "workers/mcp/src/tool-metadata.ts";
const MCP_DOC = "platform-docs/mcp.md";
const SPEC_SCHEMA = "workers/mcp/src/mcp-schema-2025-11-25.json";

/**
 * Every wire fact this repository is obliged to document, in one table.
 *
 * `unit` is what the numbers in the success line count; `authority.floor` is the size below
 * which the parser is assumed broken rather than the tree assumed clean, and every floor
 * carries the reason it is where it is — never a bound chosen to make today's number pass.
 */
export function wireFacts() {
	return [
		{
			id: "tool annotations",
			unit: "hint(s)",
			wire: "the `annotations` object on every tool in `tools/list`",
			authority: {
				files: [SPEC_SCHEMA, TOOL_METADATA],
				how: "the spec's `ToolAnnotations` hints, split by what `ToolAnnotations` in tool-metadata.ts declares",
				floor: 4,
				why: "MCP 2025-11-25 defines four `*Hint` fields; finding fewer means the vendored schema moved.",
				parse: (byFile) => {
					const hints = parseSpecHints(byFile.get(SPEC_SCHEMA));
					const declared = new Set(parseDeclaredAnnotations(byFile.get(TOOL_METADATA)));
					return new Map(hints.map((h) => [h, declared.has(h) ? "declared" : "omitted"]));
				},
			},
			restatements: [
				{
					file: MCP_DOC,
					how: "the `Hint` / `Published` table in its safety section",
					parse: parseAnnotationTable,
				},
			],
		},
		{
			id: "structured results",
			unit: "output schema(s)",
			wire: "`outputSchema` on a tool, and the `structuredContent` it obliges the server to return",
			authority: {
				files: [TOOL_METADATA],
				how: "the keys of `TOOL_OUTPUT`, and the payload key each one wraps",
				floor: 1,
				why:
					"`list_agents` and `my_instances` declare one; matching none means TOOL_OUTPUT was renamed or\n" +
					"  its shape moved, at which point this check is comparing an empty set to the docs.",
				parse: (byFile) => {
					const { tools, ambiguous } = parseOutputSchemaDecls(byFile.get(TOOL_METADATA));
					if (ambiguous.length) {
						throw new Error(
							`TOOL_OUTPUT declares a schema this parser cannot read as one payload key:\n    ${ambiguous.join("\n    ")}\n` +
								"  Every schema is `{ <payload>: …, error: … }`. Widen the parser deliberately — do not\n" +
								"  let it guess, because the guess would become the documented shape.",
						);
					}
					return tools;
				},
			},
			restatements: [
				{
					file: MCP_DOC,
					how: "its `` `tool`: `structuredContent: {\"key\": …}` `` bullets",
					parse: parseStructuredBullets,
				},
			],
		},
	];
}

// ─────────────────────────────────────────────────────────────────────────────
// The check
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run every wire fact against the tree.
 *
 * @param {{read: (f: string) => string, exists: (f: string) => boolean}} io
 * @param {ReturnType<typeof wireFacts>} [facts]
 * @returns {{failures: {check: string, message: string}[], notes: string[]}}
 */
export function checkWireSurface(io, facts = wireFacts()) {
	const failures = [];
	const notes = [];
	const fail = (message) => failures.push({ check: "wire-surface", message });

	for (const fact of facts) {
		const before = failures.length;
		const files = [
			...fact.authority.files,
			...(fact.binding ? [fact.binding.file] : []),
			...fact.restatements.map((r) => r.file),
		];
		const gone = files.filter((f) => !io.exists(f));
		if (gone.length) {
			// Never a skip. A moved file is how a check stops running while still printing a tick.
			fail(
				`${fact.id}: ${gone.length} listed path(s) do not exist: ${gone.join(", ")}.\n` +
					"  This fact was NOT measured. Point the entry in scripts/lib/wire-surface.mjs at the\n" +
					"  file that replaced it, or delete the fact as a decision.",
			);
			continue;
		}

		let defined;
		try {
			defined = fact.authority.parse(new Map(fact.authority.files.map((f) => [f, io.read(f)])));
		} catch (err) {
			fail(`${fact.id}: ${err.message}`);
			continue;
		}
		if (defined.size < fact.authority.floor) {
			fail(
				`${fact.id}: read ${defined.size} ${fact.unit} from ${fact.authority.how}, expected at least ${fact.authority.floor}.\n` +
					`  ${fact.authority.why}\n` +
					"  This check would otherwise pass by comparing an empty set to the docs and reporting\n" +
					"  agreement. Fix the parser — do not lower the floor.",
			);
			continue;
		}

		if (fact.binding) {
			const problem = fact.binding.check(io.read(fact.binding.file));
			if (problem) {
				fail(`${fact.id}: ${fact.binding.file} — ${problem}\n  ${fact.binding.why}`);
			}
		}

		const sites = new Map([...defined].map(([k, v]) => [k, { expected: v }]));
		const sizes = [];
		for (const r of fact.restatements) {
			const documented = r.parse(io.read(r.file));
			if (documented.size === 0) {
				fail(
					`${fact.id}: ${r.file} states nothing, read via ${r.how}.\n` +
						`  ${fact.wire} reaches every client whether or not this file mentions it. A deleted or\n` +
						"  rephrased paragraph must not read as agreement — that is the failure mode #555 shipped.",
				);
				continue;
			}
			sizes.push(`${r.file} (${documented.size})`);
			const { missing, phantom, wrong } = diffConfirm(sites, documented);
			if (missing.length) {
				fail(
					`${fact.id}: ${r.file} omits ${missing.length} of ${defined.size} ${fact.unit}: ${missing.join(", ")}.\n` +
						`  ${fact.wire} — undocumented, a caller has to discover it by reading a wire dump.`,
				);
			}
			if (phantom.length) {
				fail(
					`${fact.id}: ${r.file} documents ${phantom.length} ${fact.unit} the code does not define: ${phantom.join(", ")}.\n` +
						"  Worse than an omission: a caller will build against something that never arrives.",
				);
			}
			if (wrong.length) {
				fail(
					`${fact.id}: ${r.file} gives the wrong value for ${wrong.length} ${fact.unit}:\n` +
						wrong
							.map((w) => `    ${w.tool}: says "${w.documented}", the code defines "${w.actual}"`)
							.join("\n"),
				);
			}
		}

		// A fact that failed gets NO success line. Printing "== no restatement read" beside a
		// ✓ is the exact shape this check exists to refuse: the tick and the finding would
		// then be describing the same tree.
		if (failures.length > before) continue;
		notes.push(
			`wire surface — ${fact.id}: ${defined.size} ${fact.unit} from ${fact.authority.files.length} code file(s) ` +
				`== ${sizes.join(", ")}` +
				(fact.binding ? `, advertised from ${fact.binding.file}` : ""),
		);
	}

	return { failures, notes };
}
