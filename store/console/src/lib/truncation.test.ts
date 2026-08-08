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

const CONSOLE_SRC = resolve(__dirname, "..");

function tsxFiles(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		const p = join(dir, entry);
		if (statSync(p).isDirectory()) tsxFiles(p, out);
		else if (entry.endsWith(".tsx")) out.push(p);
	}
	return out;
}

/** A width utility that gives `truncate` something to clamp to (incl. responsive variants). */
const HAS_WIDTH = /(?:^|:)(?:w-|max-w-|basis-)/;

/**
 * Class strings that promise never to shrink AND never declare a width, while asking to truncate.
 * Deliberately textual: this is a Tailwind class combination, which no type checker can see and
 * which produces no error — it produces a silently dead ellipsis.
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

describe("truncate + shrink-0 without a width (#393)", () => {
	it("finds the shape it is about", () => {
		expect(findDeadTruncations('<span className="text-2xs truncate shrink-0">')).toHaveLength(1);
	});

	it("allows shrink-0 when an explicit width bounds the truncation", () => {
		// The legitimate use: a fixed label column that holds its width and ellipsises inside it.
		expect(findDeadTruncations('<span className="w-20 sm:w-28 truncate shrink-0">')).toEqual([]);
		expect(findDeadTruncations('<span className="max-w-[8rem] truncate shrink-0">')).toEqual([]);
	});

	it("ignores either utility on its own", () => {
		expect(findDeadTruncations('<span className="truncate min-w-0">')).toEqual([]);
		expect(findDeadTruncations('<span className="shrink-0 font-bold">')).toEqual([]);
	});

	it("the console tree has none", () => {
		const hits = tsxFiles(CONSOLE_SRC).flatMap((file) =>
			findDeadTruncations(readFileSync(file, "utf8")).map((c) => `${relative(CONSOLE_SRC, file)}  ${c}`),
		);
		expect(hits, `A truncating element that cannot shrink and has no width will overflow instead of ellipsising:\n${hits.join("\n")}`).toEqual([]);
	});
});
