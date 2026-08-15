import { describe, expect, it } from "vitest";
import { commitLabelRe, FALLBACK_COMMIT_RE, refuseClick, refuseKey, type ElementFacts, type FocusFacts } from "./commit-guard.js";

const READ_ONLY = { mode: "read_only" as const };
const DRY_RUN = { mode: "dry_run" as const };

/**
 * What the CLOUD actually sends for a rehearsal: the terminal-submit set, which deliberately
 * excludes "save", "apply" and every page-advance word so a rehearsal can walk a multi-page form.
 * The real list and its contents are asserted in `workers/api/src/lib/commit-guard.test.ts`; this
 * stands in for it so these tests measure the runner's RULE rather than the cloud's vocabulary.
 * The runner's own FALLBACK_COMMIT_RE is deliberately the widest set — it is what a runner falls
 * back to when it was told a mode but no words, and failing wide is the safe direction there.
 */
const TERMINAL = /\bsubmit\b|\bfinish\b|(?<![\p{L}])(envoyer|absenden)(?![\p{L}])/iu;

function facts(over: Partial<ElementFacts> = {}): ElementFacts {
	return { submits: false, method: "", name: "", tag: "button", type: "", ...over };
}
function focus(over: Partial<FocusFacts> = {}): FocusFacts {
	return { inForm: false, method: "", tag: "input", type: "text", name: "", ...over };
}

describe("refuseClick — the read-only rule is a DOM fact, not a label", () => {
	it("refuses a POST-form submit whatever it is called, in any language", () => {
		for (const name of ["", "Continue", "Suivant", "Weiter", "记录"]) {
			const r = refuseClick(READ_ONLY, facts({ submits: true, method: "post", name }), "Continue", FALLBACK_COMMIT_RE);
			expect(r, name || "(unnamed)").toMatch(/READ-ONLY/);
		}
	});

	it("allows a GET form's submit — that is a search, which a read-only agent may run", () => {
		expect(refuseClick(READ_ONLY, facts({ submits: true, method: "get", name: "Search" }), "Search", FALLBACK_COMMIT_RE)).toBeNull();
	});

	it("refuses when the element could not be read at all — an unreadable target is not a yes", () => {
		expect(refuseClick(READ_ONLY, null, "Open statement", FALLBACK_COMMIT_RE)).toMatch(/could not be read/);
	});

	it("still refuses a committing LABEL that is not a native submit (a JS button)", () => {
		expect(refuseClick(READ_ONLY, facts({ name: "Pay now" }), "", FALLBACK_COMMIT_RE)).toMatch(/READ-ONLY/);
	});
});

describe("refuseClick — a rehearsal decides on the label, but on the PAGE's label", () => {
	it("refuses when the element's REAL name commits and the model claimed something else", () => {
		// #627 exactly: the brain says "Continue", the element says "Envoyer ma candidature", and
		// the runner is the only party that can see the difference — it clicks by ref.
		expect(refuseClick(DRY_RUN, facts({ name: "Envoyer ma candidature" }), "Continue", TERMINAL)).toMatch(/BLOCKED/);
	});

	it("does NOT refuse an intermediate POST submit — a rehearsal has to walk the whole form", () => {
		// The structural rule that makes read-only safe would stop a rehearsal on page 1 of 6:
		// "Save and Continue" is a POST submit too. Which submit is FINAL is not in the DOM.
		expect(refuseClick(DRY_RUN, facts({ submits: true, method: "post", name: "Save and Continue" }), "Save and Continue", TERMINAL)).toBeNull();
	});

	it("falls back to the claimed name when the element cannot be probed", () => {
		expect(refuseClick(DRY_RUN, null, "Submit application", TERMINAL)).toMatch(/BLOCKED/);
		expect(refuseClick(DRY_RUN, null, "Next", TERMINAL)).toBeNull();
	});
});

describe("refuseKey — the hole a click-only guard could never see (#629)", () => {
	it("refuses Enter inside a POST form", () => {
		expect(refuseKey(READ_ONLY, "Enter", focus({ inForm: true, method: "post" }))).toMatch(/READ-ONLY/);
		expect(refuseKey(READ_ONLY, "NumpadEnter", focus({ inForm: true, method: "post" }))).toMatch(/READ-ONLY/);
	});

	it("allows Enter in a GET search form — the read-only prompt explicitly permits searching", () => {
		expect(refuseKey(READ_ONLY, "Enter", focus({ inForm: true, method: "get" }))).toBeNull();
		expect(refuseKey(READ_ONLY, "Enter", focus({ inForm: false }))).toBeNull();
	});

	it("refuses Space on a focused submit button", () => {
		expect(refuseKey(READ_ONLY, "Space", focus({ tag: "button", type: "submit", method: "post", inForm: true }))).toMatch(/READ-ONLY/);
	});

	it("refuses when focus could not be read", () => {
		expect(refuseKey(READ_ONLY, "Enter", null)).toMatch(/could not be read/);
	});

	it("leaves a rehearsal's keys alone — that carve-out belongs to the loop, which holds the state", () => {
		expect(refuseKey(DRY_RUN, "Enter", focus({ inForm: true, method: "post" }))).toBeNull();
	});

	it("leaves navigation keys alone", () => {
		for (const k of ["Tab", "Escape", "ArrowDown"]) {
			expect(refuseKey(READ_ONLY, k, focus({ inForm: true, method: "post" })), k).toBeNull();
		}
	});
});

describe("commitLabelRe — the vocabulary travels with the command", () => {
	it("compiles what the cloud sent, so a word fixed in the Worker reaches an old CLI", () => {
		const re = commitLabelRe({ mode: "dry_run", labels: "\\bwidgetise\\b", flags: "i" });
		expect(re.test("Widgetise")).toBe(true);
	});

	it("falls back rather than throwing on a malformed pattern — a guard must not fail open", () => {
		expect(commitLabelRe({ mode: "read_only", labels: "([" }).test("Submit")).toBe(true);
		expect(commitLabelRe(undefined).test("Envoyer")).toBe(true);
	});
});
