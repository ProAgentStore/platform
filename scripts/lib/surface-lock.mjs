/**
 * surface-lock.mjs — the pure half of `scripts/check-surface-lock.mjs` (#576).
 *
 * Parsing a TS object literal and diffing two revisions of it are the two things worth
 * testing against strings, exactly as `doc-claims.mjs` and `wire-surface.mjs` are, and for
 * the same reason: the shapes that matter here (a rewritten entry, a dropped entry, a file
 * whose export was renamed) are shapes the repo does not contain and must not have to.
 *
 * Nothing here reads the filesystem or shells out to git.
 */

/** The declaration this parser is looking for. Named once, used in the failure message too. */
export const LOCK_EXPORT = "SURFACE_LOCK";

/**
 * Parse `export const SURFACE_LOCK: Record<string, string> = { "0.1.1": "sha256:…", … }`.
 *
 * Returns `null` — NOT an empty map — when the declaration cannot be found. The two are very
 * different answers and collapsing them is the ADR 0002 G1/G3 failure: "the lock records
 * nothing" and "this parser can no longer find the lock" must not produce the same result,
 * because the second one silently retires the guard.
 *
 * Comments are ignored by construction: only `"version": "hash"` pairs are read, so the
 * per-entry prose ABOVE each line stays freely editable. That is deliberate and matches
 * `check-migrations.mjs`, which strips comments before comparing DDL — correcting a comment
 * that says something untrue is the one edit to a frozen record that is always right.
 *
 * @param {string} src
 * @returns {Map<string, string> | null} version -> fingerprint
 */
export function parseSurfaceLock(src) {
	const decl = src.match(new RegExp(`export const ${LOCK_EXPORT}\\b[^=]*=\\s*\\{`));
	if (!decl) return null;
	const start = decl.index + decl[0].length - 1;
	// Brace-matched rather than lazily regexed to the first `}`: a nested object in a future
	// entry would otherwise truncate the map and read as "these entries were deleted".
	let depth = 0;
	let end = -1;
	for (let i = start; i < src.length; i++) {
		if (src[i] === "{") depth++;
		else if (src[i] === "}") {
			depth--;
			if (depth === 0) {
				end = i;
				break;
			}
		}
	}
	if (end === -1) return null;
	const body = src.slice(start, end + 1);
	const out = new Map();
	for (const m of body.matchAll(/"([^"]+)"\s*:\s*"([^"]*)"/g)) out.set(m[1], m[2]);
	return out;
}

/**
 * What changed between an OLDER revision of the lock and the current one.
 *
 * The invariant is append-only: a version already recorded keeps the fingerprint it was
 * recorded with, forever. New versions may be added freely — that is the normal act.
 *
 * @param {Map<string, string>} before
 * @param {Map<string, string>} after
 * @returns {{rewritten: {version: string, was: string, now: string}[], removed: string[], added: string[]}}
 */
export function diffLock(before, after) {
	const rewritten = [];
	const removed = [];
	for (const [version, was] of before) {
		if (!after.has(version)) {
			removed.push(version);
			continue;
		}
		const now = after.get(version);
		if (now !== was) rewritten.push({ version, was, now });
	}
	const added = [...after.keys()].filter((v) => !before.has(v));
	return { rewritten, removed, added };
}
