/**
 * workspace-members.mjs — resolve `pnpm-workspace.yaml`'s `packages:` block to real
 * directories, for the guards that need to know how many projects there ARE (#740).
 *
 * Deliberately not a YAML parser. The `packages:` block in this repo is a flat list of
 * quoted scalars and has been since the workspace was created; a full parser would be
 * more code, another dependency, and no more correct for this input. What it IS is
 * loud about the shapes it does not handle — per ADR 0002 G3, a parser that shrugs at
 * an input it cannot read converts a bug in itself into a smaller measurement, and the
 * guard above it would then certify a workspace it never walked.
 *
 * NOT handled, by design, each of which THROWS rather than being skipped:
 *   • a nested glob, a mid-segment star, or more than one star anywhere — only a
 *     literal path or a single trailing slash-star is understood
 *   • a negation, e.g. an entry beginning with `!`
 *   • flow sequence syntax, e.g. `packages: ['a', 'b']`
 *   • an entry that is not a quoted scalar
 *   • a missing or empty `packages:` block
 *
 * If the workspace ever legitimately needs one of those, teach this file — do not
 * delete the guard that calls it.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Pull the quoted entries out of the `packages:` block.
 *
 * @param {string} src raw `pnpm-workspace.yaml`
 * @returns {string[]} the patterns, in file order
 */
export function parseWorkspacePatterns(src) {
	const lines = src.split(/\r?\n/);
	const start = lines.findIndex((l) => /^packages:\s*(#.*)?$/.test(l));
	if (start === -1) {
		const inline = lines.find((l) => /^packages:\s*\S/.test(l));
		if (inline) {
			throw new Error(
				`pnpm-workspace.yaml: \`packages:\` carries an inline value (${inline.trim()}). ` +
					"This reader understands a block sequence only — see the header.",
			);
		}
		throw new Error("pnpm-workspace.yaml: no `packages:` block. This reader cannot proceed.");
	}

	const patterns = [];
	for (const line of lines.slice(start + 1)) {
		if (!line.trim() || line.trimStart().startsWith("#")) continue;
		// A non-indented, non-empty line ends the block.
		if (!/^\s/.test(line)) break;
		const item = line.match(/^\s+-\s+(.*?)\s*(?:#.*)?$/);
		if (!item) {
			throw new Error(
				`pnpm-workspace.yaml: unreadable entry in \`packages:\` — ${JSON.stringify(line)}. ` +
					"This reader understands `  - 'path'` only.",
			);
		}
		const quoted = item[1].match(/^(['"])(.*)\1$/);
		if (!quoted) {
			throw new Error(
				`pnpm-workspace.yaml: entry ${JSON.stringify(item[1])} is not a quoted scalar. ` +
					"This reader does not handle flow sequences or bare scalars.",
			);
		}
		patterns.push(quoted[2]);
	}

	if (!patterns.length) {
		throw new Error("pnpm-workspace.yaml: the `packages:` block is empty — nothing would be measured.");
	}
	return patterns;
}

/**
 * Expand one pattern to the member directories it selects, relative to `root` and
 * POSIX-separated.
 *
 * @param {string} root repository root
 * @param {string} pattern one entry from `packages:`
 * @returns {string[]}
 */
export function expandPattern(root, pattern) {
	if (pattern.startsWith("!")) {
		throw new Error(`pnpm-workspace.yaml: negated pattern ${JSON.stringify(pattern)} is not handled.`);
	}
	const stars = (pattern.match(/\*/g) ?? []).length;
	if (stars === 0) {
		const dir = resolve(root, pattern);
		if (!existsSync(dir) || !statSync(dir).isDirectory()) {
			throw new Error(`pnpm-workspace.yaml: ${pattern} names a directory that does not exist.`);
		}
		return [pattern];
	}
	if (stars > 1 || !pattern.endsWith("/*")) {
		throw new Error(
			`pnpm-workspace.yaml: pattern ${JSON.stringify(pattern)} is not handled — ` +
				"only a literal path or a single trailing `/*` is understood.",
		);
	}
	const parent = pattern.slice(0, -2);
	const base = resolve(root, parent);
	if (!existsSync(base) || !statSync(base).isDirectory()) {
		throw new Error(`pnpm-workspace.yaml: ${pattern} expands under ${parent}, which does not exist.`);
	}
	const found = readdirSync(base, { withFileTypes: true })
		.filter((e) => e.isDirectory() && !e.name.startsWith("."))
		.map((e) => `${parent}/${e.name}`)
		.sort();
	if (!found.length) {
		throw new Error(`pnpm-workspace.yaml: ${pattern} matched no directory — it would select nothing.`);
	}
	return found;
}

/**
 * Every workspace member directory, deduplicated, in sorted order.
 *
 * @param {string} root repository root
 * @param {string} src raw `pnpm-workspace.yaml`
 * @returns {string[]}
 */
export function workspaceMembers(root, src) {
	const seen = new Set();
	for (const pattern of parseWorkspacePatterns(src)) {
		for (const dir of expandPattern(root, pattern)) seen.add(dir);
	}
	return [...seen].sort();
}
