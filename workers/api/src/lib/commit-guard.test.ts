import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	COMMIT_VERB_RE,
	commitBlockReason,
	commitGuardSpec,
	commitModeFor,
	POST_FILL_SUBMIT_RE,
	resolveSnapshotElement,
	SUBMIT_KEY_RE,
	TERMINAL_SUBMIT_RE,
} from "./commit-guard.js";

/**
 * The two holes this closes, both of which were "the thing that decides is not the thing that
 * acts":
 *
 *   #627 — dry-run was enforced on `action.name`, a string the MODEL wrote, while the runner
 *          clicks by `ref` and never reads `name`. A wrong name — a paraphrase, a page in French —
 *          behaved exactly like a correct one, and the nameless variant had already submitted a
 *          real application during a run the owner asked to be a test.
 *   #629 — the read-only guard looked only at clicks, so an agent that "can never change anything"
 *          could commit by pressing Enter.
 */

// A real @playwright/mcp snapshot fragment: one line per element, with the role, the accessible
// name the PAGE reports, and the ref the brain targets by.
const SNAPSHOT = [
	'- heading "Ingénieur logiciel" [level=1] [ref=e3]',
	'- textbox "Nom complet" [ref=e10]',
	'- button "Continuer" [ref=e40]',
	'- button "Envoyer ma candidature" [ref=e88] [cursor=pointer]',
	"- generic [ref=e91]",
].join("\n");

describe("resolveSnapshotElement — the page's own account of the element", () => {
	it("reads role and name back out of the snapshot line the ref points at", () => {
		expect(resolveSnapshotElement(SNAPSHOT, "e88")).toEqual({ role: "button", name: "Envoyer ma candidature" });
		expect(resolveSnapshotElement(SNAPSHOT, "e10")).toEqual({ role: "textbox", name: "Nom complet" });
	});

	it("returns null when the ref is not on the page the brain was shown", () => {
		expect(resolveSnapshotElement(SNAPSHOT, "e999")).toBeNull();
		expect(resolveSnapshotElement(SNAPSHOT, undefined)).toBeNull();
		expect(resolveSnapshotElement("", "e88")).toBeNull();
	});

	it("reports a ref that exists but carries no name, rather than pretending it is missing", () => {
		expect(resolveSnapshotElement(SNAPSHOT, "e91")).toEqual({ role: "generic", name: "" });
	});
});

describe("commitBlockReason — a MISLABELLED submit is refused (#627)", () => {
	it("blocks a submit the model labelled as something else entirely", () => {
		// The exact shape the old guard could not see: `name` says "Continue", `ref` points at the
		// final submit. The guard tested the name and allowed it; the runner clicked the ref.
		const action = { action: "click" as const, ref: "e88", name: "Continue" };
		expect(commitBlockReason({ mode: "apply_dry_run", action, snapshot: SNAPSHOT })).toMatch(/BLOCKED/);
		// …and with no snapshot to check against, the claimed name is all there is — which is
		// precisely the state the guard used to be in permanently.
		expect(commitBlockReason({ mode: "apply_dry_run", action })).toBeNull();
	});

	it("blocks a non-English final submit — the vocabulary was English-only", () => {
		for (const name of ["Envoyer ma candidature", "Absenden", "Bewerbung abschicken", "Enviar solicitud", "Invia candidatura", "Skicka ansökan", "Wyślij", "提交", "送信", "제출", "Gönder"]) {
			expect(commitBlockReason({ mode: "apply_dry_run", action: { action: "click", name } }), name).toMatch(/BLOCKED/);
		}
	});

	it("still lets a rehearsal WALK a non-English form — page-advance stays allowed", () => {
		for (const name of ["Continuer", "Weiter", "Siguiente", "Avanti", "Volgende", "Dalej", "Suivant", "下一步", "Postuler", "Jetzt bewerben"]) {
			expect(commitBlockReason({ mode: "apply_dry_run", action: { action: "click", name } }), name).toBeNull();
		}
	});

	it("blocks on the page's name even when the model supplied none at all", () => {
		expect(commitBlockReason({ mode: "apply_dry_run", action: { action: "click", ref: "e88" }, snapshot: SNAPSHOT })).toMatch(/BLOCKED/);
		// A named element the page calls something harmless is allowed through.
		expect(commitBlockReason({ mode: "apply_dry_run", action: { action: "click", ref: "e40" }, snapshot: SNAPSHOT })).toBeNull();
	});

	it("refuses a click it can check NEITHER way", () => {
		expect(commitBlockReason({ mode: "apply_dry_run", action: { action: "click", ref: "e999" }, snapshot: SNAPSHOT })).toMatch(/include its visible `name`/);
	});
});

describe("commitBlockReason — read-only covers the whole action surface (#629)", () => {
	const READ_ONLY = { mode: "read_only" as const };

	it("refuses Enter, Return and NumpadEnter when the runner cannot enforce it", () => {
		for (const key of ["Enter", "return", "NumpadEnter"]) {
			expect(commitBlockReason({ ...READ_ONLY, action: { action: "key", key } }), key).toMatch(/READ-ONLY/);
		}
		expect(commitBlockReason({ ...READ_ONLY, action: { action: "key", key: "Space" } })).toMatch(/READ-ONLY/);
	});

	it("leaves navigation keys alone — a read-only agent still has to move around", () => {
		for (const key of ["Tab", "Escape", "ArrowDown", "PageDown"]) {
			expect(commitBlockReason({ ...READ_ONLY, action: { action: "key", key } }), key).toBeNull();
		}
	});

	it("hands Enter to the runner when the runner has said it enforces the guard itself", () => {
		// The runner can tell a GET search form from a POST mutation and refuse only the second,
		// which is what keeps "type into the search box and press Enter" working. Delegating is
		// conditional on its OWN acknowledgement, never on a version number.
		expect(commitBlockReason({ ...READ_ONLY, action: { action: "key", key: "Enter" }, runnerEnforces: true })).toBeNull();
		expect(commitBlockReason({ ...READ_ONLY, action: { action: "key", key: "Enter" }, runnerEnforces: false })).toMatch(/READ-ONLY/);
	});

	it("does NOT touch a rehearsal's keys — that carve-out needs state this guard cannot have", () => {
		// An Enter right after an arrow key is an autocomplete accept. `runApplyLoop` knows that;
		// a stateless guard inside a journaled step does not, and would break every typeahead.
		expect(commitBlockReason({ mode: "apply_dry_run", action: { action: "key", key: "Enter" } })).toBeNull();
		expect(commitBlockReason({ mode: "task_dry_run", action: { action: "key", key: "Enter" } })).toBeNull();
	});

	it("uses the WIDE vocabulary for read-only and a browse rehearsal, the narrow one for apply", () => {
		const pay = { action: "click" as const, name: "Pay now" };
		expect(commitBlockReason({ mode: "read_only", action: pay })).toMatch(/READ-ONLY/);
		expect(commitBlockReason({ mode: "task_dry_run", action: pay })).toMatch(/DRY RUN/);
		// An apply rehearsal is about the FINAL submit; "Pay" is not part of that promise, and
		// widening it would refuse the page-advance buttons an application has to walk through.
		expect(commitBlockReason({ mode: "apply_dry_run", action: pay })).toBeNull();
	});
});

describe("commitModeFor / commitGuardSpec — what the runner is told", () => {
	it("read-only wins over dry-run: it is the permanent form of the same guard", () => {
		expect(commitModeFor({ readOnly: true, dryRun: true })).toBe("read_only");
		expect(commitModeFor({ dryRun: true })).toBe("task_dry_run");
		expect(commitModeFor({})).toBeNull();
		expect(commitModeFor(null)).toBeNull();
	});

	it("sends the vocabulary itself, so a word fixed in the Worker reaches an old CLI", () => {
		const spec = commitGuardSpec("apply_dry_run");
		expect(spec.mode).toBe("dry_run");
		expect(new RegExp(spec.labels, spec.flags).test("Envoyer ma candidature")).toBe(true);
		const ro = commitGuardSpec("read_only");
		expect(ro.mode).toBe("read_only");
		expect(new RegExp(ro.labels, ro.flags).test("Pay now")).toBe(true);
	});
});

describe("the vocabulary itself", () => {
	it("matches tokens whose last character is not an ASCII word character", () => {
		// `\b` is ASCII-only, so `\bwyślij\b` matches nothing at all — a whole language silently
		// absent from a guard that reports itself as covering it. The Unicode lookarounds are why
		// these pass.
		expect(TERMINAL_SUBMIT_RE.test("Wyślij")).toBe(true);
		expect(TERMINAL_SUBMIT_RE.test("Potwierdź")).toBe(true);
		expect(TERMINAL_SUBMIT_RE.test("Bestätigen")).toBe(true);
		expect(TERMINAL_SUBMIT_RE.test("Gönder")).toBe(true);
	});

	it("does not fire on a longer word that merely contains a token", () => {
		expect(TERMINAL_SUBMIT_RE.test("Resubmitted receipts")).toBe(false);
		expect(TERMINAL_SUBMIT_RE.test("Envoyerait")).toBe(false);
	});

	it("the post-fill set is a superset of the terminal set, and both are subsets of the commit set", () => {
		for (const name of ["Submit", "Envoyer", "Absenden", "提交"]) {
			expect(TERMINAL_SUBMIT_RE.test(name), name).toBe(true);
			expect(POST_FILL_SUBMIT_RE.test(name), name).toBe(true);
			expect(COMMIT_VERB_RE.test(name), name).toBe(true);
		}
		// Post-fill adds the labels that are only terminal once a form has been filled.
		expect(TERMINAL_SUBMIT_RE.test("I Agree")).toBe(false);
		expect(POST_FILL_SUBMIT_RE.test("I Agree")).toBe(true);
	});

	it("SUBMIT_KEY_RE covers NumpadEnter, which the apply loop's /^(enter|return)$/ never did", () => {
		expect(SUBMIT_KEY_RE.test("NumpadEnter")).toBe(true);
		expect(SUBMIT_KEY_RE.test("Enter")).toBe(true);
		expect(SUBMIT_KEY_RE.test("Tab")).toBe(false);
	});
});

describe("the runner's fallback vocabulary", () => {
	/**
	 * The runner keeps a copy for the case where nothing is sent (an older Worker, a malformed
	 * spec). A copy that rots into an unparseable or empty pattern would fail OPEN — the guard
	 * would allow everything while still reporting itself as enforcing — so the copy is read here
	 * and exercised, rather than trusted. G1/G3 of ADR 0002: the input set is asserted, and a file
	 * this cannot parse is a failure rather than a smaller measurement.
	 */
	const RUNNER_GUARD = "packages/browser-runner/src/commit-guard.ts";

	it("parses, and refuses the committing words in every script the cloud list covers", () => {
		const src = readFileSync(new URL(`../../../../${RUNNER_GUARD}`, import.meta.url), "utf8");
		const m = src.match(/export const FALLBACK_COMMIT_RE\s*=\s*(\/[\s\S]*?\/[a-z]*);/);
		expect(m, `no FALLBACK_COMMIT_RE in ${RUNNER_GUARD} — the runner would fail open`).toBeTruthy();
		const body = (m as RegExpMatchArray)[1];
		const lastSlash = body.lastIndexOf("/");
		const re = new RegExp(body.slice(1, lastSlash), body.slice(lastSlash + 1));
		const words = ["Submit", "Pay now", "Envoyer", "Absenden", "Enviar", "Skicka", "Wyślij", "提交", "送信", "제출"];
		for (const w of words) expect(re.test(w), `${w} is not in the runner's fallback vocabulary`).toBe(true);
		expect(words.length, "denominator: words exercised against the runner's fallback").toBe(10);
		expect(re.test("Continue")).toBe(false);
	});
});
