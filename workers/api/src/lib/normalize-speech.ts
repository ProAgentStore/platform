/**
 * The speech normaliser, VENDORED from `packages/sdk/src/voice/normalize.ts` (#392).
 *
 * ── Why a copy and not an import
 *
 * `workers/api` has no dependency on `@proagentstore/sdk` at all — not in its package.json, not
 * in a single source file — and the SDK is a PUBLISHED npm package whose `exports` map does not
 * expose `./voice`. Making the API worker import it would mean a new published subpath, a new
 * dependency edge from the deployed Worker into a browser-facing package, and a `pnpm --filter
 * @proagentstore/sdk build` in front of `wrangler deploy`, all to reach eight lines of pure
 * string handling. Moving the rule into a third shared package is worse again: the SDK is
 * published, so a workspace dependency of its own would have to be published too.
 *
 * So this is the same trade `agent-workflows.test.ts` already makes for the MCP worker's
 * hand-written zod enum — copy the small thing, and ASSERT the copies agree — and the same
 * "vendor, don't depend" posture the workspace takes between stores.
 *
 * ── The part that is not optional
 *
 * The defect being fixed IS two copies of one rule drifting: `resolveSubordinate` normalised with
 * `trim().toLowerCase()` while every other spoken-text comparison went through `normalizeSpeech`,
 * so a transcript's trailing full stop made a supervisor deny an agent it does supervise. A
 * vendored copy that nothing checks would reproduce exactly that, one directory over.
 * `normalize-speech.test.ts` therefore imports the SDK's real implementation and asserts this one
 * agrees with it over a corpus and a seeded fuzz. Change the rule in either file without the
 * other and that test goes red.
 *
 * ── The rule itself (kept verbatim, including why each class differs)
 *
 *   PUNCTUATION (`\p{P}`) → a SPACE, then whitespace collapses. A hyphen JOINS two words that
 *     were spoken separately, so deleting it would give `stopstop`, which matches nothing either.
 *
 *   ELISION MARKS (apostrophes) → DELETED. They join letters INSIDE a word: `don't` must become
 *     `dont`, not `don t`. Both sides of every comparison run through here, so the choice only
 *     has to be consistent.
 *
 *   FORMAT CHARACTERS (`\p{Cf}`) → DELETED. Zero-width joiners, the BOM and the soft hyphen are
 *     invisible by definition; a match must never turn on a glyph nobody can see.
 *
 * NFC first, because a decomposed `é` and a composed `é` are the same spoken word and STT engines
 * do not agree on which they emit.
 */

/** Apostrophes and their typographic variants — elision marks, deleted rather than spaced. */
const ELISION = /['’‘`´ʻʼ]/g;
/** Invisible format characters (ZWJ/ZWNJ, BOM, soft hyphen): never part of a match. */
const INVISIBLE = /\p{Cf}/gu;
/** Every punctuation category, every script — dashes, quotes, brackets, CJK and inverted marks. */
const PUNCTUATION = /\p{P}/gu;

/**
 * Normalise text for matching: lowercase, NFC, invisible and elision marks removed, all other
 * punctuation reduced to a space, whitespace collapsed.
 *
 * Byte-for-byte the SDK's `normalizeSpeech`. Keep it that way — see the header.
 */
export function normalizeSpeech(text: string): string {
	return (text || "")
		.toLowerCase()
		.normalize("NFC")
		.replace(INVISIBLE, "")
		.replace(ELISION, "")
		.replace(PUNCTUATION, " ")
		.replace(/\s+/g, " ")
		.trim();
}
