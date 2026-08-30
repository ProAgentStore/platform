import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { describe, expect, it } from "vitest";
import { findHandAuthoredCards, findHandAuthoredControls } from "./control-shapes.js";
import { lineOf, scanTags } from "./jsx-tags.js";
import { TREES, assertMeasurable, tsxFiles } from "./tsx-trees.js";

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
//
// 69 → 54: `AgentDetail`'s 15, all of them ordinary. Its four remaining `<button>` elements draw no
// box at all (the tab bar's `border-b-2` arms, two text-only `Remove` links, two `&larr; Back`
// links), so this file is finished as far as this guard can see.
// 54 → 56 at #514: the two new OVERLAID corner icons — Report a problem on a message bubble, and
// the phone overflow control that now holds all three actions. They are the Copy/Delete idiom
// already in this count and not `<Button size="icon">`: they are absolutely positioned ON message
// text and carry a `bg-black/40` scrim so a 16px glyph stays legible over any content, and
// `Button`'s className passthrough is position-only — colour handed in there does not reliably
// win, which is the trap its own docstring names. The composer they open uses `<Button>` for all
// four of its ordinary controls, so what is banked here is exactly the overlay pair.
//
// ── 56 → 42, and the console is DONE, which is a different statement from "42 left"
//
// 14 sites migrated, following the rule above unchanged: `BoardTab` 9, `InstanceDetail` 3,
// `Browse` 2. Every one preserved its rendered type step — `text-sm` → `lg`, `text-xs` → `md`.
//
// The number that matters is not 42 but the fact that all 42 now fall inside a class §3 already
// excludes on purpose, counted rather than asserted:
//
//   10  below the smallest step's type size (`text-2xs` — BoardTab's dense chips, Usage's metric row)
//    5  pills (`rounded-full`)
//    5  card-shaped buttons (Dashboard's two grids, Notifications' rows, RunnerPanel, DeploymentCard)
//    4  overlaid message actions with their own scrim
//    3  segmented selectors with an active arm (Usage, StatsTab, TeamworkSection)
//    6  the three judgements already recorded below (LoadFailed, Login's pair, RunDetail's text-base trio)
//    9  four more judgements recorded HERE for the first time
//
// So the next pass on this tree is not "finish the migration" — it is a decision about whether the
// vocabulary should GROW a step (a filled status tint, a pill, an active arm), which is a design
// question and not a sweep. Quoting 42 as remaining effort would overstate it by 42.
//
// ── The four new judgements
//
//  - **`RunDetail`'s takeover header** (Resume / End / Close) is three filled tints — success-soft,
//    danger-soft, panel — on a `bg-black` full-screen surface. `secondary` draws no fill, and an
//    unfilled control on black is the same contrast failure that kept `LoadFailed`'s Retry
//    hand-written. Three buttons in one row, so it is all or none.
//  - **`RunDetail`'s "tap your answer" options** sit in the SAME panel as the `text-base` Send the
//    note below already excludes, and carry `text-ink` rather than `text-muted` because they are the
//    user's own answer to a question about their legal name or their salary. Migrating half a panel
//    that is deliberately larger and higher-contrast than the rest of the app is how that decision
//    gets lost.
//  - **`InstanceDetail`'s composer control row** (Mute, Loop stop, Loop open, kebab) is four
//    matched-height controls, each with a state colour no variant has: filled danger when muted,
//    `LOOP_BUTTON_CLASS[phase]`, `bg-accent-soft` when open. The Mute is additionally governed by
//    ADR 0001 (reachable in every phase, never behind a disclosure) — the wrong control to restyle
//    for a shape.
//  - **`InstanceDetail`'s Send** is sized to the textarea beside it (`py-2.5`, `rounded-xl`, matching
//    the composer's own geometry). `lg` is `py-2 rounded-lg`, which would leave the send button
//    shorter than the box it sends.
//
// ── `agents/coder/web` 47 → 23: the vocabulary transfers, the MODULE cannot
//
// The Coder UI renders inside this console and compiles against its stylesheet, so until now one
// screen carried two button systems. It could not import `lib/control-classes.ts`: `store/console`
// depends on `@proagentstore/coder-web`, and the SDK is not a home for it because Tailwind v4
// skips `node_modules` — which is exactly why `index.css` carries an explicit `@source` for that
// directory. So the table is VENDORED there and held byte-identical by `control-classes.test.ts`,
// the same bargain `designTokens.test.ts` already strikes for the tokens in `store/admin`.
//
// 24 sites migrated. The 23 left are the usual excluded classes — 2 pills, 1 overlay, 1
// card-shaped, 4 active-arm toggles, the composer send, the responsive-padding issue button — plus
// **8 that a measurement disqualified rather than a judgement**, and that is the finding worth
// keeping: `.hidden{display:none}` is emitted BEFORE `.inline-flex` in the built stylesheet, so
// `className="hidden sm:flex"` on a `<Button>` does not hide it — `BUTTON_BASE` wins, silently,
// and only on mobile. The whole coding-session header is responsive that way. Those eight are not
// unmigrated work; they are a gap in the table, and `Button.tsx`'s docstring now carries the test
// for which classes may be handed through and which cannot.
//
// ── `store/admin` 15 → 4, and the pin becomes a floor rather than a debt
//
// The same vendoring, for a plainer reason: a separate Vite app and a separate package, whose
// `rootDir` does not reach into the console's. 11 sites migrated across App, Agents (incl. the
// shared `Pager`), Audit, GithubIssues, Instances, McpAudit and the moderation trigger. McpAudit's
// Reload also loses an ad-hoc `border-accent/30` — an alpha invented at one call site, which is
// what §1 objects to — and now matches Audit's own Apply.
//
// The 4 left: the confirm/force PAIR in `moderation.tsx` (the Force arm is a FILLED red, which the
// table has no variant for, and the console deliberately has no filled destructive step — migrating
// only its Cancel would break the pair, which is the Login-pair judgement again), the `AuditLine`
// disclosure (a full-width text row that happens to name `px-1 rounded`, the "text link in a
// button's clothing" case this guard's own docstring describes), and GithubIssues' severity
// selector (card-shaped, with a selected state).
//
// All three trees are now at the floor of what this vocabulary can express. What is pinned is no
// longer a migration backlog; it is the list of shapes the table does not have.
//
// ── 42 → 43 at #536, and this is a RE-PIN, not a regression
//
// The console pin was set against an under-count. `jsx-tags.ts` did not treat a backtick as a
// string delimiter, so the apostrophe in `` setError(`Couldn't remember ${key} …`) `` at
// `tabs/TmuxTab.tsx:413` opened a quote state the closing backtick never cleared — and swallowed
// the button 23 lines ABOVE it, at `tabs/TmuxTab.tsx:390  px-2 py-2 rounded-lg`. That button has
// been there the whole time. Nobody added a shape; the scanner could not see one, and every
// sentence above about the console being "DONE" was written over a subset.
//
// The other two trees are unchanged (admin 4, coder/web 23) and so are all three card pins, even
// though the admin is where the mis-lex was WORST — one `<DangerAction>` in `UserDetail.tsx`
// swallowed 3491 characters over 79 lines. Its 32 hidden tags simply contained no `<button>` with
// both padding and a radius. That is luck, not coverage, which is the argument for the
// denominator assertion below rather than for a bigger pin.
const PINNED = { "store/console": 43, "store/admin": 4, "agents/coder/web": 23 };

describe.each(TREES)("%s holds its count of buttons that draw their own box", (name, root) => {
	/**
	 * ADR 0002 G1/G2 — the denominator. Every assertion in this file is over the tags this sweep
	 * managed to read, and #536 is what happens when that set silently shrinks: the pin above read
	 * 42 for months while the tree held 43, and nothing changed colour. `assertMeasurable` fails
	 * when the walk loses the tree, when one opening tag spans more lines than an attribute list
	 * plausibly can (the mis-lex signature), when `<label>` opens and closes stop balancing, and
	 * when `scanTags` cannot close a tag at all.
	 */
	it("measured a tree the size of a real one", () => {
		const { denominator } = assertMeasurable(name, root);
		console.log(`  ↳ ${denominator}`);
	});

	it("is exactly at its pin", () => {
		const found = sweep(root);
		const { files, tags } = assertMeasurable(name, root);
		expect(
			found.length,
			`${name}: ${found.length} hand-authored button shape(s) over ${tags} tags in ${files.length} files, pinned at ${PINNED[name]}.\n${found.map((f) => `  ${f}`).join("\n")}\n\n` +
				"Over the pin: use <Button variant size> from components/Button.tsx instead of writing padding + radius.\n" +
				"Under it: you migrated some — lower the pin here in the same commit, or the ground is left as headroom.\n" +
				"If the TAG count fell too, suspect the scanner before the tree (#536, ADR 0002).",
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
// −1 for #727: the Repo tab's "Add a repository" card moved to the Settings tab, and the panel it
// became (components/RepoConnectPanel.tsx) is a <Card> — the hand-written `p-5` shape it used to
// carry is gone rather than relocated, so the ground is recorded here instead of left as headroom.
const PINNED_CARDS = { "store/console": 32, "store/admin": 3, "agents/coder/web": 9 };

describe.each(TREES)("%s holds its count of hand-written cards", (name, root) => {
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

	it("sees a shape on a button whose title is a template literal holding an apostrophe (#536)", () => {
		// The under-count itself, as a fixture. Against the pre-fix lexer the apostrophe in
		// `agent's` opened a quote state the backtick could not close, the tag was scanned to the
		// end of the input, and this returned [] — which is how `tabs/TmuxTab.tsx:390` stayed out
		// of the pin above. The second control proves the loss did not stop at the one tag.
		const src = [
			"<button title={`the agent",
			"'s runner`} className=\"px-2 py-2 rounded-lg\">Restart</button>\n",
			"<button className=\"px-3 py-1.5 rounded-lg\">After</button>",
		].join("");
		expect(shapes(src)).toEqual(["px-2 py-2 rounded-lg", "px-3 py-1.5 rounded-lg"]);
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

/**
 * Responsive label guard (#438).
 *
 * Two bugs reached production because a control row's labels were NOT hidden on mobile:
 * #426 (an overflow) and #431 (a four-button row 80 lines below the two-button row that
 * was already fixed). Both fixes added `hidden sm:inline` to the `<span>` labels. Nothing
 * stopped the pattern from recurring — that is what this guard is.
 *
 * ── The silently-dead class (assertion 1, the first finding)
 *
 * `.hidden{display:none}` is emitted BEFORE `.inline-flex` in the built stylesheet, so
 * `className="hidden sm:flex"` on a `<Button>` does NOT hide it on mobile — `BUTTON_BASE`
 * wins and the control stays visible. Silently. The author sees a desktop build that is
 * correct, and the mobile regression ships unnoticed. `Button.tsx`'s docstring documents
 * this; this assertion makes it machine-enforceable (#438).
 *
 * The correct approach when a NATIVE button must be conditionally visible is either:
 *  (a) wrap it in a container that carries `hidden sm:block` (the container is not a
 *      `<Button>` so it has no BUTTON_BASE conflict), or
 *  (b) move responsive visibility into the table (a new variant or size step), or
 *  (c) use a native `<button>` rather than the `<Button>` component — native buttons
 *      do not carry BUTTON_BASE, so `hidden sm:flex` works there.
 *
 * This guard asserts the count is 0, not that it stays 0: if a new `<Button hidden sm:>`
 * lands it must be zero, not "plus one from last sprint".
 *
 * ── Non-vacuity
 *
 * `assertMeasurable` (from the button-shape guard above) already verifies the three trees
 * are a real size. A second denominator assertion here would duplicate it; the shared call
 * there is the denominator for this scan too.
 */
describe("responsive labels — Button with hidden sm: is silently dead (#438)", () => {
	/**
	 * Finds every `<Button>` opening tag (capital B = the component, not a native element)
	 * whose className attribute carries a `hidden sm:` utility.
	 *
	 * Why `hidden sm:` is wrong on `<Button>`: `Button.tsx` injects `buttonClass()` which
	 * includes `BUTTON_BASE = "... inline-flex ..."`. Tailwind resolves same-property
	 * utilities by their position in the GENERATED stylesheet, not by their order in the
	 * class attribute. `.hidden{display:none}` is emitted before `.inline-flex`, so
	 * `.inline-flex` wins — the button is always visible. Verified on the built `index.css`.
	 */
	function findButtonWithHiddenSm(source: string): Array<{ line: number; excerpt: string }> {
		const hits: Array<{ line: number; excerpt: string }> = [];
		for (const tag of scanTags(source)) {
			if (tag.name !== "Button" || tag.closing || tag.selfClosing) continue;
			// Extract everything from `className` onward in the tag body.
			const cnIdx = tag.body.indexOf("className");
			if (cnIdx === -1) continue;
			const cnText = tag.body.slice(cnIdx);
			// `hidden sm:` is the pattern: `hidden` followed immediately by a `sm:` utility
			// (e.g. `hidden sm:flex`, `hidden sm:inline-flex`).
			if (!/hidden\s+sm:/.test(cnText)) continue;
			hits.push({ line: lineOf(source, tag.index), excerpt: tag.body.trim().slice(0, 120) });
		}
		return hits;
	}

	it.each(TREES)("no <Button> carries hidden sm: in className in %s", (_name, root) => {
		const offenders: string[] = [];
		for (const file of tsxFiles(root)) {
			const source = readFileSync(file, "utf8");
			for (const hit of findButtonWithHiddenSm(source)) {
				offenders.push(`  ${relative(root, file)}:${hit.line}  ${hit.excerpt}`);
			}
		}
		expect(
			offenders,
			[
				"`hidden sm:flex` (or `sm:inline-flex`) on a `<Button>` does not hide it on mobile.",
				"BUTTON_BASE emits `inline-flex`, which wins because `.inline-flex` is emitted AFTER",
				"`.hidden` in the built stylesheet — Tailwind's property-order rule, not specificity.",
				"",
				"Use a wrapper element, a native `<button>` (which has no BUTTON_BASE conflict),",
				"or a new table entry in control-classes.ts if this becomes a pattern (#438).",
				"",
				...offenders,
			].join("\n"),
		).toEqual([]);
	});

	it("the scan finds Button tags at all — non-vacuity", () => {
		// If scanTags or the name filter breaks, `findButtonWithHiddenSm` could return nothing
		// for every file and the guard above would pass vacuously. The same trap `assertMeasurable`
		// closes for the shape and card guards. This confirms the scan is actually live.
		let found = 0;
		for (const [, root] of TREES) {
			for (const file of tsxFiles(root)) {
				found += scanTags(readFileSync(file, "utf8")).filter((t) => t.name === "Button" && !t.closing && !t.selfClosing).length;
			}
		}
		expect(found, "no <Button> tags found in any tree — the scanner is broken or all trees are empty").toBeGreaterThan(20);
	});
});
