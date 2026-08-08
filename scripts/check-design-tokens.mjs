#!/usr/bin/env node
/**
 * check-design-tokens.mjs — three rules over the same three trees:
 *
 *   1. no colour utility may name a token nothing declares (#367);
 *   2. no font size may be written as a bracketed value instead of a scale step (#390);
 *   3. no status colour may be written as an opacity modifier instead of its pairing (#367).
 *
 * They live together because they scan the same source, against the same `@theme`, and
 * because they are three halves of one idea: a class name must name a DECISION, not a value.
 * Rule 3 is the newest and the most literal reading of that — `-soft` is a decision about how
 * dark a tinted status background should be, made once; a slash and a number is the same
 * decision made again by whoever is typing, which is why the tree held three of them for red.
 *
 * PAGS runs its own design system (`DESIGN-SYSTEM.md`; it is deliberately out of scope of
 * the shared six-store spec as of 2026-08-07 — dark-only, own tokens). Owning it is a
 * reason to have named tokens, not a licence to name ones that do not exist.
 *
 * The defect this catches, and why nothing else could: Tailwind v4 has no error state. A
 * utility whose token is undeclared generates NO rule, so the element silently keeps the
 * inherited colour. Biome is a JS/TS linter and cannot see a class name; the type checker
 * sees a string; the build succeeds; a screenshot looks plausible. The mechanism is in
 * lib/design-tokens.mjs, and its worst outcome is not a missing tint — it is a bare
 * `border` left on v4's `currentColor` default, i.e. a near-white line on a black page,
 * which is exactly what #368 fixed in DataTab and what this found in four more places.
 *
 * The type rule catches the mirror image: a bracketed font size does not fail, it WORKS,
 * which is how 190 of them accumulated across 17 values with nine inside a 2px band. It is
 * a gate at zero in all three trees because #390 collapsed every one of them onto a step —
 * a lint with nowhere for the decision to go is 190 blocked edits, which is why this rule
 * could not have landed with #367.
 *
 * Gate where the tree is clean, ratchet where it is not — the same rule ci.yml's lint step
 * follows. Every surface is at zero on every rule as of #367; `store/admin`'s pin of 2 was
 * two inputs wearing a background token from somebody else's design system, and the pin is a
 * `pinned: 0` rather than a deleted field so the next tree that needs one has the mechanism.
 * A pin is always exact, never a `<=` ceiling, which would bank the ground as headroom —
 * numerically how the last ratchet in this repo got spent.
 *
 * Run: `node scripts/check-design-tokens.mjs`
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
	findArbitraryFontSizes,
	findDeadColorUtilities,
	findMissingStatusTokens,
	findStatusOpacityModifiers,
	pairingFor,
	parseThemeColorTokens,
	parseThemeTypeSteps,
	retiredTokenAdvice,
} from "./lib/design-tokens.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Each surface, and the `@theme` that defines what its class names may say.
 *
 * `agents/coder/web` has no stylesheet of its own: the console's `index.css` `@source`s it
 * so the Coder UI's classes are compiled with the console's tokens. It is therefore judged
 * against the console's `@theme`, which is also why a dead class there is invisible from
 * inside its own package.
 */
const SURFACES = [
	{ name: "store/console", src: "store/console/src", theme: "store/console/src/index.css", pinned: 0 },
	{ name: "store/admin", src: "store/admin/src", theme: "store/admin/src/index.css", pinned: 0 },
	{ name: "agents/coder/web", src: "agents/coder/web/src", theme: "store/console/src/index.css", pinned: 0 },
];

const SKIP_DIRS = new Set(["node_modules", "dist", "build", "coverage"]);

function* sourceFiles(dir) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (!SKIP_DIRS.has(entry.name)) yield* sourceFiles(full);
			continue;
		}
		// Tests name utilities as expected VALUES; the source they assert on is what ships.
		if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) yield full;
	}
}

/** Every source file of a surface, with its repo-relative path, read once per rule. */
function* surfaceSources(surface) {
	for (const file of sourceFiles(resolve(ROOT, surface.src))) {
		yield { rel: relative(ROOT, file).split(sep).join("/"), source: readFileSync(file, "utf8") };
	}
}

/** Rule 1 (#367): no colour utility names a token nothing declares. Returns true when OK. */
function checkColours(surface) {
	const declared = parseThemeColorTokens(readFileSync(resolve(ROOT, surface.theme), "utf8"));
	if (declared.size < 10) {
		console.error(
			`✗ Parsed only ${declared.size} colour token(s) out of ${surface.theme}.\n` +
				"  The @theme block moved or changed shape, and this guard would pass by checking\n" +
				"  nothing. Fix parseThemeColorTokens — do not delete the check.",
		);
		process.exit(1);
	}

	const offenders = [];
	for (const { rel, source } of surfaceSources(surface)) {
		for (const hit of findDeadColorUtilities(source, declared)) offenders.push({ ...hit, rel });
	}

	if (offenders.length === surface.pinned) {
		const how = surface.pinned === 0 ? "clean" : `at its pin of ${surface.pinned}`;
		console.log(`✓ ${surface.name}: every colour utility names a declared token (${how}).`);
		return true;
	}

	if (offenders.length < surface.pinned) {
		console.error(
			`\n✗ ${surface.name} is down to ${offenders.length} dead colour utility(ies), below its pin of ${surface.pinned}.\n` +
				`  Lower \`pinned\` for it in scripts/check-design-tokens.mjs in the same commit, or the\n` +
				"  ground you just took is left available as headroom.",
		);
		return false;
	}

	console.error(
		`\n✗ ${surface.name}: ${offenders.length} colour utility(ies) name a token nothing declares` +
			(surface.pinned ? ` (pinned at ${surface.pinned})` : "") +
			":\n",
	);
	for (const o of offenders) {
		const advice = retiredTokenAdvice(o.utility);
		console.error(`  ${o.rel}:${o.line}  ${o.utility}${advice ? `   → ${advice}` : ""}`);
	}
	if (offenders.some((o) => retiredTokenAdvice(o.utility))) {
		console.error(
			"\n  The arrowed ones are the pigment names #367 retired: the status tokens are named for\n" +
				"  INTENT now, so one word no longer means an error, a destructive action and an offline\n" +
				"  state at once. Write the name on the right. If you want a tinted background or border,\n" +
				"  the pairings are -soft and -line — see DESIGN-SYSTEM.md §1.",
		);
	}
	console.error(
		`\n  These compile to NOTHING — the element keeps whatever colour it inherited, and a\n` +
			`  bordered one gets v4's currentColor default (a near-white line on a black page).\n` +
			`  Use a token declared in ${surface.theme}, or declare the token there.\n` +
			"  If a legitimate Tailwind keyword is being misread as a colour, add it to\n" +
			"  NON_COLOR_VALUES in scripts/lib/design-tokens.mjs.",
	);
	return false;
}

/**
 * Rule 2 (#390): no font size is written as a bracketed value. A gate at zero, everywhere.
 *
 * The step check runs first and on its own: a scale step declared with no matching
 * `--text-*--line-height` emits a `line-height` that resolves to nothing, so the utility
 * silently inherits one — the colour rule's failure mode one property over, and the reason
 * the sweep this rule closes could point every call site at a step that half-works.
 */
function checkTypeScale(surface) {
	const { steps, lineHeights } = parseThemeTypeSteps(readFileSync(resolve(ROOT, surface.theme), "utf8"));
	for (const step of steps) {
		if (lineHeights.has(step)) continue;
		console.error(
			`\n✗ ${surface.theme} declares a --text-${step} step with no --text-${step}--line-height.\n` +
				"  Tailwind emits a line-height naming the missing variable, which resolves to nothing\n" +
				"  and silently inherits. Declare both, or neither.",
		);
		return false;
	}

	const offenders = [];
	for (const { rel, source } of surfaceSources(surface)) {
		for (const hit of findArbitraryFontSizes(source)) offenders.push({ ...hit, rel });
	}

	if (offenders.length === 0) {
		console.log(`✓ ${surface.name}: every font size names a scale step (${steps.size} declared here).`);
		return true;
	}

	console.error(`\n✗ ${surface.name}: ${offenders.length} font size(s) written as a value instead of a step:\n`);
	for (const o of offenders) console.error(`  ${o.rel}:${o.line}  ${o.utility}`);
	console.error(
		"\n  DESIGN-SYSTEM.md §2 fixes the scale: text-2xs · xs · sm · base · lg · xl · 2xl · 3xl.\n" +
			"  Pick the nearest step; below the 11px floor, round UP — that floor is the whole point\n" +
			"  of #390, and 0.32px between two neighbouring values is not a decision anyone made.\n" +
			"  A genuinely new step is a --text-* entry (with its --line-height) in BOTH @theme\n" +
			"  blocks, since designTokens.test.ts holds them equal.",
	);
	return false;
}

/**
 * Rule 3 (#367): a status colour names its pairing token, never an opacity modifier.
 *
 * A gate at zero in all three trees, and it can be one for the same reason rule 2 could: the
 * ticket declared `-soft` and `-line` first, so all 123 modifier sites had somewhere to go
 * before anything started failing. Before that they were spread over three alphas for one red
 * tint and five for one yellow border — each written by someone who had no way to know what
 * the others had picked, and no reason to think it mattered.
 */
function checkStatusPairings(surface) {
	const missing = findMissingStatusTokens(readFileSync(resolve(ROOT, surface.theme), "utf8"));
	if (missing.length) {
		console.error(
			`\n✗ ${surface.theme} is missing status token(s): ${missing.map((m) => `--color-${m}`).join(", ")}.\n` +
				"  Each status intent declares a base colour, a -soft background and a -line border.\n" +
				"  This is checked from the DECLARATION end on purpose: `text-` is excluded from the\n" +
				"  dead-token rule because it collides with the font-size scale, so deleting one of\n" +
				"  these would leave every `text-<intent>` in the app silently uncoloured with nothing\n" +
				"  able to see it. See lib/design-tokens.mjs for why widening that rule was rejected.",
		);
		return false;
	}

	const offenders = [];
	for (const { rel, source } of surfaceSources(surface)) {
		for (const hit of findStatusOpacityModifiers(source)) offenders.push({ ...hit, rel });
	}

	if (offenders.length === 0) {
		console.log(`✓ ${surface.name}: every status tint names its pairing token.`);
		return true;
	}

	console.error(`\n✗ ${surface.name}: ${offenders.length} status colour(s) written with an opacity modifier:\n`);
	for (const o of offenders) console.error(`  ${o.rel}:${o.line}  ${o.utility}   → ${pairingFor(o.utility)}`);
	console.error(
		"\n  The alpha is already decided: -soft (0.15) for a tinted background, -line (0.4) for a\n" +
			"  tinted border, declared in BOTH @theme blocks. Picking one per call site is what left\n" +
			"  the same idea wearing three different tints (DESIGN-SYSTEM.md §1).\n" +
			"  A genuinely different value is a new token, not a modifier.",
	);
	return false;
}

let failed = false;
for (const surface of SURFACES) {
	if (!checkColours(surface)) failed = true;
	if (!checkTypeScale(surface)) failed = true;
	if (!checkStatusPairings(surface)) failed = true;
}

process.exit(failed ? 1 : 0);
