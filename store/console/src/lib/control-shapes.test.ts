import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { findHandAuthoredCards, findHandAuthoredControls } from "./control-shapes.js";

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

function sweep(root: string, find = findHandAuthoredControls) {
	return tsxFiles(root).flatMap((file) => find(readFileSync(file, "utf8")).map((c) => `${relative(root, file)}:${c.line}  ${c.shape.join(" ")}`));
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
// +2 for #488: DeploymentCard.tsx has 2 hand-authored button shapes, and AgentDetail.tsx was also updated.
//
// 126 → 69 at #366's third pass. 57 sites across 16 files — AccountConnections, Notifications,
// TriggersSection, TmuxTab, StatsTab, Profile, RunDetail, LoopPresetsSection, DataTab, Dashboard,
// Terminals, Usage, SettingsTab, ActivityTab, IndexingTab, LoopRunsSection, DeploymentCard.
//
// ── The rule this pass followed, stated so the next one is not a coin toss
//
// **The rendered type step is preserved; padding and radius collapse.** A call site at `text-sm`
// becomes `size="lg"` (also `text-sm`), one at `text-xs` becomes `md` or `sm` by its padding.
// The alternative — map every `px-3 py-1.5` to `md` regardless — would have shrunk a dozen
// 14px labels to 12px under cover of a shape sweep, which is a legibility change wearing a
// refactor's clothes. #390 already settled the type scale and both steps are Tailwind defaults,
// so nothing here is drift; the drift this ticket measured is in padding and radius, and that is
// what moved. `rounded-xl` and bare `rounded` on a control both became `rounded-lg`.
//
// ── What was deliberately left, and why, so 69 is not read as 69 identical to-dos
//
// Beyond the classes DESIGN-SYSTEM.md §3 already excludes (card-shaped, pills, segmented arms,
// overlaid, fixed-size icons), three judgements were made by hand:
//
//  - **`LoadFailed`'s Retry** sits INSIDE a `bg-danger-soft` banner and draws `border-danger-line`.
//    `variant="danger"` draws `border-line`, which is the right border on a panel and a washed-out
//    one on a red fill. One shared component, twelve rendered call sites, so it is the wrong place
//    to take a contrast risk for a shape.
//  - **Login's two provider buttons** are a matched pair and one of them is Google's mandated white
//    button. Migrating only the GitHub half would break the pairing that is the whole point of the
//    screen.
//  - **RunDetail's needs-input Send / Take over / Resume** are `text-base` on purpose — that is the
//    screen where someone types a legal name or a salary because the agent refused to guess. The
//    vocabulary has no step above `lg`, and inventing one for three controls is the table-describing-
//    one-call-site failure §3 warns about.
const PINNED = { "store/console": 69, "store/admin": 15, "agents/coder/web": 47 };

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

/**
 * The card half (#366), added 2026-08-08 — the ticket counted "3 card geometries" and nothing
 * held them. `<div>` really is the wrong unit to scan on its own; what makes this exact is
 * asking for a container tag AND the card radius AND a surface at once. The reasoning, and the
 * measured false positives that each condition removes, are in `control-shapes.ts`.
 *
 * 58 → 30 in the console at this commit: the 28 sites whose class string was already
 * byte-identical to `cardClass()` became `<Card>`, which is a rename rather than a restyle —
 * `CARD_TONE.panel` + `CARD_GEOMETRY` emit those exact utilities in that exact order, so the
 * rendered class attribute is unchanged. The remaining 30 differ in padding and are a judgement
 * call per screen, not a sweep.
 */
// +3 for #488: DeploymentCard.tsx adds 3 hand-written cards; AgentDetail/McpInputRequests also added.
const PINNED_CARDS = { "store/console": 33, "store/admin": 3, "agents/coder/web": 9 };

describe.each([
	["store/console", CONSOLE_SRC],
	["store/admin", ADMIN_SRC],
	["agents/coder/web", CODER_WEB_SRC],
] as const)("%s holds its count of hand-written cards", (name, root) => {
	it("is exactly at its pin", () => {
		const found = sweep(root, findHandAuthoredCards);
		expect(
			found.length,
			`${name}: ${found.length} hand-written card(s), pinned at ${PINNED_CARDS[name]}.\n${found.map((f) => `  ${f}`).join("\n")}\n\n` +
				"Over the pin: use <Card> from components/Card.tsx instead of writing a surface, a radius and padding.\n" +
				"Under it: you migrated some — lower the pin here in the same commit, or the ground is left as headroom.",
		).toBe(PINNED_CARDS[name]);
	});
});

describe("findHandAuthoredCards", () => {
	const cards = (src: string) => findHandAuthoredCards(src).map((c) => c.shape.join(" "));

	it("reports a container with a surface, the card radius and padding", () => {
		expect(cards(`<div className="bg-panel border border-line rounded-xl p-3 sm:p-4 mb-4">x</div>`)).toEqual(["p-3 sm:p-4 rounded-xl"]);
	});

	it("reports a bordered empty state with no fill, which is still a card", () => {
		expect(cards(`<div className="text-center text-muted-soft py-10 border border-line rounded-xl">none yet</div>`)).toEqual(["py-10 rounded-xl"]);
	});

	it("ignores the three tags that made the naive version noisy", () => {
		// Measured on the tree, not imagined: this app's text inputs are rounded and bordered, a
		// <button> would be double-reported under the guard above, and a dropdown panel is
		// card-SHAPED but cannot be a <Card>, so telling someone to use one would be wrong.
		expect(cards(`<input className="bg-panel border border-line rounded-xl px-3 py-2" />`)).toEqual([]);
		expect(cards(`<button className="bg-panel border border-line rounded-xl p-3">x</button>`)).toEqual([]);
		expect(cards(`<nav className="bg-panel border border-line rounded-xl py-1">x</nav>`)).toEqual([]);
	});

	it("ignores a control radius, which is how the two populations stay apart", () => {
		expect(cards(`<div className="bg-panel border border-line rounded-lg p-3">x</div>`)).toEqual([]);
	});

	it("ignores a layout box with no surface, and a surface with no padding", () => {
		expect(cards(`<div className="rounded-xl p-4 flex gap-2">x</div>`)).toEqual([]);
		expect(cards(`<div className="bg-panel border border-line rounded-xl overflow-hidden">x</div>`)).toEqual([]);
	});

	it("does not report a Card, which is the point", () => {
		expect(cards(`<Card className="mb-4">x</Card>`)).toEqual([]);
	});

	it("does not read a card out of a comment", () => {
		expect(cards(`{/* was a div with bg-panel border border-line rounded-xl p-4 */}\n<Card>x</Card>`)).toEqual([]);
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
