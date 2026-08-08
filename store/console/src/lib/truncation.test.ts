import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `truncate` needs a width to clamp to, and `shrink-0` is a promise never to have one (#393).
 *
 * ── The defect, measured
 *
 * The Terminals machine card renders the other hostnames a machine has answered to — `also
 * RLs-MacBook-Air · Sergeys-MacBook-Air.local` — as `truncate shrink-0` inside a `flex-wrap` row.
 * At 320px in WebKit that string did not truncate. It drew straight out of the card and was
 * painted OVER by the Forget button beside it: two overlapping controls, one unreadable.
 *
 * `truncate` is `overflow:hidden; text-overflow:ellipsis; white-space:nowrap`. None of that does
 * anything until the box is narrower than its text, and a flex item's default `min-width:auto`
 * plus `shrink-0` guarantees it never is. The ellipsis is silently dead.
 *
 * ── Why a guard rather than the fix alone
 *
 * Every horizontal-overflow guard in this repo — and there are many, across four viewports and two
 * engines — measured ZERO for this page. They compare `scrollWidth` to `clientWidth` on the
 * document, and text escaping its own box does not widen the document. The class of defect is
 * invisible to the whole existing suite, which is the argument for checking the cause in the source
 * instead of the symptom on the screen.
 *
 * ── What is NOT a violation
 *
 * `shrink-0` WITH an explicit width is correct and stays legal: `w-20 sm:w-28 truncate shrink-0`
 * is a fixed label column that should hold its width and ellipsise its content. Both existing uses
 * (`StatsCard`, `Usage`) are that shape, which is why this can gate at zero rather than ratchet —
 * the rule names the actual mistake, not the pair of utilities.
 */

/**
 * BOTH source trees the console is built from (#454).
 *
 * This scanned `store/console/src` only, and `agents/coder/web/src` is a different workspace
 * package — so `CodingTab.tsx` could not be seen by this guard WHATEVER it said, which is half of
 * why #454's dead ellipsis shipped. The two are compiled into one bundle and one stylesheet (the
 * console imports `@proagentstore/coder-web`; that is why coder-web's Tailwind classes appear in
 * `store/console/dist/assets/index.css`), so "everything the console renders" is the honest scope
 * for a rule about what the console renders.
 *
 * The guard stays HERE rather than being split in two or moved to a shared package: it is one rule
 * about one bundle, and two copies of it is how the two trees start disagreeing about what the
 * rule is. `vitest.config.ts` already names `agents/coder/web/src` explicitly for the same reason
 * — most dirs under `agents/` are inert vendored seed copies and must not be swept in.
 */
const ROOTS = [resolve(__dirname, ".."), resolve(__dirname, "../../../../agents/coder/web/src")];

function tsxFiles(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		const p = join(dir, entry);
		if (statSync(p).isDirectory()) tsxFiles(p, out);
		else if (entry.endsWith(".tsx")) out.push(p);
	}
	return out;
}

/**
 * A utility that gives `truncate` something to clamp to (incl. responsive variants).
 *
 * `flex-1` is here because in Tailwind it is `flex: 1 1 0%` — it sets the flex BASIS to zero,
 * which is exactly what `basis-0` beside it does and exactly what #454's fix used. Without it the
 * rule would flag its own remedy.
 */
const HAS_WIDTH = /(?:^|:)(?:w-|max-w-|basis-|flex-1$)/;

/**
 * Class strings that promise never to shrink AND never declare a width, while asking to truncate.
 * Deliberately textual: this is a Tailwind class combination, which no type checker can see and
 * which produces no error — it produces a silently dead ellipsis.
 *
 * ── WHY THIS IS STILL `shrink-0` AND NOT `shrink-0 || min-w-0` (#454)
 *
 * #454 asked for the shape to be widened to `truncate` + (`shrink-0` OR `min-w-0`), on the correct
 * observation that its own defect — `CodingTab`'s repo caption — was `truncate min-w-0` and slipped
 * through. Widened and MEASURED before gating, as #454 itself instructed. It reports four call
 * sites, and three of them are correct code:
 *
 *     store/console/src/components/FileConnectorPanel.tsx:71   parent `flex items-center …`
 *     store/console/src/tabs/LoopRunsSection.tsx:128           parent `flex items-start …`
 *     store/console/src/tabs/TmuxTab.tsx:342                   parent `flex …`
 *     store/console/src/pages/Terminals.tsx:121                parent `flex … FLEX-WRAP`
 *
 * `truncate min-w-0` in a NON-wrapping flex row is the canonical, correct idiom — it is precisely
 * how you let an item shrink and ellipsise. It is a dead ellipsis only when the row WRAPS, because
 * a `flex-wrap` container assigns items to lines from their hypothetical main size before it
 * shrinks anything, so the item leaves for a line where it has room. The difference is entirely in
 * the PARENT, and a class-string scanner cannot see the parent.
 *
 * So the widened rule would have gated `main` on three call sites where the only available "fix" is
 * to add `flex-1 basis-0` to items that should not grow — changing correct layouts to satisfy a
 * test. That is how a guard gets suppressed instead of obeyed. It is left at `shrink-0`, which is
 * an unconditional error at any parent and gates cleanly at zero.
 *
 * #454's shape is caught instead where the parent is actually observable: `mobile — the single-repo
 * Coder tab row (#431)` in `e2e/console.spec.ts` asserts the header is ONE line at 320 and 390. A
 * geometry assertion is parent-aware by construction, which is exactly what this rule cannot be.
 * (`Terminals.tsx:121` above is genuinely the wrapping shape, and is left alone deliberately: its
 * consequence is one extra line inside a card, not #454's three-line header pushing the terminal
 * pane off the screen. Recorded here so the next person does not have to re-derive it.)
 */
export function findDeadTruncations(source: string): string[] {
	const found: string[] = [];
	for (const match of source.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
		const classes = (match[1] ?? match[2] ?? "").split(/\s+/).filter(Boolean);
		if (!classes.includes("truncate") || !classes.includes("shrink-0")) continue;
		if (classes.some((c) => HAS_WIDTH.test(c))) continue;
		found.push(classes.join(" "));
	}
	return found;
}

describe("truncate + shrink-0 without a width (#393, scope widened by #454)", () => {
	it("finds the shape it is about", () => {
		expect(findDeadTruncations('<span className="text-2xs truncate shrink-0">')).toHaveLength(1);
	});

	it("allows shrink-0 when an explicit width bounds the truncation", () => {
		// The legitimate use: a fixed label column that holds its width and ellipsises inside it.
		expect(findDeadTruncations('<span className="w-20 sm:w-28 truncate shrink-0">')).toEqual([]);
		expect(findDeadTruncations('<span className="max-w-[8rem] truncate shrink-0">')).toEqual([]);
	});

	it("allows a zero flex basis, which is #454's remedy", () => {
		// `flex-1` IS `flex: 1 1 0%` in Tailwind — a zero basis, same as `basis-0` beside it. It
		// belongs in HAS_WIDTH or the rule flags the very fix #454 shipped on `CodingTab`.
		expect(findDeadTruncations('<span className="truncate shrink-0 flex-1 basis-0">')).toEqual([]);
		expect(findDeadTruncations('<span className="truncate shrink-0 flex-1">')).toEqual([]);
		// `flex-none` must NOT be mistaken for it: that is `flex: none`, i.e. no basis at all.
		expect(findDeadTruncations('<span className="truncate shrink-0 flex-none">')).toHaveLength(1);
	});

	it("ignores either utility on its own", () => {
		expect(findDeadTruncations('<span className="truncate min-w-0">')).toEqual([]);
		expect(findDeadTruncations('<span className="shrink-0 font-bold">')).toEqual([]);
	});

	it("neither tree the console is built from has any", () => {
		const hits = ROOTS.flatMap((root) =>
			tsxFiles(root).flatMap((file) => findDeadTruncations(readFileSync(file, "utf8")).map((c) => `${relative(root, file)}  ${c}`)),
		);
		expect(hits, `A truncating element with no width and no zero basis will overflow or wrap instead of ellipsising:\n${hits.join("\n")}`).toEqual([]);
	});
});
