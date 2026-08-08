import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { findHandAuthoredControls } from "./control-shapes.js";

/**
 * The ratchet that stops the fifteenth button shape (#366).
 *
 * 47 padding+radius combinations across 266 buttons did not arrive by decision — they
 * accumulated because nothing failed when a new one appeared. A sweep alone fixes the tree
 * once; #367's guard caught five defects that landed on main from a different author WHILE
 * its own sweep was running, which is the argument for the check over the sweep, made
 * without waiting for it.
 *
 * Pinned EXACTLY, not as a `<=` ceiling, following `designTokens.test.ts` and the file-size
 * ratchet: a ceiling banks the ground you just took as headroom, which is numerically how the
 * last ratchet in this repo got spent. Migrating a call site to `<Button>` lowers the pin in
 * the same commit.
 *
 * The three trees share one stylesheet — the console's `index.css` `@source`s
 * `agents/coder/web` — so all three are counted, as they are by the two sibling guards. Only
 * the console tree was migrated in #366; the other two are pinned where they stand so they
 * cannot grow while their turn waits.
 */

const CONSOLE_SRC = resolve(__dirname, "..");
const ADMIN_SRC = resolve(__dirname, "../../../admin/src");
const CODER_WEB_SRC = resolve(__dirname, "../../../../agents/coder/web/src");

function tsxFiles(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		const p = join(dir, entry);
		if (statSync(p).isDirectory()) tsxFiles(p, out);
		else if (/\.tsx$/.test(entry)) out.push(p);
	}
	return out;
}

function sweep(root: string) {
	return tsxFiles(root).flatMap((file) => findHandAuthoredControls(readFileSync(file, "utf8")).map((c) => `${relative(root, file)}:${c.line}  ${c.shape.join(" ")}`));
}

/**
 * Measured at 6b37070, after this commit's migration.
 *
 * `store/console` was **182** before #366 and is what the sweep moved — the shared component
 * family, the Knowledge tab and TeamworkSection, 57 sites. The other two are untouched: the
 * Coder UI is its own package with its own review surface, and `store/admin` carried
 * uncommitted maintainer work this batch — the same reason #367 pinned it rather than fixing
 * it. Pinned rather than excluded, so the debt is visible and may only go down.
 *
 * Admin's number moved from 13 to 15 between filing and landing: the operator portal's GitHub
 * issue monitor (341b0d1) arrived with two more, which is this guard's argument in miniature.
 *
 * 125 → 124 at #389: `RepoTab`'s *Index* button became `<Button variant="primary" size="lg">`
 * when its three padding-less siblings were given real boxes. The other three never counted —
 * they named no padding and no radius, which is precisely the shape this guard excludes, and
 * one of them was the 16px *Remove* that deletes an indexed repository. The ratchet moving by
 * one while the actual defect moved by four is the honest measure of what it covers.
 *
 * 48 → 47 at #408: the repo row's `Open` / `Start` pair collapsed into ONE action, because a
 * coding session is a cache the platform reaps and re-opens by itself and the user was being asked
 * to read its state off a button. One fewer hand-authored box, recorded rather than banked.
 */
const PINNED = { "store/console": 124, "store/admin": 15, "agents/coder/web": 47 };

describe.each([
	["store/console", CONSOLE_SRC],
	["store/admin", ADMIN_SRC],
	["agents/coder/web", CODER_WEB_SRC],
] as const)("%s holds its count of buttons that draw their own box", (name, root) => {
	it("is exactly at its pin", () => {
		const found = sweep(root);
		expect(
			found.length,
			`${name}: ${found.length} hand-authored button shape(s), pinned at ${PINNED[name]}.\n${found.map((f) => `  ${f}`).join("\n")}\n\n` +
				"Over the pin: use <Button variant size> from components/Button.tsx instead of writing padding + radius.\n" +
				"Under it: you migrated some — lower the pin here in the same commit, or the ground is left as headroom.",
		).toBe(PINNED[name]);
	});
});

describe("findHandAuthoredControls", () => {
	const shapes = (src: string) => findHandAuthoredControls(src).map((c) => c.shape.join(" "));

	it("reports a button that names both padding and a radius", () => {
		expect(shapes(`<button type="button" className="text-xs px-3 py-1.5 rounded-lg">Go</button>`)).toEqual(["px-3 py-1.5 rounded-lg"]);
	});

	it("ignores a button with padding but no radius, and one with a radius but no padding", () => {
		// A text link in a button's clothing, and a circular avatar button. Neither draws a box.
		expect(shapes(`<button className="px-2 text-muted hover:text-ink">x</button>`)).toEqual([]);
		expect(shapes(`<button className="rounded-full w-6 h-6">x</button>`)).toEqual([]);
	});

	it("sees a shape written only inside a template literal or a ternary arm", () => {
		// The arm that only fires when the tab is active is still a shape somebody wrote by hand.
		// Built by concatenation so this file does not itself contain a JS template placeholder,
		// which biome's noTemplateCurlyInString flags inside an ordinary string.
		const tag = ["<button className={`text-xs $", "{on ? 'px-3 py-1.5 rounded-lg' : 'text-muted'}`}>x</button>"].join("");
		expect(shapes(tag)).toEqual(["px-3 py-1.5 rounded-lg"]);
	});

	it("counts a responsive or state prefix as the same decision", () => {
		expect(shapes(`<button className="sm:px-4 hover:rounded-xl">x</button>`)).toEqual(["sm:px-4 hover:rounded-xl"]);
	});

	it("is not fooled by an arrow function's > inside the tag", () => {
		// The bug a naive /<[^>]*>/ has: the tag is cut before className and the shape is missed.
		expect(shapes(`<button onClick={(e) => go(e)} className="p-1.5 rounded-lg"><X /></button>`)).toEqual(["p-1.5 rounded-lg"]);
	});

	it("does not read a shape out of a comment", () => {
		// DESIGN-SYSTEM.md §5: prose about markup is not markup, and a guard that cries wolf
		// gets suppressed rather than fixed.
		expect(shapes(`{/* was px-3 py-1.5 rounded-lg before <Button> */}\n<Button size="md">x</Button>`)).toEqual([]);
	});

	it("does not report a Button, a Link or a styled div", () => {
		// Only <button> is in scope. A <Link> that looks like a button is a known, stated gap.
		expect(shapes(`<Button variant="primary" size="md">x</Button>`)).toEqual([]);
		expect(shapes(`<div className="px-3 py-1.5 rounded-lg bg-panel">x</div>`)).toEqual([]);
	});

	it("does not mistake pointer-events or peer- utilities for padding", () => {
		expect(shapes(`<button className="pointer-events-none peer-checked:rounded-lg">x</button>`)).toEqual([]);
	});

	it("reports the line so the failure can be clicked", () => {
		expect(findHandAuthoredControls(`\n\n<button className="p-2 rounded">x</button>`)[0].line).toBe(3);
	});
});
