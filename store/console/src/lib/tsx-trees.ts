/**
 * The three React trees the source-scanning guards sweep, and the assertion that they were
 * actually read (#536, ADR 0002).
 *
 * `control-labels.test.ts` and `control-shapes.test.ts` both walk `store/console/src`,
 * `store/admin/src` and `agents/coder/web/src`, hand every `.tsx` to a pure finder, and assert
 * something about the offenders that come back — an empty list, or an exact pin. Both had their
 * own copy of the walk and neither ever stated how much it had looked at.
 *
 * That is the gap #536 fell through. A lexer bug made 33 tags invisible across two of 107 files;
 * one pinned count was therefore an under-count (42 where the tree held 43) and nothing changed
 * colour. `docs/adr/0002-a-guard-states-what-it-measured.md` (G1, G2) is the rule that came out
 * of it: the size of the input set is an assertion, and it is printed in the passing output.
 *
 * So this module owns the walk once, and `assertMeasurable` is the denominator. It asserts four
 * different things, because the ways this sweep can quietly shrink are not one thing:
 *
 *   1. **A floor on files and tags** — catches the coarse failure: a tree moved, a walk that
 *      stopped recursing, a rootDir change. It is a FLOOR with a reason, never a pin: these
 *      trees grow every week and a ceiling would fail on honest work. It does NOT catch a
 *      33-tag swallow in 1979, and is not claimed to.
 *   2. **A bound on how many lines one opening tag may span** — this is the one that catches the
 *      swallow, and it needs no threshold tuning to speak of. A real opening tag is a list of
 *      attributes; the longest in these three trees is 28 lines. The tag #536 mis-lexed spanned
 *      **79 lines and 3491 characters**, swallowing 32 tags including a `<label>`/`<input>`
 *      pair. A scanner that has run past the `>` shows up here immediately.
 *   3. **Label balance per file** — the second-order hazard, which is worse than losing a tag.
 *      `control-labels.ts` scores a control as named when it sits inside a `<label>`. If a
 *      swallow eats a `</label>` but not its `<label>`, the depth never comes back down and
 *      EVERY subsequent control in that file is scored `via: "wrapping-label"` — silently
 *      named, and therefore silently exempt. Measured at zero in all three trees, both before
 *      and after the #536 fix, so this is a guard against the next lexer change rather than a
 *      finding.
 *   4. **That `scanTags` did not throw** — implicit, and the loudest of the four. It throws on a
 *      tag whose `>` it never finds, which is ADR 0002 G3 and the `continue` that #536 removed.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { lineOf, scanTags } from "./jsx-tags.js";

const HERE = resolve(__dirname);

export type TreeName = "store/console" | "store/admin" | "agents/coder/web";

/**
 * The console tree, the operator portal, and the Coder UI package the console renders inside.
 *
 * All three share one stylesheet — the console's `index.css` `@source`s `agents/coder/web` — so
 * "the console" as a directory was never all of the console as a screen. Both sweeps take the
 * same three, and until #536 both had their own copy of this list and of the walk below.
 */
export const TREES = [
	["store/console", resolve(HERE, "..")],
	["store/admin", resolve(HERE, "../../../admin/src")],
	["agents/coder/web", resolve(HERE, "../../../../agents/coder/web/src")],
] as const satisfies readonly (readonly [TreeName, string])[];

export function tsxFiles(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		const p = join(dir, entry);
		if (statSync(p).isDirectory()) tsxFiles(p, out);
		else if (/\.tsx$/.test(entry)) out.push(p);
	}
	return out;
}

/**
 * A floor per tree, and the count it was set from. Deliberately well below today's measurement:
 * its job is to fire when the walk stops seeing a tree, not to track growth. Raising one is
 * never required by adding files; lowering one means a tree really did shrink, and should be
 * explained here.
 */
const FLOORS: Record<TreeName, { files: number; tags: number; measured: string }> = {
	"store/console": { files: 55, tags: 4000, measured: "69 files / 5473 tags at cfe8ff7" },
	"store/admin": { files: 20, tags: 1400, measured: "27 files / 1979 tags at cfe8ff7" },
	"agents/coder/web": { files: 8, tags: 700, measured: "11 files / 967 tags at cfe8ff7" },
};

/**
 * The longest opening tag in these trees is 28 lines (`TmuxTab.tsx`'s engine button). 40 leaves
 * room for a genuinely long attribute list and still fails on a mis-lex, which starts at 79.
 */
const MAX_TAG_LINES = 40;

export interface TreeMeasurement {
	files: string[];
	tags: number;
	/** The widest opening tag found, as a line span — the mis-lex detector. */
	longest: { rel: string; line: number; name: string; lines: number };
	/** One line naming the denominator, for the passing output (ADR 0002 G2). */
	denominator: string;
}

/**
 * Walk a tree, measure it, and fail if the measurement is not one a real tree could produce.
 *
 * Throws rather than returning a verdict: every caller is a test, and a guard whose
 * plausibility check can be ignored by a caller is back where it started.
 */
export function assertMeasurable(name: TreeName, root: string): TreeMeasurement {
	const floor = FLOORS[name];
	if (!floor) throw new Error(`tsx-trees: no floor recorded for ${name} — add one rather than sweeping a tree nothing sizes (ADR 0002 G1).`);

	const files = tsxFiles(root);
	let tags = 0;
	let longest = { rel: "", line: 0, name: "", lines: 0 };
	const unbalanced: string[] = [];

	for (const file of files) {
		const source = readFileSync(file, "utf8");
		const rel = relative(root, file);
		// Throws on a tag it cannot close (ADR 0002 G3) — the failure surfaces with the file name.
		let scanned: ReturnType<typeof scanTags>;
		try {
			scanned = scanTags(source);
		} catch (err) {
			throw new Error(`${rel}: ${(err as Error).message}`);
		}
		tags += scanned.length;

		let labelDepth = 0;
		for (const tag of scanned) {
			const lines = tag.body.split("\n").length;
			if (lines > longest.lines) longest = { rel, line: lineOf(source, tag.index), name: tag.name, lines };
			if (tag.name.toLowerCase() !== "label") continue;
			if (tag.closing) labelDepth--;
			else if (!tag.selfClosing) labelDepth++;
		}
		if (labelDepth !== 0) unbalanced.push(`${rel} (depth ${labelDepth})`);
	}

	if (files.length < floor.files || tags < floor.tags) {
		throw new Error(
			`${name}: swept ${files.length} file(s) and ${tags} tag(s), below the floor of ${floor.files}/${floor.tags} (measured ${floor.measured}).\n` +
				"  The walk has lost the tree — a moved directory or a scanner that stopped parsing. Every\n" +
				"  assertion over these findings is now true of a subset (ADR 0002 G1).",
		);
	}

	if (longest.lines > MAX_TAG_LINES) {
		throw new Error(
			`${name}: one opening <${longest.name}> at ${longest.rel}:${longest.line} spans ${longest.lines} lines, over the ${MAX_TAG_LINES}-line bound.\n` +
				"  An opening tag is a list of attributes. This size means the scanner ran PAST the `>` and is\n" +
				"  swallowing the tags after it — the #536 defect, where one 79-line tag hid 32 others.",
		);
	}

	if (unbalanced.length) {
		throw new Error(
			`${name}: <label> opens and closes do not balance in ${unbalanced.join(", ")}.\n` +
				"  A lost `</label>` leaves control-labels.ts's labelDepth above zero, so every control after\n" +
				"  it in that file is scored as named by a wrapping label — exempted, silently (#536).",
		);
	}

	return { files, tags, longest, denominator: `${name}: ${files.length} .tsx files, ${tags} tags, longest tag ${longest.lines} lines` };
}
