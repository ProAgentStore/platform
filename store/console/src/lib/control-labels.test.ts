import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { findControls, findPlaceholderOnlyControls, findUnlabeledControls } from "./control-labels.js";

/**
 * The regression guard for #292's real half.
 *
 * The issue reported two classes. Invalid DOM nesting was NOISE — every claimed site was a
 * scanner artifact: `<path>` in an inline SVG matched as `<p>`, `<pre>` matched as `<p>`, and
 * the "button inside button" hits were all the same idiom, a SELF-CLOSING full-screen dismiss
 * overlay button immediately followed by its SIBLING menu `<div>`. There was no nesting bug to
 * fix, so there is nothing here to guard.
 *
 * Missing accessible names were real. A `<select>` that WRITES — moving a record's pipeline
 * status, picking which Drive folder to ingest — announced as an unnamed combo box, and the
 * Behaviour tab's nineteen sliders were nineteen indistinguishable unnamed sliders.
 *
 * This sweep is over the SOURCE, not a rendered tree, because neither console has
 * component-testing infrastructure and #282 decided deliberately against adding one. The
 * scanner is a pure function; this file both unit-tests it and points it at the real tree.
 */

const CONSOLE_SRC = resolve(__dirname, "..");
const ADMIN_SRC = resolve(__dirname, "../../../admin/src");

function tsxFiles(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		const p = join(dir, entry);
		if (statSync(p).isDirectory()) tsxFiles(p, out);
		else if (/\.tsx$/.test(entry)) out.push(p);
	}
	return out;
}

/**
 * Controls whose only name is a `placeholder`. A weak name, not an absent one — the control is
 * usable, but the name vanishes as soon as you type into it. Recorded as a COUNT rather than
 * fixed wholesale, so the remainder is a ratchet rather than a list that goes stale.
 *
 * Lower this when you fix some. Never raise it.
 */
const PLACEHOLDER_ONLY_BUDGET = { console: 26, admin: 11 };

/**
 * The one file this sweep does not cover, and why.
 *
 * `TmuxTab.tsx`'s backend `<select>` (which CREATES terminal targets) is genuinely unlabeled,
 * but the file had uncommitted work in a concurrent session when #292 was fixed, and losing
 * someone's edits costs more than an unnamed control. Delete this entry and add the
 * `aria-label` in the same commit as the next change to that file.
 */
const DEFERRED = new Set(["tabs/TmuxTab.tsx"]);

const format = (root: string, findings: { file: string; line: number; excerpt: string }[]) => findings.map((f) => `  ${relative(root, f.file)}:${f.line}  ${f.excerpt}`).join("\n");

function sweep(root: string, pick: typeof findUnlabeledControls) {
	return tsxFiles(root)
		.filter((file) => !DEFERRED.has(relative(root, file)))
		.flatMap((file) => pick(readFileSync(file, "utf8")).map((c) => ({ file, line: c.line, excerpt: c.excerpt })));
}

describe("every form control in the console has an accessible name", () => {
	it("store/console has no control with no name at all", () => {
		const found = sweep(CONSOLE_SRC, findUnlabeledControls);
		expect(found, `unlabeled controls:\n${format(CONSOLE_SRC, found)}`).toEqual([]);
	});

	it("store/admin has no control with no name at all", () => {
		const found = sweep(ADMIN_SRC, findUnlabeledControls);
		expect(found, `unlabeled controls:\n${format(ADMIN_SRC, found)}`).toEqual([]);
	});

	it("placeholder-only controls do not increase", () => {
		expect(sweep(CONSOLE_SRC, findPlaceholderOnlyControls).length).toBeLessThanOrEqual(PLACEHOLDER_ONLY_BUDGET.console);
		expect(sweep(ADMIN_SRC, findPlaceholderOnlyControls).length).toBeLessThanOrEqual(PLACEHOLDER_ONLY_BUDGET.admin);
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
