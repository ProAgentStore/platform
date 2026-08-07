#!/usr/bin/env node
/**
 * check-design-tokens.mjs — no colour utility may name a token nothing declares (#367).
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
 * Gate where the tree is clean, ratchet where it is not — the same rule ci.yml's lint step
 * follows. `store/admin` carries two hits in a tree with uncommitted maintainer work this
 * batch, so it is pinned rather than excluded: excluding it would hide the debt, and a
 * ceiling (`<=`) would bank the ground as headroom, which is numerically how the last
 * ratchet in this repo got spent.
 *
 * Run: `node scripts/check-design-tokens.mjs`
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { findDeadColorUtilities, parseThemeColorTokens } from "./lib/design-tokens.mjs";

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
	{ name: "store/admin", src: "store/admin/src", theme: "store/admin/src/index.css", pinned: 2 },
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

let failed = false;

for (const surface of SURFACES) {
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
	for (const file of sourceFiles(resolve(ROOT, surface.src))) {
		const rel = relative(ROOT, file).split(sep).join("/");
		for (const hit of findDeadColorUtilities(readFileSync(file, "utf8"), declared)) {
			offenders.push({ ...hit, rel });
		}
	}

	if (offenders.length === surface.pinned) {
		const how = surface.pinned === 0 ? "clean" : `at its pin of ${surface.pinned}`;
		console.log(`✓ ${surface.name}: every colour utility names a declared token (${how}).`);
		continue;
	}

	failed = true;
	if (offenders.length < surface.pinned) {
		console.error(
			`\n✗ ${surface.name} is down to ${offenders.length} dead colour utility(ies), below its pin of ${surface.pinned}.\n` +
				`  Lower \`pinned\` for it in scripts/check-design-tokens.mjs in the same commit, or the\n` +
				"  ground you just took is left available as headroom.",
		);
		continue;
	}

	console.error(
		`\n✗ ${surface.name}: ${offenders.length} colour utility(ies) name a token nothing declares` +
			(surface.pinned ? ` (pinned at ${surface.pinned})` : "") +
			":\n",
	);
	for (const o of offenders) console.error(`  ${o.rel}:${o.line}  ${o.utility}`);
	console.error(
		`\n  These compile to NOTHING — the element keeps whatever colour it inherited, and a\n` +
			`  bordered one gets v4's currentColor default (a near-white line on a black page).\n` +
			`  Use a token declared in ${surface.theme}, or declare the token there.\n` +
			"  If a legitimate Tailwind keyword is being misread as a colour, add it to\n" +
			"  NON_COLOR_VALUES in scripts/lib/design-tokens.mjs.",
	);
}

process.exit(failed ? 1 : 0);
