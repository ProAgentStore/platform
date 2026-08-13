import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { findControls, findMouseOnlyClickTargets, findPlaceholderOnlyControls, findUnlabeledControls } from "./control-labels.js";
import { TREES, assertMeasurable, tsxFiles } from "./tsx-trees.js";

/**
 * The regression guard for the real half of #292, and now of #324.
 *
 * #292 reported two classes. Invalid DOM nesting was NOISE — every claimed site was a scanner
 * artifact: `<path>` in an inline SVG matched as `<p>`, `<pre>` matched as `<p>`, and the "button
 * inside button" hits were all the same idiom, a SELF-CLOSING full-screen dismiss overlay button
 * immediately followed by its SIBLING menu `<div>`. There was no nesting bug to fix, so there is
 * nothing here to guard.
 *
 * Missing accessible names were real. A `<select>` that WRITES — moving a record's pipeline
 * status, picking which Drive folder to ingest — announced as an unnamed combo box, and the
 * Behaviour tab's nineteen sliders were nineteen indistinguishable unnamed sliders.
 *
 * #324 re-reported the same class at 46, plus 14 "click handlers on non-interactive elements",
 * 4 autoFocus warnings and a missing `alt`. Checked one at a time: the autoFocus four were a PROP
 * NAMED `autoFocus` on `TicketThread`, which drives a `ref.focus()` in an effect and never
 * reaches the DOM attribute; every `<img>` in all three trees already carries an alt (the two
 * avatars correctly carry `alt=""`); and of the click-target claims exactly three were real —
 * two in `DataTab`'s modal backdrop and one `<tr onClick>` in the admin's error list. The rest
 * were sites that already declare a role and handle their own keys, with the reason written down
 * at the call site. So the mouse-only-click sweep below exists, and it is small.
 *
 * This sweep is over the SOURCE, not a rendered tree, because none of these apps has
 * component-testing infrastructure and #282 decided deliberately against adding one. The
 * scanner is a pure function; this file both unit-tests it and points it at the real trees.
 */

/**
 * The three trees, and the walk, moved to `tsx-trees.ts` at #536 — where the assertion that they
 * were actually READ lives too. The third of them is the one that was invisible to this sweep
 * until #324: the Coding tab is its own package (`@proagentstore/coder-web`) that the console
 * imports, so "the console" as a directory was never all of the console as a screen. It was
 * already at zero on both counts — which is exactly why it is worth pinning, since nothing was
 * holding it there.
 */

/**
 * Controls whose only name is a `placeholder`. A weak name, not an absent one — the control is
 * usable, but the name vanishes as soon as you type into it.
 *
 * This was a budget: 26 at #292, 16 after #301, and #324 took the last sixteen. It is now an
 * emptiness assertion in all three trees, like the admin's, because a budget only earns its
 * complexity while there is a backlog to burn down. There is no longer one, and the offender
 * list in the failure message is far more useful than "expected 1 to be <= 16".
 *
 * The sixteen were worth finishing rather than sampling, because almost every one of them WROTE:
 * the MCP access-token field, the browser task's start URL, the URL the agent will ingest into
 * its knowledge base, the Special Instructions that rewrite its prompt, the Drive and WorkDrive
 * folders being granted, and the two fields that wire one agent's events into another. The board
 * column rows are the clearest case of the failure mode: "Column title" named all four of them
 * identically, so the placeholder was not distinguishing anything even before you typed. Those
 * carry an index now.
 */
const format = (root: string, findings: { file: string; line: number; excerpt: string }[]) => findings.map((f) => `  ${relative(root, f.file)}:${f.line}  ${f.excerpt}`).join("\n");

function sweep(root: string, pick: (source: string) => { line: number; excerpt: string }[]) {
	return tsxFiles(root).flatMap((file) => pick(readFileSync(file, "utf8")).map((c) => ({ file, line: c.line, excerpt: c.excerpt })));
}

describe.each(TREES)("%s", (name, root) => {
	/**
	 * ADR 0002 G1/G2 — the denominator. The three assertions below are emptiness assertions, and
	 * an empty offender list is indistinguishable from an empty input set. #536 is the measured
	 * case: a lexer that lost a backtick made 33 tags invisible, one of them a `<label>`/`<input>`
	 * pair in the admin that no a11y sweep had ever looked at, and all three of these stayed green.
	 *
	 * The label-balance arm of `assertMeasurable` matters most HERE, and it is the reason it exists
	 * rather than the tag floor: `findControls` scores a control as named when it sits inside a
	 * `<label>`. A swallow that eats a `</label>` and not its `<label>` leaves that depth stuck
	 * above zero and quietly exempts every control after it in the file — turning one lost tag into
	 * false negatives for the rest of the file, which is worse than losing the tag.
	 */
	it("measured a tree the size of a real one, and one with balanced labels", () => {
		const { denominator, files } = assertMeasurable(name, root);
		const controls = files.reduce((n, f) => n + findControls(readFileSync(f, "utf8")).length, 0);
		console.log(`  ↳ ${denominator}, ${controls} named-or-not form controls`);
		expect(controls, `${name}: ${controls} form controls found — an a11y sweep over no controls is green and means nothing.`).toBeGreaterThan(10);
	});

	it("has no form control with no name at all", () => {
		const found = sweep(root, findUnlabeledControls);
		expect(found, `unlabeled controls:\n${format(root, found)}`).toEqual([]);
	});

	it("has no form control named only by a placeholder", () => {
		const found = sweep(root, findPlaceholderOnlyControls);
		expect(found, `placeholder-only controls:\n${format(root, found)}\n\nGive it an aria-label, or an aria-labelledby pointing at text already on screen.`).toEqual([]);
	});

	it("has no click handler only a mouse can reach", () => {
		const found = sweep(root, findMouseOnlyClickTargets);
		expect(found, `mouse-only click targets:\n${format(root, found)}\n\nUse a <button> (the codebase's dismiss-overlay idiom is a self-closing full-screen button beside the panel), or declare a role and handle the keyboard.`).toEqual([]);
	});
});

describe("findControls resolves a name the way a browser does", () => {
	const one = (src: string) => findControls(src)[0];

	it("prefers aria-labelledby, then aria-label, then id", () => {
		expect(one(`<input aria-labelledby="h" aria-label="x" id="y" />`).via).toBe("aria-labelledby");
		expect(one(`<input aria-label="x" id="y" />`).via).toBe("aria-label");
		expect(one(`<input id="y" />`).via).toBe("id");
	});

	it("treats a wrapping <label> as a name", () => {
		expect(one(`<label>Max <input type="number" /></label>`).via).toBe("wrapping-label");
	});

	it("does not let a label leak past its close tag", () => {
		// The bug this guards: tracking "are we inside a label" by open tags alone marks every
		// control after the first label in a file as named, which is most of them.
		expect(one(`<label>a<input id="a" /></label><select />`.replace(`<input id="a" />`, ""))?.via).toBe("none");
	});

	it("counts placeholder as a weak name, distinct from none", () => {
		expect(one(`<textarea placeholder="Talk to me" />`).via).toBe("placeholder");
		expect(one(`<textarea />`).via).toBe("none");
	});

	it("accepts title as a name", () => {
		expect(one(`<select title="Move to column" />`).via).toBe("title");
	});

	it("skips input types that name themselves", () => {
		expect(findControls(`<input type="hidden" /><input type="submit" value="Go" />`)).toEqual([]);
	});

	it("does not truncate a tag at a `>` inside an arrow function or a string", () => {
		// The reason this is a tag scanner and not `/<[^>]*>/`: the arrow in `onChange={(e) =>`
		// ends the match early, hiding every attribute after it — including the aria-label — and
		// the guard would then report hundreds of false failures.
		const src = `<select onChange={(e) => setX(e.target.value)} aria-label="Status" />`;
		expect(one(src).via).toBe("aria-label");
		expect(one(`<input placeholder=">" aria-label="Prompt" />`).via).toBe("aria-label");
	});

	it("reports the line the control opens on", () => {
		expect(one("\n\n<input />").line).toBe(3);
	});
});

describe("findMouseOnlyClickTargets", () => {
	const tags = (src: string) => findMouseOnlyClickTargets(src).map((c) => c.tag);

	it("reports a bare container that is only clickable", () => {
		expect(tags(`<div onClick={close} />`)).toEqual(["div"]);
		expect(tags(`<tr onClick={open}><td>x</td></tr>`)).toEqual(["tr"]);
	});

	it("does not report elements that are already controls", () => {
		expect(tags(`<button type="button" onClick={close} /><a href="/x" onClick={go} />`)).toEqual([]);
	});

	it("does not report a component — it may render a button", () => {
		// The reason this is a deny-list of known-inert HTML tags: `<Row onClick=…>` is a prop
		// passed to something that decides for itself, and guessing wrong here would make the
		// guard unusable.
		expect(tags(`<Row onClick={open} />`)).toEqual([]);
	});

	it("accepts a declared role as the escape hatch", () => {
		// A role is someone stating the semantics on purpose — RunDetail's remote-control surface
		// is role="application" with its own key handling. A bare div is the accident.
		expect(tags(`<div role="application" tabIndex={0} onClick={send} onKeyDown={key} />`)).toEqual([]);
	});

	it("ignores hover handlers, which have no keyboard equivalent to be missing", () => {
		expect(tags(`<div onMouseEnter={hi} onMouseLeave={bye} />`)).toEqual([]);
	});
});

describe("comments are not markup", () => {
	it("does not report a tag written inside a JSX comment", () => {
		// Found by this guard failing on the very commit that fixed the bug: the comment saying
		// why `<tr onClick>` was wrong was itself reported as a `<tr onClick>`.
		expect(findMouseOnlyClickTargets(`{/* a <tr onClick> is mouse-only */}\n<button onClick={x} />`)).toEqual([]);
		expect(findControls(`{/* <input /> in prose */}`)).toEqual([]);
	});

	it("does not report a tag in a line comment or a block comment", () => {
		expect(findControls(`\t// <select /> was here\n`)).toEqual([]);
		expect(findControls(`/**\n * <textarea /> in a doc comment\n */\n`)).toEqual([]);
	});

	it("leaves line numbers untouched, so masking cannot shift a report", () => {
		expect(findControls(`{/* <input /> */}\n\n<input />`)[0].line).toBe(3);
	});

	it("does not blank a URL or a glob inside an attribute", () => {
		// The reason masking is anchored to line starts: a mid-line `//` here is string content,
		// and blanking to end-of-line would eat the aria-label that follows it.
		expect(findControls(`<input placeholder="https://x" aria-label="Repo URL" />`)[0].via).toBe("aria-label");
	});

	it("still sees the controls after a template literal holding an apostrophe (#536)", () => {
		// The admin's real shape, shrunk: a `<DangerAction description={`Deletes this user's …`}>`
		// swallowed 3491 characters over 79 lines, and the `<label>`/`<input>` pair inside it had
		// never been read by this sweep at all. Pre-fix this returned one finding for the outer
		// tag's own attributes; now it returns the control that was hidden behind it.
		// Assembled from pieces so this file holds no literal interpolation inside a plain string,
		// which biome's noTemplateCurlyInString flags — the same dodge control-shapes.test.ts uses.
		const src = ["<DangerAction description={`Deletes this user", "'s $", "{k} key`} />\n<input aria-label=\"Confirm\" />\n<textarea />"].join("");
		expect(findControls(src).map((c) => `${c.tag}:${c.via}`)).toEqual(["input:aria-label", "textarea:none"]);
	});

	it("does not let a swallowed </label> exempt every control after it", () => {
		// The second-order hazard. `labelDepth` is what makes a wrapped control count as named, so
		// a lost close tag silently names everything downstream. `assertMeasurable` asserts this
		// balance across all three real trees; this is the unit-level statement of the same thing.
		const src = ["<label>Name <input id=\"n\" /></label>\n<input title={`it", "'s here`} />\n<textarea />"].join("");
		expect(findControls(src).map((c) => `${c.tag}:${c.via}`)).toEqual(["input:id", "input:title", "textarea:none"]);
	});
});
